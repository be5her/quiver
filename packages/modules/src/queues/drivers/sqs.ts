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
  sqsCollectStop,
  sqsDestination,
  sqsErrorCode,
  sqsIsFifo,
  sqsMergePeek,
  sqsMessage,
  sqsMessageAttributes,
  sqsNearRedrive,
  sqsQueueName,
  sqsQueueOrigins,
  sqsRedrive,
  sqsRegion,
  sqsRetryable,
  sqsSecretBinding,
  SQS_LIST_ATTRIBUTES,
  SQS_SECRET_BINDING,
  type QueueConnection,
  type QueueDriver,
  type QueueSecrets,
  type SqsFailure,
  type SqsRedrive,
} from '@quiver/core';

// SQS through @aws-sdk/client-sqs. One client is pooled per connection and rebuilt when its region, endpoint,
// profile or key change; queue URLs are cached on it by name. SQS has no way to look at a message without
// receiving it, so peeks and tails receive with a visibility timeout of 0: the message stays visible to every
// other consumer and nothing is deleted, but each receive counts towards its receive count (and so a redrive
// policy's maxReceiveCount). Peeks therefore receive each message about once and stop before a round that could
// receive one past the limit, tails back off while SQS keeps handing back what they have seen and stop one receive
// short of the DLQ, and the commands make all of them mutating for agents. Tails never delete either, like
// Kafka's throwaway groups and the memory broker.

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
  /** Origins a queue URL given as the destination may have: the endpoint, SQS's own hosts in the region, and the hosts of the queue URLs SQS answered with. */
  origins: Set<string>;
  /** Aborted when the client is replaced or closed, with the reason, so the tails on it end rather than go on with old keys or an old host. */
  retired: AbortController;
}

const pool = new Map<string, Pooled>();

