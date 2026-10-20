import { z } from 'zod';

// Queues contract: connections committed under `.quiver/queues/<id>.json`, passwords and keys in
// `host.secrets`. Every broker is reached through a `QueueDriver`; `memory` is an in-process broker
// for trying the module out and for the smoke.

export const QueueKindSchema = z.enum(['memory', 'kafka', 'sqs', 'rabbit']);
export type QueueKind = z.infer<typeof QueueKindSchema>;

export const QueueConnectionSchema = z.object({
  id: z.string(),
  name: z.string().default('Connection'),
  kind: QueueKindSchema.default('memory'),
  /** Kafka: bootstrap brokers, `host:port`. */
  brokers: z.array(z.string()).default([]),
  /** Kafka: client id sent to the brokers. */
  clientId: z.string().default('quiver'),
  ssl: z.boolean().default(false),
  /** Kafka SASL; the password is a secret. */
  sasl: z.enum(['none', 'plain', 'scram-sha-256', 'scram-sha-512']).default('none'),
  username: z.string().default(''),
  /** SQS: region, an AWS profile or an access key id (its secret is a secret), and an endpoint for LocalStack. */
  region: z.string().default(''),
  profile: z.string().default(''),
  accessKeyId: z.string().default(''),
  endpoint: z.string().default(''),
  /** RabbitMQ: `amqp://host:5672/vhost` and the management API, `http://host:15672`. */
  url: z.string().default(''),
  managementUrl: z.string().default(''),
});
export type QueueConnection = z.infer<typeof QueueConnectionSchema>;

/** Secret values for a connection, by name (`password`, `secretAccessKey`), read from `host.secrets`. */
export type QueueSecrets = Record<string, string>;

export interface QueueDestination {
  name: string;
  kind: 'topic' | 'queue' | 'exchange';
  /** Messages waiting (queues) or the sum of partition end offsets (topics), when the broker says. */
  messages?: number;
  partitions?: number;
  consumers?: number;
  fifo?: boolean;
  /** Broker-specific settings worth showing, as text. */
  details?: Record<string, string>;
}

export interface QueueMessage {
  /** Unique within the destination: offset for Kafka, message id for SQS, a sequence for RabbitMQ. */
  id: string;
  destination: string;
  partition?: number;
  offset?: string;
  key?: string;
  headers: Record<string, string>;
  body: string;
  /** ISO 8601, when the broker gives one. */
  timestamp?: string;
  /** Broker-specific attributes such as receive count or routing key. */
  attributes?: Record<string, string>;
}

export interface QueueConsumerGroup {
  id: string;
  state: string;
  members: number;
  lag: { topic: string; partition: number; offset: string; end: string; lag: number }[];
}

export const QueuePeekInputSchema = z.object({
  connectionId: z.string(),
  destination: z.string(),
  limit: z.number().int().min(1).max(500).default(50),
  /** Kafka: from the start or the newest messages, optionally one partition. */
  from: z.enum(['latest', 'earliest']).default('latest'),
  partition: z.number().int().min(0).optional(),
});
export type QueuePeekOptions = Omit<z.infer<typeof QueuePeekInputSchema>, 'connectionId' | 'destination'>;

export const QueueProduceInputSchema = z.object({
  connectionId: z.string(),
  destination: z.string(),
  body: z.string(),
  key: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  partition: z.number().int().min(0).optional(),
  /** SQS FIFO: message group and deduplication ids. */
  groupId: z.string().optional(),
  dedupId: z.string().optional(),
  delaySeconds: z.number().int().min(0).max(900).optional(),
  /** RabbitMQ: publish to this exchange with `destination` as the routing key. */
  exchange: z.string().optional(),
});
export type QueueProduceMessage = Omit<z.infer<typeof QueueProduceInputSchema>, 'connectionId' | 'destination'>;

export const QueueConsumeInputSchema = z.object({
  connectionId: z.string(),
  destination: z.string(),
  from: z.enum(['latest', 'earliest']).default('latest'),
});

export const QueueWaitInputSchema = z.object({
  connectionId: z.string(),
  destination: z.string(),
  /** Substring of the body, key or a header value; any message when empty. */
  match: z.string().default(''),
  timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
});

export const QueueDestinationInputSchema = z.object({ connectionId: z.string(), destination: z.string() });
export const QueueCreateInputSchema = QueueDestinationInputSchema.extend({
  partitions: z.number().int().min(1).optional(),
  fifo: z.boolean().optional(),
});

/** A live consumer started by a driver; `stop` ends it and releases its connection. */
export interface QueueSubscription {
  stop(): Promise<void>;
}

/**
 * What every broker implements. Peek must not consume: Kafka reads with a throwaway group, SQS with a
 * zero visibility timeout, RabbitMQ gets and requeues. Optional methods are missing where the broker has
 * no such thing, and the commands answer that they are not supported.
 */
export interface QueueDriver {
  kind: QueueKind;
  test(c: QueueConnection, s: QueueSecrets): Promise<{ ok: boolean; message: string }>;
  listDestinations(c: QueueConnection, s: QueueSecrets): Promise<QueueDestination[]>;
  describe(c: QueueConnection, s: QueueSecrets, destination: string): Promise<QueueDestination>;
  peek(c: QueueConnection, s: QueueSecrets, destination: string, options: QueuePeekOptions): Promise<QueueMessage[]>;
  produce(c: QueueConnection, s: QueueSecrets, destination: string, message: QueueProduceMessage): Promise<{ id: string }>;
  consume(c: QueueConnection, s: QueueSecrets, destination: string, options: { from: 'latest' | 'earliest' }, onMessage: (m: QueueMessage) => void, onEnd: (error?: Error) => void): Promise<QueueSubscription>;
  purge?(c: QueueConnection, s: QueueSecrets, destination: string): Promise<void>;
  create?(c: QueueConnection, s: QueueSecrets, destination: string, options: { partitions?: number; fifo?: boolean }): Promise<void>;
  remove?(c: QueueConnection, s: QueueSecrets, destination: string): Promise<void>;
  groups?(c: QueueConnection, s: QueueSecrets): Promise<QueueConsumerGroup[]>;
  /** Release pooled clients for a connection, on delete and on workspace close. */
  close?(connectionId: string): Promise<void>;
}
