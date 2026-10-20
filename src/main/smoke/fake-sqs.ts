import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A fake of the SQS JSON protocol (AWS JSON 1.0, `X-Amz-Target: AmazonSQS.<Operation>`), covering what the SQS
// driver calls: queues with attributes, FIFO groups and deduplication, delays, visibility timeouts, long polling
// and purge. It checks the access key id in the signature, not the signature itself.

const ACCOUNT = '000000000000';
const DEFAULT_VISIBILITY_S = 30;

interface FakeMessage {
  id: string;
  body: string;
  attributes: Record<string, { DataType: string; StringValue?: string; BinaryValue?: string }>;
  sentAt: number;
  /** When it can next be received: later than now while delayed or in flight. */
  visibleAt: number;
  received: number;
  firstReceivedAt: number;
  groupId?: string;
  dedupId?: string;
  sequence?: string;
}

interface FakeQueue {
  name: string;
  attributes: Record<string, string>;
  messages: FakeMessage[];
  createdAt: number;
  lastPurge: number;
  /** FIFO deduplication ids sent in the last five minutes, with the message id they made. */
  dedup: Map<string, { id: string; at: number; sequence?: string }>;
  /** Long polls waiting for a message. */
  waiters: Set<() => void>;
}

export interface FakeSqs {
  /** The endpoint to give the connection. */
  url: string;
  /** The key pair the fake accepts; requests signed with another access key id are refused. */
  accessKeyId: string;
  secretAccessKey: string;
  /** Also accepted, as an AWS profile would hand it out. */
  profileKeyId: string;
  /** What the driver did: operations by name, the visibility timeouts its receives asked for, the access key ids it signed with. */
  seen: { ops: string[]; visibility: (number | undefined)[]; keys: string[] };
  /** Make a queue directly, with attributes (a redrive policy, say) the driver does not set. */
  addQueue(name: string, attributes?: Record<string, string>): string;
  setAttributes(name: string, attributes: Record<string, string>): void;
  /** The messages a queue holds, received or not. */
  messages(name: string): FakeMessage[];
  close(): Promise<void>;
}

class SqsError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly queryCode = `AWS.SimpleQueueService.${type}`,
  ) {
    super(message);
  }
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

