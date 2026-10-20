import { ConfigResourceTypes, Kafka, logLevel, type Admin, type Consumer, type KafkaConfig, type KafkaMessage, type Producer, type SASLOptions } from 'kafkajs';
import { QuiverError, newId, type QueueConnection, type QueueConsumerGroup, type QueueDestination, type QueueDriver, type QueueMessage, type QueueSecrets } from '@quiver/core';
import { kafkaGroupLag, kafkaMergePeek, kafkaPeekRanges, kafkaRangesDone, kafkaTopicSize, type PartitionOffsets } from '@quiver/core';

// Kafka through kafkajs. Admin and producer clients are pooled per connection and rebuilt when its settings or
// password change. Peeks and live tails each join a throwaway consumer group (`quiver-peek-…`, `quiver-tail-…`)
// that never commits and is deleted when done, so no real group's offsets move.

const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15_000;
/** How long a peek may take, including the group join (about three seconds on a default broker). */
const PEEK_TIMEOUT_MS = 20_000;
/** How long a live tail waits for its group join before handing back the subscription anyway. */
const JOIN_TIMEOUT_MS = 15_000;
/** Every throwaway group Quiver makes starts with this; `groups` leaves them out. */
export const KAFKA_GROUP_PREFIX = 'quiver-';
export const KAFKA_PEEK_GROUP = `${KAFKA_GROUP_PREFIX}peek-`;
export const KAFKA_TAIL_GROUP = `${KAFKA_GROUP_PREFIX}tail-`;

interface Pooled {
  key: string;
  kafka: Kafka;
  admin: Promise<Admin> | null;
  producer: Promise<Producer> | null;
}

const pool = new Map<string, Pooled>();

function config(c: QueueConnection, s: QueueSecrets): KafkaConfig {
  const brokers = c.brokers.map((b) => b.trim()).filter(Boolean);
  if (!brokers.length) throw new QuiverError('INVALID_INPUT', 'The connection has no brokers; add host:port');
  let sasl: SASLOptions | undefined;
  if (c.sasl !== 'none') {
    if (!c.username) throw new QuiverError('INVALID_INPUT', `SASL ${c.sasl} needs a username`);
    sasl = { mechanism: c.sasl, username: c.username, password: s.password ?? '' } as SASLOptions;
  }
  return {
    clientId: c.clientId || 'quiver',
    brokers,
    ssl: c.ssl,
    sasl,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    retry: { retries: 1, initialRetryTime: 200, maxRetryTime: 2000 },
    logLevel: logLevel.NOTHING,
  };
}

function client(c: QueueConnection, s: QueueSecrets): Pooled {
  const key = JSON.stringify([c.brokers, c.clientId, c.ssl, c.sasl, c.username, s.password ?? '']);
  const existing = pool.get(c.id);
  if (existing?.key === key) return existing;
  if (existing) void release(existing);
  const pooled: Pooled = { key, kafka: new Kafka(config(c, s)), admin: null, producer: null };
  pool.set(c.id, pooled);
  return pooled;
}

async function release(p: Pooled): Promise<void> {
  const admin = p.admin;
  const producer = p.producer;
  p.admin = null;
  p.producer = null;
  await Promise.all([admin?.then((a) => a.disconnect()).catch(() => undefined), producer?.then((x) => x.disconnect()).catch(() => undefined)]);
}

/** A connected admin client; a failed connect is forgotten so the next call tries again. */
function admin(c: QueueConnection, s: QueueSecrets): Promise<Admin> {
  const p = client(c, s);
  if (!p.admin) {
    const a = p.kafka.admin();
    const ready = a.connect().then(() => a);
    p.admin = ready;
    ready.catch(() => {
      if (p.admin === ready) p.admin = null;
    });
  }
  return p.admin;
}

function producer(c: QueueConnection, s: QueueSecrets): Promise<Producer> {
  const p = client(c, s);
  if (!p.producer) {
    const x = p.kafka.producer({ allowAutoTopicCreation: true });
    const ready = x.connect().then(() => x);
    p.producer = ready;
    ready.catch(() => {
      if (p.producer === ready) p.producer = null;
    });
  }
  return p.producer;
}

