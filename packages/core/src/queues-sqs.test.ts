import { describe, expect, it } from 'vitest';
import type { QueueMessage } from './models/queues';
import {
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
  SQS_COLLECT_STALE_ROUNDS,
} from './queues-sqs';

describe('sqsQueueName', () => {
  it('takes the name from a queue URL or an ARN', () => {
    expect(sqsQueueName('https://sqs.eu-west-1.amazonaws.com/123456789012/orders')).toBe('orders');
    expect(sqsQueueName('http://localhost:4566/000000000000/jobs.fifo/')).toBe('jobs.fifo');
    expect(sqsQueueName('arn:aws:sqs:eu-west-1:123456789012:orders-dlq')).toBe('orders-dlq');
  });
});

describe('sqsIsFifo', () => {
  it('trusts the attribute, else the .fifo name', () => {
    expect(sqsIsFifo('a.fifo')).toBe(true);
    expect(sqsIsFifo('a')).toBe(false);
    expect(sqsIsFifo('a.fifo', { FifoQueue: 'false' })).toBe(false);
    expect(sqsIsFifo('a', { FifoQueue: 'true' })).toBe(true);
  });
});

describe('sqsRedrive', () => {
  it('parses the policy JSON', () => {
    expect(sqsRedrive('{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:1:orders-dlq","maxReceiveCount":"5"}')).toEqual({
      deadLetterQueue: 'orders-dlq',
      deadLetterArn: 'arn:aws:sqs:us-east-1:1:orders-dlq',
      maxReceiveCount: 5,
    });
  });

  it('is null without a policy or with a broken one', () => {
    expect(sqsRedrive(undefined)).toBeNull();
    expect(sqsRedrive('')).toBeNull();
    expect(sqsRedrive('{nope')).toBeNull();
    expect(sqsRedrive('{}')).toBeNull();
  });
});

describe('sqsNearRedrive', () => {
  const redrive = (maxReceiveCount: number) => ({ deadLetterQueue: 'dlq', deadLetterArn: 'arn:aws:sqs:us-east-1:1:dlq', maxReceiveCount });

  it('is true one receive before SQS would move the message', () => {
    expect(sqsNearRedrive(3, redrive(5))).toBe(false);
    expect(sqsNearRedrive(4, redrive(5))).toBe(true);
    expect(sqsNearRedrive(9, redrive(5))).toBe(true);
    expect(sqsNearRedrive(1, redrive(1))).toBe(true);
  });

  it('is false without a redrive policy', () => {
    expect(sqsNearRedrive(1000, null)).toBe(false);
    expect(sqsNearRedrive(1000, redrive(0))).toBe(false);
  });
});

describe('sqsCollectStop', () => {
  const round = { seen: 4, enough: 15, visible: 15, got: 4, stale: 0, redrive: false, nearRedrive: false };

  it('goes on after a short round while the queue holds more', () => {
    expect(sqsCollectStop(round)).toBeNull();
    expect(sqsCollectStop({ ...round, visible: undefined })).toBeNull();
  });

  it('stops before another round once a message is one receive short of the dead-letter queue, even when more are wanted', () => {
    expect(sqsCollectStop({ ...round, redrive: true, nearRedrive: true })).toBe('near-redrive');
    expect(sqsCollectStop({ ...round, seen: 15, redrive: true, nearRedrive: true })).toBe('near-redrive');
  });

  it('stops with enough, on an empty round, or once as many as the queue held are seen', () => {
    expect(sqsCollectStop({ ...round, seen: 15 })).toBe('enough');
    expect(sqsCollectStop({ ...round, got: 0 })).toBe('drained');
    expect(sqsCollectStop({ ...round, enough: 500, seen: 15 })).toBe('drained');
  });

  it('gives SQS a few rounds of messages already seen, but only one when receives count towards a redrive policy', () => {
    expect(sqsCollectStop({ ...round, stale: SQS_COLLECT_STALE_ROUNDS - 1 })).toBeNull();
    expect(sqsCollectStop({ ...round, stale: SQS_COLLECT_STALE_ROUNDS })).toBe('stale');
    expect(sqsCollectStop({ ...round, stale: 1, redrive: true })).toBe('stale');
  });
});

