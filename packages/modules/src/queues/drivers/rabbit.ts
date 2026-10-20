import { connect, type Channel, type ChannelModel, type ConfirmChannel, type Message } from 'amqplib';
import { QuiverError, newId, type QueueConnection, type QueueDestination, type QueueDriver, type QueueMessage, type QueueSecrets } from '@quiver/core';
import {
  RABBIT_TAIL_PREFIX,
  rabbitAmqpOptions,
  rabbitApiPath,
  rabbitBindingDetails,
  rabbitExchangeDestination,
  rabbitListedExchange,
  rabbitListedQueue,
  rabbitManagementUrl,
  rabbitMessage,
  rabbitPeekSelect,
  rabbitQueueDestination,
  rabbitTailBindings,
  rabbitTarget,
  type RabbitApiBinding,
  type RabbitApiExchange,
  type RabbitApiQueue,
  type RabbitTarget,
} from '@quiver/core';

// RabbitMQ through amqplib for messages and the management HTTP API for listings, counts and bindings. One AMQP
// connection and one confirm channel (for produce) are pooled per connection and rebuilt when its settings or
// password change; peeks, checks and tails each open a channel of their own on it. The driver builds the AMQP
// options from the connection's fields, so no `amqp://user:pass@…` URL is ever stored.
//
// Destinations are queues by name and exchanges as `exchange:<name>`. A peek takes messages with basic.get and
// requeues them (nack with requeue), which marks them redelivered and, on quorum queues, counts a delivery. A live
// tail never consumes: it binds an exclusive queue of its own (`quiver-tail-…`) to what routes to the destination,
// or reads a stream queue from an offset.

const CONNECT_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 10_000;
/** How long a peek may take in all. */
const PEEK_TIMEOUT_MS = 15_000;
/** A `latest` peek reads at most this many from the head of a queue and keeps the newest `limit` of them. */
const PEEK_SCAN_LIMIT = 1000;
/** A stream peek ends once nothing arrived for this long. */
const STREAM_IDLE_MS = 750;
/** A tail from `earliest` of a classic or quorum queue first replays up to this many of the messages already in it. */
const REPLAY_LIMIT = 1000;

interface Pooled {
  key: string;
  model: Promise<ChannelModel> | null;
  confirm: Promise<ConfirmChannel> | null;
  /** Message ids of mandatory publishes the broker returned as unroutable. */
  returned: Set<string>;
}

const pool = new Map<string, Pooled>();

function amqpOptions(c: QueueConnection, s: QueueSecrets) {
  return rabbitAmqpOptions(c, s.password);
}

function client(c: QueueConnection, s: QueueSecrets): Pooled {
  const o = amqpOptions(c, s);
  const key = JSON.stringify([o.protocol, o.hostname, o.port, o.vhost, o.username, o.password]);
  const existing = pool.get(c.id);
  if (existing?.key === key) return existing;
  if (existing) void release(existing);
  const pooled: Pooled = { key, model: null, confirm: null, returned: new Set() };
  pool.set(c.id, pooled);
  return pooled;
}

async function release(p: Pooled): Promise<void> {
  const model = p.model;
  p.model = null;
  p.confirm = null;
  await model?.then((m) => m.close()).catch(() => undefined);
}

function open(c: QueueConnection, s: QueueSecrets): Promise<ChannelModel> {
  const o = amqpOptions(c, s);
  return connect(o, { timeout: CONNECT_TIMEOUT_MS, servername: o.protocol === 'amqps' ? o.hostname : undefined, clientProperties: { connection_name: 'quiver' } });
}

/** The pooled AMQP connection; one that fails or closes is forgotten so the next call connects again. */
function model(c: QueueConnection, s: QueueSecrets): Promise<ChannelModel> {
  const p = client(c, s);
  if (!p.model) {
    const ready = open(c, s).then((m) => {
      m.on('error', () => undefined);
      m.on('close', () => {
        if (p.model === ready) {
          p.model = null;
          p.confirm = null;
        }
      });
      return m;
    });
    p.model = ready;
    ready.catch(() => {
      if (p.model === ready) p.model = null;
    });
  }
  return p.model;
}

