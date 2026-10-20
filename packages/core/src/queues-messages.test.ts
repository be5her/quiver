import { describe, expect, it } from 'vitest';
import type { QueueMessage } from './models/queues';
import { QueueTail, queueMessageMatches } from './queues-messages';

const msg = (n: number, extra: Partial<QueueMessage> = {}): QueueMessage => ({ id: String(n), destination: 't', headers: {}, body: `body ${n}`, ...extra });

describe('queueMessageMatches', () => {
  it('matches any message when the needle is empty', () => {
    expect(queueMessageMatches(msg(1), '')).toBe(true);
  });

  it('looks in the body, the key and header values, ignoring case', () => {
    const m = msg(1, { body: '{"order":42}', key: 'Customer-7', headers: { trace: 'ABC-123' } });
    expect(queueMessageMatches(m, 'ORDER')).toBe(true);
    expect(queueMessageMatches(m, 'customer-7')).toBe(true);
    expect(queueMessageMatches(m, 'abc-1')).toBe(true);
    // Header names are not searched, only their values.
    expect(queueMessageMatches(m, 'trace')).toBe(false);
    expect(queueMessageMatches(m, 'nope')).toBe(false);
  });
});

describe('QueueTail', () => {
  it('reads what arrived after the cursor and hands back the next cursor', () => {
    const tail = new QueueTail(10);
    for (let i = 0; i < 3; i++) tail.push(msg(i));
    const first = tail.read(0, 100);
    expect(first.messages.map((m) => m.id)).toEqual(['0', '1', '2']);
    expect(first.cursor).toBe(3);
    tail.push(msg(3));
    const next = tail.read(first.cursor, 100);
    expect(next).toEqual({ messages: [msg(3)], cursor: 4, dropped: 0 });
    expect(tail.read(next.cursor, 100)).toEqual({ messages: [], cursor: 4, dropped: 0 });
  });

  it('pages with a limit', () => {
    const tail = new QueueTail(10);
    for (let i = 0; i < 5; i++) tail.push(msg(i));
    const page = tail.read(0, 2);
    expect(page.messages.map((m) => m.id)).toEqual(['0', '1']);
    expect(tail.read(page.cursor, 2).messages.map((m) => m.id)).toEqual(['2', '3']);
  });

  it('drops the oldest past its limit and says how many a slow reader missed', () => {
    const tail = new QueueTail(3);
    for (let i = 0; i < 5; i++) tail.push(msg(i));
    expect(tail.total).toBe(5);
    const read = tail.read(0, 100);
    expect(read.messages.map((m) => m.id)).toEqual(['2', '3', '4']);
    expect(read.dropped).toBe(2);
    expect(read.cursor).toBe(5);
  });

  it('clear keeps the cursor moving forward', () => {
    const tail = new QueueTail(3);
    tail.push(msg(0));
    tail.push(msg(1));
    tail.clear();
    expect(tail.read(0, 10)).toEqual({ messages: [], cursor: 2, dropped: 2 });
    tail.push(msg(2));
    expect(tail.read(2, 10).messages.map((m) => m.id)).toEqual(['2']);
  });
});
