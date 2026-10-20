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
  type QueueAttributeName,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';
import { QuiverError, sqsDestination, sqsIsFifo, sqsMergePeek, sqsMessage, sqsMessageAttributes, sqsQueueName, SQS_LIST_ATTRIBUTES, type QueueConnection, type QueueDriver, type QueueMessage, type QueueSecrets } from '@quiver/core';

// SQS through @aws-sdk/client-sqs. One client is pooled per connection and rebuilt when its region, endpoint,
// profile or key change; queue URLs are cached on it by name. SQS has no way to look at a message without
// receiving it, so peeks and tails receive with a visibility timeout of 0: the message stays visible to every
// other consumer and nothing is deleted, but each receive counts towards its receive count (and so a redrive
// policy's maxReceiveCount). Tails never delete either, like Kafka's throwaway groups and the memory broker.

const CONNECT_TIMEOUT_MS = 5000;
/** Longer than the 20 second long poll a tail waits in. */
const REQUEST_TIMEOUT_MS = 30_000;
const LONG_POLL_SECONDS = 20;
/** SQS hands back at most this many messages per receive. */
const RECEIVE_MAX = 10;
/** How long a peek keeps receiving before it settles for what it has. */
const PEEK_TIMEOUT_MS = 10_000;
/** The most a peek for the newest messages collects before it picks them, since SQS hands out the oldest first. */
const PEEK_COLLECT_MAX = 500;
/** A peek stops after this many receives in a row bring nothing it has not seen. */
const PEEK_STALE_ROUNDS = 2;
/** A tail whose receive brought nothing new waits this long before the next, since unconsumed messages come straight back. */
const TAIL_IDLE_MS = 1000;
/** A tail from `latest` treats anything sent this long before it started as already there, whatever the clocks say. */
const TAIL_CLOCK_SKEW_MS = 60_000;
/** Message ids a tail remembers, so messages it does not consume are not handed on twice. */
const TAIL_SEEN_LIMIT = 10_000;
/** Queues described at once while listing. */
const LIST_CONCURRENCY = 8;

interface Pooled {
  key: string;
  client: SQSClient;
  /** Queue URL by name, as GetQueueUrl or ListQueues answered. */
  urls: Map<string, string>;
}

const pool = new Map<string, Pooled>();

function config(c: QueueConnection, s: QueueSecrets): SQSClientConfig {
  const endpoint = c.endpoint.trim();
  const region = c.region.trim() || (endpoint ? 'us-east-1' : '');
  if (!region) throw new QuiverError('INVALID_INPUT', 'The connection has no region; set one such as eu-west-1');
  const out: SQSClientConfig = {
    region,
    endpoint: endpoint || undefined,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
  };
  const accessKeyId = c.accessKeyId.trim();
  if (accessKeyId) {
    if (!s.secretAccessKey) throw new QuiverError('INVALID_INPUT', `Access key ${accessKeyId} needs its secret: store it as the secret secretAccessKey`);
    out.credentials = { accessKeyId, secretAccessKey: s.secretAccessKey };
  } else if (c.profile.trim()) {
    out.profile = c.profile.trim();
  }
  // With neither, the SDK's default chain applies: environment variables, the default profile, SSO or an instance role.
  return out;
}

