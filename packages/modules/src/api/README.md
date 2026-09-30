# API client

Collections, requests with params, headers, body and auth, environments with encrypted secrets, a history of what was sent, curl import and export, and `{{variables}}` everywhere.

## Variables

Global variables (Settings) apply to every workspace; the active environment of a workspace overrides them; built-in dynamic values (`{{$uuid}}`, `{{$timestamp}}`, `{{$timestampMs}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`) are new on every send. An environment is one committed file under `.quiver/environments/`; values flagged secret are kept encrypted in `.quiver/local/secrets.json` and the committed file carries an empty value.

Variables are highlighted in URLs, params, headers, auth fields and bodies (and in the realtime and MCP inspector fields, which resolve them the same way), unknown ones in red. Hovering one shows its value and whether it comes from the active environment, the global variables or the built-ins, with secrets masked until you click the eye; the pencil edits the value where it is defined (the active environment, secrets staying encrypted, or the global variables). An undefined variable's card offers to define it, in any environment of the workspace (optionally as a secret) or in the global variables; a name that is already a secret in that environment stays secret. Open request and environment tabs, and the global variables in Settings, follow changes made elsewhere (an agent, a git pull or branch switch) unless they have unsaved edits.

## History

Every send is appended to `.quiver/local/history.jsonl`, a plain file on this machine that agents can list. So nothing that is a credential goes into it as it was typed. The request is stored as it was written, with `{{variables}}` still as references (a secret variable is never in there), and with these masked as `••••••••`: the token, password or API key of the Auth tab, the value of `Authorization` (its scheme is kept: `Bearer ••••••••`), `Proxy-Authorization`, `Cookie` and headers or query parameters named like a credential (`X-API-Key`, `access_token`, `password`, `signature` and so on), and a password in the URL. The URL that went on the wire is stored with the same parameters masked, plus every secret the request resolved to, wherever it sits in the URL. Bodies are stored as written.

The request is still sent exactly as typed; only the record of it is masked. Opening an entry from the history gives the request back with the masks in place, so a credential that was typed in has to be typed again, while one that came from a variable just works. A history written before this existed is rewritten, masked, the next time its workspace opens.

## GraphQL

A GraphQL request is an ordinary request whose body type is `graphql`: a query document, variables as JSON text (with `{{variables}}` inside) and an optional operation name. Over POST it goes out as `{"query","variables","operationName"}` JSON; over GET the same three become query parameters. `api.graphql.introspect` runs the standard introspection query against the request's URL with its headers and auth, and caches the result as SDL under `.quiver/local`, keyed by endpoint; the editor uses it for autocompletion and lint, the Docs tab explores it (search and an SDL view), and `api.graphql.schema` hands it to agents. Documents with several operations get an operation picker; prettify reformats the document.

## Agents

Listing, reading, creating, saving and sending requests, the environment commands, `api_graphql_introspect`, `api_graphql_schema` and `api_variables_list` (the variables in effect, secrets masked) are allowed. Deletes are gated. `api_variables_set` decides per call: changing a value in the active environment is allowed, changing a global variable (which every workspace uses) is gated; `api_variables_define` likewise adds a variable to any environment freely and to the global variables only with mutations enabled. Secret values are masked for agents everywhere.

## Verified by

The smoke sends requests to a local echo server (variables, dynamic values, secrets, curl export), checks that typed tokens, passwords, API keys, an `Authorization` header and a secret resolved into the URL reach the server but not the history file (also for a failed send, and for a log left by an older version), runs a graphql-js endpoint (POST, GET, operation names, introspection), and drives the UI: hovering variables, revealing a secret, an undefined variable marked red, editing and defining values from the hover card.
