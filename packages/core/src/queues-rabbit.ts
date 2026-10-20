import { QuiverError } from './errors';
import { urlHasCredentials, type QueueConnection, type QueueDestination, type QueueMessage } from './models/queues';

// Pure parts of the RabbitMQ driver, kept apart from amqplib and the management API so they can be tested
// without a broker: naming, connection options built from the fields, management API rows as destinations,
// the bindings a live tail copies, and AMQP messages as Quiver messages.

/** A destination naming an exchange rather than a queue: `exchange:<name>`. Plain names are queues. */
export const RABBIT_EXCHANGE_PREFIX = 'exchange:';
/** The exclusive queues Quiver's live tails declare start with this; listings leave them out. */
export const RABBIT_TAIL_PREFIX = 'quiver-tail-';

export interface RabbitTarget {
  kind: 'queue' | 'exchange';
  name: string;
}

/**
 * What a destination string names: `exchange:<name>` is an exchange, anything else a queue. `.` and `..` are refused:
 * the management API's URLs would resolve them as path segments and ask for something else.
 */
export function rabbitTarget(destination: string): RabbitTarget {
  const exchange = destination.startsWith(RABBIT_EXCHANGE_PREFIX);
  const name = exchange ? destination.slice(RABBIT_EXCHANGE_PREFIX.length) : destination;
  if (!name) throw new QuiverError('INVALID_INPUT', exchange ? 'The default exchange cannot be addressed; name a queue instead' : 'A queue name is required');
  if (name === '.' || name === '..') throw new QuiverError('INVALID_INPUT', `"${name}" cannot be addressed as a queue or exchange name`);
  return { kind: exchange ? 'exchange' : 'queue', name };
}

/** The AMQP options the driver connects with, built from the connection's fields; never a URL with the password in it. */
export interface RabbitAmqpOptions {
  protocol: 'amqp' | 'amqps';
  hostname: string;
  port: number;
  username: string;
  password: string;
  /** Escaped (`/` is `%2F`): amqplib unescapes the vhost it is given, so a raw `%` in a name would change it. */
  vhost: string;
}

/**
 * Connection options from the fields. A host that looks like a pasted URL (`amqp://user:pass@host`) is refused: the
 * user and password belong in `username` and the secret. With neither user nor password set, RabbitMQ's default
 * `guest`/`guest` is used, which a broker accepts from localhost only.
 */
export function rabbitAmqpOptions(c: Pick<QueueConnection, 'host' | 'port' | 'vhost' | 'ssl' | 'username'>, password: string | undefined): RabbitAmqpOptions {
  const hostname = c.host.trim();
  if (!hostname) throw new QuiverError('INVALID_INPUT', 'The connection has no host; add the RabbitMQ host name');
  if (/[\s/@]/.test(hostname)) throw new QuiverError('INVALID_INPUT', 'The host must be a plain host name, not a URL; put the user in username and the password in the connection secret');
  const anonymous = !c.username && !password;
  return {
    protocol: c.ssl ? 'amqps' : 'amqp',
    hostname,
    port: c.port ?? (c.ssl ? 5671 : 5672),
    username: anonymous ? 'guest' : c.username,
    password: anonymous ? 'guest' : (password ?? ''),
    vhost: encodeURIComponent(c.vhost || '/'),
  };
}

/**
 * The management API's base URL without a trailing slash: `managementUrl`, or `http://<host>:15672` (`https`, 15671 with
 * ssl). With ssl an `http://` URL is refused: the password goes to the management API as basic auth, in the clear.
 */
export function rabbitManagementUrl(c: Pick<QueueConnection, 'host' | 'ssl' | 'managementUrl'>): string {
  const given = c.managementUrl.trim();
  if (given) {
    if (urlHasCredentials(given)) throw new QuiverError('INVALID_INPUT', 'The management URL must not contain a user or password');
    if (c.ssl && /^http:/i.test(given)) throw new QuiverError('INVALID_INPUT', 'The connection uses ssl, so the management URL must be https://; over http:// the password would be sent in the clear');
    return given.replace(/\/+$/, '');
  }
  const host = c.host.trim();
  if (!host || /[\s/@]/.test(host)) throw new QuiverError('INVALID_INPUT', 'The connection has no management URL and no host to derive it from');
  return c.ssl ? `https://${host}:15671` : `http://${host}:15672`;
}

