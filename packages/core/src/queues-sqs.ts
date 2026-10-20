import type { QueueDestination, QueueMessage } from './models/queues';

// Shaping for the SQS driver, kept apart from the AWS SDK so it can be tested without a queue. SQS hands
// everything back as strings: attributes by name, message attributes as typed values, timestamps in epoch ms.

/** The attributes a listing asks for per queue: enough for the counts, FIFO and the DLQ. */
export const SQS_LIST_ATTRIBUTES = ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed', 'FifoQueue', 'RedrivePolicy'] as const;

/** The queue name from a queue URL (`https://sqs.eu-west-1.amazonaws.com/123456789012/orders`) or an ARN. */
export function sqsQueueName(urlOrArn: string): string {
  const s = urlOrArn.replace(/\/+$/, '');
  if (s.startsWith('arn:')) return s.split(':').pop() ?? s;
  return s.split('/').pop() ?? s;
}

/** True when the queue is FIFO: by its attribute when there is one, else by the `.fifo` name SQS requires of them. */
export function sqsIsFifo(name: string, attributes?: Record<string, string>): boolean {
  if (attributes?.FifoQueue !== undefined) return attributes.FifoQueue === 'true';
  return name.endsWith('.fifo');
}

export interface SqsRedrive {
  /** The dead-letter queue's name and ARN. */
  deadLetterQueue: string;
  deadLetterArn: string;
  maxReceiveCount: number;
}

/** The `RedrivePolicy` attribute, which is JSON in a string; null when there is none or it does not parse. */
export function sqsRedrive(policy: string | undefined): SqsRedrive | null {
  if (!policy) return null;
  try {
    const p = JSON.parse(policy) as { deadLetterTargetArn?: string; maxReceiveCount?: number | string };
    if (!p.deadLetterTargetArn) return null;
    return { deadLetterQueue: sqsQueueName(p.deadLetterTargetArn), deadLetterArn: p.deadLetterTargetArn, maxReceiveCount: Number(p.maxReceiveCount ?? 0) };
  } catch {
    return null;
  }
}

const count = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const seconds = (v: string | undefined): string | undefined => {
  const n = count(v);
  if (n === undefined) return undefined;
  if (n >= 86_400 && n % 86_400 === 0) return `${n / 86_400} d`;
  if (n >= 3600 && n % 3600 === 0) return `${n / 3600} h`;
  if (n >= 60 && n % 60 === 0) return `${n / 60} min`;
  return `${n} s`;
};

const epoch = (v: string | undefined, unit: 's' | 'ms'): string | undefined => {
  const n = count(v);
  if (n === undefined || n <= 0) return undefined;
  return new Date(unit === 's' ? n * 1000 : n).toISOString();
};

/**
 * A queue as a destination: `messages` is the approximate number visible, and the details carry what is in
 * flight or delayed, FIFO settings, the dead-letter queue and the other settings worth showing, in that order.
 */
export function sqsDestination(name: string, attributes: Record<string, string>, extra: Record<string, string> = {}): QueueDestination {
  const a = attributes;
  const fifo = sqsIsFifo(name, a);
  const details: Record<string, string> = {};
  const put = (label: string, value: string | undefined) => {
    if (value !== undefined && value !== '') details[label] = value;
  };
  put('url', extra.url);
  put('in flight', a.ApproximateNumberOfMessagesNotVisible);
  put('delayed', a.ApproximateNumberOfMessagesDelayed);
  if (fifo) {
    put('content-based deduplication', a.ContentBasedDeduplication);
    put('deduplication scope', a.DeduplicationScope);
    put('throughput limit', a.FifoThroughputLimit);
  }
  const redrive = sqsRedrive(a.RedrivePolicy);
  if (redrive) {
    details['dead-letter queue'] = redrive.deadLetterQueue;
    details['max receive count'] = String(redrive.maxReceiveCount);
  }
  put('dead-letter source queues', extra.sources);
  if (a.RedriveAllowPolicy) {
    try {
      const p = JSON.parse(a.RedriveAllowPolicy) as { redrivePermission?: string; sourceQueueArns?: string[] };
      put('redrive allowed', p.redrivePermission === 'byQueue' ? (p.sourceQueueArns ?? []).map(sqsQueueName).join(', ') : p.redrivePermission);
    } catch {
      put('redrive allowed', a.RedriveAllowPolicy);
    }
  }
  put('visibility timeout', seconds(a.VisibilityTimeout));
  put('retention', seconds(a.MessageRetentionPeriod));
  put('delivery delay', seconds(a.DelaySeconds));
  put('receive wait', seconds(a.ReceiveMessageWaitTimeSeconds));
  const max = count(a.MaximumMessageSize);
  if (max !== undefined) details['max message size'] = max % 1024 === 0 ? `${max / 1024} KiB` : `${max} B`;
  if (a.KmsMasterKeyId) details.encryption = `KMS ${a.KmsMasterKeyId}`;
  else if (a.SqsManagedSseEnabled === 'true') details.encryption = 'SQS managed';
  put('arn', a.QueueArn);
  put('created', epoch(a.CreatedTimestamp, 's'));
  put('modified', epoch(a.LastModifiedTimestamp, 's'));
  return { name, kind: 'queue', messages: count(a.ApproximateNumberOfMessages), fifo, details };
}

