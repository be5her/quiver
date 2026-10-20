import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListDeadLetterSourceQueuesCommand,
  ListQueuesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
  type QueueAttributeName,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';
import {
  QuiverError,
  sqsDestination,
  sqsIsFifo,
  sqsMergePeek,
  sqsMessage,
  sqsMessageAttributes,
  sqsNearRedrive,
  sqsQueueName,
  sqsRedrive,
  SQS_LIST_ATTRIBUTES,
  type QueueConnection,
  type QueueDriver,
  type QueueSecrets,
  type SqsRedrive,
} from '@quiver/core';

// SQS through @aws-sdk/client-sqs. One client is pooled per connection and rebuilt when its region, endpoint,
// profile or key change; queue URLs are cached on it by name. SQS has no way to look at a message without
// receiving it, so peeks and tails receive with a visibility timeout of 0: the message stays visible to every
// other consumer and nothing is deleted, but each receive counts towards its receive count (and so a redrive
// policy's maxReceiveCount). Peeks therefore receive each message about once, tails back off while SQS keeps
// handing back what they have seen and stop one receive short of the DLQ, and the commands make all of them
// mutating for agents. Tails never delete either, like Kafka's throwaway groups and the memory broker.

const CONNECT_TIMEOUT_MS = 5000;
/** Longer than the 20 second long poll a tail waits in. */
const REQUEST_TIMEOUT_MS = 30_000;
const LONG_POLL_SECONDS = 20;
/** SQS hands back at most this many messages per receive. */
const RECEIVE_MAX = 10;
/** How long a peek keeps receiving before it settles for what it has. */
const PEEK_TIMEOUT_MS = 10_000;
/** The most a peek for the newest messages (or a tail's first look) collects, since SQS hands out older ones first. */
const PEEK_COLLECT_MAX = 500;
/** A tail whose receive brought only messages it has seen waits this long, doubling up to the max, since unconsumed messages come straight back. */
const TAIL_IDLE_MS = 1000;
const TAIL_IDLE_MAX_MS = 20_000;
/** A tail retries a failed receive (throttling, a network drop) after this long, doubling up to the max. */
const TAIL_RETRY_MS = 1000;
const TAIL_RETRY_MAX_MS = 30_000;
/** A tail from `latest` treats anything sent this long before it started as already there; NTP keeps clocks well within it. */
const TAIL_CLOCK_SKEW_MS = 5000;
/** Message ids a tail remembers, so messages it does not consume are not handed on twice. */
const TAIL_SEEN_LIMIT = 10_000;
/** Queues described at once while listing. */
const LIST_CONCURRENCY = 8;
/** A listing stops at one page of this many queues, each described with a request of its own. */
const LIST_MAX = 1000;

interface Pooled {
  key: string;
  client: SQSClient;
  /** Queue URL by name, as GetQueueUrl or ListQueues answered. */
  urls: Map<string, string>;
  /** Origins a queue URL given as the destination may have: the endpoint, or SQS's own hosts in the region. */
  origins: Set<string>;
}

const pool = new Map<string, Pooled>();

function regionOf(c: QueueConnection): string {
  const region = c.region.trim() || (c.endpoint.trim() ? 'us-east-1' : '');
  if (!region) throw new QuiverError('INVALID_INPUT', 'The connection has no region; set one such as eu-west-1');
  return region;
}

function config(c: QueueConnection, s: QueueSecrets): SQSClientConfig {
  const endpoint = c.endpoint.trim();
  const out: SQSClientConfig = {
    region: regionOf(c),
    endpoint: endpoint || undefined,
    // The SDK would otherwise send a request to whatever host a queue URL names, signed with these credentials.
    useQueueUrlAsEndpoint: false,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
  };
  const accessKeyId = c.accessKeyId.trim();
  if (accessKeyId) {
    if (!s.secretAccessKey) throw new QuiverError('INVALID_INPUT', `Access key ${accessKeyId} needs its secret: store it as the secret secretAccessKey`);
    out.credentials = { accessKeyId, secretAccessKey: s.secretAccessKey, sessionToken: s.sessionToken || undefined };
  } else if (endpoint) {
    // An endpoint comes with the committed connection, so it never gets the profile's or the environment's credentials.
    throw new QuiverError('INVALID_INPUT', `A connection with an endpoint (${endpoint}) needs an access key of its own, so your AWS credentials are never sent elsewhere; LocalStack takes any key, such as test with the secret test`);
  } else if (c.profile.trim()) {
    out.profile = c.profile.trim();
  }
  // With neither, the SDK's default chain applies: environment variables, the default profile, SSO or an instance role.
  return out;
}

