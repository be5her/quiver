import { promises as fs } from 'node:fs';
import path from 'node:path';
import { capabilityLabels, contentText, expandUriTemplate, skeletonFromSchema } from '@quiver/core';
import type { McpConfigFile, McpLogEntry, McpPrompt, McpPromptResult, McpReadResourceResult, McpRecordedCall, McpRecordedCallSummary, McpRecordingFile, McpRecordingStatus, McpResource, McpResourceTemplate, McpServerSummary, McpTool, McpToolCallOutcome } from '@quiver/core';
import { definePart, runSections, until } from '../part';
import agents from './mcp/agents';

/** The inspector and the call recorder; agent permissions are their own section, `mcp/agents.ts`. */
const inspector = definePart({
  name: 'mcp',
  summary: 'MCP inspector and call recorder',
  async run(t) {
    const { host, check, run, ws, folder, env, mcpPort, rpc, agentRpc, toolNames: names } = t;
    const { mcpDir, fakeStdio, fakeMcp } = t.fixtures;

    // ---------- MCP inspector: project config import, stdio, Streamable HTTP and SSE servers, tools, resources, prompts, log ----------
    const untilStatus = async (id: string, status: McpServerSummary['status'], timeout = 5000): Promise<McpServerSummary> => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const s = await run<McpServerSummary>('mcp.server.get', { id }, ws.id);
        if (s.status === status || Date.now() > deadline) return s;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const untilTools = async (id: string, pred: (tools: McpTool[]) => boolean, timeout = 3000): Promise<McpTool[]> => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const list = await run<McpTool[]>('mcp.tool.list', { id }, ws.id);
        if (pred(list) || Date.now() > deadline) return list;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const textOf = (outcome: { result: { content: McpToolCallOutcome['result']['content'] } } | null | undefined): string => (outcome?.result.content[0] ? (contentText(outcome.result.content[0]) ?? '') : '');
    await fs.writeFile(
      path.join(folder, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            'smoke-stdio': { command: fakeStdio.node, args: [fakeStdio.script, '--flag', 'value with space'], env: { SMOKE_MCP_VAR: 'from-mcp-json' } },
            'smoke-http': { type: 'http', url: fakeMcp.httpUrl, headers: { Authorization: 'Bearer ${SMOKE_MCP_TOKEN:-fallback-token}' } },
          },
        },
        null,
        2,
      ),
    );
    await fs.mkdir(path.join(folder, '.vscode'), { recursive: true });
    await fs.writeFile(path.join(folder, '.vscode', 'mcp.json'), `{\n  // legacy transport\n  "servers": {\n    "smoke-sse": { "type": "sse", "url": "${fakeMcp.sseUrl}", },\n  },\n}\n`);
    const discovered = await run<McpConfigFile[]>('mcp.server.discover', {}, ws.id);
    check(
      'mcp inspector: discovers servers in .mcp.json and .vscode/mcp.json',
      discovered.length === 2 &&
        discovered[0].file === '.mcp.json' &&
        discovered[0].servers.map((s) => s.name).join() === 'smoke-stdio,smoke-http' &&
        discovered[1].servers[0]?.transport === 'sse' &&
        discovered.every((f) => f.error === null && f.servers.every((s) => !s.imported)),
      discovered.map((f) => [f.file, f.error, f.servers.map((s) => s.name)]),
    );
    const importedServers = await run<McpServerSummary[]>('mcp.server.import', {}, ws.id);
    const stdioServer = importedServers.find((s) => s.name === 'smoke-stdio')!;
    const httpImported = importedServers.find((s) => s.name === 'smoke-http')!;
    const sseServer = importedServers.find((s) => s.name === 'smoke-sse')!;
    check(
      'mcp inspector: import saves one server per entry with its origin',
      importedServers.length === 3 && importedServers.every((s) => s.importedFrom) && stdioServer?.env[0]?.key === 'SMOKE_MCP_VAR' && stdioServer.args.length === 3 && httpImported?.headers[0]?.key === 'Authorization' && sseServer?.transport === 'sse',
      importedServers.map((s) => [s.name, s.transport, s.importedFrom]),
    );
    check('mcp inspector: definitions committed to the project', (await fs.stat(path.join(folder, '.quiver', 'mcp-servers', `${stdioServer.id}.json`))).isFile());
    const reimported = await run<McpServerSummary[]>('mcp.server.import', { file: '.mcp.json' }, ws.id);
    check(
      'mcp inspector: re-import updates instead of duplicating',
      reimported.length === 2 && reimported.every((s) => [stdioServer.id, httpImported.id].includes(s.id)) && (await run<McpConfigFile[]>('mcp.server.discover', {}, ws.id)).every((f) => f.servers.every((s) => s.imported)),
      reimported.map((s) => s.id),
    );

    const stdioOpen = await run<McpServerSummary>('mcp.connect', { id: stdioServer.id }, ws.id);
    check(
      'mcp inspector: stdio server starts and initializes',
      stdioOpen.status === 'connected' && stdioOpen.serverInfo?.name === 'smoke-stdio' && typeof stdioOpen.pid === 'number' && stdioOpen.pid > 0 && stdioOpen.toolCount === 2 && capabilityLabels(stdioOpen.capabilities).includes('tools'),
      { status: stdioOpen.status, error: stdioOpen.error, info: stdioOpen.serverInfo, pid: stdioOpen.pid, tools: stdioOpen.toolCount },
    );
    const stdioTools = await run<McpTool[]>('mcp.tool.list', { id: stdioServer.id }, ws.id);
    check('mcp inspector: stdio tools listed with annotations', stdioTools.map((t) => t.name).join() === 'env_echo,exit' && stdioTools[0].annotations?.readOnlyHint === true, stdioTools.map((t) => t.name));
    const envEcho = await run<McpToolCallOutcome>('mcp.tool.call', { id: stdioServer.id, name: 'env_echo' }, ws.id);
    const envEchoData = JSON.parse(textOf(envEcho) || '{}') as { var: string | null; cwd: string; argv: string[] };
    check(
      'mcp inspector: process got the env, cwd and quoted args',
      envEchoData.var === 'from-mcp-json' && path.relative(folder, envEchoData.cwd ?? '') === '' && envEchoData.argv?.join('|') === '--flag|value with space' && envEcho.durationMs >= 0,
      envEchoData,
    );
    const stdioLog = await run<McpLogEntry[]>('mcp.log.list', { id: stdioServer.id }, ws.id);
    check(
      'mcp inspector: log has stderr, the handshake, and the call pair with timing',
      stdioLog.some((e) => e.kind === 'stderr' && e.data.includes('[fake-mcp] started')) &&
        stdioLog.some((e) => e.direction === 'out' && e.kind === 'request' && e.method === 'initialize') &&
        stdioLog.some((e) => e.direction === 'in' && e.kind === 'response' && e.method === 'tools/call' && e.durationMs !== null && e.ok === true) &&
        stdioLog.some((e) => e.direction === 'system' && e.kind === 'open' && e.data.includes('smoke-stdio 0.1.0')),
      stdioLog.map((e) => `${e.direction}:${e.kind}:${e.method ?? ''}`),
    );
    const unknownTool = await host.invoke('mcp.tool.call', { id: stdioServer.id, name: 'nope' }, { caller: 'ui', workspaceId: ws.id });
    check('mcp inspector: a JSON-RPC error becomes REQUEST_FAILED with the server message', !unknownTool.ok && unknownTool.error.code === 'REQUEST_FAILED' && unknownTool.error.message.includes('Unknown tool nope'), unknownTool.ok ? 'ok?' : unknownTool.error.message);
    const errorLogged = await run<McpLogEntry[]>('mcp.log.list', { id: stdioServer.id, kind: 'error' }, ws.id);
    check('mcp inspector: log filters by kind and marks error responses', errorLogged.length === 1 && errorLogged[0].ok === false && errorLogged[0].method === 'tools/call' && errorLogged[0].direction === 'in', errorLogged.map((e) => e.data.slice(0, 80)));
    await run('mcp.tool.call', { id: stdioServer.id, name: 'exit', arguments: { code: 3 } }, ws.id);
    const stdioGone = await untilStatus(stdioServer.id, 'disconnected');
    check('mcp inspector: a stdio server that exits is reported', stdioGone.status === 'disconnected' && (stdioGone.error ?? '').includes('exited') && stdioGone.pid === null, { status: stdioGone.status, error: stdioGone.error });

    const httpServer = await run<McpServerSummary>(
      'mcp.server.save',
      { server: { name: 'smoke http', transport: 'http', url: fakeMcp.httpUrl, auth: { type: 'bearer', token: '{{token}}' }, headers: [{ id: 'h1', key: 'X-Smoke', value: '{{token}}', enabled: true }] } },
      ws.id,
    );
    check('mcp inspector: server saved with defaults', httpServer.status === 'disconnected' && httpServer.logLimit === 500 && httpServer.autoConnect === false && httpServer.toolCount === 0 && httpServer.serverInfo === null);
    const httpOpen = await run<McpServerSummary>('mcp.connect', { id: httpServer.id }, ws.id);
    check(
      'mcp inspector: streamable http server initializes with info, protocol, capabilities and instructions',
      httpOpen.status === 'connected' &&
        httpOpen.serverInfo?.name === 'smoke-http' &&
        httpOpen.serverInfo.version === '1.2.3' &&
        /^\d{4}-\d{2}-\d{2}$/.test(httpOpen.protocolVersion ?? '') &&
        capabilityLabels(httpOpen.capabilities).includes('logging') &&
        httpOpen.instructions === 'Use echo to test the connection.' &&
        httpOpen.toolCount === 4 &&
        httpOpen.resourceCount === 2 &&
        httpOpen.promptCount === 1,
      { status: httpOpen.status, error: httpOpen.error, protocol: httpOpen.protocolVersion, caps: capabilityLabels(httpOpen.capabilities), counts: [httpOpen.toolCount, httpOpen.resourceCount, httpOpen.promptCount] },
    );
    check('mcp inspector: auth and headers resolved from the environment reach the server', fakeMcp.authSeen.includes('Bearer s3cret') && fakeMcp.headersSeen.includes('s3cret'), { auth: fakeMcp.authSeen, headers: fakeMcp.headersSeen });
    const httpTools = await run<McpTool[]>('mcp.tool.list', { id: httpServer.id }, ws.id);
    const echoTool = httpTools.find((t) => t.name === 'echo');
    check(
      'mcp inspector: tools carry schemas, annotations and output schema',
      echoTool?.inputSchema.properties?.text !== undefined && echoTool.inputSchema.required?.includes('text') === true && echoTool.annotations?.readOnlyHint === true && echoTool.outputSchema?.properties?.echoed !== undefined && echoTool.title === 'Echo',
      echoTool,
    );
    check('mcp inspector: argument skeleton from the schema', JSON.stringify(skeletonFromSchema(echoTool?.inputSchema)) === '{"text":""}', skeletonFromSchema(echoTool?.inputSchema));
    const echoCall = await run<McpToolCallOutcome>('mcp.tool.call', { id: httpServer.id, name: 'echo', arguments: { text: 'hi' } }, ws.id);
    check('mcp inspector: tool call returns content and structured content', textOf(echoCall) === 'echo:hi' && echoCall.result.structuredContent?.echoed === 'hi' && !echoCall.result.isError && echoCall.durationMs >= 0, echoCall);
    const failCall = await run<McpToolCallOutcome>('mcp.tool.call', { id: httpServer.id, name: 'fail' }, ws.id);
    check('mcp inspector: a tool error is returned with isError', failCall.result.isError === true && textOf(failCall) === 'nope', failCall.result);
    const badArgs = await run<McpToolCallOutcome>('mcp.tool.call', { id: httpServer.id, name: 'add', arguments: { a: 'x' } }, ws.id);
    check('mcp inspector: invalid arguments come back as a tool error naming the validation', badArgs.result.isError === true && /validation|invalid/i.test(textOf(badArgs)), textOf(badArgs).slice(0, 160));
    const notifyCall = await run<McpToolCallOutcome>('mcp.tool.call', { id: httpServer.id, name: 'notify' }, ws.id);
    const httpToolsAfter = await untilTools(httpServer.id, (t) => t.some((x) => x.name === 'dynamic'));
    check('mcp inspector: tools/list_changed refreshes the cached tools', textOf(notifyCall) === 'notified' && httpToolsAfter.some((t) => t.name === 'dynamic'), httpToolsAfter.map((t) => t.name));
    const logMsgs = await run<McpLogEntry[]>('mcp.log.list', { id: httpServer.id, kind: 'log' }, ws.id);
    check('mcp inspector: server log messages are recorded as log entries', logMsgs.length >= 1 && logMsgs[0].direction === 'in' && logMsgs[0].method === 'notifications/message' && logMsgs[0].data.includes('hello from the server'), logMsgs.map((e) => e.data.slice(0, 100)));
    const resources = await run<{ resources: McpResource[]; templates: McpResourceTemplate[] }>('mcp.resource.list', { id: httpServer.id }, ws.id);
    check(
      'mcp inspector: resources and templates listed',
      resources.resources.map((r) => r.uri).join() === 'smoke://greeting' && resources.templates.map((t) => t.uriTemplate).join() === 'smoke://users/{id}' && resources.templates[0].mimeType === 'application/json',
      resources,
    );
    const greetingRes = await run<McpReadResourceResult & { durationMs: number }>('mcp.resource.read', { id: httpServer.id, uri: 'smoke://greeting' }, ws.id);
    check('mcp inspector: resource read returns text', greetingRes.contents[0]?.text === 'hello, inspector' && greetingRes.contents[0].mimeType === 'text/plain' && greetingRes.durationMs >= 0, greetingRes);
    const userRes = await run<McpReadResourceResult>('mcp.resource.read', { id: httpServer.id, uri: expandUriTemplate('smoke://users/{id}', { id: '7' }) }, ws.id);
    check('mcp inspector: template expanded and read', (JSON.parse(userRes.contents[0]?.text ?? '{}') as { id: string }).id === '7', userRes);
    const prompts = await run<McpPrompt[]>('mcp.prompt.list', { id: httpServer.id }, ws.id);
    check('mcp inspector: prompts listed with arguments', prompts[0]?.name === 'summarize' && prompts[0].arguments?.some((a) => a.name === 'topic' && a.required) === true && prompts[0].arguments.some((a) => a.name === 'tone' && !a.required), prompts);
    const prompt = await run<McpPromptResult & { durationMs: number }>('mcp.prompt.get', { id: httpServer.id, name: 'summarize', arguments: { topic: 'ports', tone: 'dry' } }, ws.id);
    check('mcp inspector: prompt rendered', prompt.messages[0]?.role === 'user' && contentText(prompt.messages[0].content) === 'Summarize ports in a dry tone' && prompt.description === 'Summary of ports', prompt);
    const pong = await run<{ durationMs: number }>('mcp.ping', { id: httpServer.id }, ws.id);
    const rawPing = await run<{ result: unknown; durationMs: number }>('mcp.request', { id: httpServer.id, method: 'ping' }, ws.id);
    check('mcp inspector: ping and raw requests answer', pong.durationMs >= 0 && rawPing.durationMs >= 0 && typeof rawPing.result === 'object', { pong, rawPing });
    await run('mcp.logging.level', { id: httpServer.id, level: 'debug' }, ws.id);
    const outRequests = await run<McpLogEntry[]>('mcp.log.list', { id: httpServer.id, direction: 'out', kind: 'request' }, ws.id);
    const readResponses = await run<McpLogEntry[]>('mcp.log.list', { id: httpServer.id, method: 'resources/read', kind: 'response' }, ws.id);
    check(
      'mcp inspector: log filters by direction and method, responses carry their request method',
      outRequests.length > 5 && outRequests.every((e) => e.direction === 'out') && outRequests.some((e) => e.method === 'logging/setLevel') && readResponses.length === 2 && readResponses.every((e) => e.durationMs !== null && e.ok === true),
      { out: outRequests.map((e) => e.method), reads: readResponses.length },
    );
    const httpClosed = await run<McpServerSummary>('mcp.disconnect', { id: httpServer.id }, ws.id);
    check('mcp inspector: disconnect ends the session and keeps the log', httpClosed.status === 'disconnected' && httpClosed.error === null && httpClosed.logCount > 10 && fakeMcp.sessions() === 0, { status: httpClosed.status, log: httpClosed.logCount, sessions: fakeMcp.sessions() });
    check('mcp inspector: log persisted under .quiver/local', (await fs.readdir(path.join(folder, '.quiver', 'local'))).includes(`mcp-log-${httpServer.id}.json`));
    const clearedLog = await run<{ cleared: number }>('mcp.log.clear', { id: httpServer.id }, ws.id);
    check('mcp inspector: clear drops the log', clearedLog.cleared > 0 && (await run<McpLogEntry[]>('mcp.log.list', { id: httpServer.id }, ws.id)).length === 0, clearedLog);

    const sseMcpOpen = await run<McpServerSummary>('mcp.connect', { id: sseServer.id }, ws.id);
    const sseEcho = sseMcpOpen.status === 'connected' ? await run<McpToolCallOutcome>('mcp.tool.call', { id: sseServer.id, name: 'echo', arguments: { text: 'sse' } }, ws.id) : null;
    check('mcp inspector: legacy sse transport connects and calls tools', sseMcpOpen.status === 'connected' && textOf(sseEcho) === 'echo:sse', { status: sseMcpOpen.status, error: sseMcpOpen.error });
    await run('mcp.disconnect', { id: sseServer.id }, ws.id);

    const deadMcp = await run<McpServerSummary>('mcp.server.save', { server: { name: 'smoke dead', transport: 'http', url: 'http://127.0.0.1:1/mcp' } }, ws.id);
    const deadMcpOpen = await run<McpServerSummary>('mcp.connect', { id: deadMcp.id }, ws.id);
    check('mcp inspector: an unreachable http server reports the failure', deadMcpOpen.status === 'disconnected' && typeof deadMcpOpen.error === 'string' && deadMcpOpen.error.length > 0, deadMcpOpen.error);
    await run('mcp.server.save', { server: { id: deadMcp.id, transport: 'stdio', command: 'quiver-no-such-command-xyz' } }, ws.id);
    const noCmdOpen = await run<McpServerSummary>('mcp.connect', { id: deadMcp.id }, ws.id);
    check('mcp inspector: a missing executable reports the spawn error', noCmdOpen.status === 'disconnected' && /ENOENT|not found|no such/i.test(noCmdOpen.error ?? ''), noCmdOpen.error);
    await run('mcp.server.save', { server: { id: deadMcp.id, transport: 'http', url: 'http://127.0.0.1:{{nope}}/mcp' } }, ws.id);
    const unresolvedMcp = await host.invoke('mcp.connect', { id: deadMcp.id }, { caller: 'ui', workspaceId: ws.id });
    check('mcp inspector: unresolved variables are reported before connecting', !unresolvedMcp.ok && unresolvedMcp.error.code === 'UNRESOLVED_VARIABLES');
    await run('mcp.server.delete', { id: deadMcp.id }, ws.id);
    check('mcp inspector: delete removes the definition', !(await run<McpServerSummary[]>('mcp.server.list', {}, ws.id)).some((s) => s.id === deadMcp.id));

    const selfServer = await run<McpServerSummary>('mcp.server.save', { server: { name: 'Quiver (this app)', transport: 'http', url: `http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(folder)}` } }, ws.id);
    const selfOpen = await run<McpServerSummary>('mcp.connect', { id: selfServer.id }, ws.id);
    const selfTools = selfOpen.status === 'connected' ? await run<McpTool[]>('mcp.tool.list', { id: selfServer.id }, ws.id) : [];
    const selfCurrent = selfOpen.status === 'connected' ? await run<McpToolCallOutcome>('mcp.tool.call', { id: selfServer.id, name: 'workspace_current' }, ws.id) : null;
    check(
      'mcp inspector: connects to Quiver itself and sees its own tools',
      selfOpen.status === 'connected' && selfOpen.serverInfo?.name === 'quiver' && selfTools.some((t) => t.name === 'mcp_tool_call') && selfTools.some((t) => t.name === 'api_request_send') && textOf(selfCurrent).includes(JSON.stringify(folder).slice(1, -1)),
      { status: selfOpen.status, error: selfOpen.error, tools: selfTools.length, current: textOf(selfCurrent).slice(0, 120) },
    );
    await run('mcp.connect', { id: httpServer.id }, ws.id);

    check(
      'mcp lists inspector tools',
      ['mcp_server_list', 'mcp_server_import', 'mcp_connect', 'mcp_tool_list', 'mcp_tool_call', 'mcp_resource_read', 'mcp_prompt_get', 'mcp_log_list'].every((n) => names.includes(n)),
      names.filter((n) => n.startsWith('mcp_')),
    );
    const agentEcho = await rpc('tools/call', { name: 'mcp_tool_call', arguments: { id: httpServer.id, name: 'echo', arguments: { text: 'agent' } } });
    check('mcp lets agents call tools annotated read-only', agentEcho.result?.isError !== true && (agentEcho.result?.content?.[0]?.text ?? '').includes('echo:agent'), agentEcho.result?.content?.[0]?.text?.slice(0, 120));
    const agentAdd = await rpc('tools/call', { name: 'mcp_tool_call', arguments: { id: httpServer.id, name: 'add', arguments: { a: 1, b: 2 } } });
    check('mcp blocks tools without readOnlyHint by default', agentAdd.result?.isError === true && (agentAdd.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'), agentAdd.result?.content?.[0]?.text?.slice(0, 120));
    for (const [tool, args] of [
      ['mcp_disconnect', { id: httpServer.id }],
      ['mcp_log_clear', { id: httpServer.id }],
      ['mcp_request', { id: httpServer.id, method: 'ping' }],
      ['mcp_server_delete', { id: httpServer.id }],
    ] as const) {
      const blockedMcp = await rpc('tools/call', { name: tool, arguments: args });
      check(`mcp blocks ${tool} by default`, blockedMcp.result?.isError === true && (blockedMcp.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }

    // Call recorder: what agents call on Quiver's own server, kept in memory between start and end, then saved to a file.
    {
      const recorded = () => run<{ status: McpRecordingStatus; calls: McpRecordedCallSummary[] }>('mcp.recording.list', {}, null);
      await rpc('tools/call', { name: 'app_info', arguments: {} });
      const beforeStart = await recorded();
      check('recorder: idle and empty until started', beforeStart.status.state === 'idle' && beforeStart.calls.length === 0, beforeStart.status);
      check('recorder: its commands are not tools for agents', !names.some((n) => n.startsWith('mcp_recording')));
      const sessionId = await agentRpc({ 'user-agent': 'smoke-http/1.0' }, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-agent', version: '4.2' } });
      check('recorder: initialize hands the client a session id', typeof sessionId === 'string' && sessionId.startsWith('quiver.'), sessionId);
      const asAgent = { 'mcp-session-id': sessionId ?? '', 'user-agent': 'smoke-http/1.0' };
      const started = await run<McpRecordingStatus>('mcp.recording.start', {}, null);
      check('recorder: start', started.state === 'recording' && typeof started.startedAt === 'string' && started.count === 0, started);
      await agentRpc(asAgent, 'tools/call', { name: 'tools_base64_encode', arguments: { text: 'hi' } });
      await agentRpc(asAgent, 'tools/call', { name: 'api_request_delete', arguments: { id: 'no-such-request' } });
      await agentRpc(asAgent, 'tools/call', { name: 'tools_no_such_tool', arguments: {} });
      await agentRpc({ 'user-agent': 'other-agent/9.9' }, 'tools/call', { name: 'tools_base64_encode', arguments: { text: 42 } });
      await agentRpc(asAgent, 'tools/list', {});
      // The inspector is an SDK client: it must send the session back by itself for its name to stick.
      await run('mcp.connect', { id: selfServer.id }, ws.id);
      await run('mcp.tool.call', { id: selfServer.id, name: 'workspace_current' }, ws.id);
      const first = await recorded();
      const [encode, refused, unknown, invalid, fromInspector] = first.calls;
      check(
        'recorder: keeps the tool calls, and only those, in order',
        first.calls.map((c) => c.tool).join() === 'tools_base64_encode,api_request_delete,tools_no_such_tool,tools_base64_encode,workspace_current' && first.status.count === 5 && first.status.bytes > 0,
        first.calls.map((c) => c.tool),
      );
      check(
        'recorder: names the agent from its handshake, with the workspace, outcome and timing',
        encode?.agent.name === 'smoke-agent' && encode.agent.version === '4.2' && encode.agent.userAgent === 'smoke-http/1.0' && encode.workspace?.id === ws.id && encode.ok === true && (encode.durationMs ?? -1) >= 0 && encode.preview === '{"text":"hi"}',
        encode,
      );
      const encodeFull = await run<McpRecordedCall>('mcp.recording.get', { id: encode.id }, null);
      check('recorder: a call carries its arguments and the result the agent got', JSON.stringify(encodeFull.arguments) === '{"text":"hi"}' && (encodeFull.result as { text?: string }).text === 'aGk=', encodeFull);
      const refusedFull = await run<McpRecordedCall>('mcp.recording.get', { id: refused.id }, null);
      check(
        'recorder: refused, unknown and invalid calls are kept as failed',
        refused.ok === false && (refusedFull.result as { code?: string }).code === 'MUTATION_BLOCKED' && unknown.ok === false && invalid.ok === false,
        { refused: refusedFull.result, unknown: unknown.ok, invalid: invalid.ok },
      );
      check('recorder: a client without a session is named after its User-Agent', invalid.agent.name === 'other-agent' && invalid.agent.version === '9.9', invalid.agent);
      check('recorder: an SDK client keeps its name across requests', fromInspector?.agent.name === 'quiver' && fromInspector.ok === true, fromInspector?.agent);
      const paused = await run<McpRecordingStatus>('mcp.recording.pause', {}, null);
      await agentRpc(asAgent, 'tools/call', { name: 'tools_uuid_generate', arguments: {} });
      const whilePaused = (await recorded()).calls.length;
      await run('mcp.recording.resume', {}, null);
      await agentRpc(asAgent, 'tools/call', { name: 'tools_uuid_generate', arguments: {} });
      const afterResume = (await recorded()).calls.length;
      check('recorder: pause skips calls, resume keeps them again', paused.state === 'paused' && whilePaused === 5 && afterResume === 6, { whilePaused, afterResume });
      const recordingFile = path.join(mcpDir, 'recording.json');
      const earlySave = await host.invoke('mcp.recording.save', { path: recordingFile }, { caller: 'ui', workspaceId: null });
      check('recorder: saving needs an ended recording', !earlySave.ok && earlySave.error.code === 'INVALID_INPUT', earlySave.ok ? 'saved?' : earlySave.error.message);
      const ended = await run<McpRecordingStatus>('mcp.recording.end', {}, null);
      await agentRpc(asAgent, 'tools/call', { name: 'tools_uuid_generate', arguments: {} });
      check('recorder: end stops recording and keeps the calls', ended.state === 'ended' && typeof ended.endedAt === 'string' && ended.savedTo === null && (await recorded()).calls.length === 6, ended);
      const agentSave = await host.invoke('mcp.recording.save', { path: recordingFile }, { caller: 'mcp', workspaceId: null });
      check('recorder: only the UI can save', !agentSave.ok && agentSave.error.code === 'INVALID_INPUT');
      const savedRecording = await run<{ path: string; calls: number }>('mcp.recording.save', { path: recordingFile }, null);
      const onDisk = JSON.parse(await fs.readFile(recordingFile, 'utf8')) as McpRecordingFile;
      check(
        'recorder: saves the recording as a JSON file and remembers where',
        savedRecording.calls === 6 &&
          onDisk.format === 'quiver.mcp-recording' &&
          onDisk.version === 1 &&
          onDisk.quiver === host.api.version &&
          onDisk.calls.length === 6 &&
          onDisk.calls[0].agent.name === 'smoke-agent' &&
          (onDisk.calls[0].result as { text?: string }).text === 'aGk=' &&
          (await run<McpRecordingStatus>('mcp.recording.status', {}, null)).savedTo === recordingFile,
        { saved: savedRecording, format: onDisk.format, calls: onDisk.calls.length },
      );
      const cleared = await run<McpRecordingStatus>('mcp.recording.clear', {}, null);
      check('recorder: discard drops it from memory', cleared.state === 'idle' && cleared.count === 0 && (await recorded()).calls.length === 0, cleared);
    }

    return {
      ui: async (u) => {
        const { js, wait, shot } = u;
        // MCP inspector: server rows, tools list, a tool call from the UI, the traffic log.
        const clickedMcp = await js(
          `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'MCP inspector'); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: mcp inspector module button', clickedMcp === true);
        await wait(800);
        const mcpRows = await js(`[...document.querySelectorAll('[data-testid=mcp-server]')].map((r) => [r.textContent, r.getAttribute('data-status')])`);
        check(
          'ui: server rows show transport, name and status',
          Array.isArray(mcpRows) &&
            mcpRows.length === 5 &&
            mcpRows.some((r: string[]) => r[0].includes('HTTP') && r[0].includes('smoke http') && r[1] === 'connected') &&
            mcpRows.some((r: string[]) => r[0].includes('CMD') && r[0].includes('smoke-stdio') && r[1] === 'disconnected') &&
            mcpRows.some((r: string[]) => r[0].includes('SSE') && r[0].includes('smoke-sse')),
          mcpRows,
        );
        const clickedHttpRow = await js(
          `(() => { const row = [...document.querySelectorAll('[data-testid=mcp-server]')].find((r) => r.textContent.includes('smoke http')); if (row) row.click(); return Boolean(row); })()`,
        );
        check('ui: server row opens its tab', clickedHttpRow === true);
        await wait(1200);
        const mcpStatus = await js(`document.querySelector('[data-testid=mcp-status]')?.textContent ?? ''`);
        check('ui: tab header shows connected with the server name and version', typeof mcpStatus === 'string' && mcpStatus.includes('connected') && mcpStatus.includes('smoke-http 1.2.3'), mcpStatus);
        const toolNames = await js(`[...document.querySelectorAll('[data-testid=mcp-tool]')].map((b) => b.textContent)`);
        check('ui: tools listed', Array.isArray(toolNames) && toolNames.length === 4 && toolNames.some((t: string) => t.startsWith('echo')), toolNames);
        const clickedEcho = await js(`(() => { const btn = [...document.querySelectorAll('[data-testid=mcp-tool]')].find((b) => b.textContent.startsWith('echo')); if (btn) btn.click(); return Boolean(btn); })()`);
        await wait(600);
        const argsText = await js(`document.querySelector('[data-testid=mcp-tool-args] .cm-content')?.textContent ?? ''`);
        check('ui: arguments prefilled from the schema', clickedEcho === true && typeof argsText === 'string' && argsText.replace(/\s/g, '') === '{"text":""}', argsText);
        const typedArgs = await js(
          `(() => { const content = document.querySelector('[data-testid=mcp-tool-args] .cm-content'); if (!content) return false; content.focus(); document.execCommand('selectAll'); return document.execCommand('insertText', false, '{"text":"from the ui"}'); })()`,
        );
        check('ui: arguments editor accepts text', typedArgs === true);
        await wait(200);
        const clickedCall = await js(`(() => { const btn = document.querySelector('[data-testid=mcp-tool-call]'); if (btn && !btn.disabled) { btn.click(); return true; } return false; })()`);
        await wait(1200);
        const resultText = await js(`document.querySelector('[data-testid=mcp-tool-result]')?.textContent ?? ''`);
        check(
          'ui: tool result shows content, structured content and timing',
          clickedCall === true && typeof resultText === 'string' && resultText.includes('echo:from the ui') && resultText.includes('structured') && /\d+ ms/.test(resultText),
          String(resultText).slice(0, 200),
        );
        await shot('19-mcp-tools-light');
        const clickedLogTab = await js(
          `(() => { const pane = [...document.querySelectorAll('[data-tab-type="mcp.server"]')].find((el) => !el.classList.contains('hidden')); const btn = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Log')); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: log tab', clickedLogTab === true);
        await wait(800);
        const logRows = await js(`[...document.querySelectorAll('[data-testid=mcp-log-entry]')].map((r) => r.getAttribute('data-direction') + ':' + r.getAttribute('data-kind') + ':' + r.textContent)`);
        check(
          'ui: log lists the call pair with method and timing',
          Array.isArray(logRows) &&
            logRows.some((t: string) => t.startsWith('out:request:') && t.includes('tools/call')) &&
            logRows.some((t: string) => t.startsWith('in:response:') && t.includes('tools/call') && /\d+ ms/.test(t)),
          Array.isArray(logRows) ? logRows.slice(-3) : logRows,
        );
        await shot('20-mcp-log-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('21-mcp-log-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(200);

        // Resources, a resource template, a prompt and the handshake info, driven from the same tab.
        const clickMcpView = (label: string) =>
          js(
            `(() => { const pane = [...document.querySelectorAll('[data-tab-type="mcp.server"]')].find((el) => !el.classList.contains('hidden')); const btn = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith(${JSON.stringify(label)})); if (btn) btn.click(); return Boolean(btn); })()`,
          );
        const typeInto = (selector: string, value: string) =>
          js(
            `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
          );
        await clickMcpView('Resources');
        await wait(800);
        const resourceRows = await js(`[...document.querySelectorAll('[data-testid=mcp-resource], [data-testid=mcp-resource-template]')].map((r) => r.getAttribute('data-testid') + ':' + r.textContent)`);
        await js(`document.querySelector('[data-testid=mcp-resource]')?.click()`);
        await wait(800);
        const resourceRead = await js(`document.querySelector('[data-testid=mcp-resource-result]')?.textContent ?? ''`);
        check(
          'ui: resources and templates listed, and picking a resource reads it',
          Array.isArray(resourceRows) &&
            resourceRows.some((r: string) => r.startsWith('mcp-resource:') && r.includes('Greeting') && r.includes('smoke://greeting')) &&
            resourceRows.some((r: string) => r.startsWith('mcp-resource-template:') && r.includes('(template)') && r.includes('smoke://users/{id}')) &&
            typeof resourceRead === 'string' &&
            resourceRead.includes('1 part') &&
            resourceRead.includes('hello, inspector'),
          { resourceRows, resourceRead: String(resourceRead).slice(0, 160) },
        );
        await js(`document.querySelector('[data-testid=mcp-resource-template]')?.click()`);
        await wait(300);
        const typedVariable = await typeInto('[data-testid=mcp-template-variable]', '7');
        await wait(100);
        await js(`document.querySelector('[data-testid=mcp-resource-read]')?.click()`);
        await wait(800);
        const templateRead = await js(`document.querySelector('[data-testid=mcp-resource-result]')?.textContent ?? ''`);
        check(
          'ui: a template expands its variables into the uri it reads',
          typedVariable === true && typeof templateRead === 'string' && templateRead.includes('smoke://users/7') && templateRead.includes('"user 7"'),
          String(templateRead).slice(0, 200),
        );
        await shot('21e-mcp-resources-light');
        await clickMcpView('Prompts');
        await wait(800);
        await js(`[...document.querySelectorAll('[data-testid=mcp-prompt]')].find((p) => p.textContent.includes('summarize'))?.click()`);
        await wait(300);
        const promptArgs = await js(`document.querySelectorAll('[data-testid=mcp-prompt-argument]').length`);
        await typeInto('[data-testid=mcp-prompt-argument]', 'signals');
        await wait(100);
        await js(`document.querySelector('[data-testid=mcp-prompt-get]')?.click()`);
        await wait(800);
        const promptResult = await js(`document.querySelector('[data-testid=mcp-prompt-result]')?.textContent ?? ''`);
        check(
          'ui: a prompt renders with its arguments into messages',
          promptArgs === 2 && typeof promptResult === 'string' && promptResult.includes('1 message') && promptResult.includes('Summary of signals') && promptResult.includes('Summarize signals'),
          { promptArgs, promptResult: String(promptResult).slice(0, 200) },
        );
        await clickMcpView('Info');
        await wait(300);
        const info = await js(
          `[document.querySelector('[data-testid=mcp-info]')?.textContent ?? '', document.querySelector('[data-testid=mcp-capabilities]')?.textContent ?? '', document.querySelector('[data-testid=mcp-instructions]')?.textContent ?? '']`,
        );
        check(
          'ui: info shows the server, its capabilities and its instructions',
          Array.isArray(info) && info[0].includes('smoke-http 1.2.3') && info[1].includes('logging') && info[1].includes('tools') && info[2] === 'Use echo to test the connection.',
          Array.isArray(info) ? info.map((t: string) => t.slice(0, 160)) : info,
        );
        await clickMcpView('Tools');
        await wait(200);

        // Call recorder: opened from the inspector's sidebar, started in the UI, lists two agents' calls as they arrive, then ends.
        const clickedRecorderRow = await js(`(() => { const row = document.querySelector('[data-testid=mcp-recorder-row]'); if (row) row.click(); return Boolean(row); })()`);
        await wait(500);
        const recorderIdle = await js(`document.querySelector('[data-testid=mcp-recorder]')?.getAttribute('data-state') + '|' + Boolean(document.querySelector('[data-testid=mcp-recording-status]'))`);
        const clickedRecord = await js(`(() => { const btn = document.querySelector('[data-testid=mcp-recorder-start]'); if (btn) btn.click(); return Boolean(btn); })()`);
        await wait(600);
        const recorderStates = await js(
          `[document.querySelector('[data-testid=mcp-recorder]')?.getAttribute('data-state'), document.querySelector('[data-testid=mcp-recorder-row]')?.getAttribute('data-state'), document.querySelector('[data-testid=mcp-recording-status]')?.textContent].join('|')`,
        );
        check(
          'ui: recorder opens from the sidebar and starts, and the status bar says so',
          clickedRecorderRow === true && recorderIdle === 'idle|false' && clickedRecord === true && recorderStates === 'recording|recording|REC 0',
          { recorderIdle, recorderStates },
        );
        const claude = { 'mcp-session-id': (await agentRpc({}, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } })) ?? '' };
        const cursor = { 'mcp-session-id': (await agentRpc({}, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor', version: '3.1' } })) ?? '' };
        await agentRpc(claude, 'tools/call', { name: 'tools_json_format', arguments: { text: '{"b":1,"a":2}', sortKeys: true } });
        await agentRpc(cursor, 'tools/call', { name: 'db_connection_list', arguments: {} });
        await agentRpc(claude, 'tools/call', { name: 'api_request_delete', arguments: { id: 'no-such-request' } });
        await agentRpc(cursor, 'tools/call', { name: 'tools_base64_encode', arguments: { text: 'hello' } });
        await wait(700);
        const recorderRows = await js(`[...document.querySelectorAll('[data-testid=mcp-recorded-call]')].map((r) => [r.getAttribute('data-agent'), r.getAttribute('data-tool'), r.getAttribute('data-ok')].join(':'))`);
        check(
          'ui: recorder lists the calls of each agent as they arrive',
          Array.isArray(recorderRows) && recorderRows.join() === 'claude-code:tools_json_format:true,cursor:db_connection_list:true,claude-code:api_request_delete:false,cursor:tools_base64_encode:true',
          recorderRows,
        );
        await js(`document.querySelector('[data-testid=mcp-recorded-call][data-tool=tools_json_format]')?.click()`);
        await wait(700);
        const recorderDetail = await js(
          `[document.querySelector('[data-testid=mcp-recorder-detail]')?.textContent ?? '', document.querySelector('[data-testid=mcp-recorder-arguments] .cm-content')?.textContent ?? '', document.querySelector('[data-testid=mcp-recorder-result] .cm-content')?.textContent ?? '']`,
        );
        check(
          'ui: a recorded call shows its agent, arguments and result',
          Array.isArray(recorderDetail) && recorderDetail[0].includes('claude-code 2.1.0') && recorderDetail[1].includes('sortKeys') && recorderDetail[2].includes('"text"'),
          Array.isArray(recorderDetail) ? recorderDetail.map((t: string) => t.slice(0, 120)) : recorderDetail,
        );
        await shot('21b-mcp-recorder-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('21c-mcp-recorder-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await js(`document.querySelector('[data-testid=mcp-recorder-end]')?.click()`);
        await wait(500);
        const recorderEnded = await js(
          `[document.querySelector('[data-testid=mcp-recorder]')?.getAttribute('data-state'), Boolean(document.querySelector('[data-testid=mcp-recorder-save]')), Boolean(document.querySelector('[data-testid=mcp-recording-status]')), document.querySelector('[data-testid=mcp-recorder-summary]')?.textContent.startsWith('4 calls')].join('|')`,
        );
        check('ui: ending the recording offers to save it and clears the status bar', recorderEnded === 'ended|true|false|true', recorderEnded);
        await shot('21d-mcp-recorder-ended-light');
        // A recording that runs while another tab is on screen is one click away in the status bar.
        await run('mcp.recording.start', {}, null);
        await js(`document.querySelector('[data-testid=tab][data-title="smoke http"]')?.click()`);
        await wait(500);
        const recorderHidden = await js(`document.querySelector('[data-tab-type="mcp.recorder"]')?.classList.contains('hidden')`);
        await js(`document.querySelector('[data-testid=mcp-recording-status]')?.click()`);
        await wait(400);
        const recorderShown = await js(`document.querySelector('[data-tab-type="mcp.recorder"]')?.classList.contains('hidden') === false`);
        check('ui: the status bar entry opens the recorder', recorderHidden === true && recorderShown === true, { recorderHidden, recorderShown });
        await run('mcp.recording.clear', {}, null);
        await wait(300);
      },
    };
  },
});

export default definePart({
  name: 'mcp',
  summary: 'MCP inspector and call recorder: stdio, HTTP and SSE servers, Quiver itself, the inspector and recorder UI; agent permissions, approvals, pause and activity',
  run: (t) => runSections(t, [inspector.run, agents]),
});
