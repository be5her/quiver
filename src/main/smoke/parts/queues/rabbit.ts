import { connect } from 'amqplib';
import type { QueueConnection, QueueDestination, QueueMessage } from '@quiver/core';
import { startFakeRabbitMgmt } from '../../fake-rabbit-mgmt';
import { freePort, type SmokeContext, type SmokeSection } from '../../part';

type Summary = QueueConnection & { secrets: string[] };
type Consumer = { id: string; status: string; error: string | null };
type Read = { consumer: Consumer; messages: QueueMessage[]; cursor: number };
type Wait = { message: QueueMessage | null; timedOut: boolean };

// Queues: RabbitMQ. The management API checks always run, against a fake the section starts and stops itself, with
// nothing listening for AMQP. The AMQP checks need a real broker and run only when QUIVER_SMOKE_RABBIT names one
// (`amqp://user:pass@host:5672/vhost`; its management API is QUIVER_SMOKE_RABBIT_MANAGEMENT or port 15672 of that host).
const section: SmokeSection = async (t) => {
  await management(t);
  await live(t);
};

async function management({ host, check, run, ws }: SmokeContext): Promise<void> {
  const code = async (id: string, input: unknown): Promise<string> => {
    const out = await host.invoke(id, input, { caller: 'ui', workspaceId: ws.id });
    return out.ok ? 'ok' : out.error.code;
  };
  const fake = await startFakeRabbitMgmt();
  // A port nothing listens on, so AMQP fails fast and only the management API answers.
  const amqpPort = await freePort();
  const fields = { kind: 'rabbit', host: '127.0.0.1', port: amqpPort, username: fake.username, managementUrl: fake.url };
  const conn = await run<Summary>('queues.connection.save', { connection: { name: 'smoke rabbit', ...fields }, secrets: { password: fake.password } }, ws.id);
  const wrong = await run<Summary>('queues.connection.save', { connection: { name: 'smoke rabbit wrong', ...fields }, secrets: { password: 'nope' } }, ws.id);
  try {
    const tested = await run<{ ok: boolean; message: string }>('queues.connection.test', { id: conn.id }, ws.id);
    check('rabbit: test reports the management API and the AMQP failure apart', !tested.ok && tested.message.includes('management API reachable (RabbitMQ 4.2.0-fake)') && tested.message.includes('AMQP failed'), tested);

    const pasted = await run<{ ok: boolean; message: string }>(
      'queues.connection.test',
      { connection: { ...fields, host: `amqp://${fake.username}:${fake.password}@127.0.0.1` }, secrets: { password: fake.password } },
      ws.id,
    );
    check('rabbit: a pasted amqp:// URL as host is refused rather than connected to', !pasted.ok && pasted.message.includes('plain host name'), pasted);

    const listed = await run<QueueDestination[]>('queues.destination.list', { connectionId: conn.id }, ws.id);
    const orders = listed.find((d) => d.name === 'orders');
    check(
      'rabbit: list has queues with counts and exchanges as exchange:<name>, without the default, amq.* or tail queues',
      listed.map((d) => d.name).join() === 'direct-only,events.stream,orders,exchange:audit,exchange:shop' && orders?.messages === 3 && orders.consumers === 1 && listed.find((d) => d.name === 'exchange:shop')?.kind === 'exchange',
      listed.map((d) => `${d.kind}:${d.name}`),
    );
    check('rabbit: the management API is asked for the vhost / as %2F with the connection user', fake.seen.some((p) => p.startsWith('/api/queues/%2F?columns=')) && fake.seen.includes('/api/exchanges/%2F'), fake.seen);

    const queue = await run<QueueDestination>('queues.destination.describe', { connectionId: conn.id, destination: 'orders' }, ws.id);
    check(
      'rabbit: describe a queue shows its type, counts, arguments and bindings',
      queue.messages === 3 && queue.details?.type === 'classic' && queue.details['x-max-length'] === '1000' && queue.details['binding 1'] === '(default) → orders' && queue.details['binding 2'] === 'shop → order.*',
      queue,
    );
    const exchange = await run<QueueDestination>('queues.destination.describe', { connectionId: conn.id, destination: 'exchange:shop' }, ws.id);
    check(
      'rabbit: describe an exchange shows its type and where it routes',
      exchange.kind === 'exchange' && exchange.details?.type === 'topic' && exchange.details['binding 1'] === 'order.* → orders' && exchange.details['binding 2'] === '# → exchange:audit',
      exchange,
    );
    check('rabbit: describe of a missing queue or exchange is NOT_FOUND', (await code('queues.destination.describe', { connectionId: conn.id, destination: 'nope' })) === 'NOT_FOUND' && (await code('queues.destination.describe', { connectionId: conn.id, destination: 'exchange:nope' })) === 'NOT_FOUND');

    check('rabbit: peek of an exchange is NOT_SUPPORTED', (await code('queues.message.peek', { connectionId: conn.id, destination: 'exchange:shop' })) === 'NOT_SUPPORTED');
    check('rabbit: purge of an exchange is NOT_SUPPORTED', (await code('queues.destination.purge', { connectionId: conn.id, destination: 'exchange:shop' })) === 'NOT_SUPPORTED');
    check(
      'rabbit: a tail of a queue reached only through the default exchange is NOT_SUPPORTED, since it would consume',
      (await code('queues.consumer.start', { connectionId: conn.id, destination: 'direct-only' })) === 'NOT_SUPPORTED',
    );
    check('rabbit: a tail of a missing queue is NOT_FOUND', (await code('queues.consumer.start', { connectionId: conn.id, destination: 'nope' })) === 'NOT_FOUND');
    check('rabbit: a key on a message sent straight to a queue is refused', (await code('queues.message.produce', { connectionId: conn.id, destination: 'orders', key: 'k', body: 'x' })) === 'INVALID_INPUT');

    const refusedBefore = fake.refused;
    check('rabbit: a wrong password is AUTH_FAILED', (await code('queues.destination.list', { connectionId: wrong.id })) === 'AUTH_FAILED' && fake.refused > refusedBefore);
  } finally {
    await run('queues.connection.delete', { id: conn.id }, ws.id);
    await run('queues.connection.delete', { id: wrong.id }, ws.id);
    await fake.close();
  }
}