function originsOf(c: QueueConnection): Set<string> {
  const endpoint = c.endpoint.trim();
  if (endpoint) {
    try {
      return new Set([new URL(endpoint).origin]);
    } catch {
      return new Set();
    }
  }
  const region = regionOf(c);
  return new Set([`https://sqs.${region}.amazonaws.com`, `https://sqs.${region}.amazonaws.com.cn`, `https://${region}.queue.amazonaws.com`]);
}

function pooled(c: QueueConnection, s: QueueSecrets): Pooled {
  const key = JSON.stringify([c.region, c.endpoint, c.profile, c.accessKeyId, s.secretAccessKey ?? '', s.sessionToken ?? '']);
  const existing = pool.get(c.id);
  if (existing?.key === key) return existing;
  existing?.client.destroy();
  const p: Pooled = { key, client: new SQSClient(config(c, s)), urls: new Map(), origins: originsOf(c) };
  pool.set(c.id, p);
  return p;
}

const NOT_FOUND = new Set(['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue']);
const CONFLICT = new Set(['QueueAlreadyExists', 'QueueNameExists', 'QueueDeletedRecently', 'AWS.SimpleQueueService.QueueDeletedRecently', 'PurgeQueueInProgress', 'AWS.SimpleQueueService.PurgeQueueInProgress']);
const AUTH = new Set([
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'SignatureDoesNotMatch',
  'InvalidSecurity',
  'AccessDenied',
  'AccessDeniedException',
  'ExpiredToken',
  'ExpiredTokenException',
  'CredentialsProviderError',
]);
const INVALID = new Set(['InvalidParameterValue', 'InvalidAttributeName', 'InvalidAttributeValue', 'InvalidMessageContents', 'MissingParameter', 'InvalidParameterCombination', 'ValidationException', 'InvalidAddress', 'UnsupportedOperation']);

/** AWS errors as Quiver errors: a missing queue is NOT_FOUND, an existing one CONFLICT, refused credentials AUTH_FAILED. */
function quiverError(err: unknown, destination?: string): QuiverError {
  if (err instanceof QuiverError) return err;
  const e = err as { name?: string; message?: string };
  const name = e.name ?? '';
  const message = e.message || String(err);
  if (NOT_FOUND.has(name)) return new QuiverError('NOT_FOUND', destination ? `Queue ${destination} not found` : message);
  if (CONFLICT.has(name)) return new QuiverError('CONFLICT', message);
  if (AUTH.has(name)) return new QuiverError('AUTH_FAILED', message);
  if (INVALID.has(name)) return new QuiverError('INVALID_INPUT', message);
  return new QuiverError('REQUEST_FAILED', message);
}

function fail(err: unknown, destination?: string): never {
  throw quiverError(err, destination);
}

async function guard<T>(fn: () => Promise<T>, destination?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    fail(err, destination);
  }
}

/** The URL of a queue given by name (or already by URL); NOT_FOUND when there is none. */
async function queueUrl(p: Pooled, destination: string): Promise<string> {
  if (/^https?:\/\//i.test(destination)) {
    let origin = '';
    try {
      origin = new URL(destination).origin;
    } catch {
      // Not a URL after all: refused below.
    }
    if (!p.origins.has(origin)) throw new QuiverError('INVALID_INPUT', `${destination} is not a queue of this connection, which reaches ${[...p.origins].join(' or ')}; give the queue's name`);
    return destination;
  }
  const cached = p.urls.get(destination);
  if (cached) return cached;
  const { QueueUrl } = await p.client.send(new GetQueueUrlCommand({ QueueName: destination }));
  if (!QueueUrl) throw new QuiverError('NOT_FOUND', `Queue ${destination} not found`);
  p.urls.set(destination, QueueUrl);
  return QueueUrl;
}

async function attributes(p: Pooled, url: string, names: readonly string[]): Promise<Record<string, string>> {
  const { Attributes } = await p.client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: names as QueueAttributeName[] }));
  return Attributes ?? {};
}

