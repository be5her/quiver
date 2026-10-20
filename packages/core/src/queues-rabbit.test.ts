import { describe, expect, it } from 'vitest';
import {
  rabbitAmqpOptions,
  rabbitApiPath,
  rabbitBindingDetails,
  rabbitExchangeDestination,
  rabbitHeaders,
  rabbitListedExchange,
  rabbitListedQueue,
  rabbitManagementUrl,
  rabbitMessage,
  rabbitPeekSelect,
  rabbitQueueDestination,
  rabbitTailBindings,
  rabbitTarget,
  type RabbitApiBinding,
} from './queues-rabbit';

const base = { host: 'rabbit.local', port: undefined, vhost: '/', ssl: false, username: 'app', managementUrl: '' };

describe('rabbitTarget', () => {
  it('reads exchange:<name> as an exchange and anything else as a queue', () => {
    expect(rabbitTarget('orders')).toEqual({ kind: 'queue', name: 'orders' });
    expect(rabbitTarget('exchange:events')).toEqual({ kind: 'exchange', name: 'events' });
  });

  it('refuses the default exchange and an empty name', () => {
    expect(() => rabbitTarget('exchange:')).toThrow(/default exchange/);
    expect(() => rabbitTarget('')).toThrow(/required/);
  });
});

describe('rabbitAmqpOptions', () => {
  it('builds the options from the fields, with the default ports', () => {
    expect(rabbitAmqpOptions(base, 'pw')).toEqual({ protocol: 'amqp', hostname: 'rabbit.local', port: 5672, username: 'app', password: 'pw', vhost: '/' });
    expect(rabbitAmqpOptions({ ...base, ssl: true, vhost: 'staging' }, 'pw')).toMatchObject({ protocol: 'amqps', port: 5671, vhost: 'staging' });
    expect(rabbitAmqpOptions({ ...base, port: 5673, vhost: '' }, 'pw')).toMatchObject({ port: 5673, vhost: '/' });
  });

  it('falls back to guest/guest only when neither user nor password is set', () => {
    expect(rabbitAmqpOptions({ ...base, username: '' }, undefined)).toMatchObject({ username: 'guest', password: 'guest' });
    expect(rabbitAmqpOptions(base, undefined)).toMatchObject({ username: 'app', password: '' });
  });

  it('refuses a pasted URL or an empty host', () => {
    expect(() => rabbitAmqpOptions({ ...base, host: 'amqp://u:p@rabbit' }, '')).toThrow(/plain host name/);
    expect(() => rabbitAmqpOptions({ ...base, host: 'u:p@rabbit' }, '')).toThrow(/plain host name/);
    expect(() => rabbitAmqpOptions({ ...base, host: ' ' }, '')).toThrow(/no host/);
  });
});

describe('rabbitManagementUrl', () => {
  it('takes the given URL without a trailing slash, or derives one from the host', () => {
    expect(rabbitManagementUrl({ ...base, managementUrl: 'http://mq:15672/' })).toBe('http://mq:15672');
    expect(rabbitManagementUrl(base)).toBe('http://rabbit.local:15672');
    expect(rabbitManagementUrl({ ...base, ssl: true })).toBe('https://rabbit.local:15671');
  });

  it('refuses a URL with credentials', () => {
    expect(() => rabbitManagementUrl({ ...base, managementUrl: 'http://u:p@mq:15672' })).toThrow(/user or password/);
  });
});

describe('rabbitApiPath', () => {
  it('encodes every segment, so the default vhost is %2F', () => {
    expect(rabbitApiPath('queues', '/', 'a b/c')).toBe('/api/queues/%2F/a%20b%2Fc');
  });
});

describe('destinations', () => {
  it('turns a queue row into a destination with its counts and arguments', () => {
    const d = rabbitQueueDestination({ name: 'orders', type: 'quorum', state: 'running', messages: 5, messages_ready: 3, messages_unacknowledged: 2, consumers: 1, durable: true, arguments: { 'x-delivery-limit': 20 } });
    expect(d).toEqual({ name: 'orders', kind: 'queue', messages: 5, consumers: 1, details: { type: 'quorum', state: 'running', ready: '3', unacknowledged: '2', durable: 'true', 'x-delivery-limit': '20' } });
  });

  it('names exchanges exchange:<name> and leaves out the default, amq.* and tail queues from listings', () => {
    expect(rabbitExchangeDestination({ name: 'events', type: 'topic', durable: true })).toEqual({ name: 'exchange:events', kind: 'exchange', details: { type: 'topic', durable: 'true' } });
    expect(['', 'amq.topic', 'events'].filter((name) => rabbitListedExchange({ name }))).toEqual(['events']);
    expect(['quiver-tail-1', 'orders'].filter((name) => rabbitListedQueue({ name }))).toEqual(['orders']);
  });

  it('describes bindings from either side', () => {
    const b: RabbitApiBinding[] = [
      { source: '', destination: 'orders', destination_type: 'queue', routing_key: 'orders' },
      { source: 'events', destination: 'orders', destination_type: 'queue', routing_key: 'order.*', arguments: {} },
    ];
    expect(rabbitBindingDetails(b, 'source')).toEqual({ 'binding 1': '(default) → orders', 'binding 2': 'events → order.*' });
    expect(rabbitBindingDetails([{ source: 'events', destination: 'audit', destination_type: 'exchange', routing_key: '', arguments: { a: 1 } }], 'destination')).toEqual({
      'binding 1': '(any) → exchange:audit {"a":1}',
    });
  });
});

