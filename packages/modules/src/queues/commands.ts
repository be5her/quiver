import {
  CommittedUrlSchema,
  QueueConnectionSchema,
  QueueConsumeInputSchema,
  QueueCreateInputSchema,
  QueueDestinationInputSchema,
  QueueKindSchema,
  QueuePeekInputSchema,
  QueueProduceInputSchema,
  QueueWaitInputSchema,
  QuiverError,
  compact,
  defineCommand,
  newId,
  nowIso,
  type CommandContext,
  type CommandDefinition,
  type HostApi,
  type QueueConnection,
  type QueueDriver,
  type QueueSecrets,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { QueueConsumers, waitForMessage } from './consumers';
import { DRIVERS } from './drivers';

/** `.quiver/queues/<id>.json`, one committed file per connection. */
export const QUEUES_COLLECTION = 'queues';
/** Per machine: produced messages and destructive actions, newest last. */
export const QUEUES_HISTORY_LOG = 'queues-history';
/** Per machine: `{ [connectionId]: { [secretName]: cipher } }`, encrypted with `host.secrets`. */
const SECRETS_DOC = 'queues-secrets';
/** Bytes of a produced body kept in the history. */
const HISTORY_BODY_LIMIT = 64 * 1024;

export const consumers = new QueueConsumers();

/** A connection as the commands hand it out: the committed settings plus the names (never values) of the secrets stored for it. */
export type QueueConnectionSummary = QueueConnection & { secrets: string[] };

export interface QueueHistoryEntry {
  id: string;
  at: string;
  connectionId: string;
  connectionName: string;
  kind: QueueConnection['kind'];
  action: 'produce' | 'purge' | 'create' | 'delete';
  destination: string;
  /** For `produce`: what was sent, the body cut at 64 KB, and the id the broker gave it. */
  message?: { key?: string; headers: Record<string, string>; body: string; truncated?: boolean; partition?: number; groupId?: string; exchange?: string; id: string };
}

type SecretsDoc = Record<string, Record<string, string>>;

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

// ---------- secrets (per machine, encrypted, never committed) ----------

async function readSecrets(w: WorkspaceApi, host: HostApi, connectionId: string): Promise<QueueSecrets> {
  const doc = await w.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  const out: QueueSecrets = {};
  for (const [name, cipher] of Object.entries(doc[connectionId] ?? {})) {
    try {
      out[name] = host.secrets.decrypt(cipher);
    } catch {
      // Encrypted on another machine or by another user: treat as unset.
    }
  }
  return out;
}

/** Set (a string) or remove (null or empty) secrets by name; the others are kept. */
async function writeSecrets(w: WorkspaceApi, host: HostApi, connectionId: string, changes: Record<string, string | null>): Promise<void> {
  const doc = await w.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
  const mine = { ...(doc[connectionId] ?? {}) };
  for (const [name, value] of Object.entries(changes)) {
    if (value) mine[name] = host.secrets.encrypt(value);
    else delete mine[name];
  }
  if (Object.keys(mine).length) doc[connectionId] = mine;
  else delete doc[connectionId];
  await w.store.writeLocal(SECRETS_DOC, doc);
}

async function secretNames(w: WorkspaceApi): Promise<SecretsDoc> {
  return w.store.readLocal<SecretsDoc>(SECRETS_DOC, {});
}

// ---------- connections ----------

async function listConnections(w: WorkspaceApi): Promise<QueueConnectionSummary[]> {
  const [items, secrets] = await Promise.all([w.store.list<QueueConnection>(QUEUES_COLLECTION), secretNames(w)]);
  const out: QueueConnectionSummary[] = [];
  for (const item of items) {
    const parsed = QueueConnectionSchema.safeParse(item);
    if (parsed.success) out.push({ ...parsed.data, secrets: Object.keys(secrets[parsed.data.id] ?? {}).sort() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function getConnection(w: WorkspaceApi, id: string): Promise<QueueConnectionSummary> {
  const item = await w.store.get<QueueConnection>(QUEUES_COLLECTION, id);
  if (!item) throw new QuiverError('NOT_FOUND', `Queue connection ${id} not found`);
  const parsed = QueueConnectionSchema.safeParse(item);
  if (!parsed.success) throw new QuiverError('INVALID_INPUT', `Queue connection ${id} is not valid: ${parsed.error.issues[0]?.message ?? 'unreadable'}`);
  return { ...parsed.data, secrets: Object.keys((await secretNames(w))[id] ?? {}).sort() };
}

function driverFor(c: QueueConnection): QueueDriver {
  return DRIVERS[c.kind];
}

/** The connection, its driver and its secrets, ready for a driver call. */
async function open(ctx: CommandContext, connectionId: string): Promise<{ connection: QueueConnection; driver: QueueDriver; secrets: QueueSecrets }> {
  const connection = await getConnection(ws(ctx), connectionId);
  return { connection, driver: driverFor(connection), secrets: await readSecrets(ws(ctx), ctx.host, connectionId) };
}

function unsupported(c: QueueConnection, what: string): never {
  throw new QuiverError('NOT_SUPPORTED', `${c.kind} connections cannot ${what}`);
}

function changed(ctx: CommandContext, reason: 'connections' | 'messages', connectionId?: string): void {
  ctx.host.emit('queues.changed', { workspaceId: ws(ctx).id, reason, connectionId });
}

async function record(ctx: CommandContext, c: QueueConnection, entry: Pick<QueueHistoryEntry, 'action' | 'destination' | 'message'>): Promise<void> {
  const full: QueueHistoryEntry = { id: newId(), at: nowIso(), connectionId: c.id, connectionName: c.name, kind: c.kind, ...entry };
  await ws(ctx).store.appendLog(QUEUES_HISTORY_LOG, full);
}

/** Every field optional and without defaults, so a save changes only what it names. */
const QueueConnectionDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  kind: QueueKindSchema.optional(),
  brokers: z.array(z.string()).optional(),
  clientId: z.string().optional(),
  ssl: z.boolean().optional(),
  sasl: z.enum(['none', 'plain', 'scram-sha-256', 'scram-sha-512']).optional(),
  username: z.string().optional(),
  region: z.string().optional(),
  profile: z.string().optional(),
  accessKeyId: z.string().optional(),
  endpoint: CommittedUrlSchema.optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  vhost: z.string().optional(),
  managementUrl: CommittedUrlSchema.optional(),
});
type QueueConnectionDraft = z.infer<typeof QueueConnectionDraftSchema>;

const SecretsInput = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), z.string().nullable())
  .describe('Secrets by name (`password` for Kafka SASL and RabbitMQ, `secretAccessKey` for SQS); null or empty removes one. Stored encrypted on this machine, never committed or returned.');

function merge(existing: QueueConnection | undefined, draft: QueueConnectionDraft, id: string): QueueConnection {
  const merged = QueueConnectionSchema.parse({ ...(existing ?? {}), ...compact(draft), id });
  if (!merged.name.trim()) merged.name = 'Connection';
  merged.brokers = merged.brokers.map((b) => b.trim()).filter(Boolean);
  return merged;
}

const ConnectionIdInput = z.object({ id: z.string().describe('Id of a queue connection (see queues.connection.list)') });
const ConnectionInput = z.object({ connectionId: z.string().describe('Id of a queue connection (see queues.connection.list)') });

const connectionList = defineCommand({
  id: 'queues.connection.list',
  title: 'List queue connections',
  description: 'Lists the queue connections of this workspace (Kafka, SQS, RabbitMQ or the in-memory broker) with the names of the secrets stored for each; secret values are never returned.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx) => listConnections(ws(ctx)),
});

const connectionGet = defineCommand({
  id: 'queues.connection.get',
  title: 'Get queue connection',
  description: 'Returns one queue connection with the names of its stored secrets.',
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => getConnection(ws(ctx), id),
});

const connectionSave = defineCommand({
  id: 'queues.connection.save',
  title: 'Save queue connection',
  description:
    'Creates or updates a queue connection; omit id to create. Only the fields given change. Kafka uses `brokers` (host:port), `clientId`, `ssl`, `sasl` and `username`; SQS `region`, `profile` or `accessKeyId`, and `endpoint` for LocalStack; RabbitMQ `host`, `port`, `vhost`, `ssl`, `username` and `managementUrl`. Passwords and keys go in `secrets`, never in the connection: URLs with a user or password are refused.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ connection: QueueConnectionDraftSchema, secrets: SecretsInput.optional() }),
  handler: async ({ connection, secrets }, ctx) => {
    const w = ws(ctx);
    const id = connection.id ?? newId();
    const existing = connection.id ? await w.store.get<QueueConnection>(QUEUES_COLLECTION, connection.id) : undefined;
    const merged = merge(existing, connection, id);
    if (secrets && Object.keys(secrets).length) {
      if (!ctx.host.secrets.available) throw new QuiverError('NOT_SUPPORTED', 'Secret storage is not available on this machine');
      await writeSecrets(w, ctx.host, id, secrets);
    }
    await w.store.put(QUEUES_COLLECTION, merged);
    // The store announces the file; the secrets live outside it.
    if (secrets) changed(ctx, 'connections', id);
    return getConnection(w, id);
  },
});

const connectionDelete = defineCommand({
  id: 'queues.connection.delete',
  title: 'Delete queue connection',
  description: 'Stops the live consumers of a queue connection, closes its clients, and deletes it with its stored secrets.',
  scope: 'workspace',
  mutating: true,
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => {
    const w = ws(ctx);
    const item = await w.store.get<QueueConnection>(QUEUES_COLLECTION, id);
    await consumers.stopConnection(w.id, id);
    const kind = QueueKindSchema.safeParse(item?.kind);
    await DRIVERS[kind.success ? kind.data : 'memory'].close?.(id);
    await writeSecrets(w, ctx.host, id, Object.fromEntries(Object.keys((await secretNames(w))[id] ?? {}).map((n) => [n, null])));
    const deleted = await w.store.remove(QUEUES_COLLECTION, id);
    changed(ctx, 'connections', id);
    return { deleted };
  },
});

const connectionTest = defineCommand({
  id: 'queues.connection.test',
  title: 'Test queue connection',
  description:
    'Connects to the broker and reports `{ ok, message }`. Give `id` to test a saved connection, `connection` (and `secrets`) to test unsaved settings, or both to test changes on top of a saved one.',
  scope: 'workspace',
  input: z.object({ id: z.string().optional(), connection: QueueConnectionDraftSchema.optional(), secrets: SecretsInput.optional() }),
  handler: async ({ id, connection, secrets }, ctx) => {
    const w = ws(ctx);
    const base = id ? await getConnection(w, id) : undefined;
    if (!base && !connection) throw new QuiverError('INVALID_INPUT', 'Give id or connection');
    // An unsaved connection gets an id of its own so it never shares a pooled client.
    const target = merge(base, connection ?? {}, base?.id ?? `test-${newId()}`);
    const stored = base ? await readSecrets(w, ctx.host, base.id) : {};
    const merged: QueueSecrets = { ...stored };
    for (const [name, value] of Object.entries(secrets ?? {})) {
      if (value) merged[name] = value;
      else delete merged[name];
    }
    try {
      return await driverFor(target).test(target, merged);
    } catch (err) {
      return { ok: false, message: (err as Error).message || String(err) };
    }
  },
});

// ---------- destinations ----------

const destinationList = defineCommand({
  id: 'queues.destination.list',
  title: 'List topics and queues',
  description: 'Lists the topics (Kafka, memory) or queues (SQS, RabbitMQ) of a connection with message counts and partitions where the broker reports them.',
  scope: 'workspace',
  input: ConnectionInput,
  handler: async ({ connectionId }, ctx) => {
    const { connection, driver, secrets } = await open(ctx, connectionId);
    return driver.listDestinations(connection, secrets);
  },
});

const destinationDescribe = defineCommand({
  id: 'queues.destination.describe',
  title: 'Describe topic or queue',
  description: 'One topic or queue in detail: counts, partitions with their offsets, and broker settings that differ from the defaults.',
  scope: 'workspace',
  input: QueueDestinationInputSchema,
  handler: async ({ connectionId, destination }, ctx) => {
    const { connection, driver, secrets } = await open(ctx, connectionId);
    return driver.describe(connection, secrets, destination);
  },
});

const destinationPurge = defineCommand({
  id: 'queues.destination.purge',
  title: 'Purge topic or queue',
  description: 'Deletes every message in a topic or queue. Kafka deletes records up to the end of each partition; offsets keep counting from there.',
  scope: 'workspace',
  mutating: true,
  input: QueueDestinationInputSchema,
  handler: async ({ connectionId, destination }, ctx) => {
    const { connection, driver, secrets } = await open(ctx, connectionId);
    if (!driver.purge) unsupported(connection, 'purge');
    await driver.purge(connection, secrets, destination);
    await record(ctx, connection, { action: 'purge', destination });
    changed(ctx, 'messages', connectionId);
    return { purged: true };
  },
});

const destinationCreate = defineCommand({
  id: 'queues.destination.create',
  title: 'Create topic or queue',
  description: 'Creates a topic (with `partitions`, default 1) or a queue (`fifo` for an SQS FIFO queue, whose name must end in .fifo).',
  scope: 'workspace',
  mutating: true,
  input: QueueCreateInputSchema,
  handler: async ({ connectionId, destination, partitions, fifo }, ctx) => {
    const { connection, driver, secrets } = await open(ctx, connectionId);
    if (!driver.create) unsupported(connection, 'create destinations');
    if (!destination.trim()) throw new QuiverError('INVALID_INPUT', 'Give the name of the topic or queue');
    await driver.create(connection, secrets, destination, { partitions, fifo });
    await record(ctx, connection, { action: 'create', destination });
    changed(ctx, 'connections', connectionId);
    return driver.describe(connection, secrets, destination);
  },
});

const destinationDelete = defineCommand({
  id: 'queues.destination.delete',
  title: 'Delete topic or queue',
  description: 'Deletes a topic or queue together with its messages.',
  scope: 'workspace',
  mutating: true,
  input: QueueDestinationInputSchema,
  handler: async ({ connectionId, destination }, ctx) => {
    const { connection, driver, secrets } = await open(ctx, connectionId);
    if (!driver.remove) unsupported(connection, 'delete destinations');
    await driver.remove(connection, secrets, destination);
    await record(ctx, connection, { action: 'delete', destination });
    changed(ctx, 'connections', connectionId);
    return { deleted: true };
  },
});

// ---------- messages ----------

const messagePeek = defineCommand({
  id: 'queues.message.peek',
  title: 'Peek at messages',
  description:
    'Reads up to `limit` messages without consuming them: the newest (`from: latest`) or the oldest (`earliest`), across partitions or from one. Kafka reads with a throwaway consumer group that commits nothing; SQS with a zero visibility timeout; RabbitMQ gets and requeues, which marks the messages redelivered.',
  scope: 'workspace',
  input: QueuePeekInputSchema,
  handler: async ({ connectionId, destination, ...options }, ctx) => {
    const { connection, driver, secrets } = await open(ctx, connectionId);
    return driver.peek(connection, secrets, destination, options);
  },
});

const messageProduce = defineCommand({
  id: 'queues.message.produce',
  title: 'Produce message',
  description:
    'Sends one message to a topic or queue, with an optional key, headers and partition (Kafka), group and deduplication ids and delay (SQS), or exchange (RabbitMQ, with the destination as routing key). Returns the id the broker gave it. The message is kept in the history.',
  scope: 'workspace',
  mutating: true,
  input: QueueProduceInputSchema,
  handler: async ({ connectionId, destination, ...message }, ctx) => {
    const { connection, driver, secrets } = await open(ctx, connectionId);
    const result = await driver.produce(connection, secrets, destination, message);
    const truncated = message.body.length > HISTORY_BODY_LIMIT;
    await record(ctx, connection, {
      action: 'produce',
      destination,
      message: {
        key: message.key,
        headers: message.headers,
        body: truncated ? message.body.slice(0, HISTORY_BODY_LIMIT) : message.body,
        ...(truncated ? { truncated } : {}),
        partition: message.partition,
        groupId: message.groupId,
        exchange: message.exchange,
        id: result.id,
      },
    });
    changed(ctx, 'messages', connectionId);
    return result;
  },
});

const messageWait = defineCommand({
  id: 'queues.message.wait',
  title: 'Wait for a message',
  description:
    'Blocks until a new message arrives on a topic or queue whose body, key or a header value contains `match` (ignoring case; any message when empty), or until `timeoutMs`. Only messages that arrive after the call count. Returns `{ message, timedOut }`. Kafka reads with a throwaway group; SQS and RabbitMQ consumers may take the message off the queue.',
  scope: 'workspace',
  input: QueueWaitInputSchema,
  handler: async ({ connectionId, destination, match, timeoutMs }, ctx) => {
    const { connection, driver, secrets } = await open(ctx, connectionId);
    try {
      return await waitForMessage(driver, connection, secrets, destination, match, timeoutMs);
    } catch (err) {
      if (err instanceof QuiverError) throw err;
      throw new QuiverError('REQUEST_FAILED', (err as Error).message || String(err));
    }
  },
});

// ---------- live consumers ----------

const ConsumerIdInput = z.object({ consumerId: z.string().describe('Id from queues.consumer.start or queues.consumer.list') });

async function liveConsumer(ctx: CommandContext, consumerId: string) {
  const l = consumers.get(ws(ctx).id, consumerId);
  if (!l) throw new QuiverError('NOT_FOUND', `Consumer ${consumerId} not found`);
  return l;
}

const consumerStart = defineCommand({
  id: 'queues.consumer.start',
  title: 'Start a live tail',
  description:
    'Starts a live consumer on a topic or queue, from new messages (`latest`) or from the start (`earliest`), and returns it. Read what arrives with queues.consumer.read; the last 1000 messages are kept. Kafka tails use a throwaway group that commits nothing.',
  scope: 'workspace',
  input: QueueConsumeInputSchema,
  handler: async ({ connectionId, destination, from }, ctx) => {
    const { connection, driver, secrets } = await open(ctx, connectionId);
    return consumers.start(ctx.host, ws(ctx).id, driver, connection, secrets, destination, from);
  },
});

const consumerStop = defineCommand({
  id: 'queues.consumer.stop',
  title: 'Stop a live tail',
  description: 'Stops a live consumer. Its messages stay readable until `forget` is set or the workspace closes.',
  scope: 'workspace',
  input: ConsumerIdInput.extend({ forget: z.boolean().default(false) }),
  handler: async ({ consumerId, forget }, ctx) => consumers.stop(await liveConsumer(ctx, consumerId), forget),
});

const consumerRead = defineCommand({
  id: 'queues.consumer.read',
  title: 'Read a live tail',
  description:
    'Messages a live consumer received after `cursor` (0 for all it still holds), oldest first, at most `limit`, optionally only those containing `match`. Pass the returned `cursor` next time; `dropped` counts messages that left the buffer unread. Also returns the consumer and its status.',
  scope: 'workspace',
  input: ConsumerIdInput.extend({
    cursor: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(1000).default(200),
    match: z.string().default(''),
  }),
  handler: async ({ consumerId, cursor, limit, match }, ctx) => consumers.read(await liveConsumer(ctx, consumerId), cursor, limit, match),
});

const consumerList = defineCommand({
  id: 'queues.consumer.list',
  title: 'List live tails',
  description: 'The live consumers of this workspace, running or stopped, optionally of one connection.',
  scope: 'workspace',
  input: z.object({ connectionId: z.string().optional() }),
  handler: async ({ connectionId }, ctx) => consumers.list(ws(ctx).id, connectionId),
});

// ---------- groups and history ----------

const groupList = defineCommand({
  id: 'queues.group.list',
  title: 'List consumer groups',
  description: "Kafka consumer groups with their state, member count and lag per topic partition (committed offset against the partition's end). Quiver's own throwaway peek groups are left out.",
  scope: 'workspace',
  input: ConnectionInput,
  handler: async ({ connectionId }, ctx) => {
    const { connection, driver, secrets } = await open(ctx, connectionId);
    if (!driver.groups) unsupported(connection, 'list consumer groups');
    return driver.groups(connection, secrets);
  },
});

const historyList = defineCommand({
  id: 'queues.history.list',
  title: 'List queue history',
  description: 'Messages produced and destinations purged, created or deleted on this machine, newest first, optionally for one connection or destination.',
  scope: 'workspace',
  input: z.object({ connectionId: z.string().optional(), destination: z.string().optional(), limit: z.number().int().min(1).max(1000).default(100) }),
  handler: async ({ connectionId, destination, limit }, ctx) => {
    const all = await ws(ctx).store.readLog<QueueHistoryEntry>(QUEUES_HISTORY_LOG, connectionId || destination ? 5000 : limit);
    return all.filter((e) => (!connectionId || e.connectionId === connectionId) && (!destination || e.destination === destination)).slice(0, limit);
  },
});

const historyClear = defineCommand({
  id: 'queues.history.clear',
  title: 'Clear queue history',
  description: 'Clears the queue history of this workspace on this machine.',
  scope: 'workspace',
  mutating: true,
  input: z.object({}),
  handler: async (_input, ctx) => {
    await ws(ctx).store.clearLog(QUEUES_HISTORY_LOG);
    changed(ctx, 'messages');
    return { cleared: true };
  },
});

/** Close every client of the workspace's connections and stop its tails; the memory broker's topics go with them. */
export async function closeQueues(w: WorkspaceApi): Promise<void> {
  await consumers.stopWorkspace(w.id);
  const items = await w.store.list<QueueConnection>(QUEUES_COLLECTION).catch(() => [] as QueueConnection[]);
  await Promise.all(
    items.map((c) => {
      const kind = QueueKindSchema.safeParse(c.kind);
      return DRIVERS[kind.success ? kind.data : 'memory'].close?.(c.id).catch(() => undefined);
    }),
  );
}

export const queueCommands: CommandDefinition[] = [
  connectionList,
  connectionGet,
  connectionSave,
  connectionDelete,
  connectionTest,
  destinationList,
  destinationDescribe,
  destinationPurge,
  destinationCreate,
  destinationDelete,
  messagePeek,
  messageProduce,
  messageWait,
  consumerStart,
  consumerStop,
  consumerRead,
  consumerList,
  groupList,
  historyList,
  historyClear,
] as CommandDefinition[];
