import type { QueueConnection, QueueConsumerGroup, QueueDestination, QueueMessage } from '@quiver/core';
import type { SmokeSection } from '../../part';

type Consumer = { id: string; status: string; error: string | null };
type Read = { consumer: Consumer; messages: QueueMessage[]; cursor: number };
type Wait = { message: QueueMessage | null; timedOut: boolean };

// Queues: a real Kafka broker, only when QUIVER_SMOKE_KAFKA=host:port names one (CI starts no broker).
// Every topic it makes has a fresh name and is deleted again.
const section: SmokeSection = async ({ check, run, ws }) => {
  const broker = process.env.QUIVER_SMOKE_KAFKA?.trim();
  if (!broker) {
    console.log('SKIP queues: kafka checks (set QUIVER_SMOKE_KAFKA=host:port to run them against a broker)');
    return;
  }
  const conn = await run<QueueConnection>('queues.connection.save', { connection: { name: 'smoke kafka live', kind: 'kafka', brokers: [broker] } }, ws.id);
  const topic = `quiver-smoke-${Date.now().toString(36)}`;
  try {
    const tested = await run<{ ok: boolean; message: string }>('queues.connection.test', { id: conn.id }, ws.id);
    check('kafka: test connects to the broker', tested.ok, tested.message);

    const created = await run<QueueDestination>('queues.destination.create', { connectionId: conn.id, destination: topic, partitions: 2 }, ws.id);
    check('kafka: create makes a topic with partitions', created.partitions === 2 && created.messages === 0, created);
    const listed = await run<QueueDestination[]>('queues.destination.list', { connectionId: conn.id }, ws.id);
    check('kafka: the topic is listed and internal topics are not', listed.some((d) => d.name === topic) && !listed.some((d) => d.name.startsWith('__')), listed.length);

    const tail = await run<Consumer>('queues.consumer.start', { connectionId: conn.id, destination: topic }, ws.id);
    for (let i = 1; i <= 4; i++) {
      await run('queues.message.produce', { connectionId: conn.id, destination: topic, key: `k${i % 2}`, headers: { n: String(i) }, body: `kafka ${i}` }, ws.id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const newest = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: topic, limit: 3 }, ws.id);
    const oldest = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: topic, limit: 2, from: 'earliest' }, ws.id);
    check(
      'kafka: peek reads the newest and the oldest across partitions, with keys and headers',
      newest.map((m) => m.body).join() === 'kafka 2,kafka 3,kafka 4' && oldest.map((m) => m.body).join() === 'kafka 1,kafka 2' && newest[2].key === 'k0' && newest[2].headers.n === '4',
      { newest: newest.map((m) => m.body), oldest: oldest.map((m) => m.body) },
    );
    const again = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: topic, limit: 10, from: 'earliest' }, ws.id);
    check('kafka: peek does not consume', again.length === 4, again.length);

    let read: Read = { consumer: tail, messages: [], cursor: 0 };
    for (const end = Date.now() + 15_000; Date.now() < end && read.messages.length < 4; await new Promise((r) => setTimeout(r, 200))) {
      read = await run<Read>('queues.consumer.read', { consumerId: tail.id }, ws.id);
    }
    check('kafka: a live tail started before producing gets every new message', read.messages.length === 4 && read.consumer.status === 'running', { got: read.messages.map((m) => m.body), status: read.consumer });

    const waiting = run<Wait>('queues.message.wait', { connectionId: conn.id, destination: topic, match: 'needle', timeoutMs: 20_000 }, ws.id);
    // The wait starts from the end offsets at the time of the call, so producing right away is safe.
    await new Promise((r) => setTimeout(r, 300));
    await run('queues.message.produce', { connectionId: conn.id, destination: topic, body: 'a needle in kafka', headers: {} }, ws.id);
    const waited = await waiting;
    check('kafka: wait returns the matching message', waited.message?.body === 'a needle in kafka', waited);

    const groups = await run<QueueConsumerGroup[]>('queues.group.list', { connectionId: conn.id }, ws.id);
    check('kafka: group list leaves out the throwaway peek, tail and wait groups', !groups.some((g) => g.id.startsWith('quiver-')), groups.map((g) => g.id));

    await run('queues.consumer.stop', { consumerId: tail.id, forget: true }, ws.id);
    await run('queues.destination.purge', { connectionId: conn.id, destination: topic }, ws.id);
    const purged = await run<QueueDestination>('queues.destination.describe', { connectionId: conn.id, destination: topic }, ws.id);
    check('kafka: purge deletes the records', purged.messages === 0, purged);
  } finally {
    await run('queues.destination.delete', { connectionId: conn.id, destination: topic }, ws.id).catch(() => undefined);
    await run('queues.connection.delete', { id: conn.id }, ws.id);
  }
};

export default section;
