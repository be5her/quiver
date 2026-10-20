import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostEventName, HostEvents, QueueConnection, QueueDestination, QueueMessage, WorkspaceInfo } from '@quiver/core';
import type { SmokeSection } from '../../part';

type Summary = QueueConnection & { secrets: string[] };
type Consumer = { id: string; status: string; error: string | null; received: number };
type Read = { consumer: Consumer; messages: QueueMessage[]; cursor: number; dropped: number };
type Wait = { message: QueueMessage | null; timedOut: boolean };
type History = { action: string; destination: string; connectionId: string; message?: { body: string; key?: string; id: string } };

// Queues: the commands over the in-memory broker, which needs nothing outside the app, so these checks always run.
const section: SmokeSection = async ({ host, check, run, ws, folder, rpc, toolNames }) => {
  const fail = async (id: string, input: unknown): Promise<string> => {
    const out = await host.invoke(id, input, { caller: 'ui', workspaceId: ws.id });
    return out.ok ? 'ok' : out.error.code;
  };
  const events: { event: HostEventName; payload: HostEvents[HostEventName] }[] = [];
  const emit = host.emit.bind(host);
  host.emit = (event, payload) => {
    events.push({ event, payload });
    emit(event, payload);
  };
  const queueEvents = (reason: string) => events.filter((e) => e.event === 'queues.changed' && (e.payload as HostEvents['queues.changed']).reason === reason);

  try {
    // ---------- connections and secrets ----------
    const mem = await run<Summary>('queues.connection.save', { connection: { name: 'smoke memory', kind: 'memory' } }, ws.id);
    const onDisk = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'queues', `${mem.id}.json`), 'utf8')) as QueueConnection;
    check('queues: a connection is committed under .quiver/queues/<id>.json', onDisk.id === mem.id && onDisk.kind === 'memory' && onDisk.name === 'smoke memory', onDisk);

    const kafka = await run<Summary>(
      'queues.connection.save',
      { connection: { name: 'smoke kafka', kind: 'kafka', brokers: [' 127.0.0.1:1 ', ''], sasl: 'plain', username: 'smoke' }, secrets: { password: 'k4fka-pass' } },
      ws.id,
    );
    const kafkaFile = await fs.readFile(path.join(folder, '.quiver', 'queues', `${kafka.id}.json`), 'utf8');
    const localDir = path.join(folder, '.quiver', 'local');
    const localText = (await Promise.all((await fs.readdir(localDir)).map((f) => fs.readFile(path.join(localDir, f), 'utf8').catch(() => '')))).join('\n');
    check(
      'queues: the password goes to host.secrets, encrypted, never into the committed file',
      kafka.secrets.join() === 'password' && !kafkaFile.includes('k4fka-pass') && !localText.includes('k4fka-pass') && kafka.brokers.join() === '127.0.0.1:1',
      { secrets: kafka.secrets, brokers: kafka.brokers },
    );
    check('queues: secret events are announced', queueEvents('connections').some((e) => (e.payload as HostEvents['queues.changed']).connectionId === kafka.id));
    const renamed = await run<Summary>('queues.connection.save', { connection: { id: kafka.id, name: 'smoke kafka 2' } }, ws.id);
    check('queues: a save changes only the fields it names and keeps the secrets', renamed.name === 'smoke kafka 2' && renamed.sasl === 'plain' && renamed.username === 'smoke' && renamed.secrets.join() === 'password', renamed);
    check(
      'queues: a URL carrying a user or password is refused',
      (await fail('queues.connection.save', { connection: { kind: 'rabbit', managementUrl: 'http://guest:guest@localhost:15672' } })) === 'INVALID_INPUT',
    );
    const listed = await run<Summary[]>('queues.connection.list', {}, ws.id);
    check('queues: connections are listed by name', listed.map((c) => c.name).join() === 'smoke kafka 2,smoke memory', listed.map((c) => c.name));
    const memTest = await run<{ ok: boolean; message: string }>('queues.connection.test', { id: mem.id }, ws.id);
    const deadTest = await run<{ ok: boolean; message: string }>('queues.connection.test', { id: kafka.id }, ws.id);
    const draftTest = await run<{ ok: boolean; message: string }>('queues.connection.test', { connection: { kind: 'kafka', brokers: [] } }, ws.id);
    check('queues: test reports ok for memory and a failure for an unreachable or incomplete broker', memTest.ok && !deadTest.ok && Boolean(deadTest.message) && !draftTest.ok && draftTest.message.includes('brokers'), {
      memTest,
      deadTest,
      draftTest,
    });

    // ---------- destinations ----------
    const created = await run<QueueDestination>('queues.destination.create', { connectionId: mem.id, destination: 'orders', partitions: 3 }, ws.id);
    check('queues: create makes a topic with partitions', created.name === 'orders' && created.partitions === 3 && created.messages === 0, created);
    check('queues: creating it again is a conflict', (await fail('queues.destination.create', { connectionId: mem.id, destination: 'orders' })) === 'CONFLICT');
    check('queues: an unknown topic is not found', (await fail('queues.message.peek', { connectionId: mem.id, destination: 'nope' })) === 'NOT_FOUND');

    // ---------- produce and peek ----------
    const produced: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = await run<{ id: string }>('queues.message.produce', { connectionId: mem.id, destination: 'orders', key: `customer-${i % 2}`, headers: { trace: `t-${i}` }, body: `{"order":${i}}` }, ws.id);
      produced.push(r.id);
      await new Promise((r) => setTimeout(r, 2));
    }
    check('queues: produce returns partition:offset ids', produced.every((id) => /^\d+:\d+$/.test(id)) && new Set(produced).size === 5, produced);
    check('queues: produce announces new messages', queueEvents('messages').length >= 5, queueEvents('messages').length);
    const newest = await run<QueueMessage[]>('queues.message.peek', { connectionId: mem.id, destination: 'orders', limit: 2 }, ws.id);
    const oldest = await run<QueueMessage[]>('queues.message.peek', { connectionId: mem.id, destination: 'orders', limit: 2, from: 'earliest' }, ws.id);
    check(
      'queues: peek reads the newest or the oldest across partitions, with key and headers',
      newest.map((m) => m.body).join() === '{"order":4},{"order":5}' && oldest.map((m) => m.body).join() === '{"order":1},{"order":2}' && newest[1].key === 'customer-1' && newest[1].headers.trace === 't-5',
      { newest: newest.map((m) => m.body), oldest: oldest.map((m) => m.body) },
    );
    const again = await run<QueueMessage[]>('queues.message.peek', { connectionId: mem.id, destination: 'orders', limit: 50 }, ws.id);
    check('queues: peek does not consume', again.length === 5, again.length);
    const p = newest[1].partition!;
    const onePartition = await run<QueueMessage[]>('queues.message.peek', { connectionId: mem.id, destination: 'orders', limit: 50, partition: p }, ws.id);
    check('queues: peek can keep to one partition, and keyed messages share one', onePartition.length > 0 && onePartition.every((m) => m.partition === p && m.key === newest[1].key), onePartition.map((m) => `${m.partition}/${m.key}`));
    const described = await run<QueueDestination>('queues.destination.describe', { connectionId: mem.id, destination: 'orders' }, ws.id);
    const dests = await run<QueueDestination[]>('queues.destination.list', { connectionId: mem.id }, ws.id);
    check('queues: describe and list count the messages', described.messages === 5 && described.partitions === 3 && dests.find((d) => d.name === 'orders')?.messages === 5, { described, dests });

    const history = await run<History[]>('queues.history.list', { connectionId: mem.id }, ws.id);
    check(
      'queues: the history keeps produced messages and actions, newest first',
      history[0]?.action === 'produce' && history[0].message?.body === '{"order":5}' && history[0].message.id === produced[4] && history.at(-1)?.action === 'create' && history.length === 6,
      history.map((h) => h.action),
    );

    // ---------- live tails and wait ----------
    const tail = await run<Consumer>('queues.consumer.start', { connectionId: mem.id, destination: 'orders' }, ws.id);
    const fromStart = await run<Consumer>('queues.consumer.start', { connectionId: mem.id, destination: 'orders', from: 'earliest' }, ws.id);
    await run('queues.message.produce', { connectionId: mem.id, destination: 'orders', body: 'live one', headers: {} }, ws.id);
    await run('queues.message.produce', { connectionId: mem.id, destination: 'orders', body: 'live two', headers: { kind: 'special' } }, ws.id);
    const read1 = await run<Read>('queues.consumer.read', { consumerId: tail.id }, ws.id);
    const read2 = await run<Read>('queues.consumer.read', { consumerId: tail.id, cursor: read1.cursor }, ws.id);
    const filtered = await run<Read>('queues.consumer.read', { consumerId: tail.id, match: 'SPECIAL' }, ws.id);
    const all = await run<Read>('queues.consumer.read', { consumerId: fromStart.id }, ws.id);
    check(
      'queues: a live tail from latest gets only new messages and reads on from its cursor',
      read1.messages.map((m) => m.body).join() === 'live one,live two' && read1.cursor === 2 && read2.messages.length === 0 && read1.consumer.status === 'running' && read1.consumer.received === 2,
      { bodies: read1.messages.map((m) => m.body), cursor: read1.cursor },
    );
    check('queues: a tail filters on header values and from earliest gets everything', filtered.messages.map((m) => m.body).join() === 'live two' && all.messages.length === 7, { filtered: filtered.messages.length, all: all.messages.length });
    check('queues: tails announce what they receive', queueEvents('consumer').some((e) => (e.payload as HostEvents['queues.changed']).consumerId === tail.id));
    const listedTails = await run<Consumer[]>('queues.consumer.list', { connectionId: mem.id }, ws.id);
    check('queues: live tails are listed', listedTails.length === 2, listedTails.length);

    const waiting = run<Wait>('queues.message.wait', { connectionId: mem.id, destination: 'orders', match: 'needle', timeoutMs: 3000 }, ws.id);
    await new Promise((r) => setTimeout(r, 50));
    await run('queues.message.produce', { connectionId: mem.id, destination: 'orders', body: 'hay', headers: {} }, ws.id);
    await run('queues.message.produce', { connectionId: mem.id, destination: 'orders', key: 'with-needle', body: 'found', headers: {} }, ws.id);
    const waited = await waiting;
    const timedOut = await run<Wait>('queues.message.wait', { connectionId: mem.id, destination: 'orders', match: 'never', timeoutMs: 200 }, ws.id);
    check('queues: wait returns the first new message that matches, or times out', waited.message?.body === 'found' && !waited.timedOut && timedOut.timedOut && timedOut.message === null, { waited, timedOut });

    // ---------- purge, groups, delete ----------
    await run('queues.destination.purge', { connectionId: mem.id, destination: 'orders' }, ws.id);
    const afterPurge = await run<QueueMessage[]>('queues.message.peek', { connectionId: mem.id, destination: 'orders', limit: 50 }, ws.id);
    const next = await run<{ id: string }>('queues.message.produce', { connectionId: mem.id, destination: 'orders', body: 'after', headers: {}, partition: 0 }, ws.id);
    check('queues: purge empties the topic and offsets keep counting', afterPurge.length === 0 && Number(next.id.split(':')[1]) > 0, { left: afterPurge.length, next: next.id });
    check('queues: consumer groups are not supported by the memory broker', (await fail('queues.group.list', { connectionId: mem.id })) === 'NOT_SUPPORTED');

    await run('queues.destination.delete', { connectionId: mem.id, destination: 'orders' }, ws.id);
    const ended = await run<Read>('queues.consumer.read', { consumerId: tail.id, cursor: read1.cursor }, ws.id);
    check('queues: deleting a topic ends its tails and removes it', ended.consumer.status === 'stopped' && !(await run<QueueDestination[]>('queues.destination.list', { connectionId: mem.id }, ws.id)).length, ended.consumer);
    const stopped = await run<Consumer>('queues.consumer.stop', { consumerId: fromStart.id, forget: true }, ws.id);
    check('queues: a stopped and forgotten tail leaves the list', stopped.status === 'stopped' && (await fail('queues.consumer.read', { consumerId: fromStart.id })) === 'NOT_FOUND');

    // ---------- agents ----------
    check(
      'queues: commands are exposed to agents',
      ['queues_connection_list', 'queues_message_peek', 'queues_message_produce', 'queues_consumer_read', 'queues_group_list'].every((n) => toolNames.includes(n)),
    );
    await run('queues.message.produce', { connectionId: mem.id, destination: 'agents', body: 'for the agent', headers: {} }, ws.id);
    const agentPeek = await rpc('tools/call', { name: 'queues_message_peek', arguments: { connectionId: mem.id, destination: 'agents' } });
    check('queues: agents may peek', !agentPeek.result?.isError && (agentPeek.result?.content?.[0]?.text ?? '').includes('for the agent'));
    for (const [tool, args] of [
      ['queues_message_produce', { connectionId: mem.id, destination: 'agents', body: 'x' }],
      ['queues_destination_purge', { connectionId: mem.id, destination: 'agents' }],
      ['queues_destination_create', { connectionId: mem.id, destination: 'agents-2' }],
      ['queues_destination_delete', { connectionId: mem.id, destination: 'agents' }],
      ['queues_connection_save', { connection: { name: 'agent' } }],
      ['queues_connection_delete', { id: mem.id }],
      // A draft on top of a saved connection would send its stored password to the draft's broker.
      ['queues_connection_test', { id: kafka.id, connection: { brokers: ['evil.example:9092'], sasl: 'plain', ssl: false } }],
    ] as const) {
      const blocked = await rpc('tools/call', { name: tool, arguments: args });
      check(`queues: mcp blocks ${tool} by default`, blocked.result?.isError === true && (blocked.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }
    const agentTestSaved = await rpc('tools/call', { name: 'queues_connection_test', arguments: { id: mem.id } });
    const agentTestDraft = await rpc('tools/call', { name: 'queues_connection_test', arguments: { connection: { kind: 'kafka', brokers: [] } } });
    check('queues: agents may test a saved connection as it is, or a draft of their own', !agentTestSaved.result?.isError && !agentTestDraft.result?.isError, { agentTestSaved, agentTestDraft });
    const agentConn = await rpc('tools/call', { name: 'queues_connection_get', arguments: { id: kafka.id } });
    check('queues: agents see secret names, never values', !(agentConn.result?.content?.[0]?.text ?? '').includes('k4fka-pass') && (agentConn.result?.content?.[0]?.text ?? '').includes('password'));

    // ---------- deleting a connection; closing the workspace ----------
    const lastTail = await run<Consumer>('queues.consumer.start', { connectionId: mem.id, destination: 'agents' }, ws.id);
    await run('queues.connection.delete', { id: kafka.id }, ws.id);
    await run('queues.connection.delete', { id: mem.id }, ws.id);
    const secretsDoc = await fs.readFile(path.join(localDir, 'queues-secrets.json'), 'utf8').catch(() => '{}');
    check(
      'queues: deleting a connection stops its tails and drops its file and secrets',
      (await fail('queues.consumer.read', { consumerId: lastTail.id })) === 'NOT_FOUND' &&
        !(await fs.stat(path.join(folder, '.quiver', 'queues', `${mem.id}.json`)).catch(() => null)) &&
        !secretsDoc.includes(kafka.id),
      secretsDoc,
    );

    const otherFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-queues-'));
    try {
      let other = await run<WorkspaceInfo>('workspace.open', { path: otherFolder }, null);
      const c = await run<Summary>('queues.connection.save', { connection: { name: 'closing', kind: 'memory' } }, other.id);
      await run('queues.message.produce', { connectionId: c.id, destination: 'kept-in-memory', body: 'x', headers: {} }, other.id);
      await run('queues.consumer.start', { connectionId: c.id, destination: 'kept-in-memory' }, other.id);
      await run('workspace.close', { id: other.id }, null);
      other = await run<WorkspaceInfo>('workspace.open', { path: otherFolder }, null);
      const left = await run<QueueDestination[]>('queues.destination.list', { connectionId: c.id }, other.id);
      const tails = await run<Consumer[]>('queues.consumer.list', {}, other.id);
      check('queues: closing the workspace stops its tails and closes its brokers', left.length === 0 && tails.length === 0, { left, tails });
      await run('workspace.close', { id: other.id }, null);
      await run('workspace.forgetRecent', { path: otherFolder }, null);
    } finally {
      await fs.rm(otherFolder, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    host.emit = emit;
  }
};

export default section;