function confirmChannel(c: QueueConnection, s: QueueSecrets): Promise<ConfirmChannel> {
  const p = client(c, s);
  if (!p.confirm) {
    const ready = model(c, s).then(async (m) => {
      const ch = await m.createConfirmChannel();
      ch.on('error', () => undefined);
      ch.on('close', () => {
        if (p.confirm === ready) p.confirm = null;
      });
      ch.on('return', (msg: Message) => {
        const id = msg.properties.messageId as string | undefined;
        if (id) p.returned.add(id);
      });
      return ch;
    });
    p.confirm = ready;
    ready.catch(() => {
      if (p.confirm === ready) p.confirm = null;
    });
  }
  return p.confirm;
}

/** A channel of its own for one call, closed afterwards; a channel the broker closed on an error is fine to drop. */
async function withChannel<T>(c: QueueConnection, s: QueueSecrets, fn: (ch: Channel) => Promise<T>): Promise<T> {
  const ch = await (await model(c, s)).createChannel();
  ch.on('error', () => undefined);
  try {
    return await fn(ch);
  } finally {
    await ch.close().catch(() => undefined);
  }
}

function label(t: RabbitTarget): string {
  return `${t.kind === 'queue' ? 'Queue' : 'Exchange'} ${t.name}`;
}

/** amqplib errors as Quiver errors: 404 is NOT_FOUND, 403 and a refused handshake AUTH_FAILED, 405 (locked) CONFLICT. */
function fail(err: unknown, target?: RabbitTarget): never {
  if (err instanceof QuiverError) throw err;
  const e = err as { code?: number | string; message?: string };
  const message = e.message || String(err);
  if (e.code === 404) throw new QuiverError('NOT_FOUND', target ? `${label(target)} not found` : message);
  if (e.code === 405) throw new QuiverError('CONFLICT', target ? `${label(target)} is exclusive to another connection` : message);
  if (e.code === 403 || /ACCESS[-_]REFUSED/.test(message)) throw new QuiverError('AUTH_FAILED', message);
  if (/NOT_ALLOWED.*vhost/i.test(message)) throw new QuiverError('NOT_FOUND', `Virtual host not found or not allowed: ${message}`);
  throw new QuiverError('REQUEST_FAILED', message);
}

async function guard<T>(fn: () => Promise<T>, target?: RabbitTarget): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    fail(err, target);
  }
}

/** True when the broker answered a check with 404: the queue or exchange does not exist. */
async function exists(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 404) return false;
    throw err;
  }
}