/** The first `LIST_MAX` queue URLs: an account with more is listed in part, and the rest are reached by name. */
async function listUrls(p: Pooled): Promise<string[]> {
  const page = await p.client.send(new ListQueuesCommand({ MaxResults: LIST_MAX }));
  const urls = page.QueueUrls ?? [];
  for (const url of urls) p.urls.set(sqsQueueName(url), url);
  return urls;
}

/** Receive without consuming: visibility timeout 0, every attribute, and `wait` seconds of long polling. */
function receive(p: Pooled, url: string, wait: number, max: number, abortSignal?: AbortSignal) {
  return p.client.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: Math.min(RECEIVE_MAX, Math.max(1, max)),
      VisibilityTimeout: 0,
      WaitTimeSeconds: wait,
      MessageSystemAttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    }),
    { abortSignal },
  );
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * Receive as a peek does: rounds of up to ten, each long polling a second so SQS looks at every server, until
 * `enough` are seen, a round brings fewer than it asked for (nothing more to hand out) or nothing new (SQS keeps
 * handing back the same ones), or the deadline. Each message is received about once, not once per round.
 */
async function collect(p: Pooled, url: string, enough: number, deadline: number): Promise<Message[]> {
  const seen = new Map<string, Message>();
  while (seen.size < enough && Date.now() < deadline) {
    const max = Math.min(RECEIVE_MAX, enough - seen.size);
    const { Messages = [] } = await receive(p, url, 1, max);
    let fresh = 0;
    for (const m of Messages) {
      if (!m.MessageId || seen.has(m.MessageId)) continue;
      seen.set(m.MessageId, m);
      fresh++;
    }
    if (Messages.length < max || !fresh) break;
  }
  return [...seen.values()];
}

const receiveCount = (m: Message) => Number(m.Attributes?.ApproximateReceiveCount ?? 0);

