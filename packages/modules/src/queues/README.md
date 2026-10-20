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

**Sidebar**: the connections, each with its kind (`MEM`, `KAFKA`, `SQS`, `AMQP`) and name, opening to its topics or queues with their message counts (and `FIFO` on SQS FIFO queues). The counts follow what is produced, purged, created or deleted from Quiver; the row's Refresh asks the broker again for what other clients did. The `+` of the header asks for a name and a broker and opens the new connection's settings; a connection's `+` creates a topic (with its partitions) or a queue (standard or FIFO on SQS); its `…` and right-click menu also test, edit and delete it. A topic or queue's menu opens it on its messages, the producer, the live tail or (Kafka) its consumer groups, and purges or deletes it.

**Connection tab**: the fields of its broker (Kafka brokers, client id, TLS, SASL and user; SQS region, profile or access key id, and an endpoint for LocalStack; RabbitMQ host, port, virtual host, TLS, user and management API; nothing for the memory broker), saved with Ctrl+S. The password or secret access key is a password box: what is typed goes to `queues.connection.save` as a secret and is cleared, the stored one is never read back (the box says whether one is stored, and "Remove on save" drops it). Test tries what is on screen: the saved connection, or the unsaved changes on top of it with a newly typed secret. A Kafka connection has a Consumer groups view: every group with its state, members and total lag, opening to committed offset, end and lag per partition.

**Destination tab**: the topic or queue with its counts, partitions and consumers, and Refresh, Purge and Delete. Views:

- **Messages**: a peek (`queues.message.peek`) as a table of position (partition:offset, or the broker's id), key, header count, body and time; newest or oldest first, 10 to 500, and one partition or all on a topic. A message opens beside the table with its key, headers and attributes and the body pretty-printed when it is JSON; Produce again copies it into the producer. It peeks again after each change made from Quiver. On RabbitMQ it waits for a click and says why: a RabbitMQ peek requeues, which marks the messages redelivered.
- **Produce**: key, headers and a JSON or text body (Format pretty-prints it, a warning says when it does not parse), plus the partition on a topic (by key or round robin otherwise), the message group and deduplication ids on an SQS FIFO queue (the group is required) or a delay on a standard one, and the exchange on RabbitMQ (empty for the default exchange, with the queue as routing key). Ctrl+Enter sends; the broker's id is shown. "Sent before" reloads a message from this machine's history.
- **Live tail**: a consumer from new messages or from the start, with Start and Stop and a text filter on body, key and header values that applies to what was already received. It reads as the host announces new messages and once a minute while quiet, so an open tail is not stopped as idle; it keeps running while another view is on screen (a dot on the view says so) and stops when the tab closes. SQS and RabbitMQ tails say that they take messages off the queue.
- **Consumer groups** (Kafka): the groups reading this topic and their lag on its partitions.

**Confirmations**: purging and deleting a topic or queue, and deleting a connection, ask first; creating a topic or queue asks for its name in a dialog first.

**Palette**: "New queue connection", and "Open topic or queue", which picks the connection and takes a name, listing the matches as it is typed (a name that does not exist yet opens too, so the first message can create it).

The smoke's `ui` section (with `--shots`) drives the panel on a memory connection: creating it from the sidebar's dialog and testing it, the Kafka form's fields and password box, creating a topic with three partitions, starting a live tail, producing a message with a key, a header and a partition, seeing it in the tail (and its filter) and in the peek table with the body pretty-printed, the count in the sidebar, Purge's confirmation (Cancel keeps the message, Purge empties the topic), and deleting the topic and the connection after their confirmations. Screenshots `30a` to `30f`.
<!-- /lane:QU -->

<!-- lane:agents -->
## Agents

Listing, describing, peeking and tailing are allowed, as is testing a saved connection or a draft with secrets of its own. Producing, purging, creating and deleting destinations, saving or deleting connections, and testing a draft on top of a saved connection (which would send its secrets to the draft's broker) are gated as mutating.
<!-- /lane:agents -->

## Verified by

The smoke part is split per driver: [`src/main/smoke/parts/queues/`](../../../../src/main/smoke/parts/queues); `npm run smoke -- queues` runs it. The Kafka and RabbitMQ sections need a real broker and run only when `QUIVER_SMOKE_KAFKA` or `QUIVER_SMOKE_RABBIT` is set.