/** One management API call, with the connection's user and password; a 404 is NOT_FOUND with `missing` as the message. */
async function api<T>(c: QueueConnection, s: QueueSecrets, path: string, missing = 'Not found'): Promise<T> {
  const base = rabbitManagementUrl(c);
  const { username, password } = amqpOptions(c, s);
  let res: Response;
  try {
    res = await fetch(base + path, {
      headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message;
    throw new QuiverError('REQUEST_FAILED', `Cannot reach the RabbitMQ management API at ${base}: ${cause}`, { reason: 'unreachable' });
  }
  if (res.status === 401) throw new QuiverError('AUTH_FAILED', `The RabbitMQ management API refused user ${username}`);
  if (res.status === 404) throw new QuiverError('NOT_FOUND', missing);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new QuiverError('REQUEST_FAILED', `RabbitMQ management API: ${res.status} ${body.slice(0, 300)}`.trim());
  }
  return (await res.json()) as T;
}

const vhostOf = (c: QueueConnection) => c.vhost || '/';
const QUEUE_COLUMNS = 'name,type,state,messages,messages_ready,messages_unacknowledged,consumers,durable,auto_delete,exclusive,arguments';

function queueInfo(c: QueueConnection, s: QueueSecrets, name: string): Promise<RabbitApiQueue> {
  return api<RabbitApiQueue>(c, s, rabbitApiPath('queues', vhostOf(c), name), `Queue ${name} not found`);
}

function exchangeInfo(c: QueueConnection, s: QueueSecrets, name: string): Promise<RabbitApiExchange> {
  return api<RabbitApiExchange>(c, s, rabbitApiPath('exchanges', vhostOf(c), name), `Exchange ${name} not found`);
}

/** The queue's type from the management API, or `classic` when it cannot be reached (AMQP alone does not say). */
async function queueType(c: QueueConnection, s: QueueSecrets, name: string): Promise<string> {
  try {
    return (await queueInfo(c, s, name)).type ?? 'classic';
  } catch (err) {
    if (err instanceof QuiverError && (err.details as { reason?: string } | undefined)?.reason === 'unreachable') return 'classic';
    throw err;
  }
}

function toMessage(destination: string, seq: number, m: Message): QueueMessage {
  return rabbitMessage(destination, seq, { body: m.content.toString(), fields: m.fields, properties: m.properties });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** basic.get up to `want` messages without acking, then requeue them all, so the queue keeps them in order. */
async function getAndRequeue(c: QueueConnection, s: QueueSecrets, queue: string, want: (count: number) => number): Promise<Message[]> {
  return withChannel(c, s, async (ch) => {
    const { messageCount } = await ch.checkQueue(queue);
    const n = Math.min(want(messageCount), PEEK_SCAN_LIMIT);
    const got: Message[] = [];
    const deadline = Date.now() + PEEK_TIMEOUT_MS;
    try {
      while (got.length < n && Date.now() < deadline) {
        const m = await ch.get(queue, { noAck: false });
        if (!m) break;
        got.push(m);
      }
    } finally {
      if (got.length) ch.nackAll(true);
    }
    return got;
  });
}

/** A stream queue cannot be read with basic.get: consume it from the first offset and stop when it goes quiet. */
async function readStream(c: QueueConnection, s: QueueSecrets, queue: string, limit: number, from: 'earliest' | 'latest'): Promise<Message[]> {
  return withChannel(c, s, async (ch) => {
    await ch.prefetch(100);
    const got: Message[] = [];
    let last = Date.now();
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const { consumerTag } = await ch.consume(
      queue,
      (m) => {
        if (!m) return done();
        ch.ack(m);
        got.push(m);
        last = Date.now();
        if (from === 'earliest' && got.length >= limit) done();
        if (got.length >= PEEK_SCAN_LIMIT * 5) got.splice(0, got.length - limit);
      },
      { noAck: false, arguments: { 'x-stream-offset': 'first' } },
    );
    const deadline = Date.now() + PEEK_TIMEOUT_MS;
    while (Date.now() < deadline && Date.now() - last < STREAM_IDLE_MS) {
      if (await Promise.race([finished.then(() => true), sleep(100).then(() => false)])) break;
    }
    await ch.cancel(consumerTag).catch(() => undefined);
    return got;
  });
}

async function peekQueue(c: QueueConnection, s: QueueSecrets, queue: string, limit: number, from: 'earliest' | 'latest'): Promise<QueueMessage[]> {
  const type = await queueType(c, s, queue);
  const got = type === 'stream' ? await readStream(c, s, queue, limit, from) : await getAndRequeue(c, s, queue, (count) => (from === 'earliest' ? limit : count));
  return rabbitPeekSelect(
    got.map((m, i) => toMessage(queue, i + 1, m)),
    limit,
    from,
  );
}

export const rabbitDriver: QueueDriver = {
  kind: 'rabbit',

  test: async (c, s) => {
    // A fresh connection, so testing a draft does not disturb the pool.
    const amqp = (async () => {
      const m = await open(c, s);
      try {
        const p = m.connection.serverProperties;
        return `${p.product ?? 'RabbitMQ'} ${p.version ?? ''}`.trim();
      } finally {
        await m.close().catch(() => undefined);
      }
    })();
    const mgmt = api<{ rabbitmq_version?: string; cluster_name?: string }>(c, s, '/api/overview');
    const [a, h] = await Promise.allSettled([amqp, mgmt]);
    const why = (r: PromiseRejectedResult) => (r.reason as Error)?.message || String(r.reason);
    const vhost = vhostOf(c);
    if (a.status === 'fulfilled' && h.status === 'fulfilled') {
      return { ok: true, message: `Connected: ${a.value}, vhost ${vhost}, management API ${h.value.rabbitmq_version ?? ''} on ${h.value.cluster_name ?? rabbitManagementUrl(c)}`.replace(/\s+/g, ' ') };
    }
    const amqpText = a.status === 'fulfilled' ? `AMQP connected (${a.value}, vhost ${vhost})` : `AMQP failed: ${why(a)}`;
    const mgmtText = h.status === 'fulfilled' ? `management API reachable (RabbitMQ ${h.value.rabbitmq_version ?? '?'})` : `management API failed: ${why(h)}`;
    return { ok: false, message: `${amqpText}; ${mgmtText}` };
  },

  listDestinations: (c, s) =>
    guard(async () => {
      const vhost = vhostOf(c);
      const [queues, exchanges] = await Promise.all([
        api<RabbitApiQueue[]>(c, s, `${rabbitApiPath('queues', vhost)}?columns=${QUEUE_COLUMNS}`, `Virtual host ${vhost} not found`),
        api<RabbitApiExchange[]>(c, s, rabbitApiPath('exchanges', vhost), `Virtual host ${vhost} not found`),
      ]);
      const out: QueueDestination[] = queues
        .filter(rabbitListedQueue)
        .map(rabbitQueueDestination)
        .sort((x, y) => x.name.localeCompare(y.name));
      out.push(
        ...exchanges
          .filter(rabbitListedExchange)
          .map(rabbitExchangeDestination)
          .sort((x, y) => x.name.localeCompare(y.name)),
      );
      return out;
    }),

  describe: (c, s, destination) => {
    const target = rabbitTarget(destination);
    return guard(async () => {
      if (target.kind === 'exchange') {
        const [e, bindings] = await Promise.all([
          exchangeInfo(c, s, target.name),
          api<RabbitApiBinding[]>(c, s, rabbitApiPath('exchanges', vhostOf(c), target.name, 'bindings', 'source'), `${label(target)} not found`),
        ]);
        const d = rabbitExchangeDestination(e);
        Object.assign(d.details!, rabbitBindingDetails(bindings, 'destination'));
        return d;
      }
      const vhost = vhostOf(c);
      // The management API's counts lag a few seconds; AMQP's queue check is exact, so it overrides them when it answers.
      const [info, bindings, check] = await Promise.allSettled([
        queueInfo(c, s, target.name),
        api<RabbitApiBinding[]>(c, s, rabbitApiPath('queues', vhost, target.name, 'bindings'), `${label(target)} not found`),
        withChannel(c, s, (ch) => ch.checkQueue(target.name)),
      ]);
      if (check.status === 'rejected' && (check.reason as { code?: number }).code === 404) throw new QuiverError('NOT_FOUND', `${label(target)} not found`);
      if (info.status === 'rejected') {
        if (check.status === 'rejected') throw info.reason;
        return { name: target.name, kind: 'queue', messages: check.value.messageCount, consumers: check.value.consumerCount, details: { management: `unavailable: ${(info.reason as Error).message}` } };
      }
      const d = rabbitQueueDestination(info.value);
      if (check.status === 'fulfilled') {
        d.messages = check.value.messageCount + Number(d.details?.unacknowledged ?? 0);
        d.consumers = check.value.consumerCount;
        d.details!.ready = String(check.value.messageCount);
      }
      if (bindings.status === 'fulfilled') Object.assign(d.details!, rabbitBindingDetails(bindings.value, 'source'));
      return d;
    }, target);
  },

  peek: (c, s, destination, { limit, from, partition }) => {
    const target = rabbitTarget(destination);
    return guard(async () => {
      if (target.kind === 'exchange') throw new QuiverError('NOT_SUPPORTED', 'An exchange holds no messages; peek a queue bound to it, or tail the exchange');
      if (partition !== undefined) throw new QuiverError('INVALID_INPUT', 'RabbitMQ queues have no partitions');
      return peekQueue(c, s, target.name, limit, from);
    }, target);
  },

  produce: (c, s, destination, message) => {
    // To a queue through the default exchange (routing key = queue), with `exchange` to that exchange (routing key =
    // destination), or to `exchange:<name>` with the key as the routing key.
    const target = message.exchange ? null : rabbitTarget(destination);
    const exchange = message.exchange ?? (target?.kind === 'exchange' ? target.name : '');
    const routingKey = message.exchange ? destination : target?.kind === 'exchange' ? (message.key ?? '') : destination;
    const checked: RabbitTarget = exchange ? { kind: 'exchange', name: exchange } : { kind: 'queue', name: destination };
    return guard(async () => {
      if (target?.kind === 'queue' && message.key) throw new QuiverError('INVALID_INPUT', "A message sent straight to a queue is routed by the queue's name; give `exchange` to publish with a routing key of your own");
      if (message.partition !== undefined) throw new QuiverError('INVALID_INPUT', 'RabbitMQ queues have no partitions');
      if (message.delaySeconds) throw new QuiverError('INVALID_INPUT', 'RabbitMQ has no per-message delay (short of the delayed-message plugin)');
      // A publish to a missing exchange would close the pooled channel; check first so the error is NOT_FOUND.
      await withChannel(c, s, (ch) => (exchange ? ch.checkExchange(exchange) : ch.checkQueue(destination)));
      const p = client(c, s);
      const ch = await confirmChannel(c, s);
      const id = newId();
      await new Promise<void>((resolve, reject) =>
        ch.publish(
          exchange,
          routingKey,
          Buffer.from(message.body),
          { headers: message.headers, messageId: id, timestamp: Math.floor(Date.now() / 1000), persistent: true, mandatory: true },
          (err) => (err ? reject(err) : resolve()),
        ),
      );
      if (p.returned.delete(id)) throw new QuiverError('REQUEST_FAILED', `No queue is bound to exchange ${exchange} for routing key "${routingKey}"; the message was dropped`);
      return { id };
    }, checked);
  },

  consume: (c, s, destination, { from }, onMessage, onEnd) => {
    const target = rabbitTarget(destination);
    return guard(async () => {
      let stream = false;
      let bindings: RabbitApiBinding[] = [];
      let exchangeType: string | undefined;
      if (target.kind === 'exchange') {
        exchangeType = (await exchangeInfo(c, s, target.name)).type;
        if (exchangeType !== 'fanout' && exchangeType !== 'topic' && exchangeType !== 'headers') {
          bindings = await api<RabbitApiBinding[]>(c, s, rabbitApiPath('exchanges', vhostOf(c), target.name, 'bindings', 'source'), `${label(target)} not found`);
        }
      } else {
        stream = (await queueInfo(c, s, target.name)).type === 'stream';
        if (!stream) bindings = await api<RabbitApiBinding[]>(c, s, rabbitApiPath('queues', vhostOf(c), target.name, 'bindings'), `${label(target)} not found`);
      }
      const copies = stream ? [] : rabbitTailBindings(target, exchangeType, bindings);
      if (!stream && !copies.length) {
        throw new QuiverError(
          'NOT_SUPPORTED',
          target.kind === 'queue'
            ? `Queue ${target.name} is reached only through the default exchange, so it cannot be tailed without consuming its messages; bind it to an exchange, or peek it`
            : `Exchange ${target.name} has no bindings to copy, so a tail would see nothing`,
        );
      }

      const ch = await (await model(c, s)).createChannel();
      let seq = 0;
      let ended = false;
      let stopping = false;
      const end = (error?: Error) => {
        if (ended) return;
        ended = true;
        onEnd(error);
      };
      ch.on('error', () => undefined);
      ch.on('close', () => end(stopping ? undefined : new Error('The RabbitMQ channel closed')));
      try {
        if (stream) {
          await ch.prefetch(100);
          await ch.consume(
            target.name,
            (m) => {
              if (!m) return end(new Error(`The broker cancelled the tail of ${target.name}`));
              ch.ack(m);
              onMessage(toMessage(destination, ++seq, m));
            },
            { noAck: false, arguments: { 'x-stream-offset': from === 'earliest' ? 'first' : 'next' } },
          );
        } else {
          const own = `${RABBIT_TAIL_PREFIX}${newId()}`;
          await ch.assertQueue(own, { exclusive: true, autoDelete: true, durable: false });
          for (const b of copies) await ch.bindQueue(own, b.source, b.pattern, b.args);
          // Bound first, then replayed: a message routed in between can show up twice, but none is missed.
          if (from === 'earliest' && target.kind === 'queue') {
            for (const m of await getAndRequeue(c, s, target.name, (count) => Math.min(count, REPLAY_LIMIT))) onMessage(toMessage(destination, ++seq, m));
          }
          await ch.consume(
            own,
            (m) => {
              if (!m) return end(new Error(`The broker cancelled the tail of ${destination}`));
              onMessage(toMessage(destination, ++seq, m));
            },
            { noAck: true },
          );
        }
      } catch (err) {
        stopping = true;
        await ch.close().catch(() => undefined);
        throw err;
      }
      return {
        stop: async () => {
          if (ended) return;
          stopping = true;
          await ch.close().catch(() => undefined);
          end();
        },
      };
    }, target);
  },

  purge: (c, s, destination) => {
    const target = rabbitTarget(destination);
    return guard(async () => {
      if (target.kind === 'exchange') throw new QuiverError('NOT_SUPPORTED', 'An exchange holds no messages to purge; purge a queue bound to it');
      await withChannel(c, s, (ch) => ch.purgeQueue(target.name));
    }, target);
  },

  create: (c, s, destination) => {
    // A durable classic queue, or for `exchange:<name>` a durable topic exchange.
    const target = rabbitTarget(destination);
    return guard(async () => {
      const there = await withChannel(c, s, (ch) => exists(() => (target.kind === 'queue' ? ch.checkQueue(target.name) : ch.checkExchange(target.name))));
      if (there) throw new QuiverError('CONFLICT', `${label(target)} already exists`);
      await withChannel<unknown>(c, s, (ch) => (target.kind === 'queue' ? ch.assertQueue(target.name, { durable: true }) : ch.assertExchange(target.name, 'topic', { durable: true })));
    }, target);
  },

  remove: (c, s, destination) => {
    const target = rabbitTarget(destination);
    return guard(async () => {
      await withChannel(c, s, async (ch) => {
        if (target.kind === 'queue') {
          await ch.checkQueue(target.name);
          await ch.deleteQueue(target.name);
        } else {
          await ch.checkExchange(target.name);
          await ch.deleteExchange(target.name);
        }
      });
    }, target);
  },

  close: async (connectionId) => {
    const p = pool.get(connectionId);
    if (!p) return;
    pool.delete(connectionId);
    await release(p);
  },
};

/** Close every pooled connection, when the app quits. */
export async function rabbitCloseAll(): Promise<void> {
  const all = [...pool.values()];
  pool.clear();
  await Promise.all(all.map((p) => release(p)));
}