/** A management API path, every segment encoded: the default vhost `/` becomes `%2F`. */
export function rabbitApiPath(...segments: string[]): string {
  return `/api/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
}

/** A queue as `GET /api/queues/<vhost>` lists it (the fields Quiver reads). */
export interface RabbitApiQueue {
  name: string;
  type?: string;
  state?: string;
  messages?: number;
  messages_ready?: number;
  messages_unacknowledged?: number;
  consumers?: number;
  durable?: boolean;
  auto_delete?: boolean;
  exclusive?: boolean;
  arguments?: Record<string, unknown>;
}

/** An exchange as `GET /api/exchanges/<vhost>` lists it. */
export interface RabbitApiExchange {
  name: string;
  type: string;
  durable?: boolean;
  auto_delete?: boolean;
  internal?: boolean;
  arguments?: Record<string, unknown>;
}

/** A binding as the management API lists it; `source` `''` is the default exchange. */
export interface RabbitApiBinding {
  source: string;
  destination: string;
  destination_type: 'queue' | 'exchange';
  routing_key: string;
  arguments?: Record<string, unknown>;
}

function valueText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (ArrayBuffer.isView(v)) return new TextDecoder().decode(v);
  return JSON.stringify(v);
}

function argumentDetails(args: Record<string, unknown> | undefined, details: Record<string, string>): void {
  for (const [k, v] of Object.entries(args ?? {})) details[k] = valueText(v);
}

/** A queue row as a destination; `messages` counts ready and unacknowledged, as the management UI does. */
export function rabbitQueueDestination(q: RabbitApiQueue): QueueDestination {
  const details: Record<string, string> = { type: q.type ?? 'classic' };
  if (q.state) details.state = q.state;
  if (q.messages_ready !== undefined) details.ready = String(q.messages_ready);
  if (q.messages_unacknowledged !== undefined) details.unacknowledged = String(q.messages_unacknowledged);
  if (q.durable !== undefined) details.durable = String(q.durable);
  if (q.auto_delete) details['auto delete'] = 'true';
  if (q.exclusive) details.exclusive = 'true';
  argumentDetails(q.arguments, details);
  return { name: q.name, kind: 'queue', messages: q.messages, consumers: q.consumers, details };
}

/** An exchange row as a destination, named `exchange:<name>`. */
export function rabbitExchangeDestination(e: RabbitApiExchange): QueueDestination {
  const details: Record<string, string> = { type: e.type };
  if (e.durable !== undefined) details.durable = String(e.durable);
  if (e.auto_delete) details['auto delete'] = 'true';
  if (e.internal) details.internal = 'true';
  argumentDetails(e.arguments, details);
  return { name: `${RABBIT_EXCHANGE_PREFIX}${e.name}`, kind: 'exchange', details };
}

/** Listings leave out the default exchange, the built-in `amq.*` ones (they can still be published to) and Quiver's own tail queues. */
export function rabbitListedExchange(e: Pick<RabbitApiExchange, 'name'>): boolean {
  return e.name !== '' && !e.name.startsWith('amq.');
}
export function rabbitListedQueue(q: Pick<RabbitApiQueue, 'name'>): boolean {
  return !q.name.startsWith(RABBIT_TAIL_PREFIX);
}

/** Bindings as describe details: `binding <n>` → `<exchange> → <routing key>`. */
export function rabbitBindingDetails(bindings: RabbitApiBinding[], side: 'source' | 'destination'): Record<string, string> {
  const out: Record<string, string> = {};
  bindings.forEach((b, i) => {
    const other = side === 'source' ? b.source || '(default)' : `${b.destination_type === 'exchange' ? RABBIT_EXCHANGE_PREFIX : ''}${b.destination}`;
    const args = b.arguments && Object.keys(b.arguments).length ? ` ${JSON.stringify(b.arguments)}` : '';
    out[`binding ${i + 1}`] = side === 'source' ? `${other} → ${b.routing_key || '(any)'}${args}` : `${b.routing_key || '(any)'} → ${other}${args}`;
  });
  return out;
}

/** One binding a live tail makes from an exchange to its own exclusive queue. */
export interface RabbitTailBinding {
  source: string;
  pattern: string;
  args?: Record<string, unknown>;
}

/** The exchange types that hand every matching queue its own copy of a message. */
const COPYING_TYPES = new Set(['direct', 'topic', 'fanout', 'headers']);

/**
 * How an exchange routes when a tail may bind to it: `direct`, `topic`, `fanout` and `headers` give every matching queue
 * a copy, and so does a delayed-message exchange by its `x-delayed-type`. Undefined for consistent-hash, modulus-hash,
 * random and other plugin types, which pick one queue per message: a tail's queue bound there would take its share of
 * the messages away from the real queues.
 */
export function rabbitCopyingType(e: Pick<RabbitApiExchange, 'type' | 'arguments'>): string | undefined {
  const type = e.type === 'x-delayed-message' ? valueText(e.arguments?.['x-delayed-type']) : e.type;
  return COPYING_TYPES.has(type) ? type : undefined;
}

function notCopying(name: string, e: Pick<RabbitApiExchange, 'type'> | undefined, queue?: string): QuiverError {
  const exchange = `exchange ${name} (${e?.type || 'type unknown'})`;
  const why = 'sends each message to one bound queue only, so a tail bound to it would take messages away from the real queues';
  return new QuiverError('NOT_SUPPORTED', queue ? `Queue ${queue} is bound to ${exchange}, which ${why}` : `The ${exchange} ${why}`);
}

/**
 * What a live tail binds its exclusive queue to, so it receives a copy of what is routed and consumes nothing:
 * - a queue: the same bindings the queue has, except the default exchange, which routes by queue name and cannot be copied
 * - a fanout, topic or headers exchange: everything (`''`, `#`, `x-match: all` with no headers)
 * - a direct exchange: the routing keys and arguments it is bound with now
 * `exchanges` gives the type of the target and of every source exchange; one that picks a single queue per message
 * (`rabbitCopyingType`) is refused as NOT_SUPPORTED. An empty result means the tail would never see a message.
 */
export function rabbitTailBindings(target: RabbitTarget, exchanges: Record<string, Pick<RabbitApiExchange, 'type' | 'arguments'>>, bindings: RabbitApiBinding[]): RabbitTailBinding[] {
  if (target.kind === 'exchange') {
    const e = exchanges[target.name];
    const type = e && rabbitCopyingType(e);
    if (!type) throw notCopying(target.name, e);
    if (type === 'fanout') return [{ source: target.name, pattern: '' }];
    if (type === 'topic') return [{ source: target.name, pattern: '#' }];
    if (type === 'headers') return [{ source: target.name, pattern: '', args: { 'x-match': 'all' } }];
  }
  const out: RabbitTailBinding[] = [];
  const seen = new Set<string>();
  for (const b of bindings) {
    if (target.kind === 'queue' ? b.source === '' || b.destination !== target.name : b.source !== target.name) continue;
    if (target.kind === 'queue' && !rabbitCopyingType(exchanges[b.source] ?? { type: '' })) throw notCopying(b.source, exchanges[b.source], target.name);
    const source = target.kind === 'queue' ? b.source : target.name;
    const args = b.arguments && Object.keys(b.arguments).length ? b.arguments : undefined;
    const key = JSON.stringify([source, b.routing_key, args ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(args ? { source, pattern: b.routing_key, args } : { source, pattern: b.routing_key });
  }
  return out;
}

/** AMQP header values as text: strings as they are, numbers and flags as text, byte arrays decoded, tables and lists as JSON. */
export function rabbitHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k] = valueText(v);
  return out;
}

/** The parts of an amqplib message the conversion reads. */
export interface RabbitRawMessage {
  body: string;
  fields: { exchange: string; routingKey: string; redelivered: boolean };
  properties: {
    headers?: Record<string, unknown>;
    messageId?: unknown;
    correlationId?: unknown;
    contentType?: unknown;
    contentEncoding?: unknown;
    type?: unknown;
    appId?: unknown;
    userId?: unknown;
    replyTo?: unknown;
    expiration?: unknown;
    priority?: unknown;
    deliveryMode?: unknown;
    timestamp?: unknown;
  };
}

/** AMQP timestamps are seconds since the epoch; some publishers write milliseconds, which are told apart by size. */
function timestampIso(value: unknown): string | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n > 1e11 ? n : n * 1000).toISOString();
}