describe('sqsRegion and sqsQueueOrigins', () => {
  it('lower-cases the region as the SDK does in hostnames, defaulting to us-east-1 with an endpoint', () => {
    expect(sqsRegion(' EU-West-1 ', '')).toBe('eu-west-1');
    expect(sqsRegion('', 'http://localhost:4566')).toBe('us-east-1');
    expect(sqsRegion('', '')).toBe('');
  });

  it('takes the endpoint origin, or SQS hosts in the region whatever its case', () => {
    expect(sqsQueueOrigins('http://localhost:4566/', 'eu-west-1')).toEqual(['http://localhost:4566']);
    expect(sqsQueueOrigins('', 'EU-West-1')).toContain(new URL('https://sqs.eu-west-1.amazonaws.com/1/q').origin);
    expect(sqsQueueOrigins('not a url', 'eu-west-1')).toEqual([]);
    expect(sqsQueueOrigins('', '')).toEqual([]);
  });
});

describe('sqsSecretBinding', () => {
  it('names the endpoint origin (or AWS) and the region, so a committed change of either is told apart', () => {
    expect(sqsSecretBinding({ endpoint: 'http://localhost:4566/', region: '' })).toBe('http://localhost:4566 (us-east-1)');
    expect(sqsSecretBinding({ endpoint: '', region: 'EU-West-1' })).toBe('AWS (eu-west-1)');
    expect(sqsSecretBinding({ endpoint: 'http://attacker:4566', region: '' })).not.toBe(sqsSecretBinding({ endpoint: 'http://localhost:4566', region: '' }));
    expect(sqsSecretBinding({ endpoint: '', region: 'eu-west-2' })).not.toBe(sqsSecretBinding({ endpoint: '', region: 'eu-west-1' }));
  });
});

