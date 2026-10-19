# Metabase

A Metabase server (version 49 or later) through its REST API, signed in with an API key or in a Quiver window with your browser account. The sidebar shows the collections with their saved questions and dashboards, and the databases Metabase knows with their tables. A saved question runs with its parameters, and a native SQL editor completes Metabase's tables and columns. Results come back in the Databases module's grid, and exports go through Metabase.

## How it works

A connection is one JSON file under `.quiver/metabase-connections/`: a name, the Metabase address (a sub-path is kept, query and hash are dropped) and the way it signs in, `browser` or `apikey`. It holds no credentials, so a teammate who pulls it signs in with their own account or adds their own key.

**Connecting.** The connection tab switches between two modes:
- **API key.** Metabase 49 and later let an admin create API keys. The key is stored encrypted on this machine, under `.quiver/local`, and sent as `x-api-key` on every request. The tab says "Key stored on this machine" or "No key on this machine", and never shows the key again once it is saved; Clear removes it.
- **Browser sign-in.** "Sign in" opens Metabase's `/auth/login` page in a separate window, sandboxed the same way as the Logs module's Grafana sign-in, and any SSO Metabase offers works there. Google's sign-in button opens a popup and posts the result back to the page; the popup gets a sandboxed window of its own, closed with the sign-in window. Once Metabase serves a page outside `/auth/` and `/api/user/current` answers (checked on every navigation and every couple of seconds), the window closes and the connection shows who is signed in. The session lives in its own Electron partition, one per Metabase origin, in the app data folder: it is per machine, never in the project, and shared by every connection and workspace that uses that Metabase. Metabase sessions last 14 days by default and need no renewing. "Sign out" ends the session on Metabase (`DELETE /api/session`) and clears the partition.

**Test** asks Metabase who the connection is (`/api/user/current`) and which version it runs, and shows "Signed in as … · Metabase v…". When a request cannot authenticate it fails with a code the views act on:
- `SIGN_IN_REQUIRED`: a browser connection with no session on this machine. The views offer "Sign in to Metabase".
- `AUTH_REQUIRED`: an API key connection with no key on this machine.
- `AUTH_FAILED`: Metabase refused the key (401 or 403), because it was revoked or mistyped.

For the last two the views offer to open the connection, where the key is set. Other failures show Metabase's own message.