/**
 * An AMQP message as a Quiver message. `id` is its sequence in the peek or tail (RabbitMQ has no offsets), `key` the
 * routing key it was published with, and the AMQP properties, exchange and redelivered flag are `attributes`.
 */
export function rabbitMessage(destination: string, seq: number, m: RabbitRawMessage): QueueMessage {
  const attributes: Record<string, string> = {
    exchange: m.fields.exchange || '(default)',
    routingKey: m.fields.routingKey,
    redelivered: String(m.fields.redelivered),
  };
  const p = m.properties;
  for (const [name, value] of Object.entries({
    messageId: p.messageId,
    correlationId: p.correlationId,
    contentType: p.contentType,
    contentEncoding: p.contentEncoding,
    type: p.type,
    appId: p.appId,
    userId: p.userId,
    replyTo: p.replyTo,
    expiration: p.expiration,
    priority: p.priority,
    deliveryMode: p.deliveryMode,
  })) {
    if (value !== undefined && value !== null && value !== '') attributes[name] = valueText(value);
  }
  return {
    id: String(seq),
    destination,
    key: m.fields.routingKey || undefined,
    headers: rabbitHeaders(p.headers),
    body: m.body,
    timestamp: timestampIso(p.timestamp),
    attributes,
  };
}

/**
 * Where a stream peek starts reading: `first` for the oldest, and for the newest the offset `limit` before the end by
 * the management API's count. Offsets keep counting after retention drops old segments, so that offset is at or before
 * the newest `limit` and the peek reads on to the end; without a count it reads from the first offset.
 */
export function rabbitStreamOffset(from: 'earliest' | 'latest', limit: number, count: number | undefined): 'first' | number {
  if (from === 'earliest' || count === undefined || !Number.isFinite(count)) return 'first';
  return Math.max(0, count - limit);
}

/** The `limit` oldest (`earliest`) or newest (`latest`) of messages read from the head of a queue. */
export function rabbitPeekSelect<T>(all: T[], limit: number, from: 'earliest' | 'latest'): T[] {
  return from === 'earliest' ? all.slice(0, limit) : all.slice(-limit);
}
