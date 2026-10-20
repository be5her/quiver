/** What a cursor read of a `RingBuffer` gives back. */
export interface RingRead<T> {
  /** The items after the cursor, oldest first, each with its sequence number. */
  items: { seq: number; value: T }[];
  /** The sequence number of the last item read (or the cursor itself when nothing was); pass it as `after` to read on. */
  next: number;
  /** Items after the cursor that fell out of the buffer before they were read. */
  dropped: number;
}

/**
 * A bounded buffer that keeps the last `capacity` items. Every item gets a sequence number, 1 for the first, so a
 * reader can keep a cursor and read on from it, and learns how many items it missed when the buffer wrapped past it.
 */
export class RingBuffer<T> {
  private readonly slots: T[] = [];
  /** The sequence number the next item gets. */
  private seq = 1;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('A ring buffer needs a capacity of at least one');
  }

  /** How many items are held. */
  get size(): number {
    return Math.min(this.seq - 1, this.capacity);
  }

  /** The sequence number of the oldest item held; equals `last + 1` when empty. */
  get first(): number {
    return this.seq - this.size;
  }

  /** The sequence number of the newest item, 0 before the first. */
  get last(): number {
    return this.seq - 1;
  }

  /** Adds an item, dropping the oldest when full; returns its sequence number. */
  push(value: T): number {
    const seq = this.seq++;
    this.slots[(seq - 1) % this.capacity] = value;
    return seq;
  }

  /** The item with this sequence number, when it is still held. */
  at(seq: number): T | undefined {
    if (seq < this.first || seq > this.last) return undefined;
    return this.slots[(seq - 1) % this.capacity];
  }

  /** Up to `limit` items after the cursor `after` (0 reads from the start), oldest first. */
  read(after = 0, limit = Infinity): RingRead<T> {
    const from = Math.max(after + 1, this.first);
    const dropped = Math.max(0, this.first - after - 1);
    const to = Math.min(this.last, from + Math.max(0, limit) - 1);
    const items: { seq: number; value: T }[] = [];
    for (let seq = from; seq <= to; seq++) items.push({ seq, value: this.slots[(seq - 1) % this.capacity] });
    return { items, next: items.length ? to : after, dropped };
  }

  /** Every item held, oldest first. */
  values(): T[] {
    return this.read(0).items.map((item) => item.value);
  }
}