**Questions and dashboards.** The sidebar's Collections branch is Metabase's collection tree, from "Our analytics" down, loaded as you expand it; each collection lists its sub-collections, saved questions and dashboards. Opening a question shows its parameters as inputs (text, number or date, by the parameter's type) and runs it once. Run sends the values with each parameter's own target, the way Metabase does, so the question's SQL or MBQL runs on Metabase with your permissions. The values are kept with the tab. A dashboard expands to the questions on it, and each one runs as a plain question: the dashboard's filters are not applied. Metabase returns at most 2000 rows to an interactive run; when it cut the rows the tab says so, and an export gets them all.

**Tables.** A table in the sidebar's Databases branch opens a table tab, which reads the table the way Metabase's own table view does: through the query builder, `POST /api/dataset` with a `type: query` (MBQL) body, not through SQL. It works for users who may only use the query builder and have no native SQL access, with exactly the permissions they have on Metabase; a refusal shows Metabase's own message. The filter bar picks a field, an operator (is, is not, `>`, `≥`, `<`, `≤`, contains, does not contain, starts with, ends with, is null, is not null, is empty, is not empty; the last four take no value) and a value, a number for numeric fields; filters are ANDed and shown as chips, and "Filter by this value" in a cell's context menu adds an `=` filter. Clicking a column header sorts by it, ascending, then descending, then off. Rows come in pages of 50, 100, 500 or 1000, with Prev and Next. The export menu saves every row through the filters and order, not only the page in hand. Filters, order and page are kept with the tab; the rows are not. For those who can run SQL, the SQL button opens a query tab with `SELECT * FROM <table> LIMIT 100`. Browsing a table is not recorded in the history.

**Native queries.** A query tab picks one of Metabase's databases and has a SQL editor that completes the tables and columns from Metabase's metadata for that database (`/api/database/:id/metadata`). Ctrl+Enter runs it through `/api/dataset`. A query tab opens from a database's terminal button in the sidebar, or from a table tab's SQL button. The query runs as the database user Metabase connects with, so a statement that writes can succeed; agents are gated on such statements by the same classification as `db_query_run`. The database and the text are kept in the tab; the result is not, so a restored tab runs again when asked. Each run is recorded in the workspace history under `.quiver/local` with its database, duration and row count or error.

**Exports.** The export menu copies the rows in hand as CSV, JSON or Markdown, or saves every row as CSV, JSON or Excel through Metabase's own export endpoints (`/api/card/:id/query/<format>` for a question, `/api/dataset/<format>` for a native query or a table). Those return every row, up to Metabase's own export limit, formatted as Metabase formats them, and the file goes where the save dialog says.

## Storage

Connections are committed under `.quiver/metabase-connections/` and hold no secret. API keys are encrypted per machine in `.quiver/local` (`metabase-secrets`) and never committed. The native query history is per machine, under `.quiver/local` (`metabase-history`). Browser sign-ins are Electron session partitions in the app data folder, one per Metabase origin. Views refresh on `metabase.changed` when a session, a key or the history changes.

## Agents

Allowed:
- `metabase_connection_list`, `metabase_connection_get`, `metabase_connection_save` and `metabase_connection_test`
- `metabase_session`, which says whether this machine can reach the server and as whom
- `metabase_databases` and `metabase_tables`
- `metabase_table_rows`, a page of a table's rows through the query builder, with filters and an order
- `metabase_collections`, `metabase_collection_items` and `metabase_search`
- `metabase_card_get`, `metabase_card_run` (a saved question is a read) and `metabase_dashboard_get`
- `metabase_history_list`

Decided per call:
- `metabase_query_run`: `SELECT`, `SHOW` and `EXPLAIN` work, anything that writes is gated
- `metabase_export`: exports a question (`cardId`), SQL (`sql`) or a table through filters (`tableId`); gated when it writes a file, or when its SQL writes; without a path it returns CSV or JSON as text

Gated:
- `metabase_signout`, which ends a session every connection to that Metabase shares
- `metabase_apikey_set` and `metabase_apikey_clear`
- `metabase_connection_delete`, which also clears the key
- `metabase_history_clear`

Signing in is not a tool: it needs a person at the window, so `metabase.signin` is hidden from MCP and the palette. A call from an agent when nobody is signed in fails with `SIGN_IN_REQUIRED`, and its message tells the agent to ask you to sign in from Quiver's Metabase view. API keys are never returned: `metabase_apikey_set` answers with the connection summary, which says only whether a key is stored (`hasApiKey`).

## Verified by

The smoke runs a fake Metabase. Its login page signs in the way Google's button does: it opens a popup, which sets the `metabase.SESSION` cookie and posts the outcome back, without anyone clicking (the Logs part's fake Grafana covers the redirect flow); it also accepts a fixed API key. It has one database with two tables, a collection tree with a sub-collection, two native questions (one with a text parameter it echoes in a column) and a dashboard with both. `/api/dataset` records the SQL it gets, fails a query that mentions `boom` the way Metabase fails one, and truncates a large one at 2000 rows. It answers query builder (MBQL) table queries from the table's fixed rows, applying the filters, the order, the limit and the page, records each body it gets, and fails a table that does not exist the way Metabase does. The export endpoints answer CSV, JSON and Excel bytes, for table queries too.

The host-level checks cover:
- normalising the address and refusing a bad one
- `SIGN_IN_REQUIRED` before signing in, then sign-in, who is signed in, and a second sign-in that opens no window
- databases, tables with their fields, the collection tree and items, and search
- a question with a parameter and its columns, and a dashboard's questions
- native query rows, a failed query's message and the truncated flag
- table rows: the first page, a later page, a descending order, the `=`, `contains`, `>` and `is-null` filters and two filters together, the body sent with its source table, page size and order, and a missing table's message
- a CSV export as text and an Excel export to a file, and a table export through a filter as CSV text
- the history and clearing it
- an API key connection: `AUTH_REQUIRED` before a key, setting it, the test with the key, a summary that says a key is stored but never holds it, and clearing it
- what agents may call: no sign-in tool, `metabase_table_rows` allowed, an `INSERT` refused and a `SELECT` allowed, and the gated commands refused
- sign-out on Metabase and locally

In the UI, the checks cover:
- the sidebar's signed-in row and its tree
- the connection tab in both modes
- a question tab with rows
- a table tab opened from the tree with its rows and row count, a filter that narrows them, a header click that sorts, and Next and Prev
- the query tab with a result and the export menu
- the error box with its Sign in button

The smoke checks are in [`src/main/smoke/parts/metabase.ts`](../../../../src/main/smoke/parts/metabase.ts); `npm run smoke -- metabase` runs them alone, with `--shots` for the UI checks.