/** kafkajs errors as Quiver errors: a missing topic is NOT_FOUND, an existing one CONFLICT, the rest REQUEST_FAILED. */
function fail(err: unknown, destination?: string): never {
  if (err instanceof QuiverError) throw err;
  const e = err as { type?: string; message?: string; name?: string };
  if (e.type === 'UNKNOWN_TOPIC_OR_PARTITION') throw new QuiverError('NOT_FOUND', destination ? `Topic ${destination} not found` : (e.message ?? 'Unknown topic'));
  if (e.type === 'TOPIC_ALREADY_EXISTS') throw new QuiverError('CONFLICT', destination ? `Topic ${destination} already exists` : (e.message ?? 'Topic exists'));
  if (e.type === 'SASL_AUTHENTICATION_FAILED' || e.name === 'KafkaJSSASLAuthenticationError') throw new QuiverError('AUTH_FAILED', e.message ?? 'SASL authentication failed');
  throw new QuiverError('REQUEST_FAILED', e.message || String(err));
}

async function guard<T>(fn: () => Promise<T>, destination?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    fail(err, destination);
  }
}

async function offsetsOf(a: Admin, topic: string): Promise<PartitionOffsets[]> {
  const metadata = await a.fetchTopicMetadata({ topics: [topic] });
  if (!metadata.topics.length) throw new QuiverError('NOT_FOUND', `Topic ${topic} not found`);
  return (await a.fetchTopicOffsets(topic)).map((o) => ({ partition: o.partition, low: o.low, high: o.high }));
}

function text(value: Buffer | string | (Buffer | string)[] | undefined | null): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((v) => v.toString()).join(', ');
  return value.toString();
}

function toMessage(topic: string, partition: number, m: KafkaMessage): QueueMessage {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.headers ?? {})) headers[k] = text(v);
  const ms = Number(m.timestamp);
  return {
    id: `${partition}:${m.offset}`,
    destination: topic,
    partition,
    offset: m.offset,
    key: m.key ? m.key.toString() : undefined,
    headers,
    body: m.value ? m.value.toString() : '',
    timestamp: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined,
  };
}

function consumerFor(c: QueueConnection, s: QueueSecrets, groupId: string): Consumer {
  return client(c, s).kafka.consumer({
    groupId,
    allowAutoTopicCreation: false,
    maxWaitTimeInMs: 500,
    // A tail that loses the broker ends and says why instead of retrying in the background forever.
    retry: { retries: 1, restartOnFailure: async () => false },
  });
}

