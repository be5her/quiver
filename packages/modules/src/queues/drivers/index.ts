import type { QueueDriver, QueueKind } from '@quiver/core';
import { memoryDriver } from './memory';
import { kafkaDriver } from './kafka';
import { sqsDriver } from './sqs';
import { rabbitDriver } from './rabbit';

/** Every broker Quiver talks to, by connection kind. */
export const DRIVERS: Record<QueueKind, QueueDriver> = { memory: memoryDriver, kafka: kafkaDriver, sqs: sqsDriver, rabbit: rabbitDriver };
