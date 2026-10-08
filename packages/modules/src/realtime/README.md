# Realtime

WebSocket and Server-Sent Events connections saved with the project, with headers, auth, subprotocols and `{{variables}}`. A live message log with a composer and saved messages for WebSocket, event names and ids for SSE, and automatic reconnects.

## How it works

A connection is one JSON file under `.quiver/realtime-connections/`: a kind (`websocket` or `sse`), a URL, headers, auth, subprotocols for WebSocket, a method and body for SSE (POST for servers that take a subscription document), and saved messages. Connecting resolves variables from the active environment and folds the auth in; the handshake or stream request carries the headers. Every message, sent or received, and every state change (open, close with code and reason, error, reconnect) lands in a log of 500 entries (configurable, bodies capped at 256 KB) kept in memory and in `.quiver/local`. WebSocket reconnects back off from 1 s to 30 s unless the close was normal (1000) or requested; SSE reconnects after the server's `retry:` hint (3 s by default) and sends `Last-Event-ID`, while a non-2xx answer or a wrong content type is reported and not retried. `realtime.message.wait` blocks until the next matching message, so an agent can send something and wait for the answer, or watch for a specific event.

## Agents

Listing, saving, `realtime_connect`, `realtime_send` and `realtime_message_wait` are allowed; `realtime_disconnect`, `realtime_connection_delete` and `realtime_message_clear` are gated.

## Verified by

The smoke runs a `ws` server (subprotocols, binary frames, reconnect after a server close) and an SSE endpoint (retry hint, `Last-Event-ID` resume, POST bodies, error answers), and checks that auth and variables reach the server. In the UI it checks the connection rows, the connected status with the subprotocol, the live log, sending from the composer, and keeping a composed message as an unsaved saved message.