/** A message attribute as SQS returns it: strings and numbers as text, binary as bytes. */
export interface SqsAttributeValue {
  DataType?: string;
  StringValue?: string;
  BinaryValue?: Uint8Array;
}

/** A received message, as far as the driver reads it. */
export interface SqsReceived {
  MessageId?: string;
  ReceiptHandle?: string;
  Body?: string;
  Attributes?: Record<string, string>;
  MessageAttributes?: Record<string, SqsAttributeValue>;
}

/** The system attributes worth showing on a message, as they are named on it. */
const MESSAGE_ATTRIBUTES: [string, string][] = [
  ['ApproximateReceiveCount', 'receive count'],
  ['ApproximateFirstReceiveTimestamp', 'first received'],
  ['MessageGroupId', 'group id'],
  ['MessageDeduplicationId', 'deduplication id'],
  ['SequenceNumber', 'sequence number'],
  ['SenderId', 'sender'],
  ['DeadLetterQueueSourceArn', 'dead-letter source'],
  ['AWSTraceHeader', 'trace header'],
];

/**
 * A received message as a queue message: message attributes become headers (binary ones base64), the group id
 * is the key, and system attributes such as the receive count go in `attributes`.
 */
export function sqsMessage(destination: string, m: SqsReceived): QueueMessage {
  const headers: Record<string, string> = {};
  for (const [name, v] of Object.entries(m.MessageAttributes ?? {})) {
    headers[name] = v.StringValue ?? (v.BinaryValue ? btoa(String.fromCharCode(...v.BinaryValue)) : '');
  }
  const a = m.Attributes ?? {};
  const attributes: Record<string, string> = {};
  for (const [name, label] of MESSAGE_ATTRIBUTES) {
    const v = a[name];
    if (v === undefined || v === '') continue;
    attributes[label] = name === 'ApproximateFirstReceiveTimestamp' ? (epoch(v, 'ms') ?? v) : v;
  }
  return {
    id: m.MessageId ?? '',
    destination,
    offset: a.SequenceNumber,
    key: a.MessageGroupId,
    headers,
    body: m.Body ?? '',
    timestamp: epoch(a.SentTimestamp, 'ms'),
    attributes,
  };
}

/** The message attributes to send for a set of headers: every header as a String attribute. */
export function sqsMessageAttributes(headers: Record<string, string>): Record<string, { DataType: 'String'; StringValue: string }> | undefined {
  const entries = Object.entries(headers);
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, { DataType: 'String' as const, StringValue: v }]));
}

/**
 * Order what a peek collected and keep `limit`: oldest first by sent time (then the FIFO sequence number), the
 * first `limit` for `earliest` and the last for `latest`. Duplicates, which repeated receives hand back, go.
 */
export function sqsMergePeek(messages: QueueMessage[], limit: number, from: 'earliest' | 'latest'): QueueMessage[] {
  const unique = [...new Map(messages.map((m) => [m.id, m])).values()];
  const seq = (m: QueueMessage) => (m.offset ? BigInt(m.offset) : 0n);
  unique.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || (seq(a) < seq(b) ? -1 : seq(a) > seq(b) ? 1 : 0) || a.id.localeCompare(b.id));
  return from === 'earliest' ? unique.slice(0, limit) : unique.slice(-limit);
}
