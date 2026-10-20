import { QuiverError, nowIso, type QueueConnection, type QueueDestination, type QueueDriver, type QueueMessage } from '@quiver/core';

// An in-process broker: topics with partitions and offsets like Kafka, kept in memory per connection and lost
// when the connection is closed or Quiver quits. It is for trying the module out and for the smoke.

/** Messages kept per topic; older ones are dropped, which moves the low watermark like Kafka's retention. */
const TOPIC_LIMIT = 10_000;

interface Partition {
  /** Offset of `messages[0]`. */
  low: number;
  messages: QueueMessage[];
}

interface Topic {
  name: string;
  partitions: Partition[];
  /** Round robin for messages without a key or partition. */
  next: number;
  listeners: Set<Listener>;
}

interface Listener {
  onMessage(m: QueueMessage): void;
  end(): void;
}

const brokers = new Map<string, Map<string, Topic>>();

function broker(c: QueueConnection): Map<string, Topic> {
  let b = brokers.get(c.id);
  if (!b) {
    b = new Map();
    brokers.set(c.id, b);
  }
  return b;
}

function newTopic(name: string, partitions = 1): Topic {
  return { name, partitions: Array.from({ length: partitions }, () => ({ low: 0, messages: [] })), next: 0, listeners: new Set() };
}

function topicOf(c: QueueConnection, name: string): Topic {
  const t = broker(c).get(name);
  if (!t) throw new QuiverError('NOT_FOUND', `Topic ${name} not found`);
  return t;
}

function hash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function summary(t: Topic): QueueDestination {
  const messages = t.partitions.reduce((n, p) => n + p.messages.length, 0);
  return { name: t.name, kind: 'topic', messages, partitions: t.partitions.length, consumers: t.listeners.size, details: { broker: 'memory' } };
}

export const memoryDriver: QueueDriver = {
  kind: 'memory',

  test: async () => ({ ok: true, message: 'In-memory broker: messages live in Quiver until it quits' }),

  listDestinations: async (c) => [...broker(c).values()].map(summary).sort((a, b) => a.name.localeCompare(b.name)),

  describe: async (c, _s, destination) => {
    const t = topicOf(c, destination);
    const d = summary(t);
    t.partitions.forEach((p, i) => (d.details![`partition ${i}`] = `offsets ${p.low}..${p.low + p.messages.length}`));
    return d;
  },

  peek: async (c, _s, destination, { limit, from, partition }) => {
    const t = topicOf(c, destination);
    if (partition !== undefined && !t.partitions[partition]) throw new QuiverError('INVALID_INPUT', `Topic ${destination} has no partition ${partition}`);
    const all = t.partitions.filter((_, i) => partition === undefined || i === partition).flatMap((p) => p.messages);
    all.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || (a.partition ?? 0) - (b.partition ?? 0) || Number(a.offset) - Number(b.offset));
    return from === 'earliest' ? all.slice(0, limit) : all.slice(-limit);
  },

  produce: async (c, _s, destination, message) => {
    // Like Kafka with auto-create on: the first message makes the topic.
    const b = broker(c);
    let t = b.get(destination);
    if (!t) {
      t = newTopic(destination);
      b.set(destination, t);
    }
    if (message.partition !== undefined && !t.partitions[message.partition]) throw new QuiverError('INVALID_INPUT', `Topic ${destination} has no partition ${message.partition}`);
    const index = message.partition ?? (message.key ? hash(message.key) % t.partitions.length : t.next++ % t.partitions.length);
    const p = t.partitions[index];
    const offset = p.low + p.messages.length;
    const m: QueueMessage = {
      id: `${index}:${offset}`,
      destination,
      partition: index,
      offset: String(offset),
      key: message.key,
      headers: { ...message.headers },
      body: message.body,
      timestamp: nowIso(),
    };
    p.messages.push(m);
    if (p.messages.length > TOPIC_LIMIT) {
      p.messages.shift();
      p.low++;
    }
    for (const listener of t.listeners) listener.onMessage(m);
    return { id: m.id };
  },

  consume: async (c, _s, destination, { from }, onMessage, onEnd) => {
    const b = broker(c);
    let t = b.get(destination);
    if (!t) {
      t = newTopic(destination);
      b.set(destination, t);
    }
    if (from === 'earliest') for (const m of await memoryDriver.peek(c, {}, destination, { limit: TOPIC_LIMIT, from: 'earliest' })) onMessage(m);
    const topic = t;
    let stopped = false;
    const listener: Listener = {
      onMessage,
      end: () => {
        if (stopped) return;
        stopped = true;
        topic.listeners.delete(listener);
        onEnd();
      },
    };
    topic.listeners.add(listener);
    return { stop: async () => listener.end() };
  },

  purge: async (c, _s, destination) => {
    for (const p of topicOf(c, destination).partitions) {
      p.low += p.messages.length;
      p.messages = [];
    }
  },

  create: async (c, _s, destination, { partitions }) => {
    const b = broker(c);
    if (b.has(destination)) throw new QuiverError('CONFLICT', `Topic ${destination} already exists`);
    b.set(destination, newTopic(destination, partitions ?? 1));
  },

  remove: async (c, _s, destination) => {
    const t = topicOf(c, destination);
    broker(c).delete(destination);
    // Live tails of a deleted topic end, as a Kafka consumer would lose its assignment.
    for (const listener of [...t.listeners]) listener.end();
  },

  close: async (connectionId) => {
    for (const t of brokers.get(connectionId)?.values() ?? []) for (const listener of [...t.listeners]) listener.end();
    brokers.delete(connectionId);
  },
};
