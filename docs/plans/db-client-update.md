# Databases module: the client update

One branch (`feat/db-client`), one pull request. This file is the checklist: tick items as they land so a later session can pick up where the last one stopped. Design decisions are recorded next to each item so they are not re-litigated.

## Ground rules

- Every feature is host commands (`defineCommand`, zod input) plus UI. Agents get the commands through MCP; writes are `mutating`.
- Pure logic goes in `packages/core` with unit tests: SQL building, URL parsing, export formatting, statement ranges, template resolution.
- The host announces every write it makes outside the store (`db-data:<connection id>` after writes, `db-history` after history writes).
- Smoke checks in `src/main/smoke.ts` cover new host behaviour; UI checks run under `QUIVER_SMOKE_SHOTS`.
- Docs: `packages/modules/src/db/README.md` (what, how, Agents, Verified by), the README table row, `src/renderer/README.md` only if the shell changes.

## Phase 1: core model and helpers

- [x] `DbKindSchema` gains `postgres`; labels, default port 5432, kind icon and colour.
- [x] `DbConnectionSchema` gains `production: boolean` (default false) and, for Postgres, reuses `database` (the database to connect to; the tree's second level lists schemas, and `database` in schema and table commands means the schema, default `public`).
- [x] `DbForeignKey { name, table, database, columns, refTable, refDatabase, refColumns }`; `DbTableDetail` gains `primaryKey: string[]`, `foreignKeys`, `referencedBy`.
- [x] `DbTableEdit` (`insert | update | delete`) and `DbTableApplyResult`.
- [x] `sql.ts`: `quoteIdentifier`/`qualifiedName` accept `postgres`; `sqlLiteral(kind, value)`; `buildTableEdits(kind, table, database, edits)` returns statements; `splitStatementRanges` and `statementAt(sql, offset)`; `wrapForPage(statement, limit, offset)` for "load more"; `isSelectLike(statement)`.
- [x] `db-url.ts`: `parseConnectionUrl(text)` for `mysql://`, `postgres://`/`postgresql://`, `redis://`/`rediss://`, `sqlite:`/`file:` and bare `.db` paths; returns the connection fields plus the password separately.
- [x] `db-export.ts`: `rowsToCsv`, `rowsToJson`, `rowsToMarkdown`, `rowsToInsert(kind, table, columns, rows)`; the UI's `db-format.ts` re-exports them.
- [x] `resolveConnectionTemplate(connection, vars)`: `{{name}}` in host, port, user, database, file and the tunnel command.
- [x] Unit tests for all of the above.

## Phase 2: drivers and host commands

- [x] Driver interface: `columns(database)` (every table with its columns in one call), `cancel()` (optional), foreign keys in `table()`, `primaryKey`.
- [x] MySQL: foreign keys from `information_schema.KEY_COLUMN_USAGE`, referenced-by the same way, columns overview from `information_schema.COLUMNS`, cancel with `KILL QUERY <thread id>` on a second connection.
- [x] SQLite: `PRAGMA foreign_key_list`, referenced-by by scanning the other tables' lists, columns overview from `PRAGMA table_info` per table; no cancel (calls are synchronous).
- [x] PostgreSQL driver (`pg`, `@types/pg`): schemas as the second level, tables with `reltuples` estimates, columns from `information_schema`, indexes from `pg_index`, foreign keys from `pg_constraint`, a synthesised `CREATE TABLE` as DDL, `run` with `rowMode: 'array'` and the result's `command`/`rowCount`, `tableRows` with exact counts under 200k rows, cancel with `pg_cancel_backend`. Timestamps, dates and numerics are kept as text so nothing is rounded or shifted.
- [x] `createDriver` case; `DbKindSchema` and the connection form; the SQL editor's `postgres` dialect (`PostgreSQL` from `@codemirror/lang-sql`).
- [x] Connection values go through `resolveConnectionTemplate` when a driver opens, with the API module's variable map (global, then active environment) and the workspace's root `.env` as the lowest layer.
- [x] `db.schema.columns { connectionId, database? }`: tables with columns, for completion and search.
- [x] `db.schema.search { query, connectionId? }`: tables and columns matching across the SQL connections of the workspace (each connection's default database, or SQLite's main).
- [x] `db.table.apply { connectionId, table, database?, edits[], preview? }`: builds the statements with `buildTableEdits`, `preview` returns them without running; otherwise runs them in a transaction, rolls back if an update or delete touches anything but one row, announces `db-data`, records one history entry. Mutating unless `preview`.
- [x] `db.query.cancel { connectionId }` kills the running statement when the driver can (no run id: the pool keeps one driver per connection, so the connection identifies the statement).
- [x] `db.transaction { connectionId, action: begin | commit | rollback }` on the pooled driver; `db.connection.list` reports `inTransaction`. Commit is mutating.
- [x] `db.export { connectionId, format, query? | table?, database?, where?, orderBy?, direction?, path?, maxRows }`: csv, json, markdown or sql (INSERT statements); returns the text, or writes the file when `path` is given (mutating then).
- [x] `db.history.list` gains `search` and `ok` filters, limit up to 2000.
- [x] `db.redis.info { connectionId }`: version, uptime, clients, memory, keys, ops/sec, hit rate parsed from `INFO` and `DBSIZE`.
- [x] Redis writes go through `db.redis.command` (argument lists, so values need no quoting; gated per call like the console); the fake Redis of the smoke learns `EXPIRE`, `PERSIST`, `RENAME`, `HDEL`, `SADD`, `SREM`, `ZADD`, `ZREM`, `RPUSH`, `LSET`, `LREM`, `SET … KEEPTTL|EX` and a fuller `INFO`.

## Phase 3: UI

- [x] Code editor: `cursorOffset()`, `Mod-Shift-Enter` emits `runCurrent`.
- [x] Query tab: column completion from `db.schema.columns`; "run statement under cursor" (Ctrl+Shift+Enter, also in the Run button's tooltip); Stop button while running on MySQL and Postgres; Export menu replacing the two copy icons (copy CSV, JSON, Markdown, INSERT; Save as… through the save dialog); "Load next N" on a truncated SELECT by wrapping the statement; `{{parameters}}` resolved from the API variables, unresolved ones prompted for and remembered per tab; the production badge and a confirmation before any write on a production connection; the Transaction toggle with Commit and Rollback.
- [x] Result grid: `editable` mode with double-click (or F2/Enter) inline editing, Tab/Shift+Tab moving between cells, changed cells, deleted rows and inserted rows marked; right-click context menu (copy value, copy as SQL literal, copy row as JSON, filter by this value, open referenced row, set NULL, delete row); a row detail panel (transposed, JSON formatted) toggled from the detail strip; foreign-key cells get a follow arrow on hover.
- [x] Table tab: pending changes with Apply (confirm on production), Discard and Preview SQL; "+ Row"; read-only with a hint when the table has no primary key or is a view; the WHERE filter can be preset (for "filter by this value" and foreign-key navigation); Structure shows Foreign keys and Referenced by, each opening the other table.
- [x] History tab (`db.history`): search, connection and outcome filters, time, duration and row count, open in a query tab, save as query, copy. The sidebar keeps the last five with "Show all".
- [x] Schema search: palette action "Search tables and columns" (Ctrl+Shift+F while the Databases module is active is not reserved by the shell, so no binding; the palette is the entry) opening a `db.search` tab; results grouped by connection and database; a table opens its tab, a column opens the table.
- [x] Redis: edit a string value (Save keeps the TTL), set or remove the TTL, rename, delete; hash fields and set, zset and list items can be added, edited and removed from the grid; "New key" with a type choice; an Info strip in the key browser.
- [x] Connection form: "Paste a URL" field that fills the form; the access section (Teleport, tunnel command) behind a disclosure, open only when the saved access is not direct; the Production checkbox; `{{variables}}` in host, user, database and file with highlighting.
- [x] Sidebar: one Open action per connection row plus a right-click (and `…`) menu with New query, Browse keys, Edit, Disconnect, Delete; "New connection" menu gains "From URL…".
- [x] Kind icon and colour for Postgres everywhere a kind is shown.

## Phase 4: verification and docs

- [x] Smoke, host side: SQLite foreign keys in `schema.table`, `schema.columns`, `schema.search`, `table.apply` (preview, insert, update, delete, rollback on a key that matches two rows), `export` in every format and to a file, history search, transaction begin and rollback, `redis.info`, Redis writes through the console, `db.query.cancel` answering on SQLite, connection URL parsing through `connection.save`.
- [x] Smoke, UI: edit a cell, apply, read it back; the context menu; the row detail; the history tab; the export menu; Redis new key and TTL.
- [x] `QUIVER_SMOKE_POSTGRES=postgres://user:pass@host:5432/db` exercises a live server the same way `QUIVER_SMOKE_MYSQL` does.
- [x] `npm run typecheck`, `npm test`, `npm run smoke` (with `QUIVER_SMOKE_SHOTS`) green.
- [x] Module README and README table row; pull request with the `enhancement` label (screenshots reviewed from the smoke run).

## Decisions worth knowing

- Rows without a primary key (and views) stay read-only in the grid. Matching on every column is how other clients corrupt data; a key is required.
- Apply runs inside a transaction and rolls back when any update or delete affects a number of rows other than one, so a stale key never touches two rows.
- The production flag is a committed property of the connection: it travels with the repo, so every teammate gets the same guard. It is a UI confirmation only; agents are already gated by `mutating`.
- A transaction holds the pooled connection, so it spans every tab on that connection. The toggle says so.
- "Load next N" wraps the statement as a subquery with LIMIT and OFFSET; the result can differ between pages without an ORDER BY, which the button's tooltip says.
- Query parameters reuse the API module's `{{variable}}` system rather than a second syntax. Connection fields too, with the workspace `.env` underneath, so a committed connection can say `{{DB_HOST}}`.
- Postgres has no `SHOW CREATE TABLE`; the Definition view shows a CREATE TABLE built from the catalog (columns, nullability, defaults, primary key, foreign keys).
- Cancellation needs a second connection to the same server (MySQL `KILL QUERY`, Postgres `pg_cancel_backend`). SQLite calls are synchronous in the main process and cannot be interrupted; the Stop button is not offered there.
