import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ring-buffer';

describe('RingBuffer', () => {
  it('numbers items from 1 and reads on from a cursor', () => {
    const ring = new RingBuffer<string>(5);
    expect(ring.read()).toEqual({ items: [], next: 0, dropped: 0 });
    expect(ring.push('a')).toBe(1);
    expect(ring.push('b')).toBe(2);
    expect(ring.push('c')).toBe(3);
    const first = ring.read(0, 2);
    expect(first).toEqual({ items: [{ seq: 1, value: 'a' }, { seq: 2, value: 'b' }], next: 2, dropped: 0 });
    expect(ring.read(first.next)).toEqual({ items: [{ seq: 3, value: 'c' }], next: 3, dropped: 0 });
    expect(ring.read(3)).toEqual({ items: [], next: 3, dropped: 0 });
  });

  it('keeps only the newest items and says how many a reader missed', () => {
    const ring = new RingBuffer<number>(3);
    for (let i = 1; i <= 7; i++) ring.push(i * 10);
    expect(ring.size).toBe(3);
    expect(ring.first).toBe(5);
    expect(ring.last).toBe(7);
    expect(ring.values()).toEqual([50, 60, 70]);
    expect(ring.read(0)).toEqual({ items: [{ seq: 5, value: 50 }, { seq: 6, value: 60 }, { seq: 7, value: 70 }], next: 7, dropped: 4 });
    expect(ring.read(2, 1)).toEqual({ items: [{ seq: 5, value: 50 }], next: 5, dropped: 2 });
    expect(ring.read(5).dropped).toBe(0);
    expect(ring.at(4)).toBeUndefined();
    expect(ring.at(6)).toBe(60);
    expect(ring.at(8)).toBeUndefined();
  });

  it('stays bounded over many wraps', () => {
    const ring = new RingBuffer<number>(5000);
    for (let i = 1; i <= 12_345; i++) ring.push(i);
    expect(ring.size).toBe(5000);
    expect(ring.values()[0]).toBe(7346);
    expect(ring.values().at(-1)).toBe(12_345);
  });

  it('refuses a capacity below one', () => {
    expect(() => new RingBuffer(0)).toThrow(/capacity/);
  });
});
