import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RabbitApiBinding, RabbitApiExchange, RabbitApiQueue } from '@quiver/core';

// A RabbitMQ management API with a fixed vhost `/`: the overview, queue and exchange listings, one queue or
// exchange, and their bindings. It checks basic auth and records the paths it was asked for. No AMQP behind it.

export interface FakeRabbitMgmt {
  url: string;
  username: string;
  password: string;
  /** Paths asked for with the right credentials, query included. */
  seen: string[];
  /** Requests refused for wrong or missing credentials. */
  refused: number;
  close(): Promise<void>;
}

const QUEUES: RabbitApiQueue[] = [
  { name: 'orders', type: 'classic', state: 'running', messages: 3, messages_ready: 2, messages_unacknowledged: 1, consumers: 1, durable: true, arguments: { 'x-max-length': 1000 } },
  { name: 'events.stream', type: 'stream', state: 'running', messages: 10, consumers: 0, durable: true, arguments: { 'x-queue-type': 'stream' } },
  { name: 'direct-only', type: 'quorum', state: 'running', messages: 0, messages_ready: 0, messages_unacknowledged: 0, consumers: 0, durable: true, arguments: {} },
  { name: 'quiver-tail-left-over', type: 'classic', state: 'running', messages: 0, consumers: 1, exclusive: true, auto_delete: true, arguments: {} },
];

const EXCHANGES: RabbitApiExchange[] = [
  { name: '', type: 'direct', durable: true },
  { name: 'amq.topic', type: 'topic', durable: true },
  { name: 'amq.direct', type: 'direct', durable: true },
  { name: 'shop', type: 'topic', durable: true },
  { name: 'audit', type: 'fanout', durable: false, auto_delete: true },
];

const BINDINGS: RabbitApiBinding[] = [
  { source: '', destination: 'orders', destination_type: 'queue', routing_key: 'orders', arguments: {} },
  { source: 'shop', destination: 'orders', destination_type: 'queue', routing_key: 'order.*', arguments: {} },
  { source: 'shop', destination: 'audit', destination_type: 'exchange', routing_key: '#', arguments: {} },
  { source: '', destination: 'direct-only', destination_type: 'queue', routing_key: 'direct-only', arguments: {} },
];

export function startFakeRabbitMgmt(): Promise<FakeRabbitMgmt> {
  const username = 'smoke';
  const password = 'r4bbit-pass';
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const seen: string[] = [];
  const fake = { username, password, seen, refused: 0 } as FakeRabbitMgmt;
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== expected) {
      fake.refused++;
      return send(401, { error: 'not_authorised', reason: 'Login failed' });
    }
    const raw = req.url ?? '/';
    seen.push(raw);
    // Segments are matched encoded, so `%2F` (the vhost `/`) stays one segment.
    const parts = raw.split('?')[0]!.split('/').slice(1);
    const [api, what, vhost, name, ...rest] = parts.map((p, i) => (i < 2 ? p : decodeURIComponent(p)));
    if (api !== 'api') return send(404, { error: 'Object Not Found' });
    if (what === 'overview' && parts.length === 2) return send(200, { rabbitmq_version: '4.2.0-fake', cluster_name: 'rabbit@fake', management_version: '4.2.0-fake' });
    if (vhost !== '/') return send(404, { error: 'Object Not Found', reason: 'vhost_not_found' });
    if (what === 'queues') {
      if (name === undefined) return send(200, QUEUES);
      const q = QUEUES.find((x) => x.name === name);
      if (!q) return send(404, { error: 'Object Not Found' });
      if (!rest.length) return send(200, q);
      if (rest.join('/') === 'bindings') return send(200, BINDINGS.filter((b) => b.destination_type === 'queue' && b.destination === name));
    }
    if (what === 'exchanges') {
      if (name === undefined) return send(200, EXCHANGES);
      const e = EXCHANGES.find((x) => x.name === name);
      if (!e) return send(404, { error: 'Object Not Found' });
      if (!rest.length) return send(200, e);
      if (rest.join('/') === 'bindings/source') return send(200, BINDINGS.filter((b) => b.source === name));
    }
    send(404, { error: 'Object Not Found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      fake.close = () => new Promise<void>((r) => server.close(() => r()));
      resolve(fake);
    });
  });
}