/** Delete a throwaway group once its consumer left; the broker refuses while members remain, which is fine. */
function dropGroup(c: QueueConnection, s: QueueSecrets, groupId: string): void {
  void admin(c, s)
    .then((a) => a.deleteGroups([groupId]))
    .catch(() => undefined);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export const kafkaDriver: QueueDriver = {
  kind: 'kafka',

  test: async (c, s) => {
    // A fresh client, so testing a draft does not disturb the pool.
    const a = new Kafka({ ...config(c, s), retry: { retries: 0 } }).admin();
    try {
      await a.connect();
      const cluster = await a.describeCluster();
      const topics = await a.listTopics();
      const n = cluster.brokers.length;
      return { ok: true, message: `Connected: ${n} broker${n === 1 ? '' : 's'}, ${topics.filter((t) => !t.startsWith('__')).length} topics, cluster ${cluster.clusterId}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message || String(err) };
    } finally {
      await a.disconnect().catch(() => undefined);
    }
  },

  listDestinations: (c, s) =>
    guard(async () => {
      const a = await admin(c, s);
      // Internal topics (`__consumer_offsets`, `__transaction_state`) are left out.
      const names = (await a.listTopics()).filter((t) => !t.startsWith('__')).sort();
      if (!names.length) return [];
      const { topics } = await a.fetchTopicMetadata({ topics: names });
      const partitions = new Map(topics.map((t) => [t.name, t.partitions.length]));
      return Promise.all(
        names.map(async (name): Promise<QueueDestination> => {
          const offsets = await a.fetchTopicOffsets(name).catch(() => null);
          return { name, kind: 'topic', partitions: partitions.get(name), messages: offsets ? kafkaTopicSize(offsets) : undefined };
        }),
      );
    }),

  describe: (c, s, destination) =>
    guard(async () => {
      const a = await admin(c, s);
      const offsets = await offsetsOf(a, destination);
      const details: Record<string, string> = {};
      for (const o of offsets) details[`partition ${o.partition}`] = `offsets ${o.low}..${o.high}`;
      try {
        const configs = await a.describeConfigs({ resources: [{ type: ConfigResourceTypes.TOPIC, name: destination }], includeSynonyms: false });
        for (const entry of configs.resources[0]?.configEntries ?? []) if (!entry.isDefault && !entry.isSensitive) details[entry.configName] = entry.configValue;
      } catch {
        // Describing configs needs an ACL some users lack; the offsets are enough.
      }
      return { name: destination, kind: 'topic', partitions: offsets.length, messages: kafkaTopicSize(offsets), details };
    }, destination),

  peek: (c, s, destination, { limit, from, partition }) =>
    guard(async () => {
      const offsets = await offsetsOf(await admin(c, s), destination);
      if (partition !== undefined && !offsets.some((o) => o.partition === partition)) throw new QuiverError('INVALID_INPUT', `Topic ${destination} has no partition ${partition}`);
      const ranges = kafkaPeekRanges(offsets, limit, from, partition);
      if (!ranges.length) return [];
      const wanted = new Map(ranges.map((r) => [r.partition, r]));
      const groupId = `${KAFKA_PEEK_GROUP}${newId()}`;
      const consumer = consumerFor(c, s, groupId);
      const collected: QueueMessage[] = [];
      const seen = new Map<number, number>();
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      let crashed: Error | null = null;
      const others = offsets.map((o) => o.partition).filter((p) => !wanted.has(p));
      // kafkajs takes seeks only once the group is set up, so they are made when it joins.
      consumer.on(consumer.events.GROUP_JOIN, () => {
        for (const r of ranges) consumer.seek({ topic: destination, partition: r.partition, offset: String(r.start) });
        if (others.length) consumer.pause([{ topic: destination, partitions: others }]);
      });
      consumer.on(consumer.events.CRASH, (e) => {
        crashed = (e.payload as { error: Error }).error;
        done();
      });
      try {
        await consumer.connect();
        await consumer.subscribe({ topics: [destination], fromBeginning: true });
        await consumer.run({
          autoCommit: false,
          eachMessage: async ({ partition: p, message }) => {
            const r = wanted.get(p);
            if (!r) return;
            const offset = Number(message.offset);
            if (offset >= r.start && offset < r.end) collected.push(toMessage(destination, p, message));
            seen.set(p, Math.max(seen.get(p) ?? -1, offset));
            if (kafkaRangesDone(ranges, seen)) done();
          },
        });
        // A compacted topic can have gaps at the end of a range; the timeout ends the peek with what was read.
        await Promise.race([finished, sleep(PEEK_TIMEOUT_MS)]);
        if (crashed && !collected.length) throw crashed;
      } finally {
        await consumer.disconnect().catch(() => undefined);
        dropGroup(c, s, groupId);
      }
      return kafkaMergePeek(collected, limit, from);
    }, destination),

  produce: (c, s, destination, message) =>
    guard(async () => {
      const p = await producer(c, s);
      const [meta] = await p.send({
        topic: destination,
        messages: [{ key: message.key ?? null, value: message.body, headers: message.headers, partition: message.partition }],
      });
      const offset = meta?.baseOffset ?? meta?.offset ?? '';
      return { id: `${meta?.partition ?? message.partition ?? 0}:${offset}` };
    }, destination),

  consume: (c, s, destination, { from }, onMessage, onEnd) =>
    guard(async () => {
      // Latest means from the moment the tail was asked for, not from when the group join finishes a few seconds later.
      const offsets = await offsetsOf(await admin(c, s), destination);
      const groupId = `${KAFKA_TAIL_GROUP}${newId()}`;
      const consumer = consumerFor(c, s, groupId);
      let ended = false;
      const end = (error?: Error) => {
        if (ended) return;
        ended = true;
        onEnd(error);
      };
      let joined!: () => void;
      const join = new Promise<void>((r) => (joined = r));
      consumer.on(consumer.events.GROUP_JOIN, () => {
        // kafkajs takes seeks only once the group is set up.
        if (from === 'latest') for (const o of offsets) consumer.seek({ topic: destination, partition: o.partition, offset: o.high });
        joined();
      });
      consumer.on(consumer.events.CRASH, (e) => {
        end((e.payload as { error: Error }).error);
        void consumer.disconnect().catch(() => undefined);
        dropGroup(c, s, groupId);
      });
      try {
        await consumer.connect();
        await consumer.subscribe({ topics: [destination], fromBeginning: from === 'earliest' });
        await consumer.run({ autoCommit: false, eachMessage: async ({ partition, message }) => onMessage(toMessage(destination, partition, message)) });
        await Promise.race([join, sleep(JOIN_TIMEOUT_MS)]);
      } catch (err) {
        await consumer.disconnect().catch(() => undefined);
        dropGroup(c, s, groupId);
        throw err;
      }
      return {
        stop: async () => {
          if (ended) return;
          await consumer.disconnect().catch(() => undefined);
          dropGroup(c, s, groupId);
          end();
        },
      };
    }, destination),

  purge: (c, s, destination) =>
    guard(async () => {
      const a = await admin(c, s);
      const offsets = await offsetsOf(a, destination);
      // Deleting records up to the high watermark of every partition; offsets keep counting from there.
      await a.deleteTopicRecords({ topic: destination, partitions: offsets.map((o) => ({ partition: o.partition, offset: o.high })) });
    }, destination),

  create: (c, s, destination, { partitions }) =>
    guard(async () => {
      const created = await (await admin(c, s)).createTopics({ waitForLeaders: true, topics: [{ topic: destination, numPartitions: partitions ?? 1 }] });
      if (!created) throw new QuiverError('CONFLICT', `Topic ${destination} already exists`);
    }, destination),

  remove: (c, s, destination) =>
    guard(async () => {
      const a = await admin(c, s);
      await offsetsOf(a, destination);
      await a.deleteTopics({ topics: [destination] });
    }, destination),

  groups: (c, s) =>
    guard(async () => {
      const a = await admin(c, s);
      const ids = (await a.listGroups()).groups.map((g) => g.groupId).filter((id) => !id.startsWith(KAFKA_GROUP_PREFIX));
      if (!ids.length) return [];
      const { groups } = await a.describeGroups(ids);
      const ends = new Map<string, PartitionOffsets[]>();
      const endsOf = async (topic: string) => {
        if (!ends.has(topic)) ends.set(topic, await a.fetchTopicOffsets(topic).catch(() => []));
        return ends.get(topic)!;
      };
      const out: QueueConsumerGroup[] = [];
      for (const g of groups) {
        const lag: QueueConsumerGroup['lag'] = [];
        for (const t of await a.fetchOffsets({ groupId: g.groupId }).catch(() => [])) lag.push(...kafkaGroupLag(t.topic, t.partitions, await endsOf(t.topic)));
        out.push({ id: g.groupId, state: g.state, members: g.members.length, lag });
      }
      return out.sort((x, y) => x.id.localeCompare(y.id));
    }),

  close: async (connectionId) => {
    const p = pool.get(connectionId);
    if (!p) return;
    pool.delete(connectionId);
    await release(p);
  },
};

/** Disconnect every pooled client, when the app quits. */
export async function kafkaCloseAll(): Promise<void> {
  const all = [...pool.values()];
  pool.clear();
  await Promise.all(all.map((p) => release(p)));
}