describe('sqsErrorCode and sqsRetryable', () => {
  it('maps AWS error names, KMS ones included', () => {
    expect(sqsErrorCode('QueueDoesNotExist')).toBe('NOT_FOUND');
    expect(sqsErrorCode('PurgeQueueInProgress')).toBe('CONFLICT');
    expect(sqsErrorCode('ExpiredTokenException')).toBe('AUTH_FAILED');
    expect(sqsErrorCode('KmsAccessDenied')).toBe('AUTH_FAILED');
    expect(sqsErrorCode('KmsDisabled')).toBe('INVALID_INPUT');
    expect(sqsErrorCode('KmsThrottled')).toBe('REQUEST_FAILED');
    expect(sqsErrorCode('Whatever')).toBe('REQUEST_FAILED');
  });

  it('retries throttling, what the SDK marks retryable, 5xx and network drops', () => {
    expect(sqsRetryable({ name: 'ThrottlingException', $metadata: { httpStatusCode: 400 } })).toBe(true);
    expect(sqsRetryable({ name: 'KmsThrottled', $metadata: { httpStatusCode: 400 } })).toBe(true);
    expect(sqsRetryable({ name: 'Odd', $retryable: {}, $metadata: { httpStatusCode: 400 } })).toBe(true);
    expect(sqsRetryable({ name: 'InternalError', $metadata: { httpStatusCode: 500 } })).toBe(true);
    expect(sqsRetryable({ name: 'Odd', $metadata: { httpStatusCode: 429 } })).toBe(true);
    // A network failure: no answer, though the SDK's retries add a $metadata without a status.
    expect(sqsRetryable({ name: 'TimeoutError' })).toBe(true);
    expect(sqsRetryable({ name: 'Error', $metadata: {} })).toBe(true);
  });

  it('does not retry what would fail again: credentials, KMS, a missing queue, other 4xx', () => {
    expect(sqsRetryable({ name: 'CredentialsProviderError' })).toBe(false);
    expect(sqsRetryable({ name: 'TokenProviderError' })).toBe(false);
    expect(sqsRetryable({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(sqsRetryable({ name: 'KmsDisabled', $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(sqsRetryable({ name: 'QueueDoesNotExist', $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(sqsRetryable({ name: 'SomethingNew', $metadata: { httpStatusCode: 400 } })).toBe(false);
  });
});

describe('sqsDestination', () => {
  it('counts visible messages and shows in flight, delayed, FIFO, the DLQ and settings', () => {
    const d = sqsDestination(
      'jobs.fifo',
      {
        ApproximateNumberOfMessages: '7',
        ApproximateNumberOfMessagesNotVisible: '2',
        ApproximateNumberOfMessagesDelayed: '0',
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        RedrivePolicy: '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:1:jobs-dlq.fifo","maxReceiveCount":3}',
        VisibilityTimeout: '30',
        MessageRetentionPeriod: '345600',
        MaximumMessageSize: '262144',
        SqsManagedSseEnabled: 'true',
        CreatedTimestamp: '1700000000',
      },
      { url: 'http://x/1/jobs.fifo' },
    );
    expect(d).toMatchObject({ name: 'jobs.fifo', kind: 'queue', messages: 7, fifo: true });
    expect(d.details).toEqual({
      url: 'http://x/1/jobs.fifo',
      'in flight': '2',
      delayed: '0',
      'content-based deduplication': 'false',
      'dead-letter queue': 'jobs-dlq.fifo',
      'max receive count': '3',
      'visibility timeout': '30 s',
      retention: '4 d',
      'max message size': '256 KiB',
      encryption: 'SQS managed',
      created: '2023-11-14T22:13:20.000Z',
    });
  });

  it('leaves the count out when SQS did not give one', () => {
    const d = sqsDestination('plain', {});
    expect(d.messages).toBeUndefined();
    expect(d.fifo).toBe(false);
  });

  it('lists the source queues a redrive allow policy names', () => {
    const d = sqsDestination('dlq', { RedriveAllowPolicy: '{"redrivePermission":"byQueue","sourceQueueArns":["arn:aws:sqs:us-east-1:1:a","arn:aws:sqs:us-east-1:1:b"]}' }, { sources: 'a, b' });
    expect(d.details).toEqual({ 'dead-letter source queues': 'a, b', 'redrive allowed': 'a, b' });
  });
});

describe('sqsMessage', () => {
  it('maps attributes to headers, the group id to the key and system attributes', () => {
    const m = sqsMessage('jobs.fifo', {
      MessageId: 'm-1',
      Body: '{"a":1}',
      Attributes: { SentTimestamp: '1700000000123', ApproximateReceiveCount: '2', MessageGroupId: 'g1', SequenceNumber: '18800000000000000001', SenderId: 'AID' },
      MessageAttributes: { trace: { DataType: 'String', StringValue: 't-1' }, n: { DataType: 'Number', StringValue: '4' }, raw: { DataType: 'Binary', BinaryValue: new Uint8Array([104, 105]) } },
    });
    expect(m).toEqual({
      id: 'm-1',
      destination: 'jobs.fifo',
      offset: '18800000000000000001',
      key: 'g1',
      headers: { trace: 't-1', n: '4', raw: 'aGk=' },
      body: '{"a":1}',
      timestamp: '2023-11-14T22:13:20.123Z',
      attributes: { 'receive count': '2', 'group id': 'g1', 'sequence number': '18800000000000000001', sender: 'AID' },
    });
  });

  it('encodes a 200 KB binary attribute without overflowing the stack', () => {
    const bytes = new Uint8Array(200 * 1024).map((_, i) => i % 256);
    const m = sqsMessage('q', { MessageId: 'big', MessageAttributes: { blob: { DataType: 'Binary', BinaryValue: bytes } } });
    expect(Buffer.from(m.headers.blob!, 'base64').equals(Buffer.from(bytes))).toBe(true);
  });
});

describe('sqsMessageAttributes', () => {
  it('sends headers as String attributes, and none for no headers', () => {
    expect(sqsMessageAttributes({})).toBeUndefined();
    expect(sqsMessageAttributes({ a: '1' })).toEqual({ a: { DataType: 'String', StringValue: '1' } });
  });
});

describe('sqsMergePeek', () => {
  const msg = (id: string, ms: number, offset?: string): QueueMessage => ({ id, destination: 'q', headers: {}, body: id, timestamp: new Date(ms).toISOString(), offset });

  it('drops duplicates and keeps the oldest or newest by sent time', () => {
    const all = [msg('c', 3), msg('a', 1), msg('b', 2), msg('a', 1), msg('d', 4)];
    expect(sqsMergePeek(all, 2, 'earliest').map((m) => m.id)).toEqual(['a', 'b']);
    expect(sqsMergePeek(all, 2, 'latest').map((m) => m.id)).toEqual(['c', 'd']);
    expect(sqsMergePeek(all, 50, 'latest')).toHaveLength(4);
  });

  it('orders FIFO messages sent in the same millisecond by sequence number', () => {
    const all = [msg('second', 5, '18800000000000000010'), msg('first', 5, '9')];
    expect(sqsMergePeek(all, 5, 'earliest').map((m) => m.id)).toEqual(['first', 'second']);
  });
});
