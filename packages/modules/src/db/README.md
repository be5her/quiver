# Databases

MySQL, PostgreSQL, SQLite (via Node's built-in `node:sqlite`, nothing to compile) and Redis. A schema tree, a table browser that edits rows in place, a SQL editor with autocompletion, multi-statement scripts and parameters, a Redis key browser that edits keys, saved queries, a searchable history and a schema search.

## Connections

A connection is created from the kind menu or **From URL…**: `mysql://user:pass@host:3306/db`, `postgres://…/db?sslmode=require`, `redis://:pass@host/2`, `rediss://` for TLS, or a SQLite path. The same URL box sits at the top of the connection form and fills it on paste, with the password going to the secret box. Host, user, database, file and the tunnel fields take `{{variables}}`, resolved when the connection opens from the API module's globals and active environment, with the workspace's root `.env` underneath, so a committed connection can say `{{DB_HOST}}` and each teammate dials their own. The Access section (Teleport tunnel or a tunnel command, see the [Teleport module](../teleport/README.md), or for Redis a Grafana data source) is folded while the connection is direct. A PostgreSQL connection through Teleport also needs its Database field: `tsh proxy db` requires the database inside the server (`--db-name`), and Quiver says so when it is missing.

**Production** is a committed flag: the connection's tabs carry a `PROD` badge and every write from the UI (a query that writes, applying grid edits, a commit) is confirmed first. It travels with the repo, so the whole team gets the guard; agents are gated by `mutating` as before.

A PostgreSQL connection names the database to connect to; the tree's second level lists its schemas (`public` first) and `database` in the schema and table commands means the schema. There is no `SHOW CREATE TABLE` in Postgres, so the Definition view shows a CREATE TABLE built from the catalog. Timestamps, dates, `numeric` and `bigint` values are kept as text so nothing is rounded or shifted into the local time zone.

**Redis through Grafana.** A Redis that is only reachable inside a cluster, but is exposed in Grafana with the Redis plugin (`redis-datasource`), can be reached through Grafana. Access "Grafana data source" takes the Grafana address and shows whether this machine is signed in to it. It then lists the Redis data sources the signed-in user can query, from `/api/frontend/settings`, which answers viewers too. Sign-in is the Logs module's: there is one session per Grafana origin on this machine, so signing in or out in either module covers both. Host, port, user, password, TLS and the database index are hidden in this mode, because the data source's own address picks the server and the database. The connection stores the address and the data source's uid and name, nothing secret, so it can be committed and each teammate signs in with their own account. `{{variables}}` work in the address. The tree, the key browser and the console mark it "via Grafana".

Every command is one query on Grafana's `/api/ds/query` in the plugin's CLI mode, and runs with the signed-in Grafana user's permissions. Arguments are single-quoted for the plugin's POSIX-style shell splitter, so spaces, quotes and line breaks arrive unchanged. An argument with a lone UTF-16 surrogate would be replaced with U+FFFD by Grafana's JSON, so it is refused instead. The reply comes back as redis-cli text in one `Value` field and is read back into strings, integers, nil and nested arrays; numeric strings stay strings. The text cannot carry tab characters inside values, because Go's tabwriter swallows them. The key browser batches TYPE and TTL of a page of keys into one request. Grafana runs each query on any connection of a pool it shares with every dashboard. So `SELECT`, `MULTI`/`EXEC`, `WATCH`, the subscribe commands, `MONITOR`, `AUTH`, `HELLO`, `CLIENT SETNAME` and similar per-connection commands are refused, and the database index must stay 0. Nothing can be cancelled.

Failures say what to do:
- Without a session the call fails with `SIGN_IN_REQUIRED`, and the views offer "Sign in to Grafana".
- Grafana's bare 500 "Query data error" means the data source cannot reach its Redis. Quiver says so and suggests asking the Grafana admin to run Save & test on it.
- Errors from the plugin and from Redis are shown as they are.
- When the saved uid is gone but a Redis data source of the saved name is there (an admin provisioned it anew), the error names the new uid and offers "Use" it. The form's picker says the same.
- When the admin turned the plugin's CLI off (`cliDisabled`), the connection only reads. The key browser goes through the plugin's fixed commands (`tmscan`, `type`, `ttl`, `get`, `hgetall`, `smembers`, `zrange`, `info`), which turn numeric values into numbers and show lists and streams by length only. Commands and edits are refused.

In the tree, one click on a connection expands it, the hover button opens its main view (a query, or the keys for Redis), and the `…` button or a right-click opens the menu: new query, schema search, edit, disconnect, delete. A dot marks a connection that is open, amber when a transaction is open on it.

## Tables

A database with more than ten tables gets a filter at the top of its list: it matches table names as you type, Enter opens the first match and Escape clears it. Click a cell in any grid to see its whole value underneath; text that holds a JSON object or array is shown formatted there, with numbers kept exactly as stored (a 64-bit id does not get rounded). The panel button next to it opens the row transposed, one column per line.

The table browser's WHERE filter is a one-line SQL editor: it completes the table's columns (with their types) and SQL keywords, Enter applies it (or picks the highlighted completion while the list is open), and a pasted line break becomes a space.

**Editing.** With a primary key the grid is editable: double-click a cell (or press Enter on it), type, Enter commits and Tab moves to the next cell; the row's context menu sets a cell to NULL, deletes the row or keeps it again; **Row** adds a new one at the bottom. Changed cells are amber, deleted rows struck through, new rows green. Changes are keyed by the primary key, so paging, sorting or a reload from another tab keeps them; **SQL** shows the statements they become, **Apply** runs them in one transaction (`db.table.apply`) and **Discard** drops them. An update or delete that matches anything but exactly one row rolls everything back, so a stale key never touches two rows. Views and tables without a primary key stay read-only, and the bar says so.

**Navigation.** Cells of a foreign-key column get an arrow on hover that opens the referenced table filtered to that row; the context menu offers the same, plus "Filter by this value", copy as JSON and copy as a SQL literal. The Structure view lists Foreign keys and Referenced by, each name opening the other table.

**Export.** The export menu copies the rows in hand as CSV, JSON, Markdown or INSERT statements, or saves every row of the table (with the current filter and order) to a file through the save dialog.

## Queries

The editor completes table and column names (from `db.schema.columns`, reloaded after writes) and keywords. Ctrl+Enter runs the selection or everything, Ctrl+Shift+Enter the statement under the cursor. On MySQL and PostgreSQL a **Stop** button replaces Run while a statement is running and kills it from a second connection; SQLite calls are synchronous in the main process and cannot be interrupted, so there is no Stop there. A truncated SELECT offers **Load next N**, which runs the statement again as a subquery with LIMIT and OFFSET after the rows in hand (without an ORDER BY the pages may overlap, which the button says). The export menu works as in the table browser; "save all rows" runs the query again on the host.

`{{parameters}}` in the text resolve from the API module's variables (highlighted, value on hover); any other name is asked for on each run, with the last value offered again, and the values are kept with the tab.

**Transaction** starts one on the pooled connection; every statement sent to that connection until **Commit** or **Rollback**, from any tab or agent, is inside it, and a COMMIT or ROLLBACK typed by hand ends it too. The tree marks the connection while it is open.

Views follow writes made anywhere (a query tab, the grid, the console, an agent): after a script that can write, by the same classification that gates agents, the host announces `db-data:<connection id>`, and the schema tree, the completion namespace, open table tabs and their rows, the Redis key list and the open key reload.

## History and search

The sidebar keeps the last five runs; **Show all** (and the palette's "Query history") opens the history tab: full text search, a connection and an outcome filter, time, duration and row count, and each entry opens in a query tab, becomes a saved query or is copied. "Search tables and columns" (palette, the sidebar's magnifier, a connection's menu) opens the schema search: every database of every SQL connection (MySQL's own schemas left out) is searched as you type, hits are grouped by connection and database, and a hit opens its table.

## Redis

The key browser scans by pattern a page at a time and shows the server's vitals (version, uptime, clients, memory, keys, ops per second, keyspace hit rate) from `db.redis.info`. **New key** asks for a name and a type and creates it with a first value. In the detail, a string is edited in place (Save keeps the TTL; JSON shown pretty is stored minified again); hash fields and set, sorted-set and list items are edited by double-clicking a cell, removed from the context menu and added with **Add**; the clock sets or removes the expiry, and the key can be renamed or deleted. These edits go through `db.redis.command`, which takes argument lists, so values with spaces, quotes or line breaks need no quoting.

## Storage

Connections are committed under `.quiver/db-connections/` and saved queries under `.quiver/db-queries/`; passwords are encrypted per machine in `.quiver/local` and never committed (a headless [`quiver`](../../../../docs/cli.md) run cannot decrypt them and says so with `SECRET_UNAVAILABLE` rather than connecting without one). SQLite files referenced by a relative path resolve against the project folder, so a committed connection works for every teammate. The query history is per machine, under `.quiver/local`; applied grid edits are recorded there as one entry.

A connection can reach its server through a tunnel: a Teleport database, or any command with a `{port}` placeholder (ssh and friends). A Redis connection through Grafana stores only the Grafana address and the data source's uid and name. Its Grafana session is per machine, in the app data folder, and shared with the Logs module. A query that fails because the Teleport cluster's certificate expired comes back as `TELEPORT_LOGIN_REQUIRED` naming the cluster, with a "Log in again" button.

## Agents

Listing connections, schemas, columns, the schema search, saved queries and the history is allowed. `db_query_run` and `db_redis_command` decide per call: `SELECT`, `SHOW`, `EXPLAIN` and read-only Redis commands always work, anything that writes is gated. `db_table_apply` is gated unless `preview` is set; `db_transaction` gates the commit; `db_export` is gated when it writes a file or runs a query that writes; `db_query_cancel` is allowed. Deleting connections and saved queries is gated. Passwords are never returned to agents. `db_connection_save` and `db_connection_test` decide per call: pointing a connection whose password is stored at another kind, host, port, TLS setting or access without giving a password of its own is gated (the stored password would be sent there), and so is a tunnel command (`access.type: command`) that is not the one already saved, since it starts a process; a rename, or a test of the connection as it is, is allowed.

Three tools say what each call does, so an agent rule can name one action of them (`db.query.run#ddl`; see [Agent permissions](../../../../README.md#agent-permissions)):
- `db.query.run`: `select` (every statement reads), `insert` (`INSERT`, `REPLACE`), `update` (`UPDATE`, `MERGE`, an upsert), `delete`, `ddl` (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME`, `COMMENT`, `GRANT`, `REVOKE`, `SELECT … INTO` a new table) and `other` (any other write: `SET`, `CALL`, `COPY`, transactions, `VACUUM`, `SELECT … INTO OUTFILE`, a writing `PRAGMA`, a `SELECT` of a built-in function that writes such as `nextval` or `pg_terminate_backend`). A `WITH`, a `MERGE` or an `EXPLAIN ANALYZE` takes the most severe change it makes (a PostgreSQL `WITH d AS (DELETE …) SELECT …` is `delete`), and a script with several statements gets its most severe one (`ddl`, then `other`, `delete`, `update`, `insert`, `select`), so `DELETE …; DROP TABLE t` is `ddl`. Redis commands through the query runner are `select` when they only read and `other` otherwise. `select` is exactly what the read-only classification lets through, so `db.query.run#ddl: deny` with mode allow refuses a `CREATE TABLE` and lets reads and other writes through. The text is read as MySQL, PostgreSQL (with and without standard strings) and SQLite would read it, whole and in the pieces the drivers send, and the most severe reading counts, so a `#`, a backslash before a quote, a `$` string or a nested comment cannot hide a write from it; a read with such text in a string may then be asked about. A function the database itself defines can still write from a `SELECT`: where that matters, connect with a database user that can only read.
- `db.redis.command`: `read`, `write` (commands on keys) and `admin` (server-wide, and scripts, which can call any command: `FLUSHALL`, `FLUSHDB`, `CONFIG`, `SHUTDOWN`, `SAVE`, `ACL`, `SCRIPT`, `EVAL`, `EVALSHA`, `FCALL`, `MODULE`, `REPLICAOF`, and the `CLIENT`, `DEBUG` and `MEMORY` subcommands that are not on their short read list, such as `CLIENT KILL`, `CLIENT UNBLOCK`, `DEBUG RELOAD`); several commands get the most severe.
- `db.table.apply`: `insert`, `update` or `delete` when every edit is of that kind, `mixed` otherwise (deny `mixed` as well when denying `delete`).

Redis through Grafana is gated the same way: the same read-only classification decides per call, and the production flag still confirms UI writes. The plugin's CLI mode has no command whitelist and runs as the signed-in Grafana user, so Quiver's gating is the only guard for agents.
- `db_connection_save` accepts `access: { type: "grafana", grafanaUrl, datasourceUid, datasourceName }` for Redis, and refuses it for SQL kinds.
- `db_grafana_redis_datasources` (allowed) lists a Grafana's Redis data sources with uid, name and whether the CLI is off.
- `db_grafana_session` (allowed) says whether this machine is signed in to a Grafana.
- Signing in is not a tool. `db.grafana.signin` is hidden from MCP and the palette, as in Logs, and an agent that gets `SIGN_IN_REQUIRED` asks you to sign in.

## Verified by

The smoke runs against a SQLite file and an in-process fake Redis (keys, console, info, expiry, rename and the collection commands, a broken connection). On the host it checks foreign keys both ways, the columns overview, the schema search, a row-edit preview, inserts, updates and deletes by key, the rollback when a key matches two rows, every export format and a file export, history search and outcome filters, a transaction begun and rolled back, cancel on SQLite, `db.redis.info`, exact-argument Redis commands, a `{{REDIS_HOST}}` connection resolved from the workspace `.env`, and an agent refused moving a connection with a stored password to another host or port, testing it elsewhere, and saving or testing a tunnel command, while it may rename the connection and test it as it is. In the UI it edits a cell and applies it, opens the context menu, the row detail and the export menu, searches the history tab, creates a Redis key from the dialog and sets its TTL, besides the earlier WHERE completion, table filter and JSON cell checks. Redis through Grafana runs against the fake Grafana of the Logs part. Its Redis data sources answer from the same fake Redis the way the plugin does: shell-split CLI lines, redis-cli text, a 500 "Query data error" for one that cannot reach Redis, and one with the CLI turned off. The host checks cover:
- a committed connection with no secret, refused for SQL kinds and with a database index
- `SIGN_IN_REQUIRED` when signed out, a sign-in shared with Logs, and a sign-out from Logs ending it
- the data source list for agents, PING and INFO
- a SET/GET/EXISTS/DEL round trip of a value with quotes and a line break, and numeric strings and arrays in the console
- scan with type and TTL, key detail and info
- the plugin's error verbatim, the unreachable data source, and a uid that changed while the name stayed
- `SELECT` and an argument Grafana cannot carry, refused before anything runs
- agent gating of a write, and the read-only mode

In the UI it checks the Access section with the sign-in state and the picker, and the key browser over Grafana.

Set `QUIVER_SMOKE_MYSQL=mysql://user:pass@host:3306/db` or `QUIVER_SMOKE_POSTGRES=postgres://user:pass@host:5432/db` to also exercise a live server.

The smoke checks are in [`src/main/smoke/parts/db.ts`](../../../../src/main/smoke/parts/db.ts); `npm run smoke -- db` runs them alone, with `--shots` for the UI checks.
