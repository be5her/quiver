# Queues

Kafka topics, SQS queues and RabbitMQ queues: list them with their counts, peek at messages without consuming them, produce messages, tail a destination live, and see Kafka consumer group lag. Connections are committed under `.quiver/queues/<id>.json`; passwords and keys stay in `host.secrets`. Under construction: the module is registered and empty; the plan is in [docs/plans/git-runner-queues.md](../../../../docs/plans/git-runner-queues.md).

<!-- lane:Q1 -->
## Connections, messages and Kafka

To be written by lane Q1.
<!-- /lane:Q1 -->

<!-- lane:Q2 -->
## SQS

To be written by lane Q2.
<!-- /lane:Q2 -->

<!-- lane:Q3 -->
## RabbitMQ

To be written by lane Q3.
<!-- /lane:Q3 -->

<!-- lane:QU -->
## The panel

To be written by lane QU.
<!-- /lane:QU -->

<!-- lane:agents -->
## Agents

Listing, describing, peeking and tailing are allowed. Producing, purging, creating and deleting destinations, and saving or deleting connections, are gated as mutating.
<!-- /lane:agents -->

## Verified by

The smoke part is split per driver: [`src/main/smoke/parts/queues/`](../../../../src/main/smoke/parts/queues); `npm run smoke -- queues` runs it. The Kafka and RabbitMQ sections need a real broker and run only when `QUIVER_SMOKE_KAFKA` or `QUIVER_SMOKE_RABBIT` is set.
