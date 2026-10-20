import { newId, nowIso, type HostApi, type QueueConnection, type QueueDriver, type QueueMessage, type QueueSecrets, type QueueSubscription } from '@quiver/core';
import { QueueTail, queueMessageMatches } from '../../../core/src/queues-messages';

// Live consumers: a tail of one destination kept in memory with a read cursor, per workspace. They are not
// persisted; closing the workspace or deleting the connection stops them.

/** At most this many `queues.changed{consumer}` events per second per consumer while messages pour in. */
const EMIT_INTERVAL_MS = 250;

export type QueueConsumerStatus = 'running' | 'stopped' | 'error';

export interface QueueConsumerSummary {
  id: string;
  connectionId: string;
  destination: string;
  from: 'latest' | 'earliest';
  status: QueueConsumerStatus;
  error: string | null;
  startedAt: string;
  stoppedAt: string | null;
  /** Messages received since the start, including those that dropped out of the buffer. */
  received: number;
}

export interface QueueConsumerRead {
  consumer: QueueConsumerSummary;
  messages: QueueMessage[];
  /** Pass back as `cursor` to read what arrived after these. */
  cursor: number;
  /** Messages that left the buffer before they were read. */
  dropped: number;
}

interface Live {
  summary: QueueConsumerSummary;
  workspaceId: string;
  host: HostApi;
  tail: QueueTail;
  subscription: QueueSubscription | null;
  emitTimer: NodeJS.Timeout | null;
}

export class QueueConsumers {
  private readonly live = new Map<string, Live>();

  private emit(l: Live, now = false): void {
    const fire = () => {
      l.emitTimer = null;
      l.host.emit('queues.changed', { workspaceId: l.workspaceId, reason: 'consumer', connectionId: l.summary.connectionId, consumerId: l.summary.id });
    };
    if (now) {
      if (l.emitTimer) clearTimeout(l.emitTimer);
      fire();
    } else l.emitTimer ??= setTimeout(fire, EMIT_INTERVAL_MS);
  }

  async start(host: HostApi, workspaceId: string, driver: QueueDriver, connection: QueueConnection, secrets: QueueSecrets, destination: string, from: 'latest' | 'earliest'): Promise<QueueConsumerSummary> {
    const l: Live = {
      summary: { id: newId(), connectionId: connection.id, destination, from, status: 'running', error: null, startedAt: nowIso(), stoppedAt: null, received: 0 },
      workspaceId,
      host,
      tail: new QueueTail(),
      subscription: null,
      emitTimer: null,
    };
    l.subscription = await driver.consume(
      connection,
      secrets,
      destination,
      { from },
      (m) => {
        l.tail.push(m);
        l.summary.received = l.tail.total;
        this.emit(l);
      },
      (error) => {
        if (l.summary.status !== 'running') return;
        l.summary.status = error ? 'error' : 'stopped';
        l.summary.error = error ? error.message || String(error) : null;
        l.summary.stoppedAt = nowIso();
        l.subscription = null;
        this.emit(l, true);
      },
    );
    this.live.set(l.summary.id, l);
    this.emit(l, true);
    return { ...l.summary };
  }

  list(workspaceId: string, connectionId?: string): QueueConsumerSummary[] {
    return [...this.live.values()].filter((l) => l.workspaceId === workspaceId && (!connectionId || l.summary.connectionId === connectionId)).map((l) => ({ ...l.summary }));
  }

  get(workspaceId: string, id: string): Live | undefined {
    const l = this.live.get(id);
    return l?.workspaceId === workspaceId ? l : undefined;
  }

  read(l: Live, cursor: number, limit: number, match: string): QueueConsumerRead {
    const page = l.tail.read(cursor, limit);
    return { consumer: { ...l.summary }, messages: match ? page.messages.filter((m) => queueMessageMatches(m, match)) : page.messages, cursor: page.cursor, dropped: page.dropped };
  }

  /** Stop the consumer; with `forget` it is also dropped from the list, otherwise its buffer stays readable. */
  async stop(l: Live, forget = false): Promise<QueueConsumerSummary> {
    const sub = l.subscription;
    l.subscription = null;
    if (l.summary.status === 'running') {
      l.summary.status = 'stopped';
      l.summary.stoppedAt = nowIso();
    }
    await sub?.stop().catch(() => undefined);
    if (l.emitTimer) clearTimeout(l.emitTimer);
    l.emitTimer = null;
    if (forget) this.live.delete(l.summary.id);
    this.emit(l, true);
    return { ...l.summary };
  }

  async stopConnection(workspaceId: string, connectionId: string): Promise<void> {
    await Promise.all([...this.live.values()].filter((l) => l.workspaceId === workspaceId && l.summary.connectionId === connectionId).map((l) => this.stop(l, true)));
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    await Promise.all([...this.live.values()].filter((l) => l.workspaceId === workspaceId).map((l) => this.stop(l, true)));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.live.values()].map((l) => this.stop(l, true)));
  }
}

/**
 * Wait for the next message on a destination that matches, through a consumer of its own that starts at the
 * newest message and is stopped as soon as a message matches or the time is up.
 */
export async function waitForMessage(
  driver: QueueDriver,
  connection: QueueConnection,
  secrets: QueueSecrets,
  destination: string,
  match: string,
  timeoutMs: number,
): Promise<{ message: QueueMessage | null; timedOut: boolean }> {
  let resolve!: (m: QueueMessage | null) => void;
  let reject!: (error: Error) => void;
  const found = new Promise<QueueMessage | null>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  found.catch(() => undefined);
  const timer = setTimeout(() => resolve(null), timeoutMs);
  let sub: QueueSubscription | null = null;
  try {
    sub = await driver.consume(
      connection,
      secrets,
      destination,
      { from: 'latest' },
      (m) => {
        if (queueMessageMatches(m, match)) resolve(m);
      },
      // A consumer that ends before a match (the broker went away, the destination was deleted) fails the wait.
      (error) => reject(error ?? new Error(`The consumer of ${destination} ended`)),
    );
    const message = await found;
    return { message, timedOut: message === null };
  } finally {
    clearTimeout(timer);
    await sub?.stop().catch(() => undefined);
  }
}