describe('rabbitTailBindings', () => {
  const bindings: RabbitApiBinding[] = [
    { source: '', destination: 'orders', destination_type: 'queue', routing_key: 'orders' },
    { source: 'events', destination: 'orders', destination_type: 'queue', routing_key: 'order.*' },
    { source: 'events', destination: 'orders', destination_type: 'queue', routing_key: 'order.*' },
    { source: 'legacy', destination: 'orders', destination_type: 'queue', routing_key: 'x', arguments: { 'x-match': 'any', kind: 'order' } },
    { source: 'events', destination: 'other', destination_type: 'queue', routing_key: 'other' },
  ];

  it('copies the bindings of a queue except the default exchange, once each', () => {
    expect(rabbitTailBindings({ kind: 'queue', name: 'orders' }, undefined, bindings)).toEqual([
      { source: 'events', pattern: 'order.*' },
      { source: 'legacy', pattern: 'x', args: { 'x-match': 'any', kind: 'order' } },
    ]);
  });

  it('finds nothing to copy for a queue reached only through the default exchange', () => {
    expect(rabbitTailBindings({ kind: 'queue', name: 'orders' }, undefined, bindings.slice(0, 1))).toEqual([]);
  });

  it('binds to everything on fanout, topic and headers exchanges', () => {
    const x = { kind: 'exchange' as const, name: 'events' };
    expect(rabbitTailBindings(x, 'fanout', [])).toEqual([{ source: 'events', pattern: '' }]);
    expect(rabbitTailBindings(x, 'topic', [])).toEqual([{ source: 'events', pattern: '#' }]);
    expect(rabbitTailBindings(x, 'headers', [])).toEqual([{ source: 'events', pattern: '', args: { 'x-match': 'all' } }]);
  });

  it('copies the routing keys a direct exchange is bound with', () => {
    expect(rabbitTailBindings({ kind: 'exchange', name: 'events' }, 'direct', bindings)).toEqual([
      { source: 'events', pattern: 'order.*' },
      { source: 'events', pattern: 'other' },
    ]);
  });
});

describe('messages', () => {
  it('turns header values into text', () => {
    expect(rabbitHeaders({ s: 'a', n: 3, b: true, bytes: new TextEncoder().encode('hi'), list: [1, 'x'], none: null })).toEqual({ s: 'a', n: '3', b: 'true', bytes: 'hi', list: '[1,"x"]', none: '' });
  });

  it('keeps the routing key as key and the AMQP properties as attributes', () => {
    const m = rabbitMessage('orders', 3, {
      body: '{"a":1}',
      fields: { exchange: '', routingKey: 'orders', redelivered: true },
      properties: { headers: { n: 1 }, messageId: 'm-1', contentType: 'application/json', timestamp: 1_700_000_000, priority: undefined, correlationId: '' },
    });
    expect(m).toEqual({
      id: '3',
      destination: 'orders',
      key: 'orders',
      headers: { n: '1' },
      body: '{"a":1}',
      timestamp: '2023-11-14T22:13:20.000Z',
      attributes: { exchange: '(default)', routingKey: 'orders', redelivered: 'true', messageId: 'm-1', contentType: 'application/json' },
    });
  });

  it('reads millisecond timestamps too, and leaves out a missing one', () => {
    const at = (timestamp: unknown) => rabbitMessage('q', 1, { body: '', fields: { exchange: 'x', routingKey: '', redelivered: false }, properties: { timestamp } });
    expect(at(1_700_000_000_000).timestamp).toBe('2023-11-14T22:13:20.000Z');
    expect(at(undefined).timestamp).toBeUndefined();
    expect(at(undefined).key).toBeUndefined();
  });

  it('selects the oldest or newest of what a peek read', () => {
    expect(rabbitPeekSelect([1, 2, 3, 4], 2, 'earliest')).toEqual([1, 2]);
    expect(rabbitPeekSelect([1, 2, 3, 4], 2, 'latest')).toEqual([3, 4]);
  });
});