async function live({ host, check, run, ws }: SmokeContext): Promise<void> {
  const url = process.env.QUIVER_SMOKE_RABBIT?.trim();
  if (!url) {
    console.log('SKIP queues: rabbit AMQP checks (set QUIVER_SMOKE_RABBIT=amqp://user:pass@host:5672/vhost to run them against a broker)');
    return;
  }
  const code = async (id: string, input: unknown): Promise<string> => {
    const out = await host.invoke(id, input, { caller: 'ui', workspaceId: ws.id });
    return out.ok ? 'ok' : out.error.code;
  };
  const parsed = new URL(url);
  const ssl = parsed.protocol === 'amqps:';
  const vhost = decodeURIComponent(parsed.pathname.slice(1)) || '/';
  const managementUrl = process.env.QUIVER_SMOKE_RABBIT_MANAGEMENT?.trim() || `${ssl ? 'https' : 'http'}://${parsed.hostname}:${ssl ? 15671 : 15672}`;
  const conn = await run<Summary>(
    'queues.connection.save',
    {
      connection: { name: 'smoke rabbit live', kind: 'rabbit', host: parsed.hostname, port: parsed.port ? Number(parsed.port) : undefined, vhost, ssl, username: decodeURIComponent(parsed.username), managementUrl },
      secrets: { password: decodeURIComponent(parsed.password) },
    },
    ws.id,
  );
  const stamp = Date.now().toString(36);
  const queue = `quiver-smoke-${stamp}`;
  const stream = `quiver-smoke-stream-${stamp}`;
  const exchange = `quiver-smoke-x-${stamp}`;
  // The smoke binds and declares a stream with amqplib itself: Quiver has no command for bindings.
  const admin = await connect(url);
  const ch = await admin.createChannel();
  ch.on('error', () => undefined);
  const readAll = async (consumerId: string, want: number): Promise<Read> => {
    let read: Read = { consumer: { id: consumerId, status: '', error: null }, messages: [], cursor: 0 };
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
      read = await run<Read>('queues.consumer.read', { consumerId }, ws.id);
      if (read.messages.length >= want) break;
    }
    return read;
  };
  try {
    const tested = await run<{ ok: boolean; message: string }>('queues.connection.test', { id: conn.id }, ws.id);
    check('rabbit live: test connects over AMQP and the management API', tested.ok, tested.message);

    await run('queues.destination.create', { connectionId: conn.id, destination: queue }, ws.id);
    await run('queues.destination.create', { connectionId: conn.id, destination: `exchange:${exchange}` }, ws.id);
    check('rabbit live: create of an existing queue is CONFLICT', (await code('queues.destination.create', { connectionId: conn.id, destination: queue })) === 'CONFLICT');
    await ch.bindQueue(queue, exchange, 'smoke.#');
    await ch.assertQueue(stream, { durable: true, arguments: { 'x-queue-type': 'stream' } });

    const queueTail = await run<Consumer>('queues.consumer.start', { connectionId: conn.id, destination: queue }, ws.id);
    const exchangeTail = await run<Consumer>('queues.consumer.start', { connectionId: conn.id, destination: `exchange:${exchange}` }, ws.id);
    for (let i = 1; i <= 3; i++) await run('queues.message.produce', { connectionId: conn.id, destination: `smoke.${i}`, exchange, headers: { n: String(i) }, body: `rabbit ${i}` }, ws.id);
    await run('queues.message.produce', { connectionId: conn.id, destination: queue, headers: {}, body: 'rabbit direct' }, ws.id);

    const oldest = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: queue, limit: 2, from: 'earliest' }, ws.id);
    const newest = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: queue, limit: 2 }, ws.id);
    check(
      'rabbit live: peek reads the oldest and the newest with routing key and headers',
      oldest.map((m) => m.body).join() === 'rabbit 1,rabbit 2' && newest.map((m) => m.body).join() === 'rabbit 3,rabbit direct' && oldest[0]?.key === 'smoke.1' && oldest[0].headers.n === '1' && oldest[0].attributes?.exchange === exchange,
      { oldest: oldest.map((m) => m.body), newest: newest.map((m) => m.body) },
    );
    const again = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: queue, limit: 10, from: 'earliest' }, ws.id);
    check('rabbit live: peek requeues, so nothing is consumed, and marks the messages redelivered', again.length === 4 && again[0]?.attributes?.redelivered === 'true', again.map((m) => m.attributes?.redelivered));
    const described = await run<QueueDestination>('queues.destination.describe', { connectionId: conn.id, destination: queue }, ws.id);
    check('rabbit live: describe counts the messages exactly and shows the binding', described.messages === 4 && Object.values(described.details ?? {}).includes(`${exchange} → smoke.#`), described);

    const fromQueue = await readAll(queueTail.id, 3);
    check(
      'rabbit live: a tail of a queue gets a copy of what its exchanges route, not what is sent to it by name',
      fromQueue.messages.map((m) => m.body).join() === 'rabbit 1,rabbit 2,rabbit 3' && fromQueue.consumer.status === 'running',
      fromQueue.messages.map((m) => m.body),
    );
    const fromExchange = await readAll(exchangeTail.id, 3);
    check('rabbit live: a tail of a topic exchange gets everything published to it', fromExchange.messages.length === 3, fromExchange.messages.map((m) => m.body));

    const waiting = run<Wait>('queues.message.wait', { connectionId: conn.id, destination: `exchange:${exchange}`, match: 'needle', timeoutMs: 10_000 }, ws.id);
    await new Promise((r) => setTimeout(r, 300));
    await run('queues.message.produce', { connectionId: conn.id, destination: `exchange:${exchange}`, key: 'smoke.needle', headers: {}, body: 'a needle in rabbit' }, ws.id);
    const waited = await waiting;
    check('rabbit live: wait returns the matching message', waited.message?.body === 'a needle in rabbit' && waited.message.key === 'smoke.needle', waited);

    check('rabbit live: a publish to a missing queue or exchange is NOT_FOUND', (await code('queues.message.produce', { connectionId: conn.id, destination: `${queue}-missing`, body: 'x' })) === 'NOT_FOUND' && (await code('queues.message.produce', { connectionId: conn.id, destination: 'k', exchange: `${exchange}-missing`, body: 'x' })) === 'NOT_FOUND');

    for (let i = 1; i <= 2; i++) await run('queues.message.produce', { connectionId: conn.id, destination: stream, headers: {}, body: `stream ${i}` }, ws.id);
    const streamPeek = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: stream, limit: 10, from: 'earliest' }, ws.id);
    const streamTail = await run<Consumer>('queues.consumer.start', { connectionId: conn.id, destination: stream, from: 'earliest' }, ws.id);
    const fromStream = await readAll(streamTail.id, 2);
    check(
      'rabbit live: a stream queue is peeked and tailed from its first offset',
      streamPeek.map((m) => m.body).join() === 'stream 1,stream 2' && fromStream.messages.map((m) => m.body).join() === 'stream 1,stream 2',
      { peek: streamPeek.map((m) => m.body), tail: fromStream.messages.map((m) => m.body) },
    );

    for (const id of [queueTail.id, exchangeTail.id, streamTail.id]) await run('queues.consumer.stop', { consumerId: id, forget: true }, ws.id);
    check('rabbit live: a publish nothing routes is refused (once no tail is bound to the exchange)', (await code('queues.message.produce', { connectionId: conn.id, destination: 'nowhere', exchange, headers: {}, body: 'lost' })) === 'REQUEST_FAILED');
    const listed = await run<QueueDestination[]>('queues.destination.list', { connectionId: conn.id }, ws.id);
    check('rabbit live: list has the queue and the exchange, and no tail queue', listed.some((d) => d.name === queue) && listed.some((d) => d.name === `exchange:${exchange}`) && !listed.some((d) => d.name.startsWith('quiver-tail-')), listed.map((d) => d.name));

    await run('queues.destination.purge', { connectionId: conn.id, destination: queue }, ws.id);
    const purged = await run<QueueDestination>('queues.destination.describe', { connectionId: conn.id, destination: queue }, ws.id);
    check('rabbit live: purge empties the queue', purged.messages === 0, purged);

    await run('queues.destination.delete', { connectionId: conn.id, destination: queue }, ws.id);
    await run('queues.destination.delete', { connectionId: conn.id, destination: `exchange:${exchange}` }, ws.id);
    check('rabbit live: deleted queue and exchange are gone', (await code('queues.destination.describe', { connectionId: conn.id, destination: queue })) === 'NOT_FOUND' && (await code('queues.destination.describe', { connectionId: conn.id, destination: `exchange:${exchange}` })) === 'NOT_FOUND');
  } finally {
    await ch.deleteQueue(queue).catch(() => undefined);
    await ch.deleteQueue(stream).catch(() => undefined);
    await ch.deleteExchange(exchange).catch(() => undefined);
    await admin.close().catch(() => undefined);
    await run('queues.connection.delete', { id: conn.id }, ws.id);
  }
}

export default section;
