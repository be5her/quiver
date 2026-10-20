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
  rabbitStreamOffset,
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

  it('refuses . and .., which the management API would read as path segments', () => {
    for (const d of ['.', '..', 'exchange:.', 'exchange:..']) expect(() => rabbitTarget(d)).toThrow(/cannot be addressed/);
    expect(rabbitTarget('...')).toEqual({ kind: 'queue', name: '...' });
  });
});

describe('rabbitAmqpOptions', () => {
  it('builds the options from the fields, with the default ports', () => {
    expect(rabbitAmqpOptions(base, 'pw')).toEqual({ protocol: 'amqp', hostname: 'rabbit.local', port: 5672, username: 'app', password: 'pw', vhost: '%2F' });
    expect(rabbitAmqpOptions({ ...base, ssl: true, vhost: 'staging' }, 'pw')).toMatchObject({ protocol: 'amqps', port: 5671, vhost: 'staging' });
    expect(rabbitAmqpOptions({ ...base, port: 5673, vhost: '' }, 'pw')).toMatchObject({ port: 5673, vhost: '%2F' });
  });

  it('escapes the vhost, so amqplib unescaping it gives back the name as it is', () => {
    const vhost = rabbitAmqpOptions({ ...base, vhost: 'a%2Fb c' }, 'pw').vhost;
    expect(vhost).toBe('a%252Fb%20c');
    expect(decodeURIComponent(vhost)).toBe('a%2Fb c');
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

  it('refuses http:// when the connection uses ssl, since the password would go in the clear', () => {
    expect(() => rabbitManagementUrl({ ...base, ssl: true, managementUrl: 'HTTP://mq:15672' })).toThrow(/https/);
    expect(rabbitManagementUrl({ ...base, ssl: true, managementUrl: 'https://mq:15671' })).toBe('https://mq:15671');
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

  const exchanges = { events: { type: 'topic' }, legacy: { type: 'headers' } };

  it('copies the bindings of a queue except the default exchange, once each', () => {
    expect(rabbitTailBindings({ kind: 'queue', name: 'orders' }, exchanges, bindings)).toEqual([
      { source: 'events', pattern: 'order.*' },
      { source: 'legacy', pattern: 'x', args: { 'x-match': 'any', kind: 'order' } },
    ]);
  });

  it('finds nothing to copy for a queue reached only through the default exchange', () => {
    expect(rabbitTailBindings({ kind: 'queue', name: 'orders' }, exchanges, bindings.slice(0, 1))).toEqual([]);
  });

  it('binds to everything on fanout, topic and headers exchanges', () => {
    const x = { kind: 'exchange' as const, name: 'events' };
    expect(rabbitTailBindings(x, { events: { type: 'fanout' } }, [])).toEqual([{ source: 'events', pattern: '' }]);
    expect(rabbitTailBindings(x, { events: { type: 'topic' } }, [])).toEqual([{ source: 'events', pattern: '#' }]);
    expect(rabbitTailBindings(x, { events: { type: 'headers' } }, [])).toEqual([{ source: 'events', pattern: '', args: { 'x-match': 'all' } }]);
  });

  it('copies the routing keys a direct exchange is bound with', () => {
    expect(rabbitTailBindings({ kind: 'exchange', name: 'events' }, { events: { type: 'direct' } }, bindings)).toEqual([
      { source: 'events', pattern: 'order.*' },
      { source: 'events', pattern: 'other' },
    ]);
  });

  it('routes a delayed-message exchange by its x-delayed-type', () => {
    const delayed = { events: { type: 'x-delayed-message', arguments: { 'x-delayed-type': 'topic' } } };
    expect(rabbitTailBindings({ kind: 'exchange', name: 'events' }, delayed, [])).toEqual([{ source: 'events', pattern: '#' }]);
    expect(rabbitTailBindings({ kind: 'queue', name: 'orders' }, { ...exchanges, ...delayed }, bindings.slice(0, 2))).toEqual([{ source: 'events', pattern: 'order.*' }]);
  });

  it('refuses exchanges that send each message to one queue, since a tail would take messages from the real ones', () => {
    for (const type of ['x-consistent-hash', 'x-modulus-hash', 'x-random']) {
      expect(() => rabbitTailBindings({ kind: 'exchange', name: 'events' }, { events: { type } }, bindings)).toThrow(/one bound queue only/);
      expect(() => rabbitTailBindings({ kind: 'queue', name: 'orders' }, { ...exchanges, legacy: { type } }, bindings)).toThrow(/Queue orders is bound to exchange legacy/);
    }
    expect(() => rabbitTailBindings({ kind: 'exchange', name: 'events' }, { events: { type: 'x-delayed-message', arguments: { 'x-delayed-type': 'x-random' } } }, [])).toThrow(/one bound queue only/);
    expect(() => rabbitTailBindings({ kind: 'queue', name: 'orders' }, { events: { type: 'topic' } }, bindings)).toThrow(/type unknown/);
  });
});

describe('rabbitStreamOffset', () => {
  it('starts the oldest at first and the newest limit before the end, or at first without a count', () => {
    expect(rabbitStreamOffset('earliest', 10, 500)).toBe('first');
    expect(rabbitStreamOffset('latest', 10, 500)).toBe(490);
    expect(rabbitStreamOffset('latest', 10, 4)).toBe(0);
    expect(rabbitStreamOffset('latest', 10, undefined)).toBe('first');
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
