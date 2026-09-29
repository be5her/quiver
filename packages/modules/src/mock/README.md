# Mock servers and webhook receivers

Local HTTP servers saved with the project. Ordered routes with `:param` and `*` patterns, status, headers, delay and bodies templated from the request. Every request is captured with what was answered, so a server without routes is a webhook receiver; unmatched requests can instead be forwarded to a real upstream and recorded. Replay a captured request against your app, turn it into a route, open it in the API client or copy it as curl.

## How it works

A mock server is one JSON file under `.quiver/mock-servers/` with a port (a random five-digit one when created, avoiding every port Quiver has handed out on this machine so servers of different projects do not collide), a host (loopback, or every interface for containers and phones), an ordered route list and a fallback. Routes match top to bottom on method and path; `/users/:id` captures a segment, `/files/*` the rest, `HEAD` matches `GET` routes. Bodies and headers are templates over the request: `{{params.id}}`, `{{query.q}}`, `{{headers.x}}` (lower-case names), `{{body}}` and `{{body.<path>}}` for JSON bodies, plus the dynamic `{{$uuid}}`, `{{$timestamp}}` and friends. The fallback either answers a fixed response (404, or 200 for a webhook receiver) or forwards the request to an upstream base URL and returns what came back, so a server can stand in for a real API while overriding single endpoints. CORS headers and preflight answers are on by default. Each server keeps its last 500 requests (configurable) in memory and in `.quiver/local`, with bodies capped at 256 KB; saving a server applies route changes to the running listener, and servers marked "start with the workspace" come up on open.

## Agents

Listing, saving servers and routes, starting, reading captured requests, `mock_request_wait` (block until the next request lands, for webhooks) and `mock_request_replay` are allowed; `mock_server_stop`, `mock_server_delete`, `mock_route_delete` and `mock_request_clear` are gated.

## Verified by

The smoke starts real listeners: routes, templates, delays, forwarding to an upstream, replay, and a webhook receiver that survives a workspace reopen.
