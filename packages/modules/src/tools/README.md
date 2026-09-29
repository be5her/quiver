# Tools

Small converters that need no workspace: JSON format (pretty-print with a chosen indent, sort keys, or minify), JWT decode (header, payload and expiry), base64 encode and decode (standard or URL-safe), URL encode and decode, hash, UUID and timestamp. Each opens in its own tab from the sidebar or the command palette; most run on every keystroke.

## How it works

Every tool is a global command (`tools.json.format`, `tools.json.minify`, `tools.jwt.decode`, `tools.base64.encode`, `tools.base64.decode`, `tools.url.encode`, `tools.url.decode`, `tools.hash.digest`, `tools.uuid.generate`, `tools.timestamp.convert`) with a zod schema, so the same conversions are available from the palette and to agents. Nothing is stored.

## Agents

Every tool is a pure conversion of its input and is allowed.
