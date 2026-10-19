# Logs

VictoriaLogs through Grafana. You sign in to Grafana once in a Quiver window, with the same account you use in the browser (Google and other SSO work), and query your log data sources there: a LogsQL line, a time range and limit, filters that are one click from any field, level chips with counts, a histogram, entries newest first with the one you pick in full, and follow mode for new entries.

## How it works

A connection is one JSON file under `.quiver/logs-connections/`: a name, the Grafana address (a sub-path is kept) and the VictoriaLogs data source in it (uid, name and type). It holds no credentials, so a teammate who pulls it signs in with their own account.

**Signing in.** "Sign in" opens Grafana's `/login` page in a separate window, and you finish the sign-in there as you would in a browser. The window runs Grafana and the identity provider sandboxed, without Quiver's preload, with every permission refused and only http(s) pages allowed; a popup an identity provider opens (Google's sign-in button does) gets a window of its own, sandboxed the same way and closed with the sign-in window, so it can post the outcome back to the page that opened it. It reports a browser user agent without the Electron and Quiver tokens, because Google's sign-in refuses pages it takes for an embedded web view ("This browser or app may not be secure"). Once Grafana serves a page other than the login form and `/api/user` answers (checked on every navigation and every couple of seconds, so a sign-in that only swaps the page's view is noticed too; a server that upgrades http to https still counts), the window closes and the connection shows who is signed in. The session lives in its own Electron partition, one per Grafana origin, in the app data folder: it is per machine, never in the project, and shared by every connection and workspace that uses that Grafana. The Databases module's Redis connections through a Grafana Redis data source share it too, so signing in or out in either module counts for both (`packages/modules/src/grafana/sessions.ts` holds the one set of sessions). Chromium keeps its cookies encrypted with the OS keychain, like the rest of Quiver's secrets.

**Staying signed in.** Grafana asks clients to renew the session token every few minutes (`grafana_session_expiry`, or a 401 with `session.token.rotate`). Before each request Quiver renews it when it is due, and when a request is still refused it renews once more and retries. Only then does the request fail with `SIGN_IN_REQUIRED`, and the view offers "Sign in". With default Grafana settings a session lasts 30 days, or 7 days without use. "Sign out" calls Grafana's `/logout` and clears the partition.

**Querying.** Every query goes through Grafana's `/api/ds/query` with the data source's uid, the way Explore runs it. Grafana's data source proxy is not used, because it skips the plugin and so the data source's tenant headers (`AccountID`, `ProjectID`). As a result your Grafana permissions and the data source's tenant and auth apply as they do in the browser. Filters are exact matches (`app:="api"`, `!level:="Debug"` to leave one out), ANDed in front of the query's filter part. That part is put in parentheses so an `or` in it cannot swallow them, and the pipes stay at the end. The entries come back newest first with nanosecond order. `level` (or `severity`, `log.level`, `lvl`) becomes the entry's level. The other fields are listed beside the message, except `_stream_id`. Pipe results (`| stats …`, `| field_values …`) come back as entries whose fields are the columns. The histogram is a `hits` query over the filter part, in about 60 buckets. The field picker runs `| field_names`, and value counts run `| stats by (<field>) count() hits | sort by (hits desc) | limit N`, all within the range.

**The view.** The query line takes LogsQL, and Enter runs it. The range is the last 5 minutes to 7 days, and the limit is 100 to 5000 entries. Each run resolves the range once, so the entries, the histogram and the chips describe the same span. Level chips count each level with the other filters applied and toggle that level. "+ Filter" lists the fields in range, then a field's most common values with counts, and keeps or leaves out the one you pick. Clicking an entry shows its message (indented when it is JSON, with numbers kept as written so a 64-bit id is not rounded) and its fields, each with keep and leave-out buttons. Chips flip between keeping and leaving out when clicked. Follow asks every 5 seconds for entries newer than the newest one on screen and puts them on top, keeping up to 5000. It looks five minutes past this machine's clock, so a server whose clock runs ahead still shows up, and an entry stamped in the future does not end the next poll's range before it starts. The query, filters, range and limit are kept in the tab, so they come back with it. Each query is recorded in the workspace history under `.quiver/local` with its filters, range and count or error.

## Agents

Allowed:
- `logs_connection_list`, `logs_connection_get` and `logs_connection_save`
- `logs_session`, which says whether this machine is signed in and as whom
- `logs_datasources`
- `logs_query`, `logs_hits`, `logs_fields` and `logs_values`
- `logs_history_list`

Gated:
- `logs_signout`, which ends a session every connection to that Grafana shares
- `logs_connection_delete`
- `logs_history_clear`

Signing in is not a tool: it needs a person at the window, so `logs.signin` is hidden from MCP and the palette. A query from an agent when nobody is signed in fails with `SIGN_IN_REQUIRED`, and its message tells the agent to ask you to sign in from Quiver (the Logs view, or the database connection that goes through that Grafana). Agents get the same entries the view shows. Pipes such as `| fields _time, _msg, level` keep large results small.

## Verified by

The smoke runs a fake Grafana. Its login page sends the window on through a stand-in identity provider and back with a session cookie, without anyone clicking. It requires token renewals, answers `/api/user` and the data sources, and answers `/api/ds/query` with VictoriaLogs-shaped frames. It also has Redis data sources for the db part (`fake-grafana-redis.ts`), which the Logs data source list leaves out. Those frames support exact filters, free text, `field_names`, `stats by` counts and `hits` buckets, and come back oldest first. The smoke can add an entry while it runs, such as one stamped two minutes ahead of the clock, as a server whose clock runs ahead would stamp it.

The host-level checks cover:
- sign-in and a second sign-in that opens no window
- the token renewal on a query
- folding filters into the query, newest-first order and the limit
- field names and values, hits and LogsQL errors
- the history
- what agents may call
- sign-out (on Grafana and locally) and signing in again

In the UI, the checks cover:
- the sidebar's signed-in row
- the query that runs when the tab opens
- level chips and the histogram total
- a level chip narrowing the entries
- the entry detail and leaving out one of its values
- follow mode picking up the entry stamped ahead of the clock and staying on past it
- the filter picker's fields, values and counts
- the settings view

The smoke checks are in [`src/main/smoke/parts/logs.ts`](../../../../src/main/smoke/parts/logs.ts); `npm run smoke -- logs` runs them alone, with `--shots` for the UI checks.
