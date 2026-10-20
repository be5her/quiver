import { RABBIT_EXCHANGE_PREFIX, type QueueConnection, type QueueDestination, type QueueKind, type QueueMessage } from '@quiver/core';
import type { CodeLanguage } from '@quiver/ui';

// The shapes the queues commands answer with that live beside the host code rather than in core; the panel only reads them.

/** `queues.connection.list` / `get`: the committed settings plus the names (never values) of the stored secrets. */
export type QueueConnectionSummary = QueueConnection & { secrets: string[] };

export interface QueueConsumerSummary {
  id: string;
  connectionId: string;
  destination: string;
  from: 'latest' | 'earliest';
  status: 'running' | 'stopped' | 'error';
  error: string | null;
  startedAt: string;
  stoppedAt: string | null;
  received: number;
}

export interface QueueConsumerRead {
  consumer: QueueConsumerSummary;
  messages: QueueMessage[];
  cursor: number;
  dropped: number;
}

export interface QueueHistoryEntry {
  id: string;
  at: string;
  connectionId: string;
  destination: string;
  action: 'produce' | 'purge' | 'create' | 'delete';
  message?: { key?: string; headers: Record<string, string>; body: string; truncated?: boolean; partition?: number; groupId?: string; exchange?: string; id: string };
}

export const QUEUE_KINDS: QueueKind[] = ['memory', 'kafka', 'sqs', 'rabbit'];

export const KIND_LABEL: Record<QueueKind, string> = { memory: 'In-memory broker', kafka: 'Kafka', sqs: 'Amazon SQS', rabbit: 'RabbitMQ' };

/** The short badge before a connection's name. */
export const KIND_BADGE: Record<QueueKind, string> = { memory: 'MEM', kafka: 'KAFKA', sqs: 'SQS', rabbit: 'AMQP' };

export function kindClass(kind: QueueKind): string {
  switch (kind) {
    case 'kafka':
      return 'text-sky-600 dark:text-sky-400';
    case 'sqs':
      return 'text-amber-600 dark:text-amber-400';
    case 'rabbit':
      return 'text-orange-600 dark:text-orange-400';
    default:
      return 'text-violet-600 dark:text-violet-400';
  }
}

/** Kafka and the memory broker have topics, SQS and RabbitMQ queues. */
export function destinationWord(kind: QueueKind): 'topic' | 'queue' {
  return kind === 'kafka' || kind === 'memory' ? 'topic' : 'queue';
}

/** The secret a connection of this kind can hold, by its name in `queues.connection.save`. */
export function secretNameOf(kind: QueueKind): 'password' | 'secretAccessKey' | null {
  return kind === 'sqs' ? 'secretAccessKey' : kind === 'memory' ? null : 'password';
}

/** Where a connection points, in one line. */
export function describeQueueConnection(c: QueueConnection): string {
  switch (c.kind) {
    case 'kafka':
      return c.brokers.length ? c.brokers.join(', ') : 'no brokers yet';
    case 'sqs':
      return [c.region || 'default region', c.endpoint, c.profile ? `profile ${c.profile}` : ''].filter(Boolean).join(' · ');
    case 'rabbit':
      return c.host ? `${c.host}${c.port ? `:${c.port}` : ''}${c.vhost && c.vhost !== '/' ? ` ${c.vhost}` : ''}` : 'no host yet';
    default:
      return 'in Quiver, until it quits';
  }
}

/** The count shown beside a destination in the sidebar. */
export function countOf(d: QueueDestination): string {
  return d.messages === undefined ? '' : String(d.messages);
}

/** A body for reading: pretty JSON when it parses, the text as is otherwise. */
export function formatBody(body: string): { text: string; language: CodeLanguage } {
  if (/^\s*[[{]/.test(body)) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2), language: 'json' };
    } catch {
      return { text: body, language: 'text' };
    }
  }
  return { text: body, language: 'text' };
}

/** A body on one line, for a table cell. Only its start is looked at, so a body of megabytes costs no more than a short one. */
export function previewBody(body: string): string {
  return body.slice(0, 600).replace(/\s+/g, ' ').slice(0, 300);
}

/** Peeks that read without side effects run on their own; SQS (receive counts) and RabbitMQ (requeues) wait for a click. */
export function peeksFreely(kind: QueueKind): boolean {
  return kind === 'kafka' || kind === 'memory';
}

/** A RabbitMQ destination that names an exchange (`exchange:<name>`) rather than a queue. */
export function isRabbitExchange(kind: QueueKind, destination: string): boolean {
  return kind === 'rabbit' && destination.startsWith(RABBIT_EXCHANGE_PREFIX);
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Where a message sits: partition and offset for topics, the broker id otherwise. */
export function positionOf(m: QueueMessage): string {
  if (m.partition !== undefined && m.offset !== undefined) return `${m.partition}:${m.offset}`;
  return m.offset ?? m.id;
}
