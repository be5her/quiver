import { describe, expect, it } from 'vitest';
import type { QueueMessage } from './models/queues';
import { kafkaGroupLag, kafkaMergePeek, kafkaPeekRanges, kafkaRangesDone, kafkaTopicSize } from './queues-kafka';

const offsets = [
  { partition: 1, low: '5', high: '8' },
  { partition: 0, low: '0', high: '100' },
  { partition: 2, low: '7', high: '7' },
];

describe('kafkaPeekRanges', () => {
  it('reads the newest of every partition for latest, skipping empty ones', () => {
    expect(kafkaPeekRanges(offsets, 10, 'latest')).toEqual([
      { partition: 0, start: 90, end: 100 },
      { partition: 1, start: 5, end: 8 },
    ]);
  });

  it('reads the oldest of every partition for earliest', () => {
    expect(kafkaPeekRanges(offsets, 10, 'earliest')).toEqual([
      { partition: 0, start: 0, end: 10 },
      { partition: 1, start: 5, end: 8 },
    ]);
  });

  it('keeps to one partition when asked', () => {
    expect(kafkaPeekRanges(offsets, 2, 'latest', 1)).toEqual([{ partition: 1, start: 6, end: 8 }]);
    expect(kafkaPeekRanges(offsets, 2, 'latest', 2)).toEqual([]);
  });
});

describe('kafkaRangesDone', () => {
  it('is done once the last offset of every range was seen', () => {
    const ranges = kafkaPeekRanges(offsets, 10, 'latest');
    expect(kafkaRangesDone(ranges, new Map([[0, 99]]))).toBe(false);
    expect(kafkaRangesDone(ranges, new Map([[0, 99], [1, 7]]))).toBe(true);
    expect(kafkaRangesDone([], new Map())).toBe(true);
  });
});

describe('kafkaMergePeek', () => {
  const m = (partition: number, offset: number, at: number): QueueMessage => ({
    id: `${partition}:${offset}`,
    destination: 't',
    partition,
    offset: String(offset),
    headers: {},
    body: '',
    timestamp: new Date(at).toISOString(),
  });

  it('orders by time across partitions and keeps the newest or oldest', () => {
    const all = [m(0, 1, 3000), m(1, 0, 1000), m(0, 0, 2000), m(1, 1, 4000)];
    expect(kafkaMergePeek(all, 2, 'latest').map((x) => x.id)).toEqual(['0:1', '1:1']);
    expect(kafkaMergePeek(all, 2, 'earliest').map((x) => x.id)).toEqual(['1:0', '0:0']);
  });

  it('breaks ties on time by partition then offset', () => {
    expect(kafkaMergePeek([m(1, 0, 5), m(0, 2, 5), m(0, 1, 5)], 10, 'earliest').map((x) => x.id)).toEqual(['0:1', '0:2', '1:0']);
  });
});

describe('kafkaTopicSize and kafkaGroupLag', () => {
  it('sums the partitions', () => {
    expect(kafkaTopicSize(offsets)).toBe(103);
  });

  it('measures lag from the committed offset, or the low watermark when nothing was committed', () => {
    expect(
      kafkaGroupLag(
        'orders',
        [
          { partition: 1, offset: '-1' },
          { partition: 0, offset: '95' },
        ],
        offsets,
      ),
    ).toEqual([
      { topic: 'orders', partition: 0, offset: '95', end: '100', lag: 5 },
      { topic: 'orders', partition: 1, offset: '-1', end: '8', lag: 3 },
    ]);
  });
});