function pooled(c: QueueConnection, s: QueueSecrets): Pooled {
  const key = JSON.stringify([c.region, c.endpoint, c.profile, c.accessKeyId, s.secretAccessKey ?? '']);
  const existing = pool.get(c.id);
  if (existing?.key === key) return existing;
  existing?.client.destroy();
  const p: Pooled = { key, client: new SQSClient(config(c, s)), urls: new Map() };
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
function fail(err: unknown, destination?: string): never {
  if (err instanceof QuiverError) throw err;
  const e = err as { name?: string; message?: string };
  const name = e.name ?? '';
  const message = e.message || String(err);
  if (NOT_FOUND.has(name)) throw new QuiverError('NOT_FOUND', destination ? `Queue ${destination} not found` : message);
  if (CONFLICT.has(name)) throw new QuiverError('CONFLICT', message);
  if (AUTH.has(name)) throw new QuiverError('AUTH_FAILED', message);
  if (INVALID.has(name)) throw new QuiverError('INVALID_INPUT', message);
  throw new QuiverError('REQUEST_FAILED', message);
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
  if (/^https?:\/\//.test(destination)) return destination;
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

async function listUrls(p: Pooled): Promise<string[]> {
  const urls: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await p.client.send(new ListQueuesCommand({ MaxResults: 1000, NextToken }));
    urls.push(...(page.QueueUrls ?? []));
    NextToken = page.NextToken;
  } while (NextToken);
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

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

export const sqsDriver: QueueDriver = {
  kind: 'sqs',

  test: async (c, s) => {
    // A fresh client, so testing a draft does not disturb the pool.
    let client: SQSClient | null = null;
    try {
      const cfg = config(c, s);
      client = new SQSClient({ ...cfg, maxAttempts: 1 });
      const page = await client.send(new ListQueuesCommand({ MaxResults: 1000 }));
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
      const seen = new Map<string, QueueMessage>();
      const deadline = Date.now() + PEEK_TIMEOUT_MS;
      // SQS hands back a sample of at most ten per receive, oldest first, so a peek receives until it has enough
      // (`limit` of the oldest, or up to 500 to find the newest among) or two receives in a row bring nothing new.
      // The first waits a second, which makes SQS look at every server rather than a sample.
      const enough = from === 'earliest' ? limit : Math.max(limit, PEEK_COLLECT_MAX);
      let stale = 0;
      for (let round = 0; seen.size < enough && stale < PEEK_STALE_ROUNDS && Date.now() < deadline; round++) {
        const { Messages = [] } = await receive(p, url, round === 0 ? 1 : 0, enough - seen.size);
        let fresh = 0;
        for (const m of Messages) {
          if (!m.MessageId || seen.has(m.MessageId)) continue;
          seen.set(m.MessageId, sqsMessage(name, m));
          fresh++;
        }
        stale = fresh ? 0 : stale + 1;
      }
      return sqsMergePeek([...seen.values()], limit, from);
    }, destination),

  produce: (c, s, destination, message) =>
    guard(async () => {
      const p = pooled(c, s);
      const url = await queueUrl(p, destination);
      const fifo = sqsIsFifo(sqsQueueName(url));
      // The key is the message group, on FIFO queues and on standard ones (fair queues); FIFO queues need one.
      const groupId = message.groupId ?? message.key;
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
      const abort = new AbortController();
      const seen = new Set<string>();
      const remember = (id: string) => {
        seen.add(id);
        if (seen.size > TAIL_SEEN_LIMIT) seen.delete(seen.values().next().value!);
      };
      // From latest, what is already on the queue does not count: what a first look sees, and anything sent well before.
      if (from === 'latest') {
        const { Messages = [] } = await receive(p, url, 0, RECEIVE_MAX);
        for (const m of Messages) if (m.MessageId) remember(m.MessageId);
      }
      let ended = false;
      const end = (error?: Error) => {
        if (ended) return;
        ended = true;
        abort.abort();
        onEnd(error);
      };
      void (async () => {
        while (!abort.signal.aborted) {
          let fresh = 0;
          try {
            const { Messages = [] } = await receive(p, url, LONG_POLL_SECONDS, RECEIVE_MAX, abort.signal);
            for (const m of Messages) {
              if (!m.MessageId || seen.has(m.MessageId)) continue;
              remember(m.MessageId);
              const sent = Number(m.Attributes?.SentTimestamp ?? 0);
              if (from === 'latest' && sent && sent < startedAt - TAIL_CLOCK_SKEW_MS) continue;
              fresh++;
              onMessage(sqsMessage(name, m));
            }
          } catch (err) {
            if (abort.signal.aborted) break;
            // A queue deleted under the tail, or credentials that stopped working, end it with the reason.
            try {
              fail(err, destination);
            } catch (e) {
              end(e as Error);
            }
            break;
          }
          if (!fresh) await sleep(TAIL_IDLE_MS, abort.signal);
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
      // CreateQueue answers with the existing queue when the settings match, so an existing name is checked first.
      const exists = await queueUrl(p, destination).then(
        () => true,
        (err: { name?: string }) => {
          if (err instanceof QuiverError || NOT_FOUND.has(err.name ?? '')) return false;
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
