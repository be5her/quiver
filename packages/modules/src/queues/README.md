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

**Connection** (`kind: rabbit`): `host`, `port` (5672, or 5671 with `ssl` for amqps), `vhost` (`/` by default), `username` and the secret `password`, plus `managementUrl` for the management HTTP API (`http://<host>:15672` when empty, `https://<host>:15671` with `ssl`), reached with the same user. The driver builds the AMQP options from these fields; a host that looks like a pasted URL (`amqp://user:pass@host`) is refused. With neither user nor password set it uses RabbitMQ's `guest`/`guest`, which a broker accepts from localhost only. One AMQP connection and one confirm channel are pooled per connection (scoped by workspace), rebuilt when the settings or the password change, and closed when the connection is deleted or the workspace closes; peeks, checks and tails each open a channel of their own on it. `test` tries AMQP and the management API apart and says which failed.

**Destinations**: queues by name, exchanges as `exchange:<name>`. The listing comes from the management API: queues with their message count (ready plus unacknowledged), consumers, type and arguments, then the named exchanges with their type; the default exchange, the built-in `amq.*` ones (they can still be published to) and Quiver's own `quiver-tail-…` queues are left out. Its counts lag a few seconds, as the management API's statistics do; `describe` of a queue takes the ready count and consumers from AMQP, which is exact, and lists its bindings (`describe` of an exchange lists where it routes). Without the management API, listing fails and `describe` of a queue falls back to the AMQP counts.

**Peek** takes up to `limit` messages from the head of the queue with `basic.get` and requeues them all (`nack` with requeue), so nothing is consumed, but **every peeked message is marked redelivered**, and on a quorum queue each peek counts as a delivery toward its `delivery-limit`, after which the broker dead-letters or drops it. While a peek holds them, other consumers do not get those messages. `latest` reads up to 1000 from the head and keeps the newest `limit`; RabbitMQ cannot read a queue from its tail. Messages a consumer holds unacknowledged are not seen. A stream queue (`x-queue-type: stream`) is read from its first offset instead, which marks nothing. An exchange holds no messages, so peeking or purging one is `NOT_SUPPORTED`. Messages come back with `key` = the routing key, a sequence number as `id`, and the exchange, routing key, redelivered flag and AMQP properties (message id, content type, …) as `attributes`.

**Produce** goes to a queue through the default exchange (a `key` is refused there: the routing key is the queue's name), to an exchange with `exchange` set and `destination` as the routing key, or to `exchange:<name>` with `key` as the routing key. It is published persistent and mandatory on a confirm channel with a fresh `messageId` (the id that comes back) and a timestamp; a missing queue or exchange is `NOT_FOUND`, and a message no queue is bound for is `REQUEST_FAILED` instead of dropped silently. `partition` and `delaySeconds` are refused.

**Live tails and waits** never consume. They declare an exclusive, auto-deleted queue of their own (`quiver-tail-…`) and bind it to what routes to the destination: for a queue, a copy of each of its bindings; for a fanout, topic or headers exchange, everything; for a direct exchange, the routing keys it is bound with. A tail therefore sees a copy of what exchanges route to the queue, but not messages published straight to the queue by name (the default exchange cannot be copied), so a queue reached only that way cannot be tailed (`NOT_SUPPORTED`; peek it instead). While a tail runs, its binding also makes messages routable that would otherwise be dropped. `earliest` on a queue first replays up to 1000 of the messages already in it, the way peek does (a message routed during the replay may show twice); on an exchange it is the same as `latest`. A stream queue is tailed from its `first` or `next` offset. A tail of a missing queue or exchange is `NOT_FOUND`; one whose channel or connection closes ends with the reason.

**Admin**: `create` makes a durable classic queue, or for `exchange:<name>` a durable topic exchange (`CONFLICT` if it exists); `purge` empties a queue; `delete` removes a queue or an exchange. There are no consumer groups.

The naming, connection options, management API rows, tail bindings and message conversion (`packages/core/src/queues-rabbit.ts`) are unit tested in `packages/core`. The smoke's `rabbit` section always runs the management API checks against a fake it starts and stops (`src/main/smoke/fake-rabbit-mgmt.ts`, no AMQP behind it): `test` telling AMQP and management apart, a pasted URL refused, the listing with counts and without default, `amq.*` or tail entries, the vhost sent as `%2F`, describe of a queue and an exchange, not found, peek and purge of an exchange, a tail of a default-exchange-only queue refused, and a wrong password. With `QUIVER_SMOKE_RABBIT=amqp://user:pass@host:5672/vhost` (and `QUIVER_SMOKE_RABBIT_MANAGEMENT` when the API is not on port 15672 of that host) it also runs against a real broker: create, produce to a queue and through an exchange, peek oldest and newest without consuming and with the redelivered flag, exact describe, tails of a queue and of an exchange, wait, unroutable and missing targets, a stream queue, purge and delete. Everything it makes has a fresh name and is deleted again; it prints a SKIP line otherwise.
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
