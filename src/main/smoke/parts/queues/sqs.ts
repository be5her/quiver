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
  const envBefore = { config: process.env.AWS_CONFIG_FILE, credentials: process.env.AWS_SHARED_CREDENTIALS_FILE, endpoint: process.env.AWS_ENDPOINT_URL_SQS };
  const mcpBefore = host.config.get().mcp;
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
    // A connection's own endpoint never gets profile or environment credentials; the SDK's configured endpoint (the
    // user's own setting, not the committed file) points the profile connection at the fake instead.
    const keysBefore = fake.seen.keys.length;
    const profileAtEndpoint = await run<Tested>('queues.connection.test', { connection: { kind: 'sqs', endpoint: fake.url, profile: 'smoke-sqs' } }, ws.id);
    const ambientAtEndpoint = await run<Tested>('queues.connection.test', { connection: { kind: 'sqs', endpoint: fake.url } }, ws.id);
    const byProfile = await run<Summary>('queues.connection.save', { connection: { name: 'smoke sqs profile', kind: 'sqs', region: 'eu-west-1', profile: 'smoke-sqs' } }, ws.id);
    ids.push(byProfile.id);
    process.env.AWS_ENDPOINT_URL_SQS = fake.url;
    const profileTest = await run<Tested>('queues.connection.test', { id: byProfile.id }, ws.id).finally(() => {
      if (envBefore.endpoint === undefined) delete process.env.AWS_ENDPOINT_URL_SQS;
      else process.env.AWS_ENDPOINT_URL_SQS = envBefore.endpoint;
    });
    check(
      'sqs: a connection can sign with an AWS profile instead of a stored key, but one with an endpoint needs a key of its own',
      profileTest.ok &&
        fake.seen.keys.slice(keysBefore).join() === fake.profileKeyId &&
        byProfile.secrets.length === 0 &&
        !profileAtEndpoint.ok &&
        profileAtEndpoint.message.includes('access key') &&
        !ambientAtEndpoint.ok &&
        ambientAtEndpoint.message.includes('access key'),
      { profileTest, profileAtEndpoint, ambientAtEndpoint, keys: fake.seen.keys.slice(keysBefore) },
    );

    // ---------- create, describe, DLQ ----------
    const created = await run<QueueDestination>('queues.destination.create', { connectionId: conn.id, destination: 'orders' }, ws.id);
    check('sqs: create makes a standard queue', created.name === 'orders' && created.kind === 'queue' && created.messages === 0 && created.fifo === false, created);
    check('sqs: creating it again is a conflict', (await fail('queues.destination.create', { connectionId: conn.id, destination: 'orders' })) === 'CONFLICT');
    const fifoName = await fail('queues.destination.create', { connectionId: conn.id, destination: 'jobs', fifo: true });
    const jobs = await run<QueueDestination>('queues.destination.create', { connectionId: conn.id, destination: 'jobs.fifo', fifo: true }, ws.id);
    check('sqs: a FIFO queue needs a name ending in .fifo, and is made FIFO', fifoName === 'INVALID_INPUT' && jobs.fifo === true, { fifoName, jobs });

    fake.addQueue('orders-dlq');
    // A limit well above what the peeks and tails below add up to; the redrive section further down runs into one.
    fake.setAttributes('orders', { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:orders-dlq', maxReceiveCount: 50 }), MessageRetentionPeriod: '345600' });
    const orders = await run<QueueDestination>('queues.destination.describe', { connectionId: conn.id, destination: 'orders' }, ws.id);
    const dlq = await run<QueueDestination>('queues.destination.describe', { connectionId: conn.id, destination: 'orders-dlq' }, ws.id);
    check(
      'sqs: describe shows the redrive policy, the queues a DLQ serves and the settings',
      orders.details?.['dead-letter queue'] === 'orders-dlq' && orders.details['max receive count'] === '50' && orders.details.retention === '4 d' && dlq.details?.['dead-letter source queues'] === 'orders',
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
    // Three peeks: the newest two and the 50 newest saw all three once each, the oldest two only orders 1 and 2.
    const receives = fake.messages('orders').map((m) => m.received).join();
    check('sqs: a peek receives each message once, not once per round', receives === '3,3,2,0', receives);

    // A queue URL is taken only for the connection's own endpoint, so a destination cannot aim the signed request elsewhere.
    const sentBefore = fake.seen.ops.length;
    const byUrl = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: `${fake.url}/000000000000/orders`, limit: 1 }, ws.id);
    const elsewhere = await fail('queues.message.peek', { connectionId: conn.id, destination: 'http://127.0.0.1:9/000000000000/orders' });
    const elsewhereTail = await fail('queues.consumer.start', { connectionId: conn.id, destination: 'https://sqs.eu-west-1.amazonaws.com/000000000000/orders' });
    // The URL's peek reads the redrive policy and receives; the others send nothing.
    check(
      'sqs: a queue URL works for the connection endpoint and is refused for any other host, before a request',
      byUrl.length === 1 && elsewhere === 'INVALID_INPUT' && elsewhereTail === 'INVALID_INPUT' && fake.seen.ops.slice(sentBefore).join() === 'GetQueueAttributes,ReceiveMessage',
      { byUrl: byUrl.length, elsewhere, elsewhereTail, ops: fake.seen.ops.slice(sentBefore) },
    );
    // A region in mixed case is lower-cased as the SDK does in hostnames, so SQS's own URLs in it are still taken.
    // The SDK's configured endpoint (not the committed file) sends the requests to the fake.
    const upper = await run<Summary>(
      'queues.connection.save',
      { connection: { name: 'smoke sqs region', kind: 'sqs', region: 'EU-West-1', accessKeyId: fake.accessKeyId }, secrets: { secretAccessKey: fake.secretAccessKey } },
      ws.id,
    );
    ids.push(upper.id);
    process.env.AWS_ENDPOINT_URL_SQS = fake.url;
    const upperPeek = await fail('queues.message.peek', { connectionId: upper.id, destination: 'https://sqs.eu-west-1.amazonaws.com/000000000000/orders', limit: 1 }).finally(() => {
      if (envBefore.endpoint === undefined) delete process.env.AWS_ENDPOINT_URL_SQS;
      else process.env.AWS_ENDPOINT_URL_SQS = envBefore.endpoint;
    });
    check('sqs: a region given in mixed case still takes the queue URLs of SQS in that region', upperPeek === 'ok', upperPeek);
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
    // Past ten messages a FIFO queue only ever hands out the oldest of each group, so its newest cannot be peeked.
    for (let i = 3; i <= 11; i++) await run('queues.message.produce', { connectionId: conn.id, destination: 'jobs.fifo', body: `job ${i}`, groupId: 'g3', dedupId: `d${i}` }, ws.id);
    const fifoReceives = fake.seen.visibility.length;
    const fifoLatest = await fail('queues.message.peek', { connectionId: conn.id, destination: 'jobs.fifo' });
    const fifoEarliest = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: 'jobs.fifo', from: 'earliest', limit: 3 }, ws.id);
    check(
      'sqs: a FIFO queue past ten messages refuses a peek for the newest before receiving, and peeks the oldest',
      fifoLatest === 'INVALID_INPUT' && fifoEarliest.map((m) => m.body).join() === 'job 1,job 2,job 3' && fake.seen.visibility.length === fifoReceives + 1,
      { fifoLatest, fifoEarliest: fifoEarliest.map((m) => m.body) },
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

    // ---------- receive counts and the dead-letter queue ----------
    // Every receive counts, even at visibility 0: a tail stops one receive short of the limit, and peeks past it
    // move the message to the DLQ as SQS does.
    fake.addQueue('retries-dlq');
    fake.addQueue('retries', { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:retries-dlq', maxReceiveCount: 3 }) });
    await run('queues.message.produce', { connectionId: conn.id, destination: 'retries', body: 'flaky', headers: {} }, ws.id);
    const firstLook = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: 'retries' }, ws.id);
    const guarded = await run<Consumer>('queues.consumer.start', { connectionId: conn.id, destination: 'retries', from: 'earliest' }, ws.id);
    let stopped: Read = { consumer: guarded, messages: [], cursor: 0 };
    await until(async () => (stopped = await run<Read>('queues.consumer.read', { consumerId: guarded.id }, ws.id)).consumer.status !== 'running', 5000);
    const atLimit = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: 'retries' }, ws.id);
    const pastLimit = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: 'retries' }, ws.id);
    const inDlq = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: 'retries-dlq' }, ws.id);
    check(
      'sqs: a tail ends one receive before the DLQ, and receives past maxReceiveCount move the message there',
      firstLook[0]?.attributes?.['receive count'] === '1' &&
        stopped.consumer.status === 'error' &&
        (stopped.consumer.error ?? '').includes('dead-letter queue retries-dlq') &&
        stopped.messages.map((m) => m.body).join() === 'flaky' &&
        atLimit[0]?.attributes?.['receive count'] === '3' &&
        pastLimit.length === 0 &&
        fake.messages('retries').length === 0 &&
        inDlq[0]?.body === 'flaky' &&
        (inDlq[0]?.attributes?.['dead-letter source'] ?? '').endsWith(':retries'),
      { firstLook: firstLook[0]?.attributes, stopped: stopped.consumer, atLimit: atLimit[0]?.attributes, pastLimit: pastLimit.length, inDlq: inDlq[0]?.attributes },
    );
    await run('queues.consumer.stop', { consumerId: guarded.id, forget: true }, ws.id);

    // On queues past ten messages whose receives come back short and overlapping, as SQS's do, a peek's or a tail's
    // later rounds would hand out messages it already received; with maxReceiveCount 1 or 2 one of those moves them
    // to the DLQ, so a peek stops before such a round and a wait or a tail refuses to start.
    const produceMany = async (destination: string, n: number) => {
      for (let i = 1; i <= n; i++) await run('queues.message.produce', { connectionId: conn.id, destination, body: `${destination} ${i}`, headers: {} }, ws.id);
    };
    fake.addQueue('guard-dlq');
    const guardedOps: Record<string, string> = {};
    for (const max of [1, 2]) {
      const policy = { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:guard-dlq', maxReceiveCount: max }) };
      for (const op of ['peek', 'wait', 'tail']) {
        const q = `guard-${max}-${op}`;
        fake.addQueue(q, policy, { uneven: true });
        await produceMany(q, 15);
        const outcome =
          op === 'peek'
            ? String((await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: q, limit: 15, from: 'earliest' }, ws.id)).length)
            : await fail(op === 'wait' ? 'queues.message.wait' : 'queues.consumer.start', { connectionId: conn.id, destination: q, ...(op === 'wait' ? { timeoutMs: 1000 } : {}) });
        guardedOps[q] = `${outcome}, ${fake.messages(q).length} held`;
      }
    }
    check(
      'sqs: with maxReceiveCount 1 or 2 and more than ten messages, peek, wait and tail stop short of the DLQ',
      fake.messages('guard-dlq').length === 0 && Object.entries(guardedOps).every(([q, v]) => v === (q.endsWith('peek') ? '10, 15 held' : 'CONFLICT, 15 held')),
      { guardedOps, dlq: fake.messages('guard-dlq').length },
    );

    // SQS often hands back fewer than asked with more waiting: a short round does not end a peek.
    fake.addQueue('backlog', {}, { uneven: true });
    await produceMany('backlog', 25);
    const backlogAll = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: 'backlog', limit: 25, from: 'earliest' }, ws.id);
    const backlogNewest = await run<QueueMessage[]>('queues.message.peek', { connectionId: conn.id, destination: 'backlog', limit: 3 }, ws.id);
    check(
      'sqs: a peek goes on through short and overlapping receives until it has seen the whole queue',
      new Set(backlogAll.map((m) => m.id)).size === 25 && backlogNewest.map((m) => m.body).join() === 'backlog 23,backlog 24,backlog 25',
      { all: backlogAll.length, newest: backlogNewest.map((m) => m.body) },
    );

    // A queue whose KMS key is disabled refuses every receive: the tail ends rather than retry forever.
    fake.addQueue('locked', { KmsMasterKeyId: 'alias/disabled' });
    const lockedTail = await run<Consumer>('queues.consumer.start', { connectionId: conn.id, destination: 'locked', from: 'earliest' }, ws.id);
    let locked: Read = { consumer: lockedTail, messages: [], cursor: 0 };
    await until(async () => (locked = await run<Read>('queues.consumer.read', { consumerId: lockedTail.id }, ws.id)).consumer.status !== 'running', 5000);
    check('sqs: a tail ends on an error that would come again, such as a disabled KMS key', locked.consumer.status === 'error' && (locked.consumer.error ?? '').includes('KMS'), locked.consumer);
    await run('queues.consumer.stop', { consumerId: lockedTail.id, forget: true }, ws.id);

    // A pulled commit that changes the connection (here its access key) rebuilds the pooled client on the next call;
    // a tail still on the old client, which would go on signing with the old key, ends.
    const moved = await run<Summary>(
      'queues.connection.save',
      { connection: { name: 'smoke sqs moved', kind: 'sqs', endpoint: fake.url, accessKeyId: fake.accessKeyId }, secrets: { secretAccessKey: fake.secretAccessKey } },
      ws.id,
    );
    ids.push(moved.id);
    fake.addQueue('quiet');
    const quietTail = await run<Consumer>('queues.consumer.start', { connectionId: moved.id, destination: 'quiet' }, ws.id);
    const movedFile = path.join(folder, '.quiver', 'queues', `${moved.id}.json`);
    await fs.writeFile(movedFile, JSON.stringify({ ...JSON.parse(await fs.readFile(movedFile, 'utf8')), accessKeyId: fake.profileKeyId }, null, 2));
    await until(async () => (await run<Summary>('queues.connection.get', { id: moved.id }, ws.id)).accessKeyId === fake.profileKeyId, 3000);
    await run('queues.destination.list', { connectionId: moved.id }, ws.id);
    let quiet: Read = { consumer: quietTail, messages: [], cursor: 0 };
    await until(async () => (quiet = await run<Read>('queues.consumer.read', { consumerId: quietTail.id }, ws.id)).consumer.status !== 'running', 3000);
    check('sqs: a tail ends once the connection it started on changes', quiet.consumer.status === 'error' && (quiet.consumer.error ?? '').includes('connection changed'), quiet.consumer);
    await run('queues.consumer.stop', { consumerId: quietTail.id, forget: true }, ws.id);

    // A pulled commit that points the connection at another endpoint (localhost instead of 127.0.0.1: another origin,
    // the same fake) does not take the stored key along; a rename keeps refusing; the key typed again goes there.
    const pulledUrl = fake.url.replace('127.0.0.1', 'localhost');
    await fs.writeFile(movedFile, JSON.stringify({ ...JSON.parse(await fs.readFile(movedFile, 'utf8')), endpoint: pulledUrl, accessKeyId: fake.accessKeyId }, null, 2));
    await until(async () => (await run<Summary>('queues.connection.get', { id: moved.id }, ws.id)).endpoint === pulledUrl, 3000);
    const pulledEndpoint = await fail('queues.destination.list', { connectionId: moved.id });
    const pulledRequests = fake.seen.ops.length;
    await run('queues.connection.save', { connection: { id: moved.id, name: 'smoke sqs moved again' } }, ws.id);
    const afterRename = await fail('queues.destination.list', { connectionId: moved.id });
    const signedElsewhere = fake.seen.ops.length - pulledRequests;
    await run('queues.connection.save', { connection: { id: moved.id }, secrets: { secretAccessKey: fake.secretAccessKey } }, ws.id);
    const reentered = await fail('queues.destination.list', { connectionId: moved.id });
    check(
      'sqs: a stored key stays with the endpoint it was saved for: a pulled endpoint is refused, also after a rename, until the key is typed again',
      pulledEndpoint === 'AUTH_FAILED' && afterRename === 'AUTH_FAILED' && signedElsewhere === 0 && reentered === 'ok',
      { pulledEndpoint, afterRename, signedElsewhere, reentered },
    );

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
      !afterDelete.some((d) => d.name === 'jobs.fifo' || d.name === 'idle') && ended.consumer.status !== 'running',
      ended.consumer,
    );

    // ---------- agents ----------
    // An SQS receive moves receive counts towards the DLQ, so peeks, tails and waits are mutations for agents.
    const agentPeek = await rpc('tools/call', { name: 'queues_message_peek', arguments: { connectionId: conn.id, destination: 'orders-dlq' } });
    const agentTail = await rpc('tools/call', { name: 'queues_consumer_start', arguments: { connectionId: conn.id, destination: 'orders-dlq' } });
    const agentWait = await rpc('tools/call', { name: 'queues_message_wait', arguments: { connectionId: conn.id, destination: 'orders-dlq', timeoutMs: 100 } });
    const agentList = await rpc('tools/call', { name: 'queues_destination_list', arguments: { connectionId: conn.id } });
    const agentConn = await rpc('tools/call', { name: 'queues_connection_get', arguments: { id: conn.id } });
    const agentProduce = await rpc('tools/call', { name: 'queues_message_produce', arguments: { connectionId: conn.id, destination: 'orders', body: 'x' } });
    const blocked = (r: typeof agentPeek) => (r.result?.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED');
    await run('config.update', { patch: { mcp: { ...mcpBefore, allowMutating: true } } }, null);
    const allowedPeek = await host.invoke('queues.message.peek', { connectionId: conn.id, destination: 'retries-dlq' }, { caller: 'mcp', workspaceId: ws.id }).finally(() => run('config.update', { patch: { mcp: mcpBefore } }, null));
    check(
      'sqs: agents list queues and see the secret name but never its value; peek, tail, wait and produce need mutations, and peek works once allowed',
      blocked(agentPeek) &&
        blocked(agentTail) &&
        blocked(agentWait) &&
        blocked(agentProduce) &&
        !agentList.result?.isError &&
        !(agentConn.result?.content?.[0]?.text ?? '').includes(fake.secretAccessKey) &&
        (agentConn.result?.content?.[0]?.text ?? '').includes('secretAccessKey') &&
        allowedPeek.ok &&
        (allowedPeek.result as QueueMessage[])[0]?.body === 'flaky',
      { agentPeek: agentPeek.result?.content?.[0]?.text?.slice(0, 120), allowedPeek: allowedPeek.ok ? 'ok' : allowedPeek.error },
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
