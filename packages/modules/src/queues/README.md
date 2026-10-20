# Queues

Kafka topics, SQS queues and RabbitMQ queues: list them with their counts, peek at messages without consuming them, produce messages, tail a destination live, and see Kafka consumer group lag. Connections are committed under `.quiver/queues/<id>.json`; passwords and keys stay in `host.secrets`. Under construction: the module is registered and empty; the plan is in [docs/plans/git-runner-queues.md](../../../../docs/plans/git-runner-queues.md).

<!-- lane:Q1 -->
## Connections, messages and Kafka

**Connections** are committed one per file under `.quiver/queues/<id>.json` (`queues.connection.save` changes only the fields it is given). Passwords and keys are passed as `secrets` by name (`password` for Kafka SASL and RabbitMQ, `secretAccessKey` for SQS), encrypted with `host.secrets` into `.quiver/local/queues-secrets.json`, and never returned: the commands list only the names of the secrets a connection has. A URL with a user or password in it is refused. `queues.connection.test` tries a saved connection, unsaved settings, or changes on top of a saved one; the last form is mutating, since it sends the saved secrets to whatever the changes point at.

**Commands**, the same for every broker through its `QueueDriver` (`drivers/`); what a broker cannot do answers `NOT_SUPPORTED`:

- `queues.connection.list` / `get` / `test`; `save` / `delete` (mutating; delete stops the connection's tails, closes its clients and drops its secrets)
- `queues.destination.list` / `describe` (counts, partitions and their offsets, non-default settings); `purge` / `create` / `delete` (mutating)
- `queues.message.peek`: up to `limit` messages, newest (`latest`) or oldest (`earliest`), across partitions or from one, without consuming them
- `queues.message.produce` (mutating): body, key, headers and partition; the broker's id comes back
- `queues.message.wait`: blocks until a new message whose body, key or a header value contains `match`, or the timeout, which starts once the consumer is in place (a Kafka group join takes a few seconds)
- `queues.consumer.start` / `stop` / `read` / `list`: live tails kept in memory (the last 1000 messages each), read with a cursor and an optional `match`; `dropped` says how many left the buffer unread. Starting a tail is not mutating and each holds a consumer on the broker, so at most 20 run per workspace, and one nobody read for 10 minutes is stopped (its messages stay readable). A tail of a destination that does not exist is `NOT_FOUND`, on every broker
- `queues.group.list`: Kafka consumer groups with state, members and lag per partition
- `queues.history.list` / `clear` (clear is mutating): produced messages (bodies cut at 64 KB) and purges, creates and deletes, per machine in `.quiver/local/queues-history.jsonl`

**Events**: `queues.changed` with `reason: 'connections'` when secrets change, a connection is deleted or a destination is created or deleted; `'messages'` after a produce, purge or history clear; `'consumer'` (with `consumerId`, at most four a second) while a tail receives and when it stops. Connection files are announced by the store.

**Memory broker** (`kind: memory`): an in-process broker with topics, partitions and offsets like Kafka, one per connection and workspace. The first message to a topic creates it (a peek or tail of a missing topic does not). It lives until the connection is deleted, the workspace closes or Quiver quits. It backs the smoke and lets the panel be tried without a broker.

Drivers keep their state (the memory broker's topics, Kafka's pooled clients) under an id scoped by workspace, since a connection file is committed and two checkouts of one project opened at once carry the same id: closing one checkout never touches the other's broker. Quitting stops every tail and disconnects every pooled client.

**Kafka** (`kind: kafka`, through `kafkajs`): `brokers` (`host:port`), `clientId`, `ssl`, and `sasl` (`plain`, `scram-sha-256`, `scram-sha-512`) with `username` and the secret `password`. Admin and producer clients are pooled per connection and rebuilt when its settings or password change; closing the workspace disconnects them. Peeks, tails and waits each join a throwaway group (`quiver-peek-…`, `quiver-tail-…`) that commits nothing and is deleted afterwards, so no real group's offsets move; every `quiver-` group is left out of `queues.group.list`. A produce to a topic that does not exist creates it when the broker allows auto-creation. A peek reads the newest or oldest `limit` of every partition from their watermarks and merges them by time; a tail or wait from `latest` starts at the end offsets of the moment it was asked for, not of its group join a few seconds later. Purge deletes records up to the end of every partition. Internal topics (`__…`) are not listed.

The offset arithmetic (`packages/core/src/queues-kafka.ts`) and the tail buffer and matching (`queues-messages.ts`) are unit tested in `packages/core` and exported from `@quiver/core`.

The smoke's `memory` section always runs: connections and secrets on disk, create, produce, peek (newest, oldest, one partition), describe, history, tails from latest and earliest with cursors and filters, a tail of a missing topic not found, the cap of 20 tails, wait and its timeout, purge, deleting a topic and a connection, two workspaces sharing a connection id keeping brokers of their own, closing the workspace, and the gating of the mutating tools over MCP. Its `kafka` section runs the same flow against a real broker when `QUIVER_SMOKE_KAFKA=host:port` is set (topics get a fresh name and are deleted), and prints a SKIP line otherwise.
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

Listing, describing, peeking and tailing are allowed, as is testing a saved connection or a draft with secrets of its own. Producing, purging, creating and deleting destinations, saving or deleting connections, and testing a draft on top of a saved connection (which would send its secrets to the draft's broker) are gated as mutating.
<!-- /lane:agents -->

## Verified by

The smoke part is split per driver: [`src/main/smoke/parts/queues/`](../../../../src/main/smoke/parts/queues); `npm run smoke -- queues` runs it. The Kafka and RabbitMQ sections need a real broker and run only when `QUIVER_SMOKE_KAFKA` or `QUIVER_SMOKE_RABBIT` is set.
