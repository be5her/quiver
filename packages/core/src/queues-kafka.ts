import type { QueueMessage } from './models/queues';

// Offset arithmetic for the Kafka driver, kept apart from kafkajs so it can be tested without a broker.
// Offsets are decimal strings as Kafka hands them out; they fit in a JS number for any real topic.

/** The low (first kept) and high (next to be written) watermark of one partition. */
export interface PartitionOffsets {
  partition: number;
  low: string;
  high: string;
}

/** Which offsets a peek reads from one partition: `[start, end)`. */
export interface PeekRange {
  partition: number;
  start: number;
  end: number;
}

/**
 * The offsets to read for a peek of `limit` messages: the oldest `limit` of every partition (`earliest`) or
 * the newest (`latest`), or of one partition only. Empty partitions are left out. Reading `limit` from every
 * partition and trimming after the merge is what makes the result the true oldest or newest across partitions.
 */
export function kafkaPeekRanges(offsets: PartitionOffsets[], limit: number, from: 'earliest' | 'latest', partition?: number): PeekRange[] {
  const out: PeekRange[] = [];
  for (const o of offsets) {
    if (partition !== undefined && o.partition !== partition) continue;
    const low = Number(o.low);
    const high = Number(o.high);
    if (!(high > low)) continue;
    out.push(from === 'earliest' ? { partition: o.partition, start: low, end: Math.min(high, low + limit) } : { partition: o.partition, start: Math.max(low, high - limit), end: high });
  }
  return out.sort((a, b) => a.partition - b.partition);
}

/** True once every range has seen its last offset; `seen` is the highest offset read per partition. */
export function kafkaRangesDone(ranges: PeekRange[], seen: Map<number, number>): boolean {
  return ranges.every((r) => (seen.get(r.partition) ?? -1) >= r.end - 1);
}

/** Messages of a peek merged across partitions by time, then partition and offset, trimmed to the oldest or newest `limit`. */
export function kafkaMergePeek(messages: QueueMessage[], limit: number, from: 'earliest' | 'latest'): QueueMessage[] {
  const time = (m: QueueMessage) => (m.timestamp ? Date.parse(m.timestamp) : 0);
  const sorted = [...messages].sort((a, b) => time(a) - time(b) || (a.partition ?? 0) - (b.partition ?? 0) || Number(a.offset ?? 0) - Number(b.offset ?? 0));
  return from === 'earliest' ? sorted.slice(0, limit) : sorted.slice(-limit);
}

/** Messages a topic holds: the sum over partitions of high minus low watermark. */
export function kafkaTopicSize(offsets: PartitionOffsets[]): number {
  return offsets.reduce((sum, o) => sum + Math.max(0, Number(o.high) - Number(o.low)), 0);
}

/**
 * Lag of a group's committed offsets against the partitions' ends. A partition the group never committed
 * (`-1`) counts from the low watermark, as a consumer starting from the beginning would read it.
 */
export function kafkaGroupLag(
  topic: string,
  committed: { partition: number; offset: string }[],
  ends: PartitionOffsets[],
): { topic: string; partition: number; offset: string; end: string; lag: number }[] {
  const byPartition = new Map(ends.map((e) => [e.partition, e]));
  return committed
    .map((c) => {
      const end = byPartition.get(c.partition);
      const high = end ? Number(end.high) : 0;
      const at = Number(c.offset) < 0 ? Number(end?.low ?? 0) : Number(c.offset);
      return { topic, partition: c.partition, offset: c.offset, end: end?.high ?? '0', lag: Math.max(0, high - at) };
    })
    .sort((a, b) => a.partition - b.partition);
}
