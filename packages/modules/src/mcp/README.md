# MCP inspector

Connect to any MCP server (a command over stdio, Streamable HTTP, or legacy SSE), browse its tools, resources and prompts, call them with arguments prefilled from the schema, and watch every JSON-RPC message in a traffic log with timings and the process's stderr. Imports the servers a project already declares in `.mcp.json`, `.cursor/mcp.json` or `.vscode/mcp.json`, and can point at Quiver's own server to see exactly what agents see.

## How it works

A server is one JSON file under `.quiver/mcp-servers/`: a transport (`stdio` with a command, arguments, environment variables and a working directory; `http` for Streamable HTTP or `sse` for the older HTTP+SSE pair, both with a URL, headers and auth), plus "connect when the workspace opens" and a log size. Strings take `{{variables}}` from the active environment and `${NAME}` or `${NAME:-default}` from Quiver's own environment, the same syntax Claude Code uses in `.mcp.json`, so an imported entry works unchanged. Connecting runs the MCP handshake with the SDK client, announces the project folder as the root, records the server's info, protocol version, capabilities and instructions, and lists its tools, resources and prompts (refreshed again on `list_changed` notifications). Every JSON-RPC message in both directions, every stderr line of a stdio server and every state change lands in a log of 500 entries (configurable, bodies capped at 256 KB) kept in memory and in `.quiver/local`; responses are paired with their requests so each shows its method, round-trip time and whether it failed. `mcp.tool.call` returns the content blocks, structured content and `isError` flag as the server sent them; `mcp.request` sends any method for the rest. The sidebar lists the servers declared in `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json` that are not imported yet, and "This Quiver" adds Quiver's own server bound to the current workspace.

## Agents

Listing, saving, importing, `mcp_connect`, `mcp_ping`, the tool, resource and prompt listings, `mcp_resource_read`, `mcp_prompt_get` and `mcp_log_list` are allowed; `mcp_tool_call` decides per call and lets tools annotated `readOnlyHint` through while gating every other tool; `mcp_disconnect`, `mcp_server_delete`, `mcp_log_clear` and `mcp_request` are gated.

## Verified by

The smoke runs a dependency-free stdio script plus SDK-built Streamable HTTP and legacy SSE endpoints: import from `.mcp.json`, initialize, tools with annotations and structured output, resources and templates, prompts, log notifications, list-changed refresh, a process that exits, and a connection to Quiver's own server.
