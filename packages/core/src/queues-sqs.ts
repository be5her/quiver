import type { QuiverErrorCode } from './errors';
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

/**
 * True when a message SQS has handed out `receiveCount` times is one receive away from the dead-letter queue: SQS
 * moves it on the receive that takes the count past `maxReceiveCount`, so a tail stops here with a receive to spare.
 */
export function sqsNearRedrive(receiveCount: number, redrive: SqsRedrive | null): boolean {
  return Boolean(redrive && redrive.maxReceiveCount > 0 && receiveCount >= redrive.maxReceiveCount - 1);
}

/** Rounds in a row that bring nothing new before a peek settles for what it has: SQS keeps handing back the same ones. */
export const SQS_COLLECT_STALE_ROUNDS = 3;

/** Where a peek's rounds of receives stand after one of them. */
export interface SqsCollectState {
  /** Distinct messages received so far, and how many are wanted. */
  seen: number;
  enough: number;
  /** The queue's approximate visible count when the peek began, when SQS gave one. */
  visible?: number;
  /** Messages the last round brought, seen before or not. */
  got: number;
  /** Rounds in a row that brought nothing new. */
  stale: number;
  /** The queue has a redrive policy. */
  redrive: boolean;
  /** A message received so far is one receive short of the dead-letter queue. */
  nearRedrive: boolean;
}

/**
 * Why a peek receives no further round, or null to receive again (the deadline is the caller's). SQS often hands back
 * fewer than asked even with more waiting, so a short round does not end it; an empty one, as many as the queue
 * holds, or rounds of only messages already seen do (one such round on a queue with a redrive policy, where every
 * receive brings a message closer to the dead-letter queue). Before all of that, a message one receive short of
 * the dead-letter queue: another round could hand it out again and move it there.
 */
export function sqsCollectStop(s: SqsCollectState): 'near-redrive' | 'enough' | 'drained' | 'stale' | null {
  if (s.nearRedrive) return 'near-redrive';
  if (s.seen >= s.enough) return 'enough';
  if (s.got === 0 || (s.visible !== undefined && s.seen >= s.visible)) return 'drained';
  if (s.stale >= (s.redrive ? 1 : SQS_COLLECT_STALE_ROUNDS)) return 'stale';
  return null;
}

/** The region as the SDK puts it in hostnames: trimmed and lower case; us-east-1 with an endpoint and none set, else empty. */
export function sqsRegion(region: string, endpoint: string): string {
  return region.trim().toLowerCase() || (endpoint.trim() ? 'us-east-1' : '');
}

/** The origins a queue URL given as a destination may have: the endpoint's, or SQS's own hosts in the region. */
export function sqsQueueOrigins(endpoint: string, region: string): string[] {
  const e = endpoint.trim();
  if (e) {
    try {
      return [new URL(e).origin];
    } catch {
      return [];
    }
  }
  const r = sqsRegion(region, '');
  return r ? [`https://sqs.${r}.amazonaws.com`, `https://sqs.${r}.amazonaws.com.cn`, `https://${r}.queue.amazonaws.com`] : [];
}

/**
 * Not a secret a user stores: the name under which the commands hand the driver what a stored access key was saved
 * for (`sqsSecretBinding`), so a committed change of endpoint or region does not take the key along. Secret names are
 * letters and digits, so it cannot clash with one.
 */
export const SQS_SECRET_BINDING = 'sqs:boundTo';

/** What a stored access key is bound to, readably: the endpoint's origin (or AWS) and the region, `http://localhost:4566 (us-east-1)`. */
export function sqsSecretBinding(c: { endpoint: string; region: string }): string {
  const e = c.endpoint.trim();
  let where = 'AWS';
  if (e) {
    try {
      where = new URL(e).origin;
    } catch {
      where = e;
    }
  }
  return `${where} (${sqsRegion(c.region, c.endpoint)})`;
}

const SQS_ERRORS: [QuiverErrorCode, string[]][] = [
  ['NOT_FOUND', ['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue']],
  ['CONFLICT', ['QueueAlreadyExists', 'QueueNameExists', 'QueueDeletedRecently', 'AWS.SimpleQueueService.QueueDeletedRecently', 'PurgeQueueInProgress', 'AWS.SimpleQueueService.PurgeQueueInProgress']],
  [
    'AUTH_FAILED',
    [
      'InvalidClientTokenId',
      'UnrecognizedClientException',
      'SignatureDoesNotMatch',
      'InvalidSecurity',
      'AccessDenied',
      'AccessDeniedException',
      'ExpiredToken',
      'ExpiredTokenException',
      'CredentialsProviderError',
      'TokenProviderError',
      'UnauthorizedException',
      'InvalidGrantException',
      'KmsAccessDenied',
      'KMS.AccessDeniedException',
    ],
  ],
  [
    'INVALID_INPUT',
    [
      'InvalidParameterValue',
      'InvalidAttributeName',
      'InvalidAttributeValue',
      'InvalidMessageContents',
      'MissingParameter',
      'InvalidParameterCombination',
      'ValidationException',
      'InvalidAddress',
      'UnsupportedOperation',
      // The queue's KMS key cannot be used: disabled, deleted, in the wrong state or not opted in to.
      'KmsDisabled',
      'KmsInvalidKeyUsage',
      'KmsInvalidState',
      'KmsNotFound',
      'KmsOptInRequired',
      'KMS.DisabledException',
      'KMS.InvalidKeyUsageException',
      'KMS.KMSInvalidStateException',
      'KMS.NotFoundException',
      'KMS.OptInRequired',
    ],
  ],
];

/** The Quiver code of an AWS error by its name: a missing queue NOT_FOUND, refused credentials or KMS key AUTH_FAILED, anything unknown REQUEST_FAILED. */
export function sqsErrorCode(name: string): QuiverErrorCode {
  return SQS_ERRORS.find(([, names]) => names.includes(name))?.[0] ?? 'REQUEST_FAILED';
}

const SQS_THROTTLING = new Set([
  'Throttling',
  'ThrottlingException',
  'ThrottledException',
  'RequestThrottled',
  'RequestThrottledException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'SlowDown',
  'KmsThrottled',
  'KMS.ThrottlingException',
]);

/** An SDK error as far as deciding on a retry goes. */
export interface SqsFailure {
  name?: string;
  $retryable?: object;
  $metadata?: { httpStatusCode?: number };
}

/**
 * Whether a tail retries a failed receive: throttling, what the SDK marks retryable, a 5xx, or a failure with no
 * answer at all (a network drop; the SDK's retries give those a `$metadata` without a status). Refused or expired
 * credentials, a missing queue, an unusable KMS key and other 4xx answers would fail the same way again, so they end it.
 */
export function sqsRetryable(err: SqsFailure): boolean {
  const name = err.name ?? '';
  if (SQS_THROTTLING.has(name) || err.$retryable !== undefined) return true;
  if (sqsErrorCode(name) !== 'REQUEST_FAILED') return false;
  const status = err.$metadata?.httpStatusCode;
  return status === undefined || status === 429 || status >= 500;
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

/** Bytes as base64, a slice at a time: spreading a whole 256 KiB attribute into one call overflows the stack. */
function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * A received message as a queue message: message attributes become headers (binary ones base64), the group id
 * is the key, and system attributes such as the receive count go in `attributes`.
 */
export function sqsMessage(destination: string, m: SqsReceived): QueueMessage {
  const headers: Record<string, string> = {};
  for (const [name, v] of Object.entries(m.MessageAttributes ?? {})) {
    headers[name] = v.StringValue ?? (v.BinaryValue ? base64(v.BinaryValue) : '');
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
