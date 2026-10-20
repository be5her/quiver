import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QueueConnection, QueueDestination, QueueMessage } from '@quiver/core';
import { until, type SmokeSection } from '../../part';
import { startFakeSqs } from '../../fake-sqs';

type Summary = QueueConnection & { secrets: string[] };
type Consumer = { id: string; status: string; error: string | null };
type Read = { consumer: Consumer; messages: QueueMessage[]; cursor: number };
type Wait = { message: QueueMessage | null; timedOut: boolean };
type Tested = { ok: boolean; message: string };

// Queues: the SQS driver against a fake of the SQS JSON protocol, which this section starts and closes itself.
const section: SmokeSection = async ({ host, check, run, ws, folder, rpc }) => {
  const fail = async (id: string, input: unknown): Promise<string> => {
    const out = await host.invoke(id, input, { caller: 'ui', workspaceId: ws.id });
    return out.ok ? 'ok' : out.error.code;
  };
  const fake = await startFakeSqs();
  const awsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-sqs-aws-'));
  const envBefore = { config: process.env.AWS_CONFIG_FILE, credentials: process.env.AWS_SHARED_CREDENTIALS_FILE };
  const ids: string[] = [];
  try {
    // ---------- connections and auth ----------
    const conn = await run<Summary>(
      'queues.connection.save',
      { connection: { name: 'smoke sqs', kind: 'sqs', region: 'eu-west-1', endpoint: fake.url, accessKeyId: fake.accessKeyId }, secrets: { secretAccessKey: fake.secretAccessKey } },
      ws.id,
    );
    ids.push(conn.id);
    const file = await fs.readFile(path.join(folder, '.quiver', 'queues', `${conn.id}.json`), 'utf8');
    check('sqs: the access key id is committed and its secret goes to host.secrets', conn.secrets.join() === 'secretAccessKey' && file.includes(fake.accessKeyId) && !file.includes(fake.secretAccessKey), conn);
    const tested = await run<Tested>('queues.connection.test', { id: conn.id }, ws.id);
    const wrongKey = await run<Tested>('queues.connection.test', { connection: { kind: 'sqs', endpoint: fake.url, accessKeyId: 'AKIDWRONG' }, secrets: { secretAccessKey: 'x' } }, ws.id);
    const noSecret = await run<Tested>('queues.connection.test', { connection: { kind: 'sqs', endpoint: fake.url, accessKeyId: 'AKIDNOSECRET' } }, ws.id);
    const noRegion = await run<Tested>('queues.connection.test', { connection: { kind: 'sqs', accessKeyId: 'AKID' }, secrets: { secretAccessKey: 'x' } }, ws.id);
    check(
      'sqs: test connects with the key, and reports a refused key, a missing secret and a missing region',
      tested.ok && tested.message.includes(fake.url) && !wrongKey.ok && wrongKey.message.includes('security token') && !noSecret.ok && noSecret.message.includes('secretAccessKey') && !noRegion.ok && noRegion.message.includes('region'),
      { tested, wrongKey, noSecret, noRegion },
    );

    // An AWS profile, read from the shared config files as the SDK would.
    await fs.writeFile(path.join(awsDir, 'credentials'), `[smoke-sqs]\naws_access_key_id = ${fake.profileKeyId}\naws_secret_access_key = profile-secret\n`);
    await fs.writeFile(path.join(awsDir, 'config'), '[profile smoke-sqs]\nregion = eu-west-1\n');
    process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(awsDir, 'credentials');
    process.env.AWS_CONFIG_FILE = path.join(awsDir, 'config');
    const byProfile = await run<Summary>('queues.connection.save', { connection: { name: 'smoke sqs profile', kind: 'sqs', region: 'eu-west-1', endpoint: fake.url, profile: 'smoke-sqs' } }, ws.id);
    ids.push(byProfile.id);
    const keysBefore = fake.seen.keys.length;
    const profileTest = await run<Tested>('queues.connection.test', { id: byProfile.id }, ws.id);
    check('sqs: a connection can sign with an AWS profile instead of a stored key', profileTest.ok && fake.seen.keys.slice(keysBefore).includes(fake.profileKeyId) && byProfile.secrets.length === 0, profileTest);

    // ---------- create, describe, DLQ ----------
    const created = await run<QueueDestination>('queues.destination.create', { connectionId: conn.id, destination: 'orders' }, ws.id);
    check('sqs: create makes a standard queue', created.name === 'orders' && created.kind === 'queue' && created.messages === 0 && created.fifo === false, created);
    check('sqs: creating it again is a conflict', (await fail('queues.destination.create', { connectionId: conn.id, destination: 'orders' })) === 'CONFLICT');
    const fifoName = await fail('queues.destination.create', { connectionId: conn.id, destination: 'jobs', fifo: true });
    const jobs = await run<QueueDestination>('queues.destination.create', { connectionId: conn.id, destination: 'jobs.fifo', fifo: true }, ws.id);
    check('sqs: a FIFO queue needs a name ending in .fifo, and is made FIFO', fifoName === 'INVALID_INPUT' && jobs.fifo === true, { fifoName, jobs });

    fake.addQueue('orders-dlq');
    fake.setAttributes('orders', { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:orders-dlq', maxReceiveCount: 5 }), MessageRetentionPeriod: '345600' });
    const orders = await run<QueueDestination>('queues.destination.describe', { connectionId: conn.id, destination: 'orders' }, ws.id);
    const dlq = await run<QueueDestination>('queues.destination.describe', { connectionId: conn.id, destination: 'orders-dlq' }, ws.id);
    check(
      'sqs: describe shows the redrive policy, the queues a DLQ serves and the settings',
      orders.details?.['dead-letter queue'] === 'orders-dlq' && orders.details['max receive count'] === '5' && orders.details.retention === '4 d' && dlq.details?.['dead-letter source queues'] === 'orders',
      { orders: orders.details, dlq: dlq.details },
    );

    // ---------- produce and peek ----------
    const produced: string[] = [];
    for (let i = 1; i <= 3; i++) {
      produced.push((await run<{ id: string }>('queues.message.produce', { connectionId: conn.id, destination: 'orders', headers: { trace: `t-${i}` }, body: `{"order":${i}}` }, ws.id)).id);
      await new Promise((r) => setTimeout(r, 3));
    }
    await run('queues.message.produce', { connectionId: conn.id, destination: 'orders', headers: {}, body: 'later', delaySeconds: 600 }, ws.id);
    const listed = await run<QueueDestination[]>('queues.destination.list', { connectionId: conn.id }, ws.id);
    const listedOrders = listed.find((d) => d.name === 'orders');
    check(
      'sqs: list has every queue with its approximate counts, delayed apart, and FIFO marked',
      listed.map((d) => d.name).join() === 'jobs.fifo,orders,orders-dlq' && listedOrders?.messages === 3 && listedOrders.details?.delayed === '1' && listed[0]!.fifo === true,
      listed,
    );
    const newest = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: 'orders', limit: 2 }, ws.id);
    const oldest = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: 'orders', limit: 2, from: 'earliest' }, ws.id);
    check(
      'sqs: peek reads the newest or oldest with headers, message ids and the receive count',
      newest.map((m) => m.body).join() === '{"order":2},{"order":3}' &&
        oldest.map((m) => m.body).join() === '{"order":1},{"order":2}' &&
        newest[1]!.id === produced[2] &&
        newest[1]!.headers.trace === 't-3' &&
        Number(newest[1]!.attributes?.['receive count']) >= 1,
      { newest, oldest: oldest.map((m) => m.body) },
    );
    const again = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: 'orders', limit: 50 }, ws.id);
    check(
      'sqs: peek does not consume: it receives with visibility timeout 0 and deletes nothing',
      again.length === 3 && fake.messages('orders').length === 4 && fake.seen.visibility.every((v) => v === 0) && !fake.seen.ops.includes('DeleteMessage'),
      { again: again.length, held: fake.messages('orders').length, visibility: [...new Set(fake.seen.visibility)] },
    );
    check('sqs: an unknown queue is not found', (await fail('queues.message.peek', { connectionId: conn.id, destination: 'nope' })) === 'NOT_FOUND' && (await fail('queues.consumer.start', { connectionId: conn.id, destination: 'nope' })) === 'NOT_FOUND');

    // ---------- FIFO ----------
    const noGroup = await fail('queues.message.produce', { connectionId: conn.id, destination: 'jobs.fifo', body: 'x' });
    const noDedup = await fail('queues.message.produce', { connectionId: conn.id, destination: 'jobs.fifo', body: 'x', groupId: 'g1' });
    const withDelay = await fail('queues.message.produce', { connectionId: conn.id, destination: 'jobs.fifo', body: 'x', groupId: 'g1', dedupId: 'd0', delaySeconds: 5 });
    const first = await run<{ id: string }>('queues.message.produce', { connectionId: conn.id, destination: 'jobs.fifo', body: 'job 1', groupId: 'g1', dedupId: 'd1' }, ws.id);
    const dup = await run<{ id: string }>('queues.message.produce', { connectionId: conn.id, destination: 'jobs.fifo', body: 'job 1', groupId: 'g1', dedupId: 'd1' }, ws.id);
    await run('queues.message.produce', { connectionId: conn.id, destination: 'jobs.fifo', body: 'job 2', key: 'g2', dedupId: 'd2' }, ws.id);
    const fifoPeek = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: 'jobs.fifo', from: 'earliest' }, ws.id);
    check(
      'sqs: FIFO produce needs a group (the key will do) and a dedup id, takes no delay, and deduplicates',
      noGroup === 'INVALID_INPUT' && noDedup === 'INVALID_INPUT' && withDelay === 'INVALID_INPUT' && first.id === dup.id && fifoPeek.map((m) => `${m.key}:${m.body}`).join() === 'g1:job 1,g2:job 2' && fifoPeek[0]!.attributes?.['deduplication id'] === 'd1' && Boolean(fifoPeek[0]!.offset),
      { noGroup, noDedup, withDelay, fifoPeek },
    );

    // ---------- live tails and wait ----------
    const tail = await run<Consumer>('queues.consumer.start', { connectionId: conn.id, destination: 'orders' }, ws.id);
    const fromStart = await run<Consumer>('queues.consumer.start', { connectionId: conn.id, destination: 'orders', from: 'earliest' }, ws.id);
    await run('queues.message.produce', { connectionId: conn.id, destination: 'orders', body: 'live one', headers: {} }, ws.id);
    await run('queues.message.produce', { connectionId: conn.id, destination: 'orders', body: 'live two', headers: { kind: 'special' } }, ws.id);
    let read: Read = { consumer: tail, messages: [], cursor: 0 };
    await until(async () => (read = await run<Read>('queues.consumer.read', { consumerId: tail.id }, ws.id)).messages.length >= 2, 8000);
    let all: Read = { consumer: fromStart, messages: [], cursor: 0 };
    await until(async () => (all = await run<Read>('queues.consumer.read', { consumerId: fromStart.id }, ws.id)).messages.length >= 5, 8000);
    await new Promise((r) => setTimeout(r, 1500));
    read = await run<Read>('queues.consumer.read', { consumerId: tail.id }, ws.id);
    all = await run<Read>('queues.consumer.read', { consumerId: fromStart.id }, ws.id);
    check(
      'sqs: a tail from latest gets only new messages, once each, though it leaves them on the queue',
      read.messages.map((m) => m.body).join() === 'live one,live two' && read.consumer.status === 'running' && fake.messages('orders').length === 6,
      { got: read.messages.map((m) => m.body), status: read.consumer, held: fake.messages('orders').length },
    );
    check('sqs: a tail from earliest gets every visible message once', all.messages.length === 5 && new Set(all.messages.map((m) => m.id)).size === 5, all.messages.map((m) => m.body));
    await run('queues.consumer.stop', { consumerId: fromStart.id, forget: true }, ws.id);

    const waiting = run<Wait>('queues.message.wait', { connectionId: conn.id, destination: 'orders', match: 'needle', timeoutMs: 8000 }, ws.id);
    await new Promise((r) => setTimeout(r, 300));
    await run('queues.message.produce', { connectionId: conn.id, destination: 'orders', body: 'hay', headers: {} }, ws.id);
    await run('queues.message.produce', { connectionId: conn.id, destination: 'orders', body: 'a needle in sqs', headers: {} }, ws.id);
    const waited = await waiting;
    check('sqs: wait returns the first new message that matches', waited.message?.body === 'a needle in sqs' && !waited.timedOut, waited);

    // ---------- purge, groups, delete ----------
    await run('queues.destination.purge', { connectionId: conn.id, destination: 'orders' }, ws.id);
    const purged = await run<QueueDestination>('queues.destination.describe', { connectionId: conn.id, destination: 'orders' }, ws.id);
    const purgeAgain = await fail('queues.destination.purge', { connectionId: conn.id, destination: 'orders' });
    check('sqs: purge empties the queue, and a second purge within a minute is a conflict', purged.messages === 0 && purgeAgain === 'CONFLICT', { purged: purged.messages, purgeAgain });
    check('sqs: consumer groups are not supported', (await fail('queues.group.list', { connectionId: conn.id })) === 'NOT_SUPPORTED');

    // An empty queue, so its tail sits in a 20 second long poll when the queue goes.
    await run('queues.destination.create', { connectionId: conn.id, destination: 'idle' }, ws.id);
    const emptyTail = await run<Consumer>('queues.consumer.start', { connectionId: conn.id, destination: 'idle' }, ws.id);
    await new Promise((r) => setTimeout(r, 300));
    await run('queues.destination.delete', { connectionId: conn.id, destination: 'idle' }, ws.id);
    await run('queues.destination.delete', { connectionId: conn.id, destination: 'jobs.fifo' }, ws.id);
    let ended: Read = { consumer: emptyTail, messages: [], cursor: 0 };
    await until(async () => (ended = await run<Read>('queues.consumer.read', { consumerId: emptyTail.id }, ws.id)).consumer.status !== 'running', 5000);
    const afterDelete = await run<QueueDestination[]>('queues.destination.list', { connectionId: conn.id }, ws.id);
    check(
      'sqs: deleting a queue removes it and ends its tails, even one in a long poll',
      !afterDelete.some((d) => d.name === 'jobs.fifo' || d.name === 'idle') && ended.consumer.status === 'error' && (ended.consumer.error ?? '').includes('not found'),
      ended.consumer,
    );

    // ---------- agents ----------
    const agentPeek = await rpc('tools/call', { name: 'queues_message_peek', arguments: { connectionId: conn.id, destination: 'orders-dlq' } });
    const agentConn = await rpc('tools/call', { name: 'queues_connection_get', arguments: { id: conn.id } });
    const agentProduce = await rpc('tools/call', { name: 'queues_message_produce', arguments: { connectionId: conn.id, destination: 'orders', body: 'x' } });
    check(
      'sqs: agents may peek, see the secret name but never its value, and are refused produce',
      !agentPeek.result?.isError &&
        !(agentConn.result?.content?.[0]?.text ?? '').includes(fake.secretAccessKey) &&
        (agentConn.result?.content?.[0]?.text ?? '').includes('secretAccessKey') &&
        (agentProduce.result?.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'),
    );

    await run('queues.consumer.stop', { consumerId: tail.id, forget: true }, ws.id);
  } finally {
    for (const id of ids) await run('queues.connection.delete', { id }, ws.id).catch(() => undefined);
    if (envBefore.config === undefined) delete process.env.AWS_CONFIG_FILE;
    else process.env.AWS_CONFIG_FILE = envBefore.config;
    if (envBefore.credentials === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    else process.env.AWS_SHARED_CREDENTIALS_FILE = envBefore.credentials;
    await fs.rm(awsDir, { recursive: true, force: true }).catch(() => {});
    await fake.close();
  }
};

export default section;
