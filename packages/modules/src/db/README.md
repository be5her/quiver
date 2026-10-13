# Databases

MySQL, PostgreSQL, SQLite (via Node's built-in `node:sqlite`, nothing to compile) and Redis. A schema tree, a table browser that edits rows in place, a SQL editor with autocompletion, multi-statement scripts and parameters, a Redis key browser that edits keys, saved queries, a searchable history and a schema search.

## Connections

A connection is created from the kind menu or **From URL…**: `mysql://user:pass@host:3306/db`, `postgres://…/db?sslmode=require`, `redis://:pass@host/2`, `rediss://` for TLS, or a SQLite path. The same URL box sits at the top of the connection form and fills it on paste, with the password going to the secret box. Host, user, database, file and the tunnel fields take `{{variables}}`, resolved when the connection opens from the API module's globals and active environment, with the workspace's root `.env` underneath, so a committed connection can say `{{DB_HOST}}` and each teammate dials their own. The Access section (Teleport tunnel or a tunnel command, see the [Teleport module](../teleport/README.md)) is folded while the connection is direct.

**Production** is a committed flag: the connection's tabs carry a `PROD` badge and every write from the UI (a query that writes, applying grid edits, a commit) is confirmed first. It travels with the repo, so the whole team gets the guard; agents are gated by `mutating` as before.

A PostgreSQL connection names the database to connect to; the tree's second level lists its schemas (`public` first) and `database` in the schema and table commands means the schema. There is no `SHOW CREATE TABLE` in Postgres, so the Definition view shows a CREATE TABLE built from the catalog. Timestamps, dates, `numeric` and `bigint` values are kept as text so nothing is rounded or shifted into the local time zone.

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

Connections are committed under `.quiver/db-connections/` and saved queries under `.quiver/db-queries/`; passwords are encrypted per machine in `.quiver/local` and never committed. SQLite files referenced by a relative path resolve against the project folder, so a committed connection works for every teammate. The query history is per machine, under `.quiver/local`; applied grid edits are recorded there as one entry.

A connection can reach its server through a tunnel: a Teleport database, or any command with a `{port}` placeholder (ssh and friends). A query that fails because the Teleport cluster's certificate expired comes back as `TELEPORT_LOGIN_REQUIRED` naming the cluster, with a "Log in again" button.

## Agents

Listing connections, schemas, columns, the schema search, saved queries and the history is allowed. `db_query_run` and `db_redis_command` decide per call: `SELECT`, `SHOW`, `EXPLAIN` and read-only Redis commands always work, anything that writes is gated. `db_table_apply` is gated unless `preview` is set; `db_transaction` gates the commit; `db_export` is gated when it writes a file or runs a query that writes; `db_query_cancel` is allowed. Deleting connections and saved queries is gated. Passwords are never returned to agents.

## Verified by

The smoke runs against a SQLite file and an in-process fake Redis (keys, console, info, expiry, rename and the collection commands, a broken connection). On the host it checks foreign keys both ways, the columns overview, the schema search, a row-edit preview, inserts, updates and deletes by key, the rollback when a key matches two rows, every export format and a file export, history search and outcome filters, a transaction begun and rolled back, cancel on SQLite, `db.redis.info`, exact-argument Redis commands and a `{{REDIS_HOST}}` connection resolved from the workspace `.env`. In the UI it edits a cell and applies it, opens the context menu, the row detail and the export menu, searches the history tab, creates a Redis key from the dialog and sets its TTL, besides the earlier WHERE completion, table filter and JSON cell checks. Set `QUIVER_SMOKE_MYSQL=mysql://user:pass@host:3306/db` or `QUIVER_SMOKE_POSTGRES=postgres://user:pass@host:5432/db` to also exercise a live server.