function regionOf(c: QueueConnection): string {
  const region = sqsRegion(c.region, c.endpoint);
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
    // The key stays with the endpoint and region it was stored for: a pulled commit that points the connection
    // elsewhere does not take the key (or its session token) along.
    const bound = s[SQS_SECRET_BINDING];
    if (bound && bound !== sqsSecretBinding(c)) {
      throw new QuiverError('AUTH_FAILED', `The secret of access key ${accessKeyId} was stored for ${bound} and the connection now points at ${sqsSecretBinding(c)}; re-enter the secret for the new endpoint`);
    }
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

function pooled(c: QueueConnection, s: QueueSecrets): Pooled {
  const key = JSON.stringify([c.region, c.endpoint, c.profile, c.accessKeyId, s.secretAccessKey ?? '', s.sessionToken ?? '', s[SQS_SECRET_BINDING] ?? '']);
  const existing = pool.get(c.id);
  if (existing?.key === key) return existing;
  // Settings that are refused leave the pooled client (and the tails on it) as they were.
  const cfg = config(c, s);
  // A destroyed v3 client still sends, so the tails holding it are told to end.
  if (existing) retire(existing, new QuiverError('CONFLICT', 'The connection changed; start the tail again'));
  const p: Pooled = { key, client: new SQSClient(cfg), urls: new Map(), origins: new Set(sqsQueueOrigins(c.endpoint, regionOf(c))), retired: new AbortController() };
  pool.set(c.id, p);
  return p;
}

function retire(p: Pooled, reason: QuiverError): void {
  p.retired.abort(reason);
  p.client.destroy();
}

/** Remember the host of a queue URL SQS answered with, so the URL is taken as a destination too. */
function rememberUrl(p: Pooled, url: string): void {
  p.urls.set(sqsQueueName(url), url);
  try {
    p.origins.add(new URL(url).origin);
  } catch {
    // Not a URL: only its name is kept.
  }
}

/** AWS errors as Quiver errors: a missing queue is NOT_FOUND, an existing one CONFLICT, refused credentials AUTH_FAILED. */
function quiverError(err: unknown, destination?: string): QuiverError {
  if (err instanceof QuiverError) return err;
  const e = err as { name?: string; message?: string };
  const code = sqsErrorCode(e.name ?? '');
  const message = e.message || String(err);
  return new QuiverError(code, code === 'NOT_FOUND' && destination ? `Queue ${destination} not found` : message);
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
  rememberUrl(p, QueueUrl);
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
  for (const url of urls) rememberUrl(p, url);
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

const receiveCount = (m: Message) => Number(m.Attributes?.ApproximateReceiveCount ?? 0);

/** What a queue's peek or tail reads before it receives: the redrive limit, and how many messages are visible. */
async function receiveLimits(p: Pooled, url: string): Promise<{ redrive: SqsRedrive | null; visible?: number }> {
  const a = await attributes(p, url, ['RedrivePolicy', 'ApproximateNumberOfMessages']);
  const visible = a.ApproximateNumberOfMessages === undefined ? NaN : Number(a.ApproximateNumberOfMessages);
  return { redrive: sqsRedrive(a.RedrivePolicy), visible: Number.isFinite(visible) ? visible : undefined };
}

/**
 * Receive as a peek does: rounds of up to ten, each long polling a second so SQS looks at every server, until
 * `enough` are seen, a round brings nothing, as many as the queue held are seen, three rounds in a row bring
 * nothing new (SQS keeps handing back the same ones; one round on a queue with a redrive policy), or the deadline
 * (`sqsCollectStop`). A short round goes on: SQS often hands back fewer than asked with more waiting. Each message
 * is received about once, but a later round can hand back one already seen, so once any message seen is one receive
 * short of the redrive limit no further round is made, and it comes back as `near`.
 */
async function collect(p: Pooled, url: string, enough: number, deadline: number, redrive: SqsRedrive | null, visible?: number): Promise<{ messages: Message[]; near?: Message }> {
  const seen = new Map<string, Message>();
  let near: Message | undefined;
  let stale = 0;
  for (;;) {
    const { Messages = [] } = await receive(p, url, 1, Math.min(RECEIVE_MAX, enough - seen.size));
    let fresh = 0;
    for (const m of Messages) {
      if (!m.MessageId) continue;
      if (!seen.has(m.MessageId)) fresh++;
      // The latest copy, with the receive count this round left it at.
      seen.set(m.MessageId, m);
      if (!near && sqsNearRedrive(receiveCount(m), redrive)) near = m;
    }
    stale = fresh ? 0 : stale + 1;
    if (sqsCollectStop({ seen: seen.size, enough, visible, got: Messages.length, stale, redrive: Boolean(redrive), nearRedrive: Boolean(near) }) || Date.now() >= deadline) break;
  }
  return { messages: [...seen.values()], near };
}

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
      // The redrive limit, so the peek stops before its own rounds move a message to the dead-letter queue.
      const { redrive, visible } = await receiveLimits(p, url);
      // A FIFO queue hands out each group from its oldest message, and at visibility 0 those stay first in line, so
      // past ten messages the newest are never handed out: refused before receiving anything, rather than answered
      // with the oldest as though they were the newest.
      if (from === 'latest' && sqsIsFifo(name) && (visible ?? 0) > RECEIVE_MAX) {
        throw new QuiverError('INVALID_INPUT', `${name} is a FIFO queue holding ${visible} messages; SQS hands them out oldest first per group, so its newest cannot be peeked. Peek from earliest instead.`);
      }
      // `limit` of the oldest, or up to 500 to find the newest among, since SQS hands out older ones first.
      const enough = from === 'earliest' ? limit : Math.max(limit, PEEK_COLLECT_MAX);
      const { messages } = await collect(p, url, enough, Date.now() + PEEK_TIMEOUT_MS, redrive, visible);
      return sqsMergePeek(messages.map((m) => sqsMessage(name, m)), limit, from);
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
      const { redrive, visible } = await receiveLimits(p, url);
      const abort = new AbortController();
      const seen = new Set<string>();
      const remember = (id: string) => {
        seen.add(id);
        if (seen.size > TAIL_SEEN_LIMIT) seen.delete(seen.values().next().value!);
      };
      const sentAt = (m: Message) => Number(m.Attributes?.SentTimestamp ?? 0);
      // From latest, what is already on the queue does not count: what a first look like a peek's sees (but not what
      // was sent while it long polled), and anything sent well before the tail started that the look missed.
      // The look stops before a round that could receive a message past the limit, and the tail does not start.
      if (from === 'latest') {
        const { messages: there, near } = await collect(p, url, PEEK_COLLECT_MAX, Date.now() + PEEK_TIMEOUT_MS, redrive, visible);
        if (near && redrive) throw nearRedriveError(destination, near, redrive);
        for (const m of there) if (m.MessageId && !(sentAt(m) >= startedAt)) remember(m.MessageId);
      }
      let ended = false;
      const end = (error?: Error) => {
        if (ended) return;
        ended = true;
        abort.abort();
        p.retired.signal.removeEventListener('abort', onRetired);
        onEnd(error);
      };
      // The pooled client was replaced (the connection's settings or keys changed) or closed: this tail would go on
      // sending with the old keys to the old host, so it ends.
      const onRetired = () => end(p.retired.signal.reason as Error);
      if (p.retired.signal.aborted) throw p.retired.signal.reason;
      p.retired.signal.addEventListener('abort', onRetired, { once: true });
      void (async () => {
        let idle = TAIL_IDLE_MS;
        let retry = TAIL_RETRY_MS;
        while (!abort.signal.aborted) {
          if (pool.get(c.id) !== p) {
            end(new QuiverError('CONFLICT', 'The connection changed; start the tail again'));
            break;
          }
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
            // Throttling, a network drop or an SQS hiccup is retried; a deleted queue, refused or expired credentials,
            // an unusable KMS key or any other answer that would come again ends the tail.
            if (!sqsRetryable(err as SqsFailure)) {
              end(quiverError(err, destination));
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
          if (sqsErrorCode(err.name ?? '') === 'NOT_FOUND') return false;
          throw err;
        },
      );
      if (exists) throw new QuiverError('CONFLICT', `Queue ${destination} already exists`);
      const { QueueUrl } = await p.client.send(new CreateQueueCommand({ QueueName: destination, Attributes: named ? { FifoQueue: 'true' } : undefined }));
      if (QueueUrl) rememberUrl(p, QueueUrl);
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
    retire(p, new QuiverError('CONFLICT', 'The connection was closed'));
  },
};

/** Close every pooled client, when the app quits. */
export async function sqsCloseAll(): Promise<void> {
  for (const p of pool.values()) retire(p, new QuiverError('CONFLICT', 'Quiver is quitting'));
  pool.clear();
}
