# Databases

MySQL, SQLite (via Node's built-in `node:sqlite`, nothing to compile) and Redis. A schema tree, a table browser with filter and paging, a SQL editor with autocompletion and multi-statement scripts, a Redis key browser and console, saved queries and a history.

A database with more than ten tables gets a filter at the top of its list in the tree: it matches table names as you type, Enter opens the first match and Escape clears it. Click a cell in any grid to see its whole value underneath; text that holds a JSON object or array is shown formatted there, with numbers kept exactly as stored (a 64-bit id does not get rounded), and Redis string values and hash fields read the same way.

The table browser's WHERE filter is a one-line SQL editor: it completes the table's columns (with their types) and SQL keywords, Enter applies it (or picks the highlighted completion while the list is open), and a pasted line break becomes a space.

Views follow writes made anywhere (a query tab, the console, an agent): after a script that can write, by the same classification that gates agents, the host announces `db-data:<connection id>`, and the schema tree, open table tabs and their rows, the Redis key list and the open key reload.

## Storage

Connections are committed under `.quiver/db-connections/` and saved queries under `.quiver/db-queries/`; passwords are encrypted per machine in `.quiver/local` and never committed. SQLite files referenced by a relative path resolve against the project folder, so a committed connection works for every teammate. The query history is per machine, under `.quiver/local`.

A connection can reach its server through a tunnel: a Teleport database (see the [Teleport module](../teleport/README.md)), or any command with a `{port}` placeholder (ssh and friends). A query that fails because the Teleport cluster's certificate expired comes back as `TELEPORT_LOGIN_REQUIRED` naming the cluster, with a "Log in again" button.

## Agents

Listing connections, schemas and saved queries is allowed. `db_query_run` decides per call: `SELECT`, `SHOW`, `EXPLAIN` and read-only Redis commands always work, anything that writes is gated. Deleting connections and saved queries is gated. Passwords are never returned to agents.

## Verified by

The smoke runs against a SQLite file and an in-process fake Redis (keys, console, a broken connection). In the UI it types into a table's WHERE filter, picks a column from the completions and applies the filter with Enter, filters a twelve-table list down to one and opens it with Enter, and reads a JSON text cell back formatted with its 20-digit id intact. It also creates and drops a table, updates a row and writes Redis keys from the host, and expects the open views to follow without being reopened. Set `QUIVER_SMOKE_MYSQL=mysql://user:pass@host:3306/db` to also exercise a live MySQL server.