/** The error a tail ends with rather than receive a message once more and so move it to the dead-letter queue. */
function nearRedriveError(destination: string, m: Message, redrive: SqsRedrive): QuiverError {
  return new QuiverError(
    'CONFLICT',
    `Stopped: message ${m.MessageId} on ${destination} has been received ${receiveCount(m)} times and the queue moves it to the dead-letter queue ${redrive.deadLetterQueue} past ${redrive.maxReceiveCount}; another receive could put it there`,
  );
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const onAbort = () => {
      clearTimeout(t);
      r();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      r();
    }, ms);
    t.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const sqsDriver: QueueDriver = {
  kind: 'sqs',

  test: async (c, s) => {
    // A fresh client, so testing a draft does not disturb the pool.
    let client: SQSClient | null = null;
    try {
      const cfg = config(c, s);
      client = new SQSClient({ ...cfg, maxAttempts: 1 });
      const page = await client.send(new ListQueuesCommand({ MaxResults: LIST_MAX }));
      const n = page.QueueUrls?.length ?? 0;
      const where = c.endpoint.trim() ? `${c.endpoint.trim()} (${cfg.region as string})` : `region ${cfg.region as string}`;
      return { ok: true, message: `Connected to ${where}: ${n}${page.NextToken ? '+' : ''} queue${n === 1 ? '' : 's'}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message || String(err) };
    } finally {
      client?.destroy();
    }
  },

  listDestinations: (c, s) =>
    guard(async () => {
      const p = pooled(c, s);
      const urls = (await listUrls(p)).sort((a, b) => sqsQueueName(a).localeCompare(sqsQueueName(b)));
      return mapLimit(urls, LIST_CONCURRENCY, async (url) => {
        const name = sqsQueueName(url);
        // A queue deleted between the listing and its attributes is still listed, without counts.
        const a = await attributes(p, url, SQS_LIST_ATTRIBUTES).catch(() => ({}) as Record<string, string>);
        const d = sqsDestination(name, a);
        // A listing keeps to the counts and the DLQ; describe has the rest.
        const keep = ['in flight', 'delayed', 'dead-letter queue', 'max receive count'];
        d.details = Object.fromEntries(Object.entries(d.details ?? {}).filter(([k]) => keep.includes(k)));
        return d;
      });
    }),

  describe: (c, s, destination) =>
    guard(async () => {
      const p = pooled(c, s);
      const url = await queueUrl(p, destination);
      const a = await attributes(p, url, ['All']);
      // Which queues send their failures here, when this queue is someone's DLQ; it needs a permission some users lack.
      const sources = await p.client
        .send(new ListDeadLetterSourceQueuesCommand({ QueueUrl: url, MaxResults: 1000 }))
        .then((r) => (r.queueUrls ?? []).map(sqsQueueName).sort().join(', '))
        .catch(() => '');
      return sqsDestination(sqsQueueName(url), a, { url, sources });
    }, destination),

  peek: (c, s, destination, { limit, from }) =>
    guard(async () => {
      const p = pooled(c, s);
      const url = await queueUrl(p, destination);
      const name = sqsQueueName(url);
      // A FIFO queue hands out each group from its oldest message, and at visibility 0 those stay first in line, so
      // past ten messages the newest are never handed out: refused before receiving anything, rather than answered
      // with the oldest as though they were the newest.
      if (from === 'latest' && sqsIsFifo(name)) {
        const held = Number((await attributes(p, url, ['ApproximateNumberOfMessages'])).ApproximateNumberOfMessages ?? 0);
        if (held > RECEIVE_MAX) {
          throw new QuiverError('INVALID_INPUT', `${name} is a FIFO queue holding ${held} messages; SQS hands them out oldest first per group, so its newest cannot be peeked. Peek from earliest instead.`);
        }
      }
      // `limit` of the oldest, or up to 500 to find the newest among, since SQS hands out older ones first.
      const enough = from === 'earliest' ? limit : Math.max(limit, PEEK_COLLECT_MAX);
      const got = await collect(p, url, enough, Date.now() + PEEK_TIMEOUT_MS);
      return sqsMergePeek(got.map((m) => sqsMessage(name, m)), limit, from);
    }, destination),

  produce: (c, s, destination, message) =>
    guard(async () => {
      const p = pooled(c, s);
      const url = await queueUrl(p, destination);
      const fifo = sqsIsFifo(sqsQueueName(url));
      // The key is the message group, on FIFO queues and on standard ones (fair queues); FIFO queues need one.
      const groupId = message.groupId || message.key;
      if (fifo && !groupId) throw new QuiverError('INVALID_INPUT', `${destination} is a FIFO queue: give a groupId (or key)`);
      if (fifo && message.delaySeconds) throw new QuiverError('INVALID_INPUT', 'FIFO queues take no delay per message; set the queue delivery delay instead');
      const { MessageId } = await p.client.send(
        new SendMessageCommand({
          QueueUrl: url,
          MessageBody: message.body,
          MessageAttributes: sqsMessageAttributes(message.headers),
          MessageGroupId: groupId || undefined,
          MessageDeduplicationId: message.dedupId || undefined,
          DelaySeconds: message.delaySeconds,
        }),
      );
      return { id: MessageId ?? '' };
    }, destination),

  consume: (c, s, destination, { from }, onMessage, onEnd) =>
    guard(async () => {
      const p = pooled(c, s);
      const url = await queueUrl(p, destination);
      const name = sqsQueueName(url);
      const startedAt = Date.now();
      // The redrive limit, so the tail stops before its own receives move a message to the dead-letter queue.
      const redrive = sqsRedrive((await attributes(p, url, ['RedrivePolicy'])).RedrivePolicy);
      const abort = new AbortController();
      const seen = new Set<string>();
      const remember = (id: string) => {
        seen.add(id);
        if (seen.size > TAIL_SEEN_LIMIT) seen.delete(seen.values().next().value!);
      };
      const sentAt = (m: Message) => Number(m.Attributes?.SentTimestamp ?? 0);
      // From latest, what is already on the queue does not count: what a first look like a peek's sees (but not what
      // was sent while it long polled), and anything sent well before the tail started that the look missed.
      if (from === 'latest') {
        const there = await collect(p, url, PEEK_COLLECT_MAX, Date.now() + PEEK_TIMEOUT_MS);
        for (const m of there) if (m.MessageId && !(sentAt(m) >= startedAt)) remember(m.MessageId);
        const near = redrive && there.find((m) => sqsNearRedrive(receiveCount(m), redrive));
        if (near) throw nearRedriveError(destination, near, redrive);
      }
      let ended = false;
      const end = (error?: Error) => {
        if (ended) return;
        ended = true;
        abort.abort();
        onEnd(error);
      };
      void (async () => {
        let idle = TAIL_IDLE_MS;
        let retry = TAIL_RETRY_MS;
        while (!abort.signal.aborted) {
          let fresh = 0;
          let got = 0;
          const asked = Date.now();
          try {
            const { Messages = [] } = await receive(p, url, LONG_POLL_SECONDS, RECEIVE_MAX, abort.signal);
            retry = TAIL_RETRY_MS;
            got = Messages.length;
            for (const m of Messages) {
              if (!m.MessageId || seen.has(m.MessageId)) continue;
              remember(m.MessageId);
              const sent = sentAt(m);
              if (from === 'latest' && sent && sent < startedAt - TAIL_CLOCK_SKEW_MS) continue;
              fresh++;
              onMessage(sqsMessage(name, m));
            }
            // What this receive handed on is shown; the next one could move a message to the DLQ, so there is none.
            const near = redrive && Messages.find((m) => sqsNearRedrive(receiveCount(m), redrive));
            if (near) {
              end(nearRedriveError(destination, near, redrive));
              break;
            }
          } catch (err) {
            if (abort.signal.aborted) break;
            // Throttling, a network drop or an SQS hiccup is retried; a deleted queue or refused credentials end the tail.
            const e = quiverError(err, destination);
            if (e.code !== 'REQUEST_FAILED') {
              end(e);
              break;
            }
            await sleep(retry, abort.signal);
            retry = Math.min(retry * 2, TAIL_RETRY_MAX_MS);
            continue;
          }
          if (fresh) {
            idle = TAIL_IDLE_MS;
          } else if (got) {
            // Only messages already handed on: SQS will give them straight back, and each receive counts.
            await sleep(idle, abort.signal);
            idle = Math.min(idle * 2, TAIL_IDLE_MAX_MS);
          } else {
            // An empty long poll waited on its own; one that came back at once (an endpoint ignoring the wait) waits here.
            idle = TAIL_IDLE_MS;
            if (Date.now() - asked < TAIL_IDLE_MS) await sleep(TAIL_IDLE_MS, abort.signal);
          }
        }
      })();
      return { stop: async () => end() };
    }, destination),

  purge: (c, s, destination) =>
    guard(async () => {
      const p = pooled(c, s);
      // SQS allows one purge per queue a minute; a second within it is CONFLICT.
      await p.client.send(new PurgeQueueCommand({ QueueUrl: await queueUrl(p, destination) }));
    }, destination),

  create: (c, s, destination, { fifo }) =>
    guard(async () => {
      const p = pooled(c, s);
      const named = destination.endsWith('.fifo');
      if (fifo && !named) throw new QuiverError('INVALID_INPUT', `A FIFO queue's name ends in .fifo: ${destination}.fifo`);
      if (fifo === false && named) throw new QuiverError('INVALID_INPUT', 'Only FIFO queues may have a name ending in .fifo');
      // CreateQueue answers with the existing queue when the settings match, so an existing name is checked first,
      // with SQS rather than the URL cache, which still holds a queue deleted outside Quiver.
      const exists = await p.client.send(new GetQueueUrlCommand({ QueueName: destination })).then(
        (r) => Boolean(r.QueueUrl),
        (err: { name?: string }) => {
          if (NOT_FOUND.has(err.name ?? '')) return false;
          throw err;
        },
      );
      if (exists) throw new QuiverError('CONFLICT', `Queue ${destination} already exists`);
      const { QueueUrl } = await p.client.send(new CreateQueueCommand({ QueueName: destination, Attributes: named ? { FifoQueue: 'true' } : undefined }));
      if (QueueUrl) p.urls.set(destination, QueueUrl);
    }, destination),

  remove: (c, s, destination) =>
    guard(async () => {
      const p = pooled(c, s);
      const url = await queueUrl(p, destination);
      await p.client.send(new DeleteQueueCommand({ QueueUrl: url }));
      p.urls.delete(sqsQueueName(url));
      p.urls.delete(destination);
    }, destination),

  close: async (connectionId) => {
    const p = pool.get(connectionId);
    if (!p) return;
    pool.delete(connectionId);
    p.client.destroy();
  },
};

/** Close every pooled client, when the app quits. */
export async function sqsCloseAll(): Promise<void> {
  for (const p of pool.values()) p.client.destroy();
  pool.clear();
}
