import type { QueueMessage } from './models/queues';

/** True when `match` is empty or occurs, ignoring case, in the body, the key or a header value of the message. */
export function queueMessageMatches(message: Pick<QueueMessage, 'body' | 'key' | 'headers'>, match: string): boolean {
  const needle = match.toLowerCase();
  if (!needle) return true;
  if (message.body.toLowerCase().includes(needle)) return true;
  if (message.key?.toLowerCase().includes(needle)) return true;
  return Object.values(message.headers).some((v) => v.toLowerCase().includes(needle));
}

/** Messages kept in memory per live consumer; older ones drop off and the read cursor skips past them. */
export const QUEUE_TAIL_LIMIT = 1000;

/**
 * A bounded buffer of messages with a monotonic cursor, for a live tail: `read(cursor)` hands back what
 * arrived after that cursor and the cursor to pass next time, and says when messages were dropped in between.
 */
export class QueueTail {
  private items: QueueMessage[] = [];
  /** Sequence number of `items[0]`. */
  private first = 0;

  constructor(private readonly limit = QUEUE_TAIL_LIMIT) {}

  push(message: QueueMessage): void {
    this.items.push(message);
    const over = this.items.length - this.limit;
    if (over > 0) {
      this.items.splice(0, over);
      this.first += over;
    }
  }

  /** Everything ever pushed, including what dropped off. */
  get total(): number {
    return this.first + this.items.length;
  }

  /** Messages after `cursor` (0 for the start), at most `limit`, oldest first. `dropped` counts messages lost before the first one returned. */
  read(cursor: number, limit: number): { messages: QueueMessage[]; cursor: number; dropped: number } {
    const from = Math.max(cursor, this.first);
    const start = Math.min(from - this.first, this.items.length);
    const messages = this.items.slice(start, start + limit);
    return { messages, cursor: from + messages.length, dropped: Math.max(0, this.first - cursor) };
  }

  clear(): void {
    this.first = this.total;
    this.items = [];
  }
}