export async function startFakeSqs(): Promise<FakeSqs> {
  const queues = new Map<string, FakeQueue>();
  const seen: FakeSqs['seen'] = { ops: [], visibility: [], keys: [] };
  const keys = { accessKeyId: 'AKIDSMOKESQS', secretAccessKey: 'sqs-smoke-secret', profileKeyId: 'AKIDSMOKEPROFILE' };
  let base = '';
  let sequence = 0;

  const urlOf = (name: string) => `${base}/${ACCOUNT}/${name}`;
  const arnOf = (name: string) => `arn:aws:sqs:us-east-1:${ACCOUNT}:${name}`;

  function addQueue(name: string, attributes: Record<string, string> = {}): string {
    if (!queues.has(name)) {
      const now = Date.now();
      queues.set(name, { name, attributes: { VisibilityTimeout: String(DEFAULT_VISIBILITY_S), ...attributes }, messages: [], createdAt: now, lastPurge: 0, dedup: new Map(), waiters: new Set() });
    }
    return urlOf(name);
  }

  function queueOf(url: unknown): FakeQueue {
    const name = String(url ?? '').split('/').pop() ?? '';
    const q = queues.get(name);
    if (!q) throw new SqsError('QueueDoesNotExist', 'The specified queue does not exist.', 'AWS.SimpleQueueService.NonExistentQueue');
    return q;
  }

  const fifo = (q: FakeQueue) => q.attributes.FifoQueue === 'true';

  function counts(q: FakeQueue) {
    const now = Date.now();
    let visible = 0;
    let inFlight = 0;
    let delayed = 0;
    for (const m of q.messages) {
      if (m.visibleAt <= now) visible++;
      else if (m.received) inFlight++;
      else delayed++;
    }
    return { visible, inFlight, delayed };
  }

  function attributesOf(q: FakeQueue, names: string[]): Record<string, string> {
    const c = counts(q);
    const all: Record<string, string> = {
      ...q.attributes,
      QueueArn: arnOf(q.name),
      ApproximateNumberOfMessages: String(c.visible),
      ApproximateNumberOfMessagesNotVisible: String(c.inFlight),
      ApproximateNumberOfMessagesDelayed: String(c.delayed),
      CreatedTimestamp: String(Math.floor(q.createdAt / 1000)),
      LastModifiedTimestamp: String(Math.floor(q.createdAt / 1000)),
    };
    if (names.includes('All')) return all;
    return Object.fromEntries(Object.entries(all).filter(([k]) => names.includes(k)));
  }

  function take(q: FakeQueue, max: number, visibility: number): FakeMessage[] {
    const now = Date.now();
    const out: FakeMessage[] = [];
    // FIFO: a group with a message in flight hands out nothing until it is back.
    const blocked = new Set(fifo(q) ? q.messages.filter((m) => m.visibleAt > now && m.received).map((m) => m.groupId) : []);
    for (const m of q.messages) {
      if (out.length >= max) break;
      if (m.visibleAt > now || blocked.has(m.groupId)) continue;
      m.received++;
      if (!m.firstReceivedAt) m.firstReceivedAt = now;
      m.visibleAt = now + visibility * 1000;
      out.push(m);
    }
    return out;
  }

  function wire(m: FakeMessage) {
    const attributes: Record<string, string> = {
      SentTimestamp: String(m.sentAt),
      ApproximateReceiveCount: String(m.received),
      ApproximateFirstReceiveTimestamp: String(m.firstReceivedAt),
      SenderId: 'AIDASMOKE',
    };
    if (m.groupId) attributes.MessageGroupId = m.groupId;
    if (m.dedupId) attributes.MessageDeduplicationId = m.dedupId;
    if (m.sequence) attributes.SequenceNumber = m.sequence;
    return { MessageId: m.id, ReceiptHandle: `${m.id}#${m.received}`, MD5OfBody: md5(m.body), Body: m.body, Attributes: attributes, MessageAttributes: Object.keys(m.attributes).length ? m.attributes : undefined };
  }

  type Input = Record<string, unknown>;
  const ops: Record<string, (input: Input, req: IncomingMessage) => unknown> = {
    ListQueues: (input) => {
      const prefix = String(input.QueueNamePrefix ?? '');
      return { QueueUrls: [...queues.keys()].filter((n) => n.startsWith(prefix)).map(urlOf) };
    },
    GetQueueUrl: (input) => ({ QueueUrl: urlOf(queueOf(urlOf(String(input.QueueName))).name) }),
    GetQueueAttributes: (input) => ({ Attributes: attributesOf(queueOf(input.QueueUrl), (input.AttributeNames as string[] | undefined) ?? []) }),
    ListDeadLetterSourceQueues: (input) => {
      const arn = arnOf(queueOf(input.QueueUrl).name);
      const sources = [...queues.values()].filter((q) => q.attributes.RedrivePolicy?.includes(`"${arn}"`)).map((q) => urlOf(q.name));
      return { queueUrls: sources };
    },
    CreateQueue: (input) => {
      const name = String(input.QueueName);
      const attributes = (input.Attributes as Record<string, string> | undefined) ?? {};
      if (name.endsWith('.fifo') !== (attributes.FifoQueue === 'true')) throw new SqsError('InvalidParameterValue', 'The name of a FIFO queue can only include alphanumeric characters, hyphens, or underscores, must end with .fifo suffix.', 'InvalidParameterValue');
      const existing = queues.get(name);
      if (existing && Object.entries(attributes).some(([k, v]) => existing.attributes[k] !== v)) throw new SqsError('QueueAlreadyExists', `A queue already exists with the same name and a different value for attribute(s)`, 'QueueAlreadyExists');
      return { QueueUrl: addQueue(name, attributes) };
    },
    DeleteQueue: (input) => {
      const q = queueOf(input.QueueUrl);
      queues.delete(q.name);
      for (const w of q.waiters) w();
      return {};
    },
    PurgeQueue: (input) => {
      const q = queueOf(input.QueueUrl);
      if (Date.now() - q.lastPurge < 60_000) throw new SqsError('PurgeQueueInProgress', `Only one PurgeQueue operation on ${q.name} is allowed every 60 seconds.`);
      q.lastPurge = Date.now();
      q.messages = [];
      return {};
    },
    SendMessage: (input) => {
      const q = queueOf(input.QueueUrl);
      const body = String(input.MessageBody ?? '');
      const groupId = input.MessageGroupId as string | undefined;
      let dedupId = input.MessageDeduplicationId as string | undefined;
      const delay = Number(input.DelaySeconds ?? q.attributes.DelaySeconds ?? 0);
      if (fifo(q)) {
        if (!groupId) throw new SqsError('MissingParameter', 'The request must contain the parameter MessageGroupId.', 'MissingParameter');
        if (input.DelaySeconds !== undefined && Number(input.DelaySeconds) > 0) throw new SqsError('InvalidParameterValue', 'Value for parameter DelaySeconds is invalid. Reason: The request include parameter that is not valid for this queue type.', 'InvalidParameterValue');
        if (!dedupId && q.attributes.ContentBasedDeduplication === 'true') dedupId = createHash('sha256').update(body).digest('hex');
        if (!dedupId) throw new SqsError('InvalidParameterValue', 'The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly', 'InvalidParameterValue');
        const prior = q.dedup.get(dedupId);
        if (prior && Date.now() - prior.at < 300_000) return { MessageId: prior.id, MD5OfMessageBody: md5(body), SequenceNumber: prior.sequence };
      }
      for (const [k, v] of Object.entries((input.MessageAttributes as FakeMessage['attributes'] | undefined) ?? {})) {
        if (!v.StringValue && !v.BinaryValue) throw new SqsError('InvalidParameterValue', `Message attribute '${k}' must contain a non-empty value of type '${v.DataType}'.`, 'InvalidParameterValue');
      }
      const now = Date.now();
      const m: FakeMessage = {
        id: randomUUID(),
        body,
        attributes: (input.MessageAttributes as FakeMessage['attributes'] | undefined) ?? {},
        sentAt: now,
        visibleAt: now + delay * 1000,
        received: 0,
        firstReceivedAt: 0,
        groupId,
        dedupId: fifo(q) ? dedupId : undefined,
        sequence: fifo(q) ? String(18_000_000_000_000_000_000n + BigInt(++sequence)) : undefined,
      };
      q.messages.push(m);
      if (m.dedupId) q.dedup.set(m.dedupId, { id: m.id, at: now, sequence: m.sequence });
      for (const w of q.waiters) w();
      return { MessageId: m.id, MD5OfMessageBody: md5(body), SequenceNumber: m.sequence };
    },
    ReceiveMessage: async (input, req) => {
      const q = queueOf(input.QueueUrl);
      const max = Number(input.MaxNumberOfMessages ?? 1);
      const visibility = input.VisibilityTimeout === undefined ? Number(q.attributes.VisibilityTimeout) : Number(input.VisibilityTimeout);
      seen.visibility.push(input.VisibilityTimeout as number | undefined);
      const wait = Number(input.WaitTimeSeconds ?? q.attributes.ReceiveMessageWaitTimeSeconds ?? 0);
      let got = take(q, max, visibility);
      if (!got.length && wait > 0) {
        // Long poll: until a message arrives, the wait ends, the queue goes or the client hangs up.
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            q.waiters.delete(done);
            req.socket.off('close', done);
            resolve();
          };
          const timer = setTimeout(done, wait * 1000);
          q.waiters.add(done);
          req.socket.once('close', done);
        });
        if (!queues.has(q.name)) throw new SqsError('QueueDoesNotExist', 'The specified queue does not exist.', 'AWS.SimpleQueueService.NonExistentQueue');
        got = take(q, max, visibility);
      }
      return got.length ? { Messages: got.map(wire) } : {};
    },
    DeleteMessage: (input) => {
      const q = queueOf(input.QueueUrl);
      const id = String(input.ReceiptHandle ?? '').split('#')[0];
      q.messages = q.messages.filter((m) => m.id !== id);
      return {};
    },
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        if (res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/x-amz-json-1.0', ...headers });
        res.end(JSON.stringify(body));
      };
      const target = String(req.headers['x-amz-target'] ?? '');
      const op = target.startsWith('AmazonSQS.') ? target.slice('AmazonSQS.'.length) : '';
      try {
        const key = /Credential=([^/]+)\//.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
        seen.keys.push(key);
        if (key !== keys.accessKeyId && key !== keys.profileKeyId) throw new SqsError('InvalidClientTokenId', 'The security token included in the request is invalid.', 'InvalidClientTokenId');
        const handler = ops[op];
        if (!handler) throw new SqsError('UnsupportedOperation', `The fake does not do ${op || 'that'}`, 'AWS.SimpleQueueService.UnsupportedOperation');
        seen.ops.push(op);
        const input = (chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) as Input;
        send(200, await handler(input, req));
      } catch (err) {
        const e = err instanceof SqsError ? err : new SqsError('InternalError', (err as Error).message, 'InternalError');
        send(e.type === 'InternalError' ? 500 : 400, { __type: `com.amazonaws.sqs#${e.type}`, message: e.message }, { 'x-amzn-query-error': `${e.queryCode};Sender` });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    ...keys,
    seen,
    addQueue,
    setAttributes: (name, attributes) => Object.assign(queueOf(urlOf(name)).attributes, attributes),
    messages: (name) => queueOf(urlOf(name)).messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const q of queues.values()) for (const w of q.waiters) w();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
