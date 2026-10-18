import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REDACTED } from '@quiver/core';
import type { ApiCollection, ApiRequest, ApiResponse, ApiRun, StreamRead, JarCookie, GraphqlSchemaDoc, Environment, HistoryEntry, WorkspaceInfo } from '@quiver/core';
import { definePart, until } from '../part';

export default definePart({
  name: 'api',
  summary: 'API client: environments, variables, requests, history masking, curl, GraphQL, agents over MCP, the request UI',
  async run(t) {
    const { host, check, run, ws, folder, env, rpc, toolNames: names } = t;
    const { echoPort, gqlPort, gqlState } = t.fixtures;

    check('environment secret round-trips', env.variables[1].value === 's3cret');
    const onDisk = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'environments', `${env.id}.json`), 'utf8')) as Environment;
    check('secret not written to committed file', onDisk.variables[1].value === '');

    type VarList = { environment: { name: string } | null; variables: { name: string; value: string | null; secret: boolean; source: string }[] };
    const varsForUi = await run<VarList>('api.variables.list', {}, ws.id);
    const varsForAgent = await host.invoke('api.variables.list', {}, { caller: 'mcp', workspaceId: ws.id });
    const agentToken = varsForAgent.ok ? (varsForAgent.result as VarList).variables.find((v) => v.name === 'token') : undefined;
    check(
      'api.variables.list: the active environment and built-ins, secrets shown to the UI and masked for agents',
      varsForUi.environment?.name === 'local' &&
        varsForUi.variables.find((v) => v.name === 'baseUrl')?.source === 'environment' &&
        varsForUi.variables.find((v) => v.name === 'token')?.value === 's3cret' &&
        varsForUi.variables.find((v) => v.name === '$uuid')?.source === 'dynamic' &&
        agentToken?.value === '••••••••' && agentToken.secret,
      { ui: varsForUi.variables.map((v) => `${v.name}:${v.source}`), agentToken },
    );

    // api.variables.set changes a value where it is defined, keeping secrets encrypted; globals are gated for agents.
    const globalsBefore = host.config.get().globalVariables;
    await run('config.update', { patch: { globalVariables: [...globalsBefore, { id: 'g1', key: 'region', value: 'eu', enabled: true }] } }, null);
    const setSecret = await run<{ source: string }>('api.variables.set', { name: 'token', value: 'n3w' }, ws.id);
    const tokenAfterSet = (await run<VarList>('api.variables.list', {}, ws.id)).variables.find((v) => v.name === 'token');
    const diskAfterSet = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'environments', `${env.id}.json`), 'utf8')) as Environment;
    check(
      'api.variables.set: updates the active environment and keeps a secret out of the committed file',
      setSecret.source === 'environment' && tokenAfterSet?.value === 'n3w' && tokenAfterSet.secret && diskAfterSet.variables[1].value === '' && diskAfterSet.variables[1].secret === true,
      { setSecret, tokenAfterSet, disk: diskAfterSet.variables[1] },
    );
    await run('api.variables.set', { name: 'token', value: 's3cret' }, ws.id);
    const agentSetEnv = await host.invoke('api.variables.set', { name: 'baseUrl', value: `http://127.0.0.1:${echoPort}` }, { caller: 'mcp', workspaceId: ws.id });
    const agentSetGlobal = await host.invoke('api.variables.set', { name: 'region', value: 'us' }, { caller: 'mcp', workspaceId: ws.id });
    const uiSetGlobal = await run<{ source: string }>('api.variables.set', { name: 'region', value: 'us' }, ws.id);
    const unknownSet = await host.invoke('api.variables.set', { name: 'nope', value: 'x' }, { caller: 'ui', workspaceId: ws.id });
    check(
      'api.variables.set: agents may change an environment value, a global one needs mutations, unknown names are refused',
      agentSetEnv.ok &&
        !agentSetGlobal.ok && agentSetGlobal.error.code === 'MUTATION_BLOCKED' &&
        uiSetGlobal.source === 'global' && host.config.get().globalVariables.find((v) => v.key === 'region')?.value === 'us' &&
        !unknownSet.ok && unknownSet.error.code === 'NOT_FOUND',
      { agentSetEnv: agentSetEnv.ok, agentSetGlobal: agentSetGlobal.ok ? 'ok?' : agentSetGlobal.error.code, uiSetGlobal, unknownSet: unknownSet.ok ? 'ok?' : unknownSet.error.code },
    );
    await run('config.update', { patch: { globalVariables: globalsBefore } }, null);

    // api.variables.define adds a missing variable to a chosen environment (secret or not) or the globals.
    const defined = await run<{ environmentName?: string }>('api.variables.define', { name: 'partner', value: 'acme', target: { kind: 'environment', id: env.id }, secret: true }, ws.id);
    await run('api.variables.define', { name: 'partner', value: 'acme2', target: { kind: 'environment', id: env.id }, secret: true }, ws.id);
    const listAfterDefine = await run<VarList & { environments: { id: string; name: string }[] }>('api.variables.list', {}, ws.id);
    const diskAfterDefine = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'environments', `${env.id}.json`), 'utf8')) as Environment;
    const partnerRows = diskAfterDefine.variables.filter((v) => v.key === 'partner');
    check(
      'api.variables.define: adds to the chosen environment once, a secret stays out of the committed file',
      defined.environmentName === 'local' &&
        listAfterDefine.variables.find((v) => v.name === 'partner')?.value === 'acme2' &&
        partnerRows.length === 1 && partnerRows[0].value === '' && partnerRows[0].secret === true &&
        listAfterDefine.environments.some((e) => e.id === env.id && e.name === 'local'),
      { defined, partnerRows, environments: listAfterDefine.environments },
    );
    const agentDefineGlobal = await host.invoke('api.variables.define', { name: 'partner', value: 'x', target: { kind: 'global' } }, { caller: 'mcp', workspaceId: ws.id });
    const secretGlobal = await host.invoke('api.variables.define', { name: 'partner', value: 'x', target: { kind: 'global' }, secret: true }, { caller: 'ui', workspaceId: ws.id });
    const builtinName = await host.invoke('api.variables.define', { name: '$uuid', value: 'x', target: { kind: 'environment', id: env.id } }, { caller: 'ui', workspaceId: ws.id });
    await run('api.variables.define', { name: 'shared', value: 'yes', target: { kind: 'global' } }, ws.id);
    check(
      'api.variables.define: a global needs mutations for agents, cannot be secret, and built-in names are refused',
      !agentDefineGlobal.ok && agentDefineGlobal.error.code === 'MUTATION_BLOCKED' &&
        !secretGlobal.ok && secretGlobal.error.code === 'INVALID_INPUT' &&
        !builtinName.ok && builtinName.error.code === 'INVALID_INPUT' &&
        host.config.get().globalVariables.find((v) => v.key === 'shared')?.value === 'yes',
      { agentDefineGlobal: agentDefineGlobal.ok || agentDefineGlobal.error.code, secretGlobal: secretGlobal.ok || secretGlobal.error.code, builtinName: builtinName.ok || builtinName.error.code },
    );
    // Defining a name that is already a secret, without asking for a secret, keeps it encrypted.
    await run('api.variables.define', { name: 'partner', value: 'acme3', target: { kind: 'environment', id: env.id }, secret: false }, ws.id);
    const partnerKept = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'environments', `${env.id}.json`), 'utf8')) as Environment;
    const partnerRow = partnerKept.variables.find((v) => v.key === 'partner');
    check(
      'api.variables.define: an existing secret stays secret and out of the committed file',
      partnerRow?.secret === true && partnerRow.value === '' && (await run<Environment>('api.environment.get', { id: env.id }, ws.id)).variables.find((v) => v.key === 'partner')?.value === 'acme3',
      partnerRow,
    );
    const envWithPartner = await run<Environment>('api.environment.get', { id: env.id }, ws.id);
    await run('api.environment.save', { environment: { ...envWithPartner, variables: envWithPartner.variables.filter((v) => v.key !== 'partner') } }, ws.id);
    await run('config.update', { patch: { globalVariables: globalsBefore } }, null);

    const created = await run<ApiRequest>('api.request.create', { name: 'echo', method: 'POST', url: '{{baseUrl}}/things?x=1' }, ws.id);
    const saved = await run<ApiRequest>(
      'api.request.save',
      {
        request: {
          ...created,
          headers: [{ id: 'h1', key: 'X-Test', value: '{{$uuid}}', enabled: true }],
          auth: { type: 'bearer', token: '{{token}}' },
          body: { type: 'json', content: '{"hello":"world"}' },
        },
      },
      ws.id,
    );
    const response = await run<ApiResponse>('api.request.send', { requestId: saved.id }, ws.id);
    const echoed = JSON.parse(response.body) as { headers: Record<string, string>; body: string; url: string };
    check('request.send status', response.status === 200, response.status);
    check('bearer token resolved from secret', echoed.headers.authorization === 'Bearer s3cret');
    check('json body sent', echoed.body === '{"hello":"world"}');
    check('query param kept', echoed.url === '/things?x=1', echoed.url);
    check('dynamic variable resolved', /^[0-9a-f-]{36}$/.test(echoed.headers['x-test'] ?? ''));

    // Code: the saved echo request as code for every target, masked for agents.
    {
      const targets = ['curl', 'javascript-fetch', 'axios', 'python-requests', 'go-net-http', 'csharp-httpclient', 'powershell'] as const;
      const codes: Record<string, string> = {};
      for (const target of targets) codes[target] = (await run<{ code: string }>('api.export.code', { requestId: saved.id, target }, ws.id)).code;
      const url = `http://127.0.0.1:${echoPort}/things?x=1`;
      const curlCommand = (await run<{ command: string }>('api.export.curl', { requestId: saved.id }, ws.id)).command;
      const agentCodes = await Promise.all(targets.map((target) => host.invoke('api.export.code', { requestId: saved.id, target }, { caller: 'mcp', workspaceId: ws.id })));
      check(
        'api.export.code: every target carries the URL, the bearer and the JSON body, curl matches Copy as curl, and agents get the bearer masked',
        targets.every((tg) => codes[tg].includes(url) && codes[tg].includes('Bearer s3cret') && codes[tg].includes('hello')) &&
          codes['javascript-fetch'].includes('await fetch(') && codes.axios.includes("import axios from 'axios';") && codes['python-requests'].includes('requests.request(') &&
          codes['go-net-http'].startsWith('package main') && codes['csharp-httpclient'].includes('new HttpRequestMessage(new HttpMethod("POST")') && codes.powershell.includes('Invoke-RestMethod') &&
          // The echo request's X-Test is {{$uuid}}, new on every render.
          codes.curl.replace(/X-Test: [^']*/, '') === curlCommand.replace(/X-Test: [^']*/, '') &&
          agentCodes.every((r) => r.ok && !(r.result as { code: string }).code.includes('s3cret') && (r.result as { code: string }).code.includes(`Bearer ${REDACTED}`)),
        { fetch: codes['javascript-fetch'].slice(0, 160), agent: agentCodes.map((r) => (r.ok ? 'ok' : r.error.code)) },
      );
      // A multipart text field holds a secret as readily as a header: agents get it masked by name and by value.
      const formBody = { type: 'form' as const, fields: [{ id: 'f1', key: 'note', value: 'hi', enabled: true }, { id: 'f2', key: 'client_secret', value: '{{token}}', enabled: true }, { id: 'f3', key: 'password', value: 'typed-pw-1', enabled: true }] };
      const formUi = (await run<{ code: string }>('api.export.code', { request: { ...saved, body: formBody }, target: 'curl' }, ws.id)).code;
      const formAgent = await host.invoke('api.export.code', { request: { ...saved, body: formBody }, target: 'python-requests' }, { caller: 'mcp', workspaceId: ws.id });
      const formAgentCode = formAgent.ok ? (formAgent.result as { code: string }).code : '';
      check(
        'api.export.code: multipart text fields reach the UI as they are and agents masked, by name and by secret value',
        formUi.includes("--form-string 'client_secret=s3cret'") && formUi.includes("--form-string 'password=typed-pw-1'") &&
          formAgent.ok && !formAgentCode.includes('s3cret') && !formAgentCode.includes('typed-pw-1') && formAgentCode.includes('"note": "hi"'),
        { formUi, formAgent: formAgent.ok ? formAgentCode.slice(0, 300) : formAgent.error.message },
      );
    }

    const history = await run<HistoryEntry[]>('api.history.list', { limit: 5 }, ws.id);
    check('history recorded', history.length === 1 && history[0].status === 200);

    // History is a plain file: credentials typed straight into a request, and secrets its URL resolves to, are masked before they reach it.
    {
      const historyFile = path.join(folder, '.quiver', 'local', 'history.jsonl');
      const latest = async () => (await run<HistoryEntry[]>('api.history.list', { limit: 1 }, ws.id))[0];
      const tokenOf = (e: HistoryEntry) => (e.request.auth.type === 'bearer' ? e.request.auth.token : null);
      check('history: a request that only references variables is stored as it was written', tokenOf(history[0]) === '{{token}}' && !(await fs.readFile(historyFile, 'utf8')).includes('s3cret'), history[0].request.auth);
      const typed = await run<ApiResponse>(
        'api.request.send',
        {
          request: {
            ...saved,
            id: '',
            name: 'typed token',
            url: '{{baseUrl}}/login?api_key=query-key-123&ref={{token}}&page=2',
            headers: [
              { id: 'h1', key: 'Authorization', value: 'Bearer header-token-456', enabled: true },
              { id: 'h2', key: 'X-Trace', value: 'keep-me', enabled: true },
            ],
            auth: { type: 'bearer', token: 'typed-token-789' },
          },
        },
        ws.id,
      );
      const typedEcho = JSON.parse(typed.body) as { headers: Record<string, string>; url: string };
      check('history: typed credentials still go on the wire as typed', typedEcho.headers.authorization === 'Bearer header-token-456' && typedEcho.url === '/login?api_key=query-key-123&ref=s3cret&page=2', typedEcho.url);
      const typedEntry = await latest();
      check(
        'history: a typed token, an Authorization header, a key parameter and a resolved secret are masked',
        tokenOf(typedEntry) === REDACTED &&
          typedEntry.request.headers[0].value === `Bearer ${REDACTED}` &&
          typedEntry.request.headers[1].value === 'keep-me' &&
          typedEntry.request.url === `{{baseUrl}}/login?api_key=${REDACTED}&ref={{token}}&page=2` &&
          typedEntry.url === `http://127.0.0.1:${echoPort}/login?api_key=${REDACTED}&ref=${REDACTED}&page=2` &&
          typedEntry.status === 200,
        { url: typedEntry.url, request: typedEntry.request.url, auth: typedEntry.request.auth, headers: typedEntry.request.headers.map((h) => h.value) },
      );
      await run('api.request.send', { request: { ...saved, id: '', name: 'basic', url: '{{baseUrl}}/b', headers: [], auth: { type: 'basic', username: 'ada', password: 'hunter2-pw' } } }, ws.id);
      const basicEntry = await latest();
      await run('api.request.send', { request: { ...saved, id: '', name: 'key', url: '{{baseUrl}}/k', headers: [], auth: { type: 'apikey', key: 'appid', value: 'app-key-321', in: 'query' } } }, ws.id);
      const keyEntry = await latest();
      check(
        'history: a basic password and an API key are masked, the user and the key name kept',
        basicEntry.request.auth.type === 'basic' &&
          basicEntry.request.auth.username === 'ada' &&
          basicEntry.request.auth.password === REDACTED &&
          keyEntry.request.auth.type === 'apikey' &&
          keyEntry.request.auth.key === 'appid' &&
          keyEntry.request.auth.value === REDACTED &&
          keyEntry.url === `http://127.0.0.1:${echoPort}/k?appid=${REDACTED}`,
        { basic: basicEntry.request.auth, key: keyEntry.request.auth, url: keyEntry.url },
      );
      const down = await host.invoke('api.request.send', { request: { ...saved, id: '', name: 'down', url: 'http://127.0.0.1:1/down', headers: [], auth: { type: 'bearer', token: 'down-token-654' } }, options: { timeoutMs: 3000 } }, { caller: 'ui', workspaceId: ws.id });
      const downEntry = await latest();
      check('history: a send that fails is masked as well', !down.ok && downEntry.error !== null && tokenOf(downEntry) === REDACTED, downEntry.error);
      const historyText = await fs.readFile(historyFile, 'utf8');
      const leaked = ['typed-token-789', 'header-token-456', 'query-key-123', 'hunter2-pw', 'app-key-321', 'down-token-654', 's3cret'].filter((s) => historyText.includes(s));
      check('history: none of it is in the file on disk', leaked.length === 0 && historyText.trim().split('\n').length === 5, leaked);

      // A log written by an older version still holds its credentials; it is rewritten when the workspace opens.
      const legacyFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-legacy-'));
      const legacyFile = path.join(legacyFolder, '.quiver', 'local', 'history.jsonl');
      await fs.mkdir(path.dirname(legacyFile), { recursive: true });
      const legacy: HistoryEntry[] = [
        {
          id: 'old1',
          at: '2026-09-01T10:00:00.000Z',
          requestId: null,
          method: 'POST',
          url: 'https://merchant.example.com/login?api_key=old-key-111',
          status: 200,
          durationMs: 5,
          error: null,
          request: { ...saved, url: 'https://merchant.example.com/login?api_key=old-key-111', headers: [{ id: 'h', key: 'authorization', value: 'Bearer old-token-333', enabled: true }], auth: { type: 'bearer', token: 'old-token-222' } },
        },
        { id: 'old2', at: '2026-09-02T10:00:00.000Z', requestId: saved.id, method: 'POST', url: 'https://merchant.example.com/things', status: 204, durationMs: 7, error: null, request: saved },
      ];
      await fs.writeFile(legacyFile, legacy.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const legacyWs = await run<WorkspaceInfo>('workspace.open', { path: legacyFolder }, null);
      const legacyList = await run<HistoryEntry[]>('api.history.list', { limit: 10 }, legacyWs.id);
      const legacyText = await fs.readFile(legacyFile, 'utf8');
      check(
        'history: entries written before masking are cleaned when the workspace opens, in the same order',
        legacyList.map((e) => e.id).join() === 'old2,old1' &&
          tokenOf(legacyList[1]) === REDACTED &&
          legacyList[1].request.headers[0].value === `Bearer ${REDACTED}` &&
          legacyList[1].url === `https://merchant.example.com/login?api_key=${REDACTED}` &&
          tokenOf(legacyList[0]) === '{{token}}' &&
          !/old-(token|key)-\d/.test(legacyText) &&
          legacyText.trim().split('\n').length === 2,
        { ids: legacyList.map((e) => e.id), onDisk: legacyText.match(/old-(token|key)-\d+/g) },
      );
      await run('workspace.close', { id: legacyWs.id }, null);
      await run('workspace.forgetRecent', { path: legacyFolder }, null);
      await fs.rm(legacyFolder, { recursive: true, force: true }).catch(() => {});
    }

    const imported = await run<ApiRequest>('api.import.curl', { command: `curl -X PUT '{{baseUrl}}/a?b=c' -H 'X-A: 1' -d '{"k":1}'` }, ws.id);
    check('curl import', imported.method === 'PUT' && imported.body.type === 'json');
    const curl = await run<{ command: string }>('api.export.curl', { requestId: imported.id }, ws.id);
    check('curl export resolves variables', curl.command.includes(`http://127.0.0.1:${echoPort}/a?b=c`), curl.command);

    // Chrome's "Copy as cURL (cmd)" escapes with carets; none may reach the saved request or the wire.
    {
      const cmdCurl = [
        `curl ^"http://127.0.0.1:${echoPort}/x?merchantId=376^" ^`,
        '  -H ^"accept: application/json^" ^',
        '  -H ^"sec-ch-ua: ^\\^"Chromium^\\^";v=^\\^"154^\\^"^" ^',
        '  -b ^"session=a%^2Fb^" ^',
        '  --data-raw ^"null^"',
      ].join('\r\n');
      const fromCmd = await run<ApiRequest>('api.import.curl', { command: cmdCurl }, ws.id);
      const sent = await run<ApiResponse>('api.request.send', { requestId: fromCmd.id }, ws.id);
      const echoedCmd = JSON.parse(sent.body) as { method: string; headers: Record<string, string>; body: string; url: string };
      check(
        'curl import: cmd.exe carets are removed and the request sends as copied',
        sent.status === 200 &&
          echoedCmd.method === 'POST' &&
          echoedCmd.url === '/x?merchantId=376' &&
          echoedCmd.headers.accept === 'application/json' &&
          echoedCmd.headers['sec-ch-ua'] === '"Chromium";v="154"' &&
          echoedCmd.headers.cookie === 'session=a%2Fb' &&
          echoedCmd.body === 'null',
        echoedCmd,
      );
      const before = (await run<ApiRequest[]>('api.request.list', {}, ws.id)).length;
      const broken = await host.invoke('api.import.curl', { command: 'curl ^"https://x.test/a ^\r\n  -H ^"a: b^"' }, { caller: 'ui', workspaceId: ws.id });
      const forced = await host.invoke('api.import.curl', { command: cmdCurl, dialect: 'posix' }, { caller: 'ui', workspaceId: ws.id });
      const after = (await run<ApiRequest[]>('api.request.list', {}, ws.id)).length;
      check(
        'curl import: an unterminated quote or the wrong shell is refused and nothing is saved',
        !broken.ok && /cmd\.exe: unterminated/.test(broken.error.message) && !forced.ok && /bash\/zsh: .*cmd\.exe/.test(forced.error.message) && after === before,
        { broken: broken.ok ? 'ok?' : broken.error.message, forced: forced.ok ? 'ok?' : forced.error.message, before, after },
      );
      await run('api.request.delete', { id: fromCmd.id }, ws.id);
    }

    const missing = await host.invoke('api.request.send', { request: { ...saved, url: '{{nope}}/x' } }, { caller: 'ui', workspaceId: ws.id });
    check('unresolved variable is reported', !missing.ok && missing.error.code === 'UNRESOLVED_VARIABLES');

    // ---------- GraphQL: body type over POST and GET, variables, operation names, introspection cache ----------
    const gqlReq = await run<ApiRequest>(
      'api.request.create',
      { name: 'smoke graphql', method: 'POST', url: `http://127.0.0.1:${gqlPort}/graphql`, body: { type: 'graphql', query: 'query Hello($name: String) {\n  hello(name: $name)\n}', variables: '{"name":"{{token}}"}' } },
      ws.id,
    );
    check('graphql: request created with a graphql body', gqlReq.body.type === 'graphql');
    const gqlSaved = await run<ApiRequest>('api.request.save', { request: { ...gqlReq, auth: { type: 'bearer', token: '{{token}}' } } }, ws.id);
    const gqlRes = await run<ApiResponse>('api.request.send', { requestId: gqlSaved.id }, ws.id);
    const gqlData = JSON.parse(gqlRes.body) as { data?: { hello?: string } };
    check('graphql: POST sends query and variables as JSON with variables resolved', gqlRes.status === 200 && gqlData.data?.hello === 'Hello, s3cret' && gqlState.lastMethod === 'POST' && gqlState.authSeen === 'Bearer s3cret', gqlRes.body);
    check('graphql: sent request shows the JSON payload', (gqlRes.sent.bodyPreview ?? '').includes('"query"') && gqlRes.sent.headers.some(([k, v]) => k === 'Content-Type' && v === 'application/json'));
    const gqlGet = await run<ApiResponse>('api.request.send', { request: { ...gqlSaved, method: 'GET' } }, ws.id);
    check(
      'graphql: GET puts query and variables in the URL',
      gqlGet.status === 200 && (JSON.parse(gqlGet.body) as typeof gqlData).data?.hello === 'Hello, s3cret' && gqlState.lastMethod === 'GET' && gqlGet.sent.url.includes('query=') && gqlGet.sent.bodyPreview === null,
      gqlGet.sent.url.slice(0, 120),
    );
    const gqlMulti = 'query A { hello } query B($id: ID!) { user(id: $id) { name } }';
    const gqlOp = await run<ApiResponse>('api.request.send', { request: { ...gqlSaved, body: { type: 'graphql', query: gqlMulti, variables: '{"id":"2"}', operationName: 'B' } } }, ws.id);
    check('graphql: operationName picks the operation', (JSON.parse(gqlOp.body) as { data?: { user?: { name: string } } }).data?.user?.name === 'Linus', gqlOp.body);
    const gqlBadVars = await host.invoke('api.request.send', { request: { ...gqlSaved, body: { type: 'graphql', query: '{ hello }', variables: '{not json' } } }, { caller: 'ui', workspaceId: ws.id });
    check('graphql: invalid variables JSON is refused before sending', !gqlBadVars.ok && gqlBadVars.error.code === 'INVALID_INPUT', gqlBadVars.ok ? 'ok?' : gqlBadVars.error.message);
    check('graphql: no schema before introspection', (await run<GraphqlSchemaDoc | null>('api.graphql.schema', { requestId: gqlSaved.id }, ws.id)) === null);
    const schemaDoc = await run<GraphqlSchemaDoc>('api.graphql.introspect', { requestId: gqlSaved.id }, ws.id);
    check(
      'graphql: introspection caches the schema as SDL',
      schemaDoc.url === `http://127.0.0.1:${gqlPort}/graphql` && schemaDoc.typeCount >= 3 && schemaDoc.sdl.includes('type User') && schemaDoc.sdl.includes('A person') && schemaDoc.sdl.includes('@deprecated'),
      { types: schemaDoc.typeCount, sdl: schemaDoc.sdl.slice(0, 80) },
    );
    const cachedSchema = await run<GraphqlSchemaDoc | null>('api.graphql.schema', { requestId: gqlSaved.id }, ws.id);
    check('graphql: cached schema is read back from .quiver/local', cachedSchema?.sdl === schemaDoc.sdl && (await fs.readdir(path.join(folder, '.quiver', 'local'))).some((f) => f.startsWith('graphql-schema-')));
    const gqlCurl = await run<{ command: string }>('api.export.curl', { requestId: gqlSaved.id }, ws.id);
    check('graphql: curl export carries the JSON payload and auth', gqlCurl.command.includes('--data-raw') && gqlCurl.command.includes('"query"') && gqlCurl.command.includes('Bearer s3cret'), gqlCurl.command.slice(0, 160));

    check('mcp lists api tools', names.includes('api_request_send') && names.includes('api_export_curl'), names.length);

    const call = await rpc('tools/call', { name: 'api_request_send', arguments: { requestId: saved.id } });
    const called = JSON.parse(call.result?.content?.[0]?.text ?? '{}') as ApiResponse;
    check('mcp tools/call sends request', called.status === 200, call.error ?? called.status);
    const blocked = await rpc('tools/call', { name: 'api_request_delete', arguments: { id: imported.id } });
    check('mcp blocks mutations by default', blocked.result?.isError === true && (blocked.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    const masked = await rpc('tools/call', { name: 'api_environment_get', arguments: { id: env.id } });
    check('mcp masks secrets', !(masked.result?.content?.[0]?.text ?? '').includes('s3cret'));
    // What an agent reads back about a request it sent has the secrets masked; the UI still sees what went on the wire.
    {
      const viaSecret = { ...saved, id: '', url: '{{baseUrl}}/agent?ref={{token}}&page=1', headers: [{ id: 'h1', key: 'X-Note', value: 'note-{{token}}', enabled: true }], body: { type: 'json', content: '{"t":"{{token}}"}' } };
      const agentSend = await rpc('tools/call', { name: 'api_request_send', arguments: { request: viaSecret, record: false } });
      const agentGot = JSON.parse(agentSend.result?.content?.[0]?.text ?? '{}') as Partial<ApiResponse>;
      const headerOf = (r: Partial<ApiResponse>, name: string) => r.sent?.headers.find(([k]) => k.toLowerCase() === name)?.[1];
      check(
        'mcp: what a send reports as sent has credentials and secret variables masked',
        agentGot.status === 200 &&
          headerOf(agentGot, 'authorization') === `Bearer ${REDACTED}` &&
          headerOf(agentGot, 'x-note') === `note-${REDACTED}` &&
          agentGot.sent?.url === `http://127.0.0.1:${echoPort}/agent?ref=${REDACTED}&page=1` &&
          agentGot.sent.bodyPreview === `{"t":"${REDACTED}"}` &&
          agentGot.url === agentGot.sent.url &&
          !JSON.stringify(agentGot.sent).includes('s3cret'),
        agentGot.sent,
      );
      const uiGot = await run<ApiResponse>('api.request.send', { request: viaSecret, record: false }, ws.id);
      check('mcp: the UI still sees the request as it went out', uiGot.sent.headers.some(([k, v]) => k === 'Authorization' && v === 'Bearer s3cret') && uiGot.sent.url.endsWith('/agent?ref=s3cret&page=1') && uiGot.sent.bodyPreview === '{"t":"s3cret"}');
      const agentDown = await rpc('tools/call', { name: 'api_request_send', arguments: { request: { ...saved, id: '', url: 'http://127.0.0.1:1/down?ref={{token}}' }, record: false, options: { timeoutMs: 3000 } } });
      const agentDownText = agentDown.result?.content?.[0]?.text ?? '';
      check('mcp: a failed send does not name the secret either', agentDown.result?.isError === true && agentDownText.includes(`ref=${REDACTED}`) && !agentDownText.includes('s3cret'), agentDownText.slice(0, 200));
      const agentCurl = (await rpc('tools/call', { name: 'api_export_curl', arguments: { requestId: saved.id } })).result?.content?.[0]?.text ?? '';
      const uiCurl = await run<{ command: string }>('api.export.curl', { requestId: saved.id }, ws.id);
      check('mcp: curl export masks the secret for agents and keeps it for the UI', agentCurl.includes(`Bearer ${REDACTED}`) && !agentCurl.includes('s3cret') && uiCurl.command.includes('Bearer s3cret'), agentCurl.slice(0, 200));
    }

    check(
      'mcp lists graphql tools',
      ['api_graphql_introspect', 'api_graphql_schema'].every((n) => names.includes(n)),
      names.filter((n) => n.startsWith('api_graphql')),
    );
    const mcpSchema = await rpc('tools/call', { name: 'api_graphql_schema', arguments: { requestId: gqlSaved.id } });
    check('mcp reads the cached graphql schema as SDL', (mcpSchema.result?.content?.[0]?.text ?? '').includes('type User'), mcpSchema.result?.content?.[0]?.text?.slice(0, 80));

    // Send options: the defaults, then the request's own, then the call's; only overrides are saved; curl says what the request does.
    {
      const probe = await run<ApiRequest>('api.request.create', { name: 'timeout probe', method: 'GET', url: '{{baseUrl}}/slow?ms=1500' }, ws.id);
      const withOptions = await run<ApiRequest>('api.request.save', { request: { ...probe, options: { timeoutMs: 300, insecure: true } } }, ws.id);
      const stored = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'requests', `${probe.id}.json`), 'utf8')) as ApiRequest;
      const timedOut = await host.invoke('api.request.send', { requestId: probe.id }, { caller: 'ui', workspaceId: ws.id });
      const longer = await host.invoke('api.request.send', { requestId: probe.id, options: { timeoutMs: 5000 } }, { caller: 'ui', workspaceId: ws.id });
      check(
        'api.request.send: a request\'s own timeout applies, and a timeout given with the call wins over it',
        !timedOut.ok && timedOut.error.message.includes('Timed out after 300 ms') && longer.ok && (longer.result as ApiResponse).status === 200,
        { timedOut: timedOut.ok ? 'ok?' : timedOut.error.message, longer: longer.ok ? (longer.result as ApiResponse).status : longer.error.message },
      );
      check('api.request.save: only the overridden options are written to the request file', JSON.stringify(stored.options) === JSON.stringify({ timeoutMs: 300, insecure: true }), stored.options);
      const probeCurl = await run<{ command: string }>('api.export.curl', { requestId: withOptions.id }, ws.id);
      const plainCurl = await run<{ command: string }>('api.export.curl', { requestId: saved.id }, ws.id);
      check(
        'api.export.curl: -L for followed redirects, -k and --max-time from the request\'s options',
        probeCurl.command.includes('-L -k --max-time 0.3') && plainCurl.command.includes('-L') && !plainCurl.command.includes('--max-time') && !plainCurl.command.includes(' -k'),
        probeCurl.command,
      );

      // Cancelling: a send given a sendId stops on api.request.cancel, also for an agent, and the history says Cancelled.
      const started = Date.now();
      const pending = host.invoke('api.request.send', { requestId: probe.id, sendId: 'smoke-cancel', options: { timeoutMs: 10_000 } }, { caller: 'ui', workspaceId: ws.id });
      await new Promise((r) => setTimeout(r, 300));
      const cancelled = await host.invoke('api.request.cancel', { sendId: 'smoke-cancel' }, { caller: 'mcp', workspaceId: ws.id });
      const outcome = await pending;
      const elapsed = Date.now() - started;
      const afterCancel = await run<{ cancelled: boolean }>('api.request.cancel', { sendId: 'smoke-cancel' }, ws.id);
      const cancelledEntry = (await run<HistoryEntry[]>('api.history.list', { limit: 1 }, ws.id))[0];
      check(
        'api.request.cancel: stops a running send with REQUEST_CANCELLED, agents may call it, and the history records Cancelled',
        cancelled.ok && (cancelled.result as { cancelled: boolean }).cancelled === true &&
          !outcome.ok && outcome.error.code === 'REQUEST_CANCELLED' && elapsed < 1400 &&
          afterCancel.cancelled === false &&
          cancelledEntry?.error === 'Cancelled' && cancelledEntry.status === null,
        { cancelled: cancelled.ok ? cancelled.result : cancelled.error.code, outcome: outcome.ok ? 'ok?' : outcome.error.code, elapsed, afterCancel, entry: cancelledEntry?.error },
      );
      check('mcp lists api_request_cancel', names.includes('api_request_cancel'));
      await run('api.request.delete', { id: probe.id }, ws.id);
    }

    // Redirects are followed by Quiver: every hop is listed, POST becomes GET on 302, 307 repeats it, credentials stay with their origin.
    {
      const base = {
        ...saved,
        id: '',
        name: 'redirects',
        headers: [{ id: 'k', key: 'X-API-Key', value: 'key-777', enabled: true }],
        auth: { type: 'bearer' as const, token: '{{token}}' },
        body: { type: 'json' as const, content: '{"r":1}' },
      };
      const send = (url: string, options?: object) => host.invoke('api.request.send', { request: { ...base, url }, options }, { caller: 'ui', workspaceId: ws.id });
      const echoOf = (r: ApiResponse) => JSON.parse(r.body) as { method: string; url: string; body: string; headers: Record<string, string> };
      const r302 = await run<ApiResponse>('api.request.send', { request: { ...base, url: '{{baseUrl}}/redirect/302?to=/landing' } }, ws.id);
      const r307 = await run<ApiResponse>('api.request.send', { request: { ...base, url: '{{baseUrl}}/redirect/307?to=/again' } }, ws.id);
      const cross = await run<ApiResponse>('api.request.send', { request: { ...base, url: `{{baseUrl}}/redirect/307?to=${encodeURIComponent(`http://127.0.0.1:${t.fixtures.echoOtherPort}/elsewhere`)}` } }, ws.id);
      check(
        'api.request.send: a 302 turns the POST into a GET without a body, and the hop is listed',
        r302.status === 200 && echoOf(r302).method === 'GET' && echoOf(r302).body === '' && echoOf(r302).url === '/landing' &&
          r302.redirects.length === 1 && r302.redirects[0].status === 302 && r302.redirects[0].method === 'POST' && r302.redirects[0].location.endsWith('/landing') && r302.url.endsWith('/landing'),
        { method: echoOf(r302).method, body: echoOf(r302).body, redirects: r302.redirects.map((h) => `${h.status} ${h.method} ${h.location}`), url: r302.url },
      );
      check(
        'api.request.send: a 307 repeats the POST with its body, Authorization and API key; one that leaves the origin drops Authorization and the API-key header',
        echoOf(r307).method === 'POST' && echoOf(r307).body === '{"r":1}' && echoOf(r307).headers.authorization === 'Bearer s3cret' && echoOf(r307).headers['x-api-key'] === 'key-777' &&
          echoOf(cross).method === 'POST' && echoOf(cross).url === '/elsewhere' && echoOf(cross).headers.authorization === undefined && echoOf(cross).headers['x-api-key'] === undefined,
        { r307: [echoOf(r307).method, echoOf(r307).headers.authorization, echoOf(r307).headers['x-api-key']], cross: [echoOf(cross).url, echoOf(cross).headers.authorization ?? null, echoOf(cross).headers['x-api-key'] ?? null] },
      );
      const unfollowed = await send('{{baseUrl}}/redirect/302?to=/landing', { followRedirects: false });
      const loop = await send('{{baseUrl}}/loop');
      check(
        'api.request.send: with redirects off the 302 is the response, and a redirect loop stops after 20 hops',
        unfollowed.ok && (unfollowed.result as ApiResponse).status === 302 && (unfollowed.result as ApiResponse).redirects.length === 0 && !loop.ok && loop.error.message.includes('Stopped after 20 redirects'),
        { unfollowed: unfollowed.ok ? (unfollowed.result as ApiResponse).status : unfollowed.error.message, loop: loop.ok ? 'ok?' : loop.error.message },
      );
      const agentHop = await host.invoke('api.request.send', { request: { ...base, url: '{{baseUrl}}/redirect/302?to=/landing&key={{token}}' } }, { caller: 'mcp', workspaceId: ws.id });
      const agentRedirects = agentHop.ok ? (agentHop.result as ApiResponse).redirects : [];
      check(
        'api.request.send: an agent sees each hop with the secrets in its URL masked',
        agentHop.ok && agentRedirects.length === 1 && agentRedirects[0].url.includes(REDACTED) && !JSON.stringify(agentRedirects).includes('s3cret'),
        agentRedirects.map((h) => h.url),
      );
      const cookies = await run<ApiResponse>('api.request.send', { request: { ...base, method: 'GET', url: '{{baseUrl}}/cookies' } }, ws.id);
      check(
        'api.request.send: Set-Cookie headers are kept one by one, an Expires with a comma included',
        cookies.setCookies.length === 2 && cookies.setCookies[0].startsWith('sid=abc123') && cookies.setCookies[1].includes('Expires=Wed, 21 Oct 2026 07:28:00 GMT'),
        cookies.setCookies,
      );
      const { total, ttfb, download } = cookies.timings;
      check('api.request.send: timings split into waiting and download', download >= 0 && Math.abs(total - ttfb - download) < 1, cookies.timings);
    }

    // Saving a response body: text as text, a binary body as its bytes; agents are gated and kept inside the project.
    {
      const image = await run<ApiResponse>('api.request.send', { request: { ...saved, id: '', method: 'GET', url: '{{baseUrl}}/image.png', body: { type: 'none' } } }, ws.id);
      const textPath = path.join(folder, 'saved', 'echo.json');
      const savedText = await run<{ path: string; bytes: number }>('api.response.save', { path: 'saved/echo.json', body: '{"a":1}', bodyEncoding: 'utf8' }, ws.id);
      const savedImage = await run<{ path: string; bytes: number }>('api.response.save', { path: path.join(folder, 'saved', 'pixel.png'), body: image.body, bodyEncoding: image.bodyEncoding }, ws.id);
      const pngBytes = await fs.readFile(path.join(folder, 'saved', 'pixel.png'));
      check(
        'api.response.save: writes text, and a binary response as the bytes that came',
        (await fs.readFile(textPath, 'utf8')) === '{"a":1}' && savedText.path === textPath && image.bodyEncoding === 'base64' && pngBytes.length === savedImage.bytes && pngBytes.subarray(1, 4).toString() === 'PNG',
        { savedText, savedImage, encoding: image.bodyEncoding },
      );
      const outside = path.join(os.tmpdir(), `quiver-smoke-outside-${Date.now()}.txt`);
      const blocked = await host.invoke('api.response.save', { path: 'saved/agent.txt', body: 'x' }, { caller: 'mcp', workspaceId: ws.id });
      const mcpBefore = host.config.get().mcp;
      await run('config.update', { patch: { mcp: { ...mcpBefore, allowMutating: true } } }, null);
      const inside = await host.invoke('api.response.save', { path: 'saved/agent.txt', body: 'x' }, { caller: 'mcp', workspaceId: ws.id });
      const escaped = await host.invoke('api.response.save', { path: outside, body: 'x' }, { caller: 'mcp', workspaceId: ws.id });
      const climbed = await host.invoke('api.response.save', { path: '../climbed.txt', body: 'x' }, { caller: 'mcp', workspaceId: ws.id });
      await run('config.update', { patch: { mcp: mcpBefore } }, null);
      const outsideWritten = await fs.stat(outside).then(() => true, () => false);
      check(
        'api.response.save: gated for agents, and with mutations on still only inside the project folder',
        !blocked.ok && blocked.error.code === 'MUTATION_BLOCKED' && inside.ok && !escaped.ok && escaped.error.code === 'INVALID_INPUT' && !climbed.ok && !outsideWritten,
        { blocked: blocked.ok ? 'ok?' : blocked.error.code, inside: inside.ok, escaped: escaped.ok ? 'ok?' : escaped.error.code, climbed: climbed.ok ? 'ok?' : climbed.error.code },
      );
      await fs.rm(path.join(folder, 'saved'), { recursive: true, force: true });
    }

    // Moving collections: under another one or to the top level, never into itself or its own sub-collections.
    {
      const outer = await run<ApiCollection>('api.collection.create', { name: 'move outer' }, ws.id);
      const inner = await run<ApiCollection>('api.collection.create', { name: 'move inner', parentId: outer.id }, ws.id);
      const intoChild = await host.invoke('api.collection.move', { id: outer.id, parentId: inner.id }, { caller: 'ui', workspaceId: ws.id });
      const intoSelf = await host.invoke('api.collection.move', { id: outer.id, parentId: outer.id }, { caller: 'ui', workspaceId: ws.id });
      const unknown = await host.invoke('api.collection.move', { id: inner.id, parentId: 'nope' }, { caller: 'ui', workspaceId: ws.id });
      const toRoot = await host.invoke('api.collection.move', { id: inner.id, parentId: null }, { caller: 'mcp', workspaceId: ws.id });
      const listed = await run<ApiCollection[]>('api.collection.list', {}, ws.id);
      check(
        'api.collection.move: refuses a move into itself or a sub-collection, and an agent may move one to the top level',
        !intoChild.ok && intoChild.error.code === 'INVALID_INPUT' && !intoSelf.ok && !unknown.ok && unknown.error.code === 'NOT_FOUND' && toRoot.ok && listed.find((c) => c.id === inner.id)?.parentId === null,
        { intoChild: intoChild.ok ? 'ok?' : intoChild.error.code, intoSelf: intoSelf.ok ? 'ok?' : intoSelf.error.code, unknown: unknown.ok ? 'ok?' : unknown.error.code, toRoot: toRoot.ok },
      );
      await run('api.collection.delete', { id: outer.id }, ws.id);
      await run('api.collection.delete', { id: inner.id }, ws.id);
    }

    // Collection defaults: a request inherits the base URL, headers and auth of the collections above it; its own settings win.
    {
      const kv = (key: string, value: string) => ({ id: `${key}-${value}`, key, value, enabled: true });
      const outerNew = await run<ApiCollection>('api.collection.create', { name: 'inherit outer' }, ws.id);
      const outerCol = await run<ApiCollection>('api.collection.save', { collection: { ...outerNew, baseUrl: '{{baseUrl}}/', headers: [kv('X-Tenant', 'acme'), kv('X-Outer', '1')], auth: { type: 'bearer', token: 'coll-token-777' } } }, ws.id);
      const innerNew = await run<ApiCollection>('api.collection.create', { name: 'inherit inner', parentId: outerCol.id }, ws.id);
      const innerCol = await run<ApiCollection>('api.collection.save', { collection: { ...innerNew, headers: [kv('x-tenant', 'beta')] } }, ws.id);
      const created = await run<ApiRequest>('api.request.create', { name: 'inherits', url: '/inherit?x=1', collectionId: innerCol.id }, ws.id);
      const child = await run<ApiRequest>('api.request.save', { request: { ...created, headers: [kv('X-Own', 'yes')] } }, ws.id);
      const sent = await run<ApiResponse>('api.request.send', { requestId: child.id }, ws.id);
      const echoed = JSON.parse(sent.body) as { url: string; headers: Record<string, string> };
      check(
        'collections: a request inside gets the nearest base URL, the merged headers (deeper wins) and the inherited bearer',
        created.auth.type === 'inherit' && echoed.url === '/inherit?x=1' && echoed.headers['x-tenant'] === 'beta' && echoed.headers['x-outer'] === '1' && echoed.headers['x-own'] === 'yes' && echoed.headers.authorization === 'Bearer coll-token-777',
        { auth: created.auth.type, url: echoed.url, tenant: echoed.headers['x-tenant'], outer: echoed.headers['x-outer'], authorization: echoed.headers.authorization },
      );
      const overridden = await run<ApiResponse>('api.request.send', { request: { ...child, headers: [kv('X-Tenant', 'mine')], auth: { type: 'basic', username: 'u', password: 'p' } } }, ws.id);
      const overEcho = JSON.parse(overridden.body) as { headers: Record<string, string> };
      check(
        'collections: a request\'s own header and auth win over the inherited ones',
        overEcho.headers['x-tenant'] === 'mine' && overEcho.headers.authorization?.startsWith('Basic ') === true && overEcho.headers['x-outer'] === '1',
        { tenant: overEcho.headers['x-tenant'], authorization: overEcho.headers.authorization },
      );
      const asAgent = await host.invoke('api.request.get', { id: child.id, effective: true }, { caller: 'mcp', workspaceId: ws.id });
      const asUi = await run<ApiRequest & { effective: ApiRequest }>('api.request.get', { id: child.id, effective: true }, ws.id);
      const agentEffective = asAgent.ok ? (asAgent.result as { effective: ApiRequest }).effective : null;
      const agentSend = await host.invoke('api.request.send', { requestId: child.id }, { caller: 'mcp', workspaceId: ws.id });
      const agentSent = agentSend.ok ? JSON.stringify((agentSend.result as ApiResponse).sent) : '';
      check(
        'api.request.get effective: what will be sent, with an inherited token masked for agents; an agent\'s send masks it too',
        asUi.effective.url === '{{baseUrl}}/inherit?x=1' && asUi.effective.auth.type === 'bearer' && (asUi.effective.auth as { token: string }).token === 'coll-token-777' &&
          agentEffective?.auth.type === 'bearer' && (agentEffective.auth as { token: string }).token === REDACTED && agentSend.ok && !agentSent.includes('coll-token-777'),
        { ui: asUi.effective.url, agentToken: agentEffective?.auth.type === 'bearer' ? (agentEffective.auth as { token: string }).token : null },
      );
      const inheritedCurl = await run<{ command: string }>('api.export.curl', { requestId: child.id }, ws.id);
      check(
        'api.export.curl: carries the inherited base URL, headers and auth',
        inheritedCurl.command.includes(`http://127.0.0.1:${echoPort}/inherit?x=1`) && inheritedCurl.command.includes('x-tenant: beta') && inheritedCurl.command.includes('Bearer coll-token-777'),
        inheritedCurl.command.slice(0, 200),
      );
      await fs.writeFile(path.join(folder, '.quiver', 'collections', 'legacycollection.json'), JSON.stringify({ id: 'legacycollection', name: 'legacy collection', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' }, null, 2));
      let legacy: ApiCollection | undefined;
      await until(async () => Boolean((legacy = (await run<ApiCollection[]>('api.collection.list', {}, ws.id)).find((c) => c.id === 'legacycollection'))), 3000);
      check('api.collection.list: a collection saved before collections had defaults reads with them', legacy?.baseUrl === '' && Array.isArray(legacy.headers) && legacy.auth.type === 'inherit', legacy);
      // Let the watcher finish with the hand-written file before removing it, then make sure it stays gone.
      await new Promise((r) => setTimeout(r, 600));
      await run('api.collection.delete', { id: 'legacycollection' }, ws.id);
      const legacyGone = await until(async () => !(await run<ApiCollection[]>('api.collection.list', {}, ws.id)).some((c) => c.id === 'legacycollection'), 3000);
      await new Promise((r) => setTimeout(r, 800));
      const stillGone = !(await run<ApiCollection[]>('api.collection.list', {}, ws.id)).some((c) => c.id === 'legacycollection');
      check('api.collection.delete: a collection written by hand and then deleted stays deleted', legacyGone && stillGone, { legacyGone, stillGone });
    }

    // Captures: a login writes its token, session cookie and user id into the environment; the next request uses them.
    {
      const cap = (variable: string, from: 'body' | 'header' | 'cookie' | 'status', path: string, secret = false) => ({ id: `cap-${variable}`, enabled: true, variable, from, path, secret });
      const loginNew = await run<ApiRequest>('api.request.create', { name: 'capture login', method: 'POST', url: '{{baseUrl}}/auth/login' }, ws.id);
      const login = await run<ApiRequest>('api.request.save', {
        request: {
          ...loginNew,
          // adminToken is not ticked secret, but its name says it is one; capReq is a secret read from a header.
          capture: [cap('capToken', 'body', '$.token', true), cap('capSession', 'cookie', 'session'), cap('capUser', 'body', '$.user.id'), cap('capReq', 'header', 'X-Request-Id', true), cap('capMissing', 'header', 'X-Nope'), cap('adminToken', 'body', '$.user.roles[0]')],
        },
      }, ws.id);
      const loggedIn = await run<ApiResponse>('api.request.send', { requestId: login.id }, ws.id);
      const byName = Object.fromEntries((loggedIn.captured ?? []).map((c) => [c.variable, c]));
      const envAfter = await run<Environment>('api.environment.get', { id: env.id }, ws.id);
      const envDisk = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'environments', `${env.id}.json`), 'utf8')) as Environment;
      const valueOf = (name: string) => envAfter.variables.find((v) => v.key === name);
      check(
        'captures: a send writes what it reads into the active environment, a secret one (ticked, or named like a credential) encrypted, and reports a capture that read nothing',
        byName.capToken?.ok && byName.capToken.value === 'cap-tok-123' && byName.capSession?.value === 'sess-9' && byName.capUser?.value === '7' && byName.capReq?.value === 'req-42' &&
          byName.capMissing?.ok === false && (byName.capMissing.error ?? '').includes('X-Nope') &&
          byName.adminToken?.value === 'admin' && byName.adminToken.secret === true &&
          valueOf('capToken')?.value === 'cap-tok-123' && valueOf('capToken')?.secret === true && valueOf('capSession')?.value === 'sess-9' &&
          valueOf('adminToken')?.value === 'admin' && valueOf('adminToken')?.secret === true &&
          envDisk.variables.find((v) => v.key === 'capToken')?.value === '' && envDisk.variables.find((v) => v.key === 'adminToken')?.value === '' &&
          !JSON.stringify(envDisk).includes('cap-tok-123') && !JSON.stringify(envDisk).includes('"admin"'),
        { captured: loggedIn.captured, onDisk: envDisk.variables.filter((v) => v.key === 'capToken' || v.key === 'adminToken') },
      );
      const capHistory = await fs.readFile(path.join(folder, '.quiver', 'local', 'history.jsonl'), 'utf8');
      check(
        'captures: the response kept in the history has the secret captures scrubbed, from the body and the headers, and the rest as it was',
        !capHistory.includes('cap-tok-123') && !capHistory.includes('[\\"admin\\"]') && !capHistory.includes('req-42') && capHistory.includes('roles'),
        { tokenInHistory: capHistory.includes('cap-tok-123'), roleInHistory: capHistory.includes('[\\"admin\\"]'), headerInHistory: capHistory.includes('req-42'), responseKept: capHistory.includes('roles') },
      );
      const chained =await run<ApiResponse>('api.request.send', { request: { ...saved, id: '', name: 'chained', url: '{{baseUrl}}/me?user={{capUser}}', headers: [], auth: { type: 'bearer', token: '{{capToken}}' } } }, ws.id);
      const chainedEcho = JSON.parse(chained.body) as { url: string; headers: Record<string, string> };
      check('captures: the next request resolves the captured variables', chainedEcho.url === '/me?user=7' && chainedEcho.headers.authorization === 'Bearer cap-tok-123', { url: chainedEcho.url, authorization: chainedEcho.headers.authorization });
      const agentLogin = await host.invoke('api.request.send', { requestId: login.id }, { caller: 'mcp', workspaceId: ws.id });
      const agentResponse = agentLogin.ok ? (agentLogin.result as ApiResponse) : null;
      const agentCaptured = agentResponse?.captured ?? [];
      const agentText = JSON.stringify(agentResponse ?? {});
      const noEnv = await run<ApiResponse>('api.request.send', { request: { ...login, url: `http://127.0.0.1:${echoPort}/auth/login` }, environmentId: null }, ws.id);
      check(
        'captures: an agent sees secret captures masked and scrubbed from the body and headers it gets, and without an environment the captures fail but the send does not',
        agentCaptured.find((c) => c.variable === 'capToken')?.value === REDACTED && agentCaptured.find((c) => c.variable === 'adminToken')?.value === REDACTED && agentCaptured.find((c) => c.variable === 'capUser')?.value === '7' &&
          !agentText.includes('cap-tok-123') && !agentText.includes('req-42') && agentResponse?.body.includes('"id":7') === true && agentResponse.headers.some(([k, v]) => k.toLowerCase() === 'x-request-id' && v === REDACTED) &&
          noEnv.status === 200 && (noEnv.captured ?? []).every((c) => !c.ok && c.value === null) && (noEnv.captured ?? []).filter((c) => (c.error ?? '').includes('No environment')).length === 5,
        { agent: agentCaptured.map((c) => `${c.variable}=${c.value}`), leaked: ['cap-tok-123', 'req-42'].filter((s) => agentText.includes(s)), noEnv: noEnv.captured?.[0]?.error },
      );
      const cleaned = await run<Environment>('api.environment.get', { id: env.id }, ws.id);
      await run('api.environment.save', { environment: { ...cleaned, variables: cleaned.variables.filter((v) => !v.key.startsWith('cap')) } }, ws.id);
    }

    // Files: a multipart upload and a binary body read from disk, re-read on a redirect; agents only inside the project.
    {
      await fs.mkdir(path.join(folder, 'uploads'), { recursive: true });
      await fs.writeFile(path.join(folder, 'uploads', 'hello.txt'), 'hello file');
      const outsideFile = path.join(t.hooksFolder, 'outside-upload.txt');
      await fs.writeFile(outsideFile, 'from outside');
      type Echo = { method: string; url: string; body: string; headers: Record<string, string> };
      const base = { ...saved, id: '', name: 'upload', headers: [], auth: { type: 'none' as const } };
      const multipart = await run<ApiResponse>('api.request.send', {
        request: {
          ...base,
          url: '{{baseUrl}}/upload',
          body: { type: 'form', fields: [{ id: 'f1', key: 'note', value: 'hi', enabled: true }, { id: 'f2', key: 'doc', value: 'uploads/hello.txt', enabled: true, kind: 'file' }, { id: 'f3', key: 'named', value: 'uploads/hello.txt', enabled: true, kind: 'file', fileName: 'greeting.md', contentType: 'text/markdown' }] },
        },
      }, ws.id);
      const mp = JSON.parse(multipart.body) as Echo;
      const boundary = /boundary=(\S+)/.exec(mp.headers['content-type'] ?? '')?.[1] ?? '';
      check(
        'files: a multipart upload sends text fields and files with their file name and type, with its length known',
        boundary.length > 0 && mp.body.includes(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n`) &&
          mp.body.includes('name="doc"; filename="hello.txt"\r\nContent-Type: text/plain\r\n\r\nhello file\r\n') &&
          mp.body.includes('name="named"; filename="greeting.md"\r\nContent-Type: text/markdown\r\n\r\nhello file\r\n') &&
          mp.body.endsWith(`--${boundary}--\r\n`) && mp.headers['content-length'] === String(Buffer.byteLength(mp.body)) && mp.headers['transfer-encoding'] === undefined &&
          (multipart.sent.bodyPreview ?? '').includes('<file hello.txt, 10 bytes>'),
        { contentType: mp.headers['content-type'], length: mp.headers['content-length'], chunked: mp.headers['transfer-encoding'] ?? null, preview: multipart.sent.bodyPreview?.slice(0, 160) },
      );
      const binary = await run<ApiResponse>('api.request.send', { request: { ...base, method: 'PUT', url: '{{baseUrl}}/redirect/307?to=/after', body: { type: 'binary', path: 'uploads/hello.txt' } } }, ws.id);
      const bin = JSON.parse(binary.body) as Echo;
      check(
        'files: a binary body is the file as it is, with a type from its name, and is read again when a 307 repeats the request',
        bin.method === 'PUT' && bin.url === '/after' && bin.body === 'hello file' && bin.headers['content-type'] === 'text/plain' && bin.headers['content-length'] === '10' && binary.redirects.length === 1,
        { method: bin.method, url: bin.url, body: bin.body, type: bin.headers['content-type'], length: bin.headers['content-length'] },
      );
      const uiOutside = await host.invoke('api.request.send', { request: { ...base, method: 'POST', url: '{{baseUrl}}/up', body: { type: 'binary', path: outsideFile } } }, { caller: 'ui', workspaceId: ws.id });
      const agentOutside = await host.invoke('api.request.send', { request: { ...base, method: 'POST', url: '{{baseUrl}}/up', body: { type: 'binary', path: outsideFile } } }, { caller: 'mcp', workspaceId: ws.id });
      const agentClimb = await host.invoke('api.request.send', { request: { ...base, method: 'POST', url: '{{baseUrl}}/up', body: { type: 'form', fields: [{ id: 'f', key: 'f', value: '../outside.txt', enabled: true, kind: 'file' }] } } }, { caller: 'mcp', workspaceId: ws.id });
      const agentInside = await host.invoke('api.request.send', { request: { ...base, method: 'POST', url: '{{baseUrl}}/up', body: { type: 'binary', path: 'uploads/hello.txt' } } }, { caller: 'mcp', workspaceId: ws.id });
      const missing = await host.invoke('api.request.send', { request: { ...base, method: 'POST', url: '{{baseUrl}}/up', body: { type: 'binary', path: 'uploads/nope.bin' } } }, { caller: 'ui', workspaceId: ws.id });
      check(
        'files: the UI may send any file, an agent only one inside the project, and a missing file is refused',
        uiOutside.ok && (JSON.parse((uiOutside.result as ApiResponse).body) as Echo).body === 'from outside' &&
          !agentOutside.ok && agentOutside.error.code === 'INVALID_INPUT' && agentOutside.error.message.includes('inside the project folder') &&
          !agentClimb.ok && agentClimb.error.code === 'INVALID_INPUT' && agentInside.ok &&
          !missing.ok && missing.error.message.includes('does not exist'),
        { agentOutside: agentOutside.ok ? 'ok?' : agentOutside.error.message, agentClimb: agentClimb.ok ? 'ok?' : agentClimb.error.code, agentInside: agentInside.ok, missing: missing.ok ? 'ok?' : missing.error.message },
      );
      const uploadReq = await run<ApiRequest>('api.request.create', { name: 'file upload', method: 'POST', url: '{{baseUrl}}/upload' }, ws.id);
      await run('api.request.save', {
        request: { ...uploadReq, body: { type: 'form', fields: [{ id: 'u1', key: 'doc', value: 'uploads/hello.txt', enabled: true, kind: 'file', contentType: 'text/plain' }, { id: 'u2', key: 'note', value: 'hi', enabled: true }] } },
      }, ws.id);
      const uploadCurl = await run<{ command: string }>('api.export.curl', { requestId: uploadReq.id }, ws.id);
      const reimported = await run<ApiRequest>('api.import.curl', { command: uploadCurl.command }, ws.id);
      const binaryReq = await run<ApiRequest>('api.request.create', { name: 'file body', method: 'PUT', url: '{{baseUrl}}/put' }, ws.id);
      await run('api.request.save', { request: { ...binaryReq, body: { type: 'binary', path: 'uploads/hello.txt' } } }, ws.id);
      const binaryCurl = await run<{ command: string }>('api.export.curl', { requestId: binaryReq.id }, ws.id);
      const binaryBack = await run<ApiRequest>('api.import.curl', { command: binaryCurl.command }, ws.id);
      const fields = reimported.body.type === 'form' ? reimported.body.fields : [];
      check(
        'files: curl export writes -F name=@file, --form-string for text and --data-binary @file, and importing it gives the same body back',
        uploadCurl.command.includes("-F 'doc=@uploads/hello.txt;type=text/plain'") && uploadCurl.command.includes("--form-string 'note=hi'") &&
          fields[0]?.kind === 'file' && fields[0].value === 'uploads/hello.txt' && fields[0].contentType === 'text/plain' && fields[1]?.value === 'hi' &&
          binaryCurl.command.includes("--data-binary '@uploads/hello.txt'") && binaryBack.body.type === 'binary' && binaryBack.method === 'PUT',
        { uploadCurl: uploadCurl.command, binaryCurl: binaryCurl.command, reimported: reimported.body },
      );
      await run('api.request.delete', { id: reimported.id }, ws.id);
      await run('api.request.delete', { id: binaryBack.id }, ws.id);
    }

    // OAuth 2.0: client credentials fetched once and reused, a sign-in with PKCE in a (hidden) window, a refresh, all masked.
    {
      const oauth = t.fixtures.fakeOAuth;
      const cc = { type: 'oauth2' as const, grant: 'client_credentials' as const, tokenUrl: `${oauth.url}/token`, clientId: 'quiver', clientSecret: 'cc-secret', scopes: 'read', clientAuth: 'basic' as const, pkce: false };
      const ccReqNew = await run<ApiRequest>('api.request.create', { name: 'oauth cc', url: '{{baseUrl}}/oauth' }, ws.id);
      const ccReq = await run<ApiRequest>('api.request.save', { request: { ...ccReqNew, auth: cc } }, ws.id);
      const first = JSON.parse((await run<ApiResponse>('api.request.send', { requestId: ccReq.id }, ws.id)).body) as { headers: Record<string, string> };
      const second = JSON.parse((await run<ApiResponse>('api.request.send', { requestId: ccReq.id }, ws.id)).body) as { headers: Record<string, string> };
      const ccToken = (first.headers.authorization ?? '').replace(/^Bearer /, '');
      const tokensFile = await fs.readFile(path.join(folder, '.quiver', 'local', 'oauth-tokens.json'), 'utf8');
      const historyText = await fs.readFile(path.join(folder, '.quiver', 'local', 'history.jsonl'), 'utf8');
      const agentCc = await host.invoke('api.request.send', { requestId: ccReq.id }, { caller: 'mcp', workspaceId: ws.id });
      const agentSent = agentCc.ok ? JSON.stringify((agentCc.result as ApiResponse).sent) : '';
      check(
        'oauth: client credentials get a token once, reuse it, keep it encrypted, and keep it and the client secret out of the history and away from agents',
        ccToken.startsWith('cc-') && second.headers.authorization === first.headers.authorization && oauth.seen.clientCredentials === 1 && oauth.seen.lastClientAuth === 'basic' &&
          !tokensFile.includes(ccToken) && !historyText.includes(ccToken) && !historyText.includes('cc-secret') && agentCc.ok && !agentSent.includes(ccToken),
        { ccToken, calls: oauth.seen.clientCredentials, inFile: tokensFile.includes(ccToken), inHistory: historyText.includes(ccToken) || historyText.includes('cc-secret') },
      );
      const bodyAuth = await run<{ source: string; token: string }>('api.oauth2.token', { auth: { ...cc, clientAuth: 'body', scopes: 'read write' } }, ws.id);
      const bodyClientAuth = oauth.seen.lastClientAuth;
      const ccCurl = await run<{ command: string }>('api.export.curl', { requestId: ccReq.id }, ws.id);
      const wrong = await host.invoke('api.request.send', { request: { ...ccReq, auth: { ...cc, clientSecret: 'nope', scopes: 'other' } } }, { caller: 'ui', workspaceId: ws.id });
      check(
        'oauth: the client can authenticate in the body, curl export carries the token, and a refused client says why',
        bodyAuth.source === 'new' && bodyAuth.token.startsWith('cc-') && bodyClientAuth === 'body' && ccCurl.command.includes(`Bearer ${ccToken}`) &&
          !wrong.ok && wrong.error.message.includes('invalid_client'),
        { bodyAuth: bodyAuth.source, lastClientAuth: bodyClientAuth, wrong: wrong.ok ? 'ok?' : wrong.error.message },
      );

      const ac = { type: 'oauth2' as const, grant: 'authorization_code' as const, tokenUrl: `${oauth.url}/token`, authUrl: `${oauth.url}/authorize`, clientId: 'web', clientSecret: '', scopes: 'profile', clientAuth: 'basic' as const, pkce: true };
      const agentBefore = await host.invoke('api.oauth2.token', { auth: ac }, { caller: 'mcp', workspaceId: ws.id });
      const signedIn = await run<{ source: string; token: string; refreshable: boolean }>('api.oauth2.token', { auth: ac }, ws.id);
      const agentAfter = await host.invoke('api.oauth2.token', { auth: ac }, { caller: 'mcp', workspaceId: ws.id });
      check(
        'oauth: a sign-in in the Quiver window (PKCE) gets a token for the UI; an agent gets SIGN_IN_REQUIRED before it and the cached token, masked, after',
        !agentBefore.ok && agentBefore.error.code === 'SIGN_IN_REQUIRED' && signedIn.source === 'new' && signedIn.token.startsWith('ac-') && signedIn.refreshable && oauth.seen.pkceOk === true && oauth.seen.authorize === 1 &&
          agentAfter.ok && (agentAfter.result as { source: string; token: string }).source === 'cache' && (agentAfter.result as { token: string }).token === REDACTED,
        { agentBefore: agentBefore.ok ? 'ok?' : agentBefore.error.code, signedIn, pkce: oauth.seen.pkceOk, agentAfter: agentAfter.ok ? agentAfter.result : agentAfter.error.code },
      );
      oauth.state.expiresIn = 10;
      const shortLived = await run<{ source: string }>('api.oauth2.token', { auth: ac, force: true }, ws.id);
      const refreshed = await host.invoke('api.oauth2.token', { auth: ac }, { caller: 'mcp', workspaceId: ws.id });
      oauth.state.expiresIn = 3600;
      const status = await run<{ hasToken: boolean; refreshable: boolean }>('api.oauth2.status', { auth: ac }, ws.id);
      await run('api.oauth2.clear', { auth: ac }, ws.id);
      const cleared = await run<{ hasToken: boolean }>('api.oauth2.status', { auth: ac }, ws.id);
      check(
        'oauth: a token near its expiry is refreshed with the refresh token, also for an agent, and Forget clears it',
        shortLived.source === 'new' && refreshed.ok && (refreshed.result as { source: string }).source === 'refresh' && oauth.seen.refreshes === 1 && status.hasToken && status.refreshable && !cleared.hasToken,
        { shortLived: shortLived.source, refreshed: refreshed.ok ? refreshed.result : refreshed.error.message, status, cleared },
      );

      const oauthCol = await run<ApiCollection>('api.collection.create', { name: 'oauth collection' }, ws.id);
      await run('api.collection.save', { collection: { ...oauthCol, auth: cc } }, ws.id);
      const inheritsNew = await run<ApiRequest>('api.request.create', { name: 'oauth inherits', url: '{{baseUrl}}/oauth-inherit', collectionId: oauthCol.id }, ws.id);
      const inheritsEcho = JSON.parse((await run<ApiResponse>('api.request.send', { requestId: inheritsNew.id }, ws.id)).body) as { headers: Record<string, string> };
      check('oauth: a request inheriting OAuth 2.0 from its collection shares the cached token', inheritsEcho.headers.authorization === `Bearer ${ccToken}` && oauth.seen.clientCredentials === 2, inheritsEcho.headers.authorization);
      await run('api.collection.delete', { id: oauthCol.id }, ws.id);
    }

    // The cookie jar: cookies responses set are kept and sent to the requests they match, redirect hops included.
    {
      await run('api.cookie.clear', {}, ws.id);
      const setUrl = (cookies: string[], to?: string) => `{{baseUrl}}/setcookie?${cookies.map((c) => `c=${encodeURIComponent(c)}`).join('&')}${to ? `&to=${encodeURIComponent(to)}` : ''}`;
      const base = { ...saved, id: '', name: 'jar', method: 'GET' as const, headers: [], auth: { type: 'none' as const }, body: { type: 'none' as const } };
      const send = (url: string, extra: object = {}) => run<ApiResponse>('api.request.send', { request: { ...base, url, ...extra } }, ws.id);
      const cookieSent = async (url: string, extra: object = {}) => (JSON.parse((await send(url, extra)).body) as { headers: Record<string, string> }).headers.cookie ?? null;
      const login = await send(setUrl(['jsid=j1; Path=/', 'scoped=s1; Path=/admin', 'far=f; Domain=elsewhere.test']));
      const atMe = await cookieSent('{{baseUrl}}/me');
      const atAdmin = await cookieSent('{{baseUrl}}/admin/x');
      const own = await cookieSent('{{baseUrl}}/me', { headers: [{ id: 'c', key: 'Cookie', value: 'jsid=mine', enabled: true }] });
      check(
        'cookie jar: a response\'s cookies are kept (a foreign Domain refused) and sent where host and path match, longest path first, a request\'s own Cookie winning',
        JSON.stringify(login.cookieJar?.stored) === '["jsid","scoped"]' && login.cookieJar?.rejected[0]?.name === 'far' && atMe === 'jsid=j1' && atAdmin === 'scoped=s1; jsid=j1' && own === 'jsid=mine',
        { jar: login.cookieJar, atMe, atAdmin, own },
      );
      const hop = await send(setUrl(['hop=h1; Path=/'], '/after'));
      const hopEcho = JSON.parse(hop.body) as { url: string; headers: Record<string, string> };
      const logout = await send(setUrl(['jsid=; Max-Age=0; Path=/']));
      const afterLogout = await cookieSent('{{baseUrl}}/me');
      check(
        'cookie jar: a redirect hop\'s cookie is kept and sent on the next hop, and Max-Age=0 deletes a cookie',
        hopEcho.url === '/after' && (hopEcho.headers.cookie ?? '').includes('hop=h1') && hop.cookieJar?.stored.includes('hop') === true &&
          logout.cookieJar?.deleted.includes('jsid') === true && afterLogout === 'hop=h1',
        { hopCookie: hopEcho.headers.cookie, logout: logout.cookieJar, afterLogout },
      );
      // Two sends in flight together: each one's cookies are added to the other's, not written over.
      const [parA, parB] = await Promise.all([send(setUrl(['par-a=a1; Path=/'])), send(setUrl(['par-b=b1; Path=/']))]);
      const afterBoth = await run<JarCookie[]>('api.cookie.list', {}, ws.id);
      check(
        'cookie jar: two sends finishing together both keep their cookies',
        parA.cookieJar?.stored.includes('par-a') === true && parB.cookieJar?.stored.includes('par-b') === true && afterBoth.some((c) => c.name === 'par-a') && afterBoth.some((c) => c.name === 'par-b'),
        { names: afterBoth.map((c) => c.name) },
      );
      const off = await send(setUrl(['off=1; Path=/']), { options: { cookies: false } });
      const offSent = await cookieSent('{{baseUrl}}/me', { options: { cookies: false } });
      const listed = await run<JarCookie[]>('api.cookie.list', {}, ws.id);
      check(
        'cookie jar: a request with the jar off sends none and keeps none',
        off.cookieJar === undefined && offSent === null && !listed.some((c) => c.name === 'off'),
        { offSent, names: listed.map((c) => c.name) },
      );
      const agentList = await host.invoke('api.cookie.list', {}, { caller: 'mcp', workspaceId: ws.id });
      const agentSend = await host.invoke('api.request.send', { request: { ...base, url: '{{baseUrl}}/me' } }, { caller: 'mcp', workspaceId: ws.id });
      const agentCookieHeader = agentSend.ok ? (agentSend.result as ApiResponse).sent.headers.find(([k]) => k.toLowerCase() === 'cookie')?.[1] : null;
      const agentDelete = await host.invoke('api.cookie.delete', { domain: '127.0.0.1', path: '/', name: 'hop' }, { caller: 'mcp', workspaceId: ws.id });
      await run('api.cookie.set', { url: `http://127.0.0.1:${echoPort}/`, cookie: 'manual=manual-value-1; Path=/' }, ws.id);
      const jarFile = await fs.readFile(path.join(folder, '.quiver', 'local', 'cookies.json'), 'utf8');
      await run('api.cookie.delete', { domain: '127.0.0.1', path: '/', name: 'hop' }, ws.id);
      const afterDelete = await run<JarCookie[]>('api.cookie.list', {}, ws.id);
      check(
        'cookie jar: agents see values masked and cannot delete, cookies can be set by hand, and the jar is an encrypted local file',
        agentList.ok && (agentList.result as JarCookie[]).every((c) => c.value === REDACTED) && (agentList.result as JarCookie[]).length >= 2 &&
          agentCookieHeader === REDACTED && !agentDelete.ok && agentDelete.error.code === 'MUTATION_BLOCKED' &&
          jarFile.includes('"cipher"') && !jarFile.includes('manual-value-1') && !jarFile.includes('"manual"') &&
          afterDelete.some((c) => c.name === 'manual' && c.value === 'manual-value-1') && !afterDelete.some((c) => c.name === 'hop'),
        { agentList: agentList.ok ? (agentList.result as JarCookie[]).map((c) => `${c.name}=${c.value}`) : agentList.error.code, agentCookieHeader, agentDelete: agentDelete.ok ? 'ok?' : agentDelete.error.code },
      );
      // A Domain nobody owns outright, or a Secure cookie over plain http, is refused as a browser would; a site's own domain under a suffix is fine.
      const setCookie = (url: string, cookie: string) => host.invoke('api.cookie.set', { url, cookie }, { caller: 'ui', workspaceId: ws.id });
      const platformWide = await setCookie('https://one.herokuapp.com/', 'all=1; Domain=herokuapp.com; Path=/');
      const suffixWide = await setCookie('https://evil.co.uk/', 'wide=1; Domain=co.uk; Path=/');
      const secureOverHttp = await setCookie('http://plain.test/', 's=1; Secure; Path=/');
      const ownUnderSuffix = await setCookie('https://x.app.co.uk/', 'own=1; Domain=app.co.uk; Path=/');
      const afterSuffix = await run<JarCookie[]>('api.cookie.list', {}, ws.id);
      await run('api.cookie.delete', { domain: 'app.co.uk', path: '/', name: 'own' }, ws.id);
      check(
        'cookie jar: a Domain that is a hosting platform or a public suffix is refused, a Secure cookie over http too, and a site\'s own domain under a suffix is kept',
        !platformWide.ok && platformWide.error.code === 'INVALID_INPUT' && platformWide.error.message.includes('too broad') &&
          !suffixWide.ok && suffixWide.error.message.includes('too broad') &&
          !secureOverHttp.ok && secureOverHttp.error.message.includes('Secure cookie set over http') &&
          ownUnderSuffix.ok && afterSuffix.some((c) => c.name === 'own' && c.domain === 'app.co.uk' && !c.hostOnly) && !afterSuffix.some((c) => c.name === 'all' || c.name === 'wide' || c.name === 's'),
        { platformWide: platformWide.ok ? 'ok?' : platformWide.error.message, suffixWide: suffixWide.ok ? 'ok?' : suffixWide.error.message, secureOverHttp: secureOverHttp.ok ? 'ok?' : secureOverHttp.error.message, own: afterSuffix.find((c) => c.name === 'own') },
      );
    }

    // Import formats: each sample, written into the project with the echo server's origin, imported by path, its tree checked and sent.
    {
      const samples = path.join(process.cwd(), 'src', 'main', 'smoke', 'samples');
      const origin = `http://127.0.0.1:${echoPort}`;
      await fs.mkdir(path.join(folder, 'imports'), { recursive: true });
      for (const name of ['openapi.yaml', 'postman.json', 'insomnia.json', 'recording.har']) {
        const text = (await fs.readFile(path.join(samples, name), 'utf8')).replaceAll('__ECHO__', origin);
        await fs.writeFile(path.join(folder, 'imports', name), text);
      }
      type Summary = { collectionId: string | null; name: string | null; requests: number; collections: number; environments: number; environmentIds: string[]; skipped: string[] };
      type Echo = { method: string; url: string; headers: Record<string, string>; body: string };
      const allCollections = () => run<ApiCollection[]>('api.collection.list', {}, ws.id);
      const allRequests = () => run<ApiRequest[]>('api.request.list', {}, ws.id);
      /** The requests under a collection, at any depth, by name. */
      const under = async (rootId: string) => {
        const cols = await allCollections();
        const ids = new Set([rootId]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const c of cols) if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) grew = ids.add(c.id).size > 0;
        }
        return { collections: cols.filter((c) => ids.has(c.id)), requests: (await allRequests()).filter((r) => r.collectionId && ids.has(r.collectionId)) };
      };
      const sendEcho = async (request: ApiRequest, environmentId?: string | null) => {
        const response = await run<ApiResponse>('api.request.send', { requestId: request.id, ...(environmentId !== undefined ? { environmentId } : {}) }, ws.id);
        return { status: response.status, echo: JSON.parse(response.body) as Echo };
      };

      // OpenAPI: tags as collections, the server as the root's base URL, the bearer scheme as root auth, a body from the schema.
      const oa = await run<Summary>('api.import.openapi', { source: { path: 'imports/openapi.yaml' } }, ws.id);
      const oaTree = await under(oa.collectionId!);
      const oaRoot = oaTree.collections.find((c) => c.id === oa.collectionId)!;
      const create = oaTree.requests.find((r) => r.name === 'Create item')!;
      const sentCreate = create ? await sendEcho(create) : null;
      const getItem = oaTree.requests.find((r) => r.name === 'Get item');
      check(
        'api.import.openapi: tags become collections, the server the base URL, the scheme the auth, and a request built from the schema is sent with them',
        oa.requests === 3 &&
          oa.collections === 3 &&
          oaRoot.name === 'Smoke Shop' &&
          oaRoot.baseUrl === `${origin}/v1` &&
          oaRoot.auth.type === 'bearer' &&
          oaTree.collections.map((c) => c.name).sort().join() === 'Smoke Shop,health,items' &&
          getItem?.url === '/items/{{itemId}}' &&
          getItem.params[0]?.key === 'verbose' &&
          sentCreate?.status === 200 &&
          sentCreate.echo.method === 'POST' &&
          sentCreate.echo.url === '/v1/items' &&
          /^Bearer [^{]+$/.test(sentCreate.echo.headers.authorization ?? '') &&
          JSON.parse(sentCreate.echo.body).name === 'Widget',
        { oa, root: { baseUrl: oaRoot.baseUrl, auth: oaRoot.auth.type }, cols: oaTree.collections.map((c) => c.name), sent: sentCreate?.echo },
      );

      // Postman: folders, {{baseUrl}} kept (the active environment has it), collection variables as an environment, scripts reported.
      const pm = await run<Summary>('api.import.postman', { source: { text: await fs.readFile(path.join(folder, 'imports', 'postman.json'), 'utf8') } }, ws.id);
      const pmTree = await under(pm.collectionId!);
      const list = pmTree.requests.find((r) => r.name === 'List orders')!;
      const sentList = list ? await sendEcho(list) : null;
      const pmEnv = pm.environmentIds[0] ? await run<Environment>('api.environment.get', { id: pm.environmentIds[0] }, ws.id) : null;
      check(
        'api.import.postman: folders and requests, variables kept and resolved, collection variables as an environment, the test script reported',
        pm.requests === 3 &&
          pmTree.collections.map((c) => c.name).sort().join() === 'Orders,Smoke Postman' &&
          pmTree.requests.find((r) => r.name === 'Get order')?.url === '{{baseUrl}}/pm/orders/{{orderId}}' &&
          sentList?.echo.url === '/pm/orders?page=1' &&
          sentList.echo.headers['x-source'] === 'postman' &&
          pmEnv?.name === 'Smoke Postman variables' &&
          pmEnv.variables.some((v) => v.key === 'orderId' && v.value === '7') &&
          pm.skipped.some((s) => s.includes('test script on List orders')),
        { pm, sent: sentList?.echo, env: pmEnv?.variables },
      );
      // A credential typed into the file becomes a {{variable}} with its value a secret in the imported environment: no committed file holds it.
      const pmSecret = await run<Summary>('api.import.postman', {
        source: {
          text: JSON.stringify({
            info: { name: 'Smoke Postman secret', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
            auth: { type: 'bearer', bearer: [{ key: 'token', value: 'pm-literal-token-1' }] },
            item: [
              {
                name: 'Secret call',
                request: {
                  method: 'POST',
                  url: '{{baseUrl}}/pm/secret?api_key=pm-literal-key-4',
                  header: [{ key: 'X-Api-Key', value: 'pm-literal-key-2' }],
                  body: { mode: 'raw', raw: '{"password":"pm-literal-pw-3"}', options: { raw: { language: 'json' } } },
                },
              },
            ],
          }),
        },
      }, ws.id);
      const pmSecretCol = await run<ApiCollection>('api.collection.get', { id: pmSecret.collectionId! }, ws.id);
      const pmSecretReq = (await under(pmSecret.collectionId!)).requests[0];
      const pmSecretEnv = await run<Environment>('api.environment.get', { id: pmSecret.environmentIds[0] }, ws.id);
      const pmSecretFiles = (
        await Promise.all([
          fs.readFile(path.join(folder, '.quiver', 'collections', `${pmSecret.collectionId}.json`), 'utf8'),
          fs.readFile(path.join(folder, '.quiver', 'requests', `${pmSecretReq?.id}.json`), 'utf8'),
          fs.readFile(path.join(folder, '.quiver', 'environments', `${pmSecret.environmentIds[0]}.json`), 'utf8'),
        ])
      ).join('\n');
      const pmSecretVar = (key: string, value: string) => pmSecretEnv.variables.some((v) => v.key === key && v.value === value && v.secret === true);
      check(
        'api.import.postman: a credential typed into an auth, a header, a query parameter or a JSON body becomes a {{variable}} whose value is a secret in the imported environment, and no saved file holds it',
        pmSecretCol.auth.type === 'bearer' && pmSecretCol.auth.token === '{{token}}' &&
          pmSecretReq?.headers[0]?.value === '{{x-api-key}}' && pmSecretReq.params[0]?.value === '{{api_key}}' && (pmSecretReq.body as { content?: string }).content?.includes('"password": "{{password}}"') === true &&
          pmSecretVar('token', 'pm-literal-token-1') && pmSecretVar('x-api-key', 'pm-literal-key-2') && pmSecretVar('api_key', 'pm-literal-key-4') && pmSecretVar('password', 'pm-literal-pw-3') &&
          !pmSecretFiles.includes('pm-literal') && pmSecret.skipped.some((s) => s.includes('token credential')) && pmSecret.skipped.some((s) => s.includes('X-Api-Key credential on Secret call')),
        { auth: pmSecretCol.auth, request: [pmSecretReq?.headers, pmSecretReq?.params, pmSecretReq?.body], env: pmSecretEnv.variables, skipped: pmSecret.skipped },
      );

      // Insomnia: {{ _.host }} templates as {{host}}, the sub-environment with the base merged in, and the request sent with it.
      const ins = await run<Summary>('api.import.insomnia', { source: { path: path.join(folder, 'imports', 'insomnia.json') } }, ws.id);
      const ping = (await under(ins.collectionId!)).requests.find((r) => r.name === 'Ping');
      const sentPing = ping ? await sendEcho(ping, ins.environmentIds[0]) : null;
      check(
        'api.import.insomnia: the workspace, its folder and request, and the environment it needs, sent with it',
        ins.requests === 1 && ins.environments === 1 && ping?.url === '{{host}}/ins/ping' && sentPing?.echo.url === '/ins/ping?q=1' && sentPing.echo.headers['x-env'] === 'dev',
        { ins, url: ping?.url, sent: sentPing?.echo },
      );

      // HAR: only the API calls to the host asked for, cookies dropped, the bearer replaced by a variable, nothing secret written down.
      const har = await run<Summary>('api.import.har', { source: { path: 'imports/recording.har' }, host: `127.0.0.1:${echoPort}` }, ws.id);
      const harTree = await under(har.collectionId!);
      const data = harTree.requests.find((r) => r.name === 'GET /har/data');
      const harFiles = await Promise.all(harTree.requests.map((r) => fs.readFile(path.join(folder, '.quiver', 'requests', `${r.id}.json`), 'utf8')));
      const unresolved = data ? await host.invoke('api.request.send', { requestId: data.id }, { caller: 'ui', workspaceId: ws.id }) : null;
      const save = harTree.requests.find((r) => r.name === 'POST /har/save');
      const sentSave = save ? await sendEcho(save) : null;
      check(
        'api.import.har: the two API calls to the echo host, the Cookie header dropped and the bearer a {{variable}} the send asks for, the rest sent as recorded',
        har.requests === 2 &&
          harTree.collections.length === 1 &&
          data?.headers.map((h) => `${h.key}: ${h.value}`).join('|') === 'Authorization: Bearer {{authorization}}|Accept: application/json' &&
          harFiles.every((f) => !f.includes('har-secret-token-123') && !f.includes('har-session-cookie')) &&
          unresolved?.ok === false &&
          unresolved.error.code === 'UNRESOLVED_VARIABLES' &&
          sentSave?.echo.body === '{"note":"hi"}' &&
          har.skipped.some((s) => s.includes('2 page loads')) &&
          har.skipped.some((s) => s.includes('1 request to other hosts')),
        { har, headers: data?.headers, unresolved: unresolved && !unresolved.ok ? unresolved.error.code : null },
      );

      // A broken file is refused and nothing is saved; agents may only import files inside the project.
      const before = { collections: (await allCollections()).length, requests: (await allRequests()).length };
      await fs.writeFile(path.join(folder, 'imports', 'broken.yaml'), 'openapi: 3.0.0\npaths:\n  /a: [unclosed\n');
      const broken = await host.invoke('api.import.openapi', { source: { path: 'imports/broken.yaml' } }, { caller: 'ui', workspaceId: ws.id });
      const wrongKind = await host.invoke('api.import.postman', { source: { path: 'imports/openapi.yaml' } }, { caller: 'ui', workspaceId: ws.id });
      const outside = path.join(os.tmpdir(), `quiver-smoke-import-${Date.now()}.json`);
      await fs.writeFile(path.join(outside), await fs.readFile(path.join(folder, 'imports', 'postman.json'), 'utf8'));
      const agentOutside = await host.invoke('api.import.postman', { source: { path: outside } }, { caller: 'mcp', workspaceId: ws.id });
      const agentInside = await host.invoke('api.import.postman', { source: { path: 'imports/postman.json' }, name: 'Agent import' }, { caller: 'mcp', workspaceId: ws.id });
      await fs.rm(outside, { force: true });
      const after = { collections: (await allCollections()).length, requests: (await allRequests()).length };
      check(
        'imports: a broken file and a file of another kind are refused with nothing saved; agents import from inside the project only',
        broken.ok === false &&
          broken.error.code === 'INVALID_INPUT' &&
          wrongKind.ok === false &&
          /not a Postman collection/.test(wrongKind.error.message) &&
          agentOutside.ok === false &&
          /inside the project folder/.test(agentOutside.error.message) &&
          agentInside.ok === true &&
          (agentInside.result as Summary).name === 'Agent import' &&
          after.collections === before.collections + 2 &&
          after.requests === before.requests + 3,
        { broken: broken.ok ? 'ok' : broken.error.message, wrongKind: wrongKind.ok ? 'ok' : wrongKind.error.message, agentOutside: agentOutside.ok ? 'ok' : agentOutside.error.message, before, after },
      );
      const agentSummary = agentInside.ok ? (agentInside.result as Summary) : null;
      for (const summary of [oa, pm, ins, har, agentSummary]) {
        if (!summary) continue;
        if (summary.collectionId) await run('api.collection.delete', { id: summary.collectionId }, ws.id);
        for (const id of summary.environmentIds) await run('api.environment.delete', { id }, ws.id);
      }
    }

    /** A request created, then saved with fields api.request.create does not take. */
    const createWith = async (base: Record<string, unknown>, extra: Partial<ApiRequest>) => {
      const created = await run<ApiRequest>('api.request.create', base, ws.id);
      return run<ApiRequest>('api.request.save', { request: { ...created, ...extra } }, ws.id);
    };

    // Checks: assertions on the status, a JSON path, a header, the time and the size, run on every send and counted in the history.
    {
      const origin = `http://127.0.0.1:${echoPort}`;
      const check6 = (on: string, path: string, op: string, expected: string) => ({ id: `${on}-${op}-${path}`, enabled: true, on, path, op, expected });
      const checked = await createWith(
        { name: 'checks probe', method: 'POST', url: `${origin}/checks?x=1`, body: { type: 'json', content: '{"n":1}' } },
        {
          checks: [
            check6('status', '', 'eq', '200'),
            check6('jsonPath', '$.method', 'eq', 'POST'),
            check6('header', 'content-type', 'contains', 'json'),
            check6('time', '', 'lt', '10000'),
            check6('size', '', 'gt', '0'),
            check6('jsonPath', '$.url', 'eq', '/nope'),
            // A pattern that would backtrack for ever on a body that does not match is refused rather than run.
            check6('body', '', 'matches', '^(a+)+$'),
            { ...check6('status', '', 'eq', '500'), id: 'off', enabled: false },
          ] as ApiRequest['checks'],
        },
      );
      const checkedResponse = await run<ApiResponse>('api.request.send', { requestId: checked.id }, ws.id);
      const checkedEntry = (await run<HistoryEntry[]>('api.history.list', { limit: 1 }, ws.id))[0];
      const agentChecked = await host.invoke('api.request.send', { requestId: checked.id }, { caller: 'mcp', workspaceId: ws.id });
      const results = checkedResponse.checks ?? [];
      check(
        'checks: each enabled check runs on the response with what it read, the failing one says why, a runaway regex is refused, and the history counts them',
        results.length === 7 &&
          results.filter((r) => r.ok).length === 5 &&
          results.find((r) => r.id.startsWith('jsonPath-eq-$.url'))?.message === 'Expected $.url to equal /nope, got "/checks?x=1"' &&
          results.find((r) => r.id === 'body-matches-')?.message.includes('repeats inside') === true &&
          checkedEntry?.checks?.passed === 5 &&
          checkedEntry.checks.total === 7 &&
          agentChecked.ok &&
          ((agentChecked.result as ApiResponse).checks ?? []).length === 7,
        { results: results.map((r) => `${r.ok ? 'ok' : 'FAIL'} ${r.message}`), entry: checkedEntry?.checks },
      );
      await run('api.request.delete', { id: checked.id }, ws.id);
    }

    // Collection runs: requests in their set order, a capture from the second used by the third, stop at the first failure, cancel.
    {
      const origin = `http://127.0.0.1:${echoPort}`;
      const statusCheck = (expected: string): ApiRequest['checks'] => [{ id: 'st', enabled: true, on: 'status', path: '', op: 'eq', expected }];
      const flow = await run<ApiCollection>('api.collection.create', { name: 'run flow' }, ws.id);
      const mk = (name: string, url: string, extra: Partial<ApiRequest> = {}) => createWith({ name, method: 'GET', url, collectionId: flow.id }, extra);
      // Names sort the other way round, so only the set order puts them right.
      const first = await mk('c first', `${origin}/run/one`, { checks: statusCheck('200') });
      const login = await mk('b login', `${origin}/run/login?token=t-123`, { capture: [{ id: 'cap', enabled: true, variable: 'runToken', from: 'body', path: '$.url', secret: false }] });
      const use = await mk('a use', `${origin}/run/use`, {
        headers: [{ id: 'h', key: 'X-Run-Token', value: '{{runToken}}', enabled: true }],
        checks: [{ id: 'tok', enabled: true, on: 'jsonPath', path: "$.headers['x-run-token']", op: 'contains', expected: 't-123' }],
      });
      const badOrder = await host.invoke('api.collection.reorder', { collectionId: flow.id, requestIds: [first.id, 'nope'] }, { caller: 'ui', workspaceId: ws.id });
      await run('api.collection.reorder', { collectionId: flow.id, requestIds: [first.id, login.id, use.id] }, ws.id);
      const historyBefore = (await run<HistoryEntry[]>('api.history.list', { limit: 500 }, ws.id)).length;
      const finish = async (runId: string) => {
        let got: ApiRun | null = null;
        await until(async () => (got = await run<ApiRun>('api.run.get', { runId }, ws.id)).status !== 'running', 15000);
        return got as unknown as ApiRun;
      };
      const started = await run<{ runId: string; requests: number }>('api.collection.run', { collectionId: flow.id, environmentId: env.id }, ws.id);
      const done = await finish(started.runId);
      const historyAfter = (await run<HistoryEntry[]>('api.history.list', { limit: 500 }, ws.id)).length;
      const listed = await run<ApiRun[]>('api.run.list', { collectionId: flow.id }, ws.id);
      const runsFile = await fs.readFile(path.join(folder, '.quiver', 'local', 'runs.jsonl'), 'utf8').catch(() => '');
      check(
        'api.collection.run: the requests go in their set order, the second captures a token the third sends and checks (the secret scrubbed from the kept check), and the run is kept',
        badOrder.ok === false &&
          started.requests === 3 &&
          done.status === 'passed' &&
          done.items.map((i) => i.name).join() === 'c first,b login,a use' &&
          done.items.every((i) => i.status === 'passed' && i.httpStatus === 200) &&
          done.items[1].captured?.join() === 'runToken' &&
          done.items[2].checks?.[0]?.ok === true &&
          done.items[2].checks[0].actual === REDACTED &&
          done.items[2].checks[0].message.includes(REDACTED) &&
          done.passed === 3 &&
          done.failed === 0 &&
          historyAfter - historyBefore === 3 &&
          listed[0]?.id === started.runId &&
          runsFile.includes(started.runId) &&
          !runsFile.includes('t-123'),
        { done: done.items.map((i) => `${i.name}:${i.status}:${i.httpStatus}:${i.error ?? ''}`), captured: done.items[1].captured, check: done.items[2].checks?.[0], tokenInRuns: runsFile.includes('t-123'), historyAdded: historyAfter - historyBefore, badOrder: badOrder.ok },
      );

      // Stop at the first failure: the first check fails, the rest are skipped.
      await run('api.request.save', { request: { ...first, order: 0, checks: statusCheck('201') } }, ws.id);
      const stopped = await finish((await run<{ runId: string }>('api.collection.run', { collectionId: flow.id, environmentId: env.id, stopOnFail: true }, ws.id)).runId);
      check(
        'api.collection.run with stopOnFail: a failing check fails the request and the rest are skipped',
        stopped.status === 'failed' && stopped.items.map((i) => i.status).join() === 'failed,skipped,skipped' && stopped.failed === 1 && Boolean(stopped.items[0].checks?.[0]?.message.includes('Expected Status to equal 201')),
        stopped.items.map((i) => `${i.name}:${i.status}`),
      );

      // Cancel: the request in flight stops and the rest are not sent; an agent may start and stop runs too.
      await run('api.request.save', { request: { ...first, order: 0, url: `${origin}/slow?ms=4000`, checks: undefined } }, ws.id);
      const agentStart = await host.invoke('api.collection.run', { collectionId: flow.id, environmentId: env.id }, { caller: 'mcp', workspaceId: ws.id });
      const slowRunId = agentStart.ok ? (agentStart.result as { runId: string }).runId : '';
      await until(async () => (await run<ApiRun>('api.run.get', { runId: slowRunId }, ws.id)).items[0]?.status === 'running', 3000);
      const cancelled = await host.invoke('api.run.cancel', { runId: slowRunId }, { caller: 'mcp', workspaceId: ws.id });
      const afterCancel = await finish(slowRunId);
      check(
        'api.run.cancel: a running run stops, the request in flight and the rest marked cancelled',
        agentStart.ok && cancelled.ok && (cancelled.result as { cancelled: boolean }).cancelled === true && afterCancel.status === 'cancelled' && afterCancel.items.every((i) => i.status === 'cancelled'),
        { status: afterCancel.status, items: afterCancel.items.map((i) => i.status) },
      );
      await run('api.collection.delete', { id: flow.id }, ws.id);
      const tokenEnv = await run<Environment>('api.environment.get', { id: env.id }, ws.id);
      await run('api.environment.save', { environment: { ...tokenEnv, variables: tokenEnv.variables.filter((v) => v.key !== 'runToken') } }, ws.id);
    }

    // Streamed responses: an event stream streams on its own, NDJSON when asked; items in order, paging with since, stop.
    {
      const { ssePort } = t.fixtures;
      type StreamResponse = ApiResponse & { streamId?: string; streamKind?: string };
      /** An unsaved request, sent inline. */
      const inline = (url: string, extra: Partial<ApiRequest> = {}): ApiRequest => ({ id: '', name: 'stream', method: 'GET', url, params: [], headers: [], body: { type: 'none' }, auth: { type: 'none' }, collectionId: null, createdAt: '', updatedAt: '', ...extra });
      const readAll = async (streamId: string) => {
        let read: StreamRead = { items: [], next: 0, done: false, dropped: 0, error: null, bytes: 0 };
        await until(async () => (read = await run<StreamRead>('api.request.stream.read', { streamId }, ws.id)).done, 5000);
        return read;
      };
      const sseResponse = await run<StreamResponse>('api.request.send', { request: inline(`http://127.0.0.1:${ssePort}/`) }, ws.id);
      const sseRead = sseResponse.streamId ? await readAll(sseResponse.streamId) : null;
      const paged = sseResponse.streamId ? await run<StreamRead>('api.request.stream.read', { streamId: sseResponse.streamId, since: 1 }, ws.id) : null;
      check(
        'streams: an event stream returns its head at once and its events are read in order, with since paging on',
        sseResponse.status === 200 &&
          sseResponse.streamKind === 'sse' &&
          sseResponse.body === '' &&
          sseRead?.done === true &&
          sseRead.error === null &&
          sseRead.items.map((i) => `${i.event}:${i.data}:${i.id}`).join('|') === 'tick:{"n":1}:1|message:line one\nline two:2' &&
          paged?.items.length === 1 &&
          paged.items[0].seq === 1 &&
          paged.next === 2,
        { kind: sseResponse.streamKind, items: sseRead?.items, paged: paged?.items.map((i) => i.seq) },
      );

      const ndRequest = inline(`http://127.0.0.1:${echoPort}/ndjson?n=4&ms=40`);
      const whole = await run<StreamResponse>('api.request.send', { request: ndRequest }, ws.id);
      const nd = await run<StreamResponse>('api.request.send', { request: ndRequest, stream: true }, ws.id);
      const ndRead = nd.streamId ? await readAll(nd.streamId) : null;
      check(
        'streams: an NDJSON body is one response unless the send asks to stream it, then one item per line',
        !whole.streamId &&
          whole.body.trim().split('\n').length === 4 &&
          nd.streamKind === 'lines' &&
          ndRead?.items.map((i) => i.data).join('|') === '{"n":1}|{"n":2}|{"n":3}|{"n":4}' &&
          ndRead.items.every((item, i) => i === 0 || item.at >= ndRead!.items[i - 1].at),
        { wholeStream: whole.streamId ?? null, items: ndRead?.items.map((i) => i.data) },
      );

      // Stop: the never-ending /echo stream closes, and an agent reading it gets the same items.
      const open = await run<StreamResponse>('api.request.send', { request: inline(`http://127.0.0.1:${ssePort}/echo`, { method: 'POST', body: { type: 'text', content: 'hello stream' } }) }, ws.id);
      await until(async () => (await run<StreamRead>('api.request.stream.read', { streamId: open.streamId! }, ws.id)).items.length === 1, 3000);
      const stopped = await run<{ stopped: boolean }>('api.request.stream.stop', { streamId: open.streamId! }, ws.id);
      const afterStop = await readAll(open.streamId!);
      const agentRead = await host.invoke('api.request.stream.read', { streamId: open.streamId! }, { caller: 'mcp', workspaceId: ws.id });
      check(
        'api.request.stream.stop: an open stream closes, what arrived stays readable, and agents read it too',
        stopped.stopped === true && afterStop.done && afterStop.error === 'Stopped' && afterStop.items[0]?.data === 'hello stream' && agentRead.ok && (agentRead.result as StreamRead).items.length === 1,
        { stopped, error: afterStop.error, items: afterStop.items.map((i) => i.data) },
      );

      // Limits: a body whose line never ends (256 KB chunks of x) closes the stream with an error, and past 20 open streams the oldest is closed.
      const endlessLine = await run<StreamResponse>('api.request.send', { request: inline(`http://127.0.0.1:${echoPort}/big?chunks=6&ms=5`), stream: true }, ws.id);
      let tooLong = null as StreamRead | null;
      await until(async () => (tooLong = await run<StreamRead>('api.request.stream.read', { streamId: endlessLine.streamId! }, ws.id)).done, 5000);
      const opened: string[] = [];
      for (let i = 0; i < 21; i++) {
        const one = await run<StreamResponse>('api.request.send', { request: inline(`http://127.0.0.1:${ssePort}/echo`, { method: 'POST', body: { type: 'text', content: `open ${i}` } }) }, ws.id);
        opened.push(one.streamId!);
      }
      let oldest = null as StreamRead | null;
      await until(async () => (oldest = await run<StreamRead>('api.request.stream.read', { streamId: opened[0] }, ws.id)).done, 5000);
      const newest = await run<StreamRead>('api.request.stream.read', { streamId: opened[20] }, ws.id);
      for (const id of opened.slice(1)) await run('api.request.stream.stop', { streamId: id }, ws.id);
      check(
        'streams: a line that never ends closes the stream with an error, and past 20 open streams the oldest is closed',
        tooLong?.done === true && /more than 1 MB/.test(tooLong.error ?? '') && tooLong.items.length === 0 && oldest?.done === true && /more than 20 streams/.test(oldest.error ?? '') && !newest.done,
        { tooLong: tooLong?.error, oldest: oldest?.error, newest: newest.done },
      );
    }

    // Response history: small responses kept with their entry, Set-Cookie values masked in the file, the setting turning it off.
    {
      const origin = `http://127.0.0.1:${echoPort}`;
      const probe = await run<ApiRequest>('api.request.create', { name: 'diff probe', method: 'GET', url: `${origin}/diff?v=1` }, ws.id);
      await run('api.request.send', { requestId: probe.id }, ws.id);
      await run('api.request.save', { request: { ...probe, url: `${origin}/diff?v=2` } }, ws.id);
      await run('api.request.send', { requestId: probe.id }, ws.id);
      const withBodies = await run<HistoryEntry[]>('api.history.list', { requestId: probe.id, withResponses: true }, ws.id);
      const listed = await run<HistoryEntry[]>('api.history.list', { requestId: probe.id }, ws.id);
      const one = await run<HistoryEntry>('api.history.get', { id: listed[0].id }, ws.id);
      await run('api.request.send', { request: { ...probe, id: '', url: `${origin}/cookies` } }, ws.id);
      const historyFile = await fs.readFile(path.join(folder, '.quiver', 'local', 'history.jsonl'), 'utf8');
      const cookieLine = historyFile.split('\n').filter((l) => l.includes('/cookies')).pop() ?? '';
      await run('workspace.state.set', { key: 'api.history.keepResponses', value: false }, ws.id);
      await run('api.request.send', { requestId: probe.id }, ws.id);
      const notKept = (await run<HistoryEntry[]>('api.history.list', { requestId: probe.id, withResponses: true }, ws.id))[0];
      await run('workspace.state.set', { key: 'api.history.keepResponses', value: true }, ws.id);
      check(
        'history: responses are kept with their entry, left out of a plain listing, masked where they set cookies, and not kept when turned off',
        withBodies.length === 2 &&
          JSON.parse(withBodies[0].response?.body ?? '{}').url === '/diff?v=2' &&
          JSON.parse(withBodies[1].response?.body ?? '{}').url === '/diff?v=1' &&
          withBodies[0].response?.status === 200 &&
          listed.every((e) => e.hasResponse && !e.response) &&
          one.response?.body === withBodies[0].response?.body &&
          cookieLine.includes(`sid=${REDACTED}`) &&
          !cookieLine.includes('abc123') &&
          notKept !== undefined &&
          !notKept.response,
        { kept: withBodies.map((e) => e.response?.body.slice(0, 40)), cookie: cookieLine.slice(cookieLine.toLowerCase().indexOf('set-cookie'), cookieLine.toLowerCase().indexOf('set-cookie') + 120), cookieLineLength: cookieLine.length, notKept: Boolean(notKept?.response) },
      );
    }

    // Network: a client certificate for the mutual-TLS server (PEM and PKCS#12), and the proxy with its bypass list.
    {
      const { mtlsPort, proxyPort, proxySeen } = t.fixtures.fakeNetwork;
      const certs = path.join(process.cwd(), 'src', 'main', 'smoke', 'certs');
      const plain = (url: string): ApiRequest => ({ id: '', name: 'net', method: 'GET', url, params: [], headers: [], body: { type: 'none' }, auth: { type: 'none' }, collectionId: null, createdAt: '', updatedAt: '' });
      const mtlsUrl = `https://127.0.0.1:${mtlsPort}/whoami`;
      // The server's certificate is from the smoke CA: accept it here, so the missing client certificate is what is refused.
      const without = await host.invoke('api.request.send', { request: plain(mtlsUrl), options: { insecure: true } }, { caller: 'ui', workspaceId: ws.id });
      const pem = await run<{ id: string }>('api.certificate.save', { certificate: { hostPattern: '127.0.0.1', certPath: path.join(certs, 'client.crt'), keyPath: path.join(certs, 'client.key'), caPath: path.join(certs, 'ca.crt') } }, ws.id);
      const withPem = await run<ApiResponse>('api.request.send', { request: plain(mtlsUrl) }, ws.id);
      await run('api.certificate.save', { certificate: { id: pem.id, hostPattern: `127.0.0.1:${mtlsPort}`, pfxPath: path.join(certs, 'client.p12'), caPath: path.join(certs, 'ca.crt'), passphrase: 'smoke-pass' } }, ws.id);
      const withPfx = await run<ApiResponse>('api.request.send', { request: plain(mtlsUrl) }, ws.id);
      const listedForUi = await run<{ pfxPath: string; hasPassphrase: boolean }[]>('api.certificate.list', {}, ws.id);
      const listedForAgent = await host.invoke('api.certificate.list', {}, { caller: 'mcp', workspaceId: ws.id });
      const certFile = await fs.readFile(path.join(folder, '.quiver', 'local', 'certificates.json'), 'utf8');
      const agentSave = await host.invoke('api.certificate.save', { certificate: { hostPattern: 'x.test', pfxPath: 'a.p12' } }, { caller: 'mcp', workspaceId: ws.id });
      check(
        'certificates: a server asking for a client certificate refuses a request without one and accepts the PEM pair and the PKCS#12 file with its passphrase',
        without.ok === true &&
          (without.result as ApiResponse).status === 401 &&
          withPem.status === 200 &&
          JSON.parse(withPem.body).client === 'quiver-smoke-client' &&
          withPfx.status === 200 &&
          listedForUi[0]?.pfxPath.endsWith('client.p12') &&
          listedForUi[0].hasPassphrase &&
          listedForAgent.ok &&
          (listedForAgent.result as { pfxPath: string }[])[0]?.pfxPath === 'client.p12' &&
          !JSON.stringify(listedForAgent.result).includes('passphrase"') &&
          !certFile.includes('smoke-pass') &&
          agentSave.ok === false,
        { without: without.ok ? (without.result as ApiResponse).status : without.error.message, pem: withPem.status, pfx: withPfx.status, agent: listedForAgent.ok ? listedForAgent.result : null },
      );
      await run('api.certificate.delete', { id: pem.id }, ws.id);

      // The proxy: undici tunnels every request with CONNECT (https with the certificate again), with the proxy credentials; the bypass list goes direct.
      const before = proxySeen.length;
      await run('api.network.save', { proxy: 'manual', url: `http://127.0.0.1:${proxyPort}`, noProxy: [], username: 'smoke', password: 'proxy-pass' }, null);
      const viaProxy = await run<ApiResponse>('api.request.send', { request: plain(`http://127.0.0.1:${echoPort}/through?x=1`) }, ws.id);
      // The token request of an OAuth 2.0 auth goes the same way as the request it is for.
      const oauthHost = new URL(t.fixtures.fakeOAuth.url).host;
      const tokenViaProxy = await run<{ source: string }>(
        'api.oauth2.token',
        { auth: { type: 'oauth2', grant: 'client_credentials', tokenUrl: `${t.fixtures.fakeOAuth.url}/token`, clientId: 'quiver', clientSecret: 'cc-secret', scopes: 'proxied', clientAuth: 'basic', pkce: false }, force: true },
        ws.id,
      );
      const pem2 = await run<{ id: string }>('api.certificate.save', { certificate: { hostPattern: '127.0.0.1', certPath: path.join(certs, 'client.crt'), keyPath: path.join(certs, 'client.key'), caPath: path.join(certs, 'ca.crt') } }, ws.id);
      const tunnelled = await run<ApiResponse>('api.request.send', { request: plain(mtlsUrl) }, ws.id);
      await run('api.certificate.delete', { id: pem2.id }, ws.id);
      const seenThrough = proxySeen.slice(before);
      await run('api.network.save', { proxy: 'manual', url: `http://127.0.0.1:${proxyPort}`, noProxy: ['127.0.0.1'], username: 'smoke' }, null);
      const bypassed = await run<ApiResponse>('api.request.send', { request: plain(`http://127.0.0.1:${echoPort}/direct`) }, ws.id);
      const seenAfterBypass = proxySeen.length - before;
      const shown = await run<{ hasPassword: boolean; passwordCipher?: string }>('api.network.get', {}, null);
      const agentNet = await host.invoke('api.network.save', { proxy: 'none' }, { caller: 'mcp' });
      await run('api.network.save', { proxy: 'none', url: '', noProxy: ['localhost', '127.0.0.1', '::1'], username: '', password: '' }, null);
      check(
        'proxy: a manual proxy carries http and https requests and OAuth 2.0 token requests with its credentials, the bypass list goes direct, the password stays hidden, agents may not change it',
        viaProxy.status === 200 &&
          tokenViaProxy.source === 'new' &&
          seenThrough.some((p) => p.method === 'CONNECT' && p.target === oauthHost) &&
          seenThrough.some((p) => p.method === 'CONNECT' && p.target === `127.0.0.1:${echoPort}` && p.auth === `Basic ${Buffer.from('smoke:proxy-pass').toString('base64')}`) &&
          tunnelled.status === 200 &&
          seenThrough.some((p) => p.method === 'CONNECT' && p.target === `127.0.0.1:${mtlsPort}`) &&
          bypassed.status === 200 &&
          seenAfterBypass === seenThrough.length &&
          shown.hasPassword === true &&
          shown.passwordCipher === undefined &&
          agentNet.ok === false,
        { seen: seenThrough, via: viaProxy.status, tunnelled: tunnelled.status, bypassed: bypassed.status, agent: agentNet.ok },
      );
    }

    return {
      ui: async (u) => {
        const { win, js, wait, shot } = u;
        await js(`document.querySelector('[data-testid=activity-item][data-drag-id=api]').click()`);
        // The request opens in the dark theme, as the welcome screen before it.
        await js(`document.documentElement.classList.add('dark')`);
        const clickedRow = await js(
          `(() => { const row = [...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('echo')); if (row) row.click(); return Boolean(row); })()`,
        );
        check('ui: request row clickable', clickedRow === true);
        await wait(800);
        const clickedSend = await js(
          `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send'); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: send button present', clickedSend === true);
        await wait(1500);
        const status = await js(`(() => { const el = [...document.querySelectorAll('span')].find((s) => /^200 /.test(s.textContent)); return el ? el.textContent : null; })()`);
        check('ui: response rendered', typeof status === 'string' && status.startsWith('200'), status);
        await shot('02-request-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(300);
        await shot('03-request-light');
        // The sidebar's history follows each send without leaving the module.
        {
          const historyTitles = () => js(`[...document.querySelectorAll('[data-testid=api-history-entry]')].map((b) => b.title)`) as Promise<string[]>;
          if (!(await historyTitles()).length) await js(`[...document.querySelectorAll('aside button')].find((b) => b.textContent.trim() === 'History')?.click()`);
          await wait(300);
          const before = await historyTitles();
          await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send')?.click()`);
          await wait(1500);
          const after = await historyTitles();
          check('ui: a send shows up in the history right away', before.length > 0 && after.length > 0 && after[0] !== before[0] && after.slice(1).includes(before[0]), { before: before.slice(0, 2), after: after.slice(0, 2) });
          const ages = (await js(`[...document.querySelectorAll('[data-testid=api-history-age]')].map((s) => s.textContent.trim())`)) as string[];
          check('ui: history rows say how long ago they were sent', ages.length > 0 && /^(now|\d+[smhd])$/.test(ages[0]), ages.slice(0, 3));
        }

        // The request tab's own controls, found among the visible ones (other tabs stay in the page).
        const visible = (selector: string) => `[...document.querySelectorAll('${selector}')].find((e) => e.offsetParent !== null)`;
        const saveButtonLabel = () => js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.title === 'Ctrl+S')?.textContent.trim() ?? null`);

        // Settings: the options in effect, only overrides kept, a badge on the segment, Reset all puts the request back.
        {
          await js(`${visible('[data-testid=api-section-settings]')}?.click()`);
          await wait(300);
          const placeholder = await js(`${visible('[data-testid=api-option-timeout]')}?.placeholder ?? null`);
          await js(`(() => { const i = ${visible('[data-testid=api-option-timeout]')}; i.value = '120'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await wait(300);
          const segment = await js(`${visible('[data-testid=api-section-settings]')}?.textContent.trim() ?? null`);
          const dirtyLabel = await saveButtonLabel();
          await shot('03i-request-settings-light');
          await js(`${visible('[data-testid=api-options-reset]')}?.click()`);
          await wait(300);
          const cleanLabel = await saveButtonLabel();
          check(
            'ui: the Settings segment shows the default timeout, marks an override and resets to an unmodified request',
            placeholder === '30' && segment === 'Settings1' && dirtyLabel === 'Save*' && cleanLabel === 'Save',
            { placeholder, segment, dirtyLabel, cleanLabel },
          );
          await js(`${visible('[data-testid=api-section-notes]')}?.click()`);
          await wait(300);
          const docsEditor = await js(`Boolean(${visible('.cm-placeholder')}?.textContent.includes('Agents read this too'))`);
          check('ui: the Notes segment edits the request description', docsEditor === true);
          await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim().startsWith('Params'))?.click()`);
          await wait(200);
        }

        // The environment picker beside Send switches the workspace's active environment, as the sidebar tick does.
        {
          const staging = await run<Environment>('api.environment.create', { name: 'staging' }, ws.id);
          await wait(600);
          const pick = (id: string) => js(`(() => { const s = ${visible('[data-testid=api-env-picker]')}; s.value = '${id}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          const options = await js(`[...${visible('[data-testid=api-env-picker]')}.options].map((o) => o.textContent.trim())`);
          await pick(staging.id);
          await wait(500);
          const switched = await run<{ id: string | null }>('api.environment.active', {}, ws.id);
          await shot('03j-environment-picker-light');
          await pick(env.id);
          await wait(500);
          const back = await run<{ id: string | null }>('api.environment.active', {}, ws.id);
          const shown = await js(`${visible('[data-testid=api-env-picker]')}.selectedOptions[0]?.textContent.trim()`);
          check(
            'ui: the environment picker lists the environments and switches the active one',
            Array.isArray(options) && options.includes('No environment') && options.includes('staging') && options.includes('local') && switched.id === staging.id && back.id === env.id && shown === 'local',
            { options, switched, back, shown },
          );
          await run('api.environment.delete', { id: staging.id }, ws.id);
          await wait(300);
        }

        // Stop: a slow send turns Send into Stop, which cancels it; the history marks it STOP.
        {
          await run('api.request.create', { name: 'stop probe', method: 'GET', url: '{{baseUrl}}/slow?ms=5000' }, ws.id);
          await wait(600);
          await js(`[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('stop probe'))?.click()`);
          await wait(800);
          await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === 'Send')?.click()`);
          await wait(400);
          const stopShown = await js(`Boolean(${visible('[data-testid=api-stop]')})`);
          await shot('03k-request-stop-light');
          await js(`${visible('[data-testid=api-stop]')}?.click()`);
          await wait(800);
          const sendBack = await js(`[...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && b.textContent.trim() === 'Send')`);
          const cancelledShown = await js(`document.body.innerText.includes('Cancelled')`);
          const firstStatus = await js(`document.querySelector('[data-testid=api-history-entry]')?.textContent ?? ''`);
          check(
            'ui: Stop cancels a running send and the history marks it',
            stopShown === true && sendBack === true && cancelledShown === true && String(firstStatus).includes('STOP'),
            { stopShown, sendBack, cancelledShown, firstStatus },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          const probeRow = (await run<ApiRequest[]>('api.request.list', {}, ws.id)).find((r) => r.name === 'stop probe');
          if (probeRow) await run('api.request.delete', { id: probeRow.id }, ws.id);
          await js(`[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('echo'))?.click()`);
          await wait(600);
        }

        // The response pane: the redirect chain, the cookies a response set, image previews, a JSON path filter and Find.
        {
          const probe = await run<ApiRequest>('api.request.create', { name: 'pane probe', method: 'GET', url: '{{baseUrl}}/redirect/302?to=/landing' }, ws.id);
          const point = async (url: string) => {
            const current = await run<ApiRequest>('api.request.get', { id: probe.id }, ws.id);
            await run('api.request.save', { request: { ...current, url } }, ws.id);
            await wait(700);
          };
          const sendNow = async () => {
            await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === 'Send')?.click()`);
            await wait(1200);
          };
          await wait(600);
          await js(`[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('pane probe'))?.click()`);
          await wait(800);
          await sendNow();
          const chip = await js(`${visible('[data-testid=api-response-redirects]')}?.textContent.trim() ?? null`);
          const bar = await js(`${visible('[data-testid=api-response-timing]')}?.title ?? null`);
          await js(`${visible('[data-testid=api-response-redirects]')}?.click()`);
          await wait(300);
          await js(`${visible('[data-testid=api-response-redirect-list] details')}?.setAttribute('open', '')`);
          await wait(200);
          const hopText = await js(`${visible('[data-testid=api-response-redirect-list] summary')}?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
          await shot('03l-response-redirects-light');
          check(
            'ui: the response says how many redirects were followed, and the headers view lists each hop',
            chip === '1 redirect' && typeof bar === 'string' && bar.includes('Redirects') && bar.includes('Download') && typeof hopText === 'string' && hopText.includes('302') && hopText.includes('/landing'),
            { chip, bar, hopText },
          );

          await point('{{baseUrl}}/cookies');
          await sendNow();
          await js(`${visible('[data-testid=api-response-cookies-tab]')}?.click()`);
          await wait(300);
          const cookieRows = (await js(`[...(${visible('[data-testid=api-response-cookies]')}?.querySelectorAll('tbody tr') ?? [])].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`)) as string[];
          await shot('03m-response-cookies-light');
          check(
            'ui: the Cookies view lists each cookie with its attributes',
            cookieRows.length === 2 && cookieRows[0].includes('sid') && cookieRows[0].includes('Session') && cookieRows[0].includes('HttpOnly') && cookieRows[1].includes('theme') && cookieRows[1].includes('Secure'),
            cookieRows,
          );

          await point('{{baseUrl}}/image.png');
          await sendNow();
          await js(`${visible('[data-testid=api-response-body-tab]')}?.click()`);
          await wait(400);
          const imageShown = await js(`(() => { const img = ${visible('[data-testid=api-response-image]')}; return img ? img.complete && img.naturalWidth === 1 : false; })()`);
          await shot('03n-response-image-light');
          await js(`${visible('[data-testid=api-response-preview-toggle]')}?.click()`);
          await wait(300);
          const rawShown = await js(`Boolean(${visible('.cm-content')}?.textContent.includes('Binary response'))`);
          check('ui: an image response is previewed, and Raw shows the bytes instead', imageShown === true && rawShown === true, { imageShown, rawShown });

          await point('{{baseUrl}}/things?x=1');
          await sendNow();
          const setFilter = (value: string) => js(`(() => { const i = ${visible('[data-testid=api-response-filter]')}; if (!i) return false; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
          await setFilter('$.url');
          await wait(300);
          const filtered = await js(`${visible('.cm-content')}?.textContent ?? ''`);
          const count = await js(`${visible('[data-testid=api-response-filter-count]')}?.textContent.trim() ?? null`);
          await setFilter('$.headers[');
          await wait(300);
          const filterError = await js(`${visible('[data-testid=api-response-filter-error]')}?.textContent ?? null`);
          await setFilter('');
          await wait(200);
          check(
            'ui: a JSON path filters the body, counts the matches and says what is wrong with a broken path',
            filtered === '"/things?x=1"' && count === '1 match' && typeof filterError === 'string' && filterError.includes('Missing "]"'),
            { filtered, count, filterError },
          );
          await js(`${visible('[data-testid=api-response-search]')}?.click()`);
          await wait(300);
          const searchPanel = await js(`Boolean(${visible('.cm-search')})`);
          check('ui: Find opens a search panel over the response body', searchPanel === true);
          await shot('03o-response-find-light');

          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          await run('api.request.delete', { id: probe.id }, ws.id);
          await js(`[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('echo'))?.click()`);
          await wait(600);
        }

        // The tree: drag a request into a collection and back out, the row menu (Move to…, Rename…), the filter, the history tab.
        {
          const target = await run<ApiCollection>('api.collection.create', { name: 'drop target' }, ws.id);
          const dragged = await run<ApiRequest>('api.request.create', { name: 'drag me', url: '{{baseUrl}}/drag' }, ws.id);
          await wait(900);
          const centre = (selector: string) =>
            js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`) as Promise<{ x: number; y: number } | null>;
          const dragTo = async (fromSel: string, toSel: string, shotName?: string) => {
            const from = await centre(fromSel);
            const to = await centre(toSel);
            if (!from || !to) return `missing ${JSON.stringify({ from, to })}`;
            win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
            await wait(120);
            win.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
            for (let step = 1; step <= 8; step++) {
              win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + ((to.x - from.x) * step) / 8), y: Math.round(from.y + ((to.y - from.y) * step) / 8), button: 'left', modifiers: ['leftbuttondown'] });
              await wait(30);
            }
            await wait(150);
            const label = await js(
              `document.querySelector('[data-testid=api-drag-label]')?.textContent.replace(/\\s+/g, ' ').trim() ?? ('no drag; under the start: ' + (document.elementFromPoint(${from.x}, ${from.y})?.outerHTML.slice(0, 200) ?? '-') + ' ' + ${JSON.stringify(JSON.stringify({ from, to }))})`,
            );
            if (shotName) await shot(shotName);
            win.webContents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
            await wait(900);
            return label;
          };
          const collectionOf = async () => (await run<ApiRequest>('api.request.get', { id: dragged.id }, ws.id)).collectionId;
          const rowSel = '[data-testid=api-request-row][data-name="drag me"]';
          const targetSel = '[data-testid=api-collection][data-name="drop target"] [role=button]';
          const intoLabel = await dragTo(rowSel, targetSel, '03p-tree-drag-light');
          const afterInto = await collectionOf();
          const outLabel = await dragTo(rowSel, '[data-testid=api-tree-root] [data-testid=section-header], [data-testid=api-tree-root] > *:first-child');
          const afterOut = await collectionOf();
          check(
            'ui: dragging a request onto a collection moves it there, and onto the top level moves it back',
            typeof intoLabel === 'string' && intoLabel.includes('drag me') && intoLabel.includes('drop target') && afterInto === target.id && typeof outLabel === 'string' && outLabel.includes('top level') && afterOut === null,
            { intoLabel, afterInto, outLabel, afterOut },
          );
          // A drag released over the item's own collection moves it nowhere: the nearest target decides, never the level around it.
          await dragTo(rowSel, targetSel);
          const ownLabel = await dragTo(rowSel, targetSel);
          const afterOwn = await collectionOf();
          check('ui: a drag released over the request\'s own collection leaves it there', afterOwn === target.id && typeof ownLabel === 'string' && !ownLabel.includes('top level'), { ownLabel, afterOwn });

          // A tab with unsaved edits saves them over the request as it is now: a move made meanwhile stays.
          await js(`document.querySelector(${JSON.stringify(rowSel)})?.click()`);
          await wait(800);
          await js(`${visible('[data-testid=api-section-settings]')}?.click()`);
          await wait(250);
          await js(`(() => { const i = ${visible('[data-testid=api-option-timeout]')}; i.value = '120'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await wait(300);
          const dirtyBefore = await saveButtonLabel();
          await run('api.request.move', { id: dragged.id, collectionId: null }, ws.id);
          await wait(500);
          await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.title === 'Ctrl+S')?.click()`);
          await wait(800);
          const savedDragged = await run<ApiRequest>('api.request.get', { id: dragged.id }, ws.id);
          check(
            'ui: saving a tab with unsaved edits keeps the edits and a move made meanwhile',
            dirtyBefore === 'Save*' && savedDragged.collectionId === null && savedDragged.options?.timeoutMs === 120_000,
            { dirtyBefore, collectionId: savedDragged.collectionId, options: savedDragged.options },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);

          const openMenu = (selector: string) =>
            js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 })); return true; })()`);
          const menuItems = () => js(`[...document.querySelectorAll('[data-testid=context-menu] button')].map((b) => (b.disabled ? '(x) ' : '') + b.textContent.trim())`) as Promise<string[]>;
          await openMenu(rowSel);
          await wait(250);
          const requestItems = await menuItems();
          await shot('03q-tree-menu-light');
          await js(`document.querySelector('[data-testid=api-menu-move]')?.click()`);
          await wait(500);
          const moveItems = await menuItems();
          await js(`document.querySelector('[data-testid=api-move-${target.id}]')?.click()`);
          await wait(800);
          const afterMenuMove = await collectionOf();
          check(
            'ui: the request menu offers the row actions, and Move to… lists the top level (here, disabled) and the collections',
            ['Open', 'Rename…', 'Duplicate', 'Copy as curl', 'Move to…', 'Delete'].every((l) => requestItems.includes(l)) && moveItems.includes('(x) Top level') && moveItems.includes('drop target') && afterMenuMove === target.id,
            { requestItems, moveItems, afterMenuMove },
          );
          await openMenu(rowSel);
          await wait(250);
          await js(`document.querySelector('[data-testid=api-menu-rename]')?.click()`);
          await wait(300);
          await js(`(() => { const i = document.querySelector('div.fixed form input'); if (!i) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'dragged and renamed'); i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('div.fixed form button[type=submit]')?.click(); })()`);
          await wait(800);
          const renamed = (await run<ApiRequest>('api.request.get', { id: dragged.id }, ws.id)).name;
          const collectionMenuItems = await (async () => {
            await js(`document.querySelector('[data-testid=api-collection][data-name="drop target"] [data-testid=api-collection-menu]')?.click()`);
            await wait(250);
            const items = await menuItems();
            await js(`document.querySelector('[data-testid=context-menu]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
            await wait(150);
            return items;
          })();
          check(
            'ui: Rename… from the menu renames the request, and the collection menu offers its actions',
            renamed === 'dragged and renamed' && ['New request', 'New GraphQL request', 'New sub-collection…', 'Import here…', 'Rename…', 'Move to…', 'Delete'].every((l) => collectionMenuItems.includes(l)),
            { renamed, collectionMenuItems },
          );

          const typeFilter = (value: string) =>
            js(`(() => { const i = document.querySelector('[data-testid=api-filter]'); i.value = ${JSON.stringify('VALUE')}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`.replace(JSON.stringify('VALUE'), JSON.stringify(value)));
          const visibleRows = () => js(`[...document.querySelectorAll('[data-testid=api-request-row]')].map((r) => r.getAttribute('data-name'))`) as Promise<string[]>;
          await typeFilter('renamed');
          await wait(300);
          const filteredRows = await visibleRows();
          const targetOpen = await js(`document.querySelector('[data-testid=api-collection][data-name="drop target"]')?.getAttribute('data-open') ?? null`);
          await shot('03r-tree-filter-light');
          await typeFilter('no-such-request-xyz');
          await wait(300);
          const emptyShown = await js(`Boolean(document.querySelector('[data-testid=api-filter-empty]'))`);
          await typeFilter('things');
          await wait(300);
          const historyFiltered = (await js(`[...document.querySelectorAll('[data-testid=api-history-entry]')].map((b) => b.title)`)) as string[];
          check(
            'ui: the filter keeps matching requests and opens their collections, says when nothing matches, and narrows the history',
            filteredRows.length === 1 && filteredRows[0] === 'dragged and renamed' && targetOpen === 'true' && emptyShown === true && historyFiltered.length > 0 && historyFiltered.every((t) => t.includes('things')),
            { filteredRows, targetOpen, emptyShown, historyFiltered: historyFiltered.length },
          );

          await js(`document.querySelector('[data-testid=api-history-show-all]')?.click()`);
          await wait(900);
          await typeFilter('');
          await wait(200);
          const historyRows = () => js(`[...document.querySelectorAll('[data-testid=api-history-row]')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`) as Promise<string[]>;
          const allRows = await historyRows();
          await js(`(() => { const s = document.querySelector('[data-testid=api-history-status]'); s.value = 'cancelled'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await wait(300);
          const cancelledRows = await historyRows();
          await shot('03s-history-tab-light');
          await js(`(() => { const s = document.querySelector('[data-testid=api-history-status]'); s.value = 'all'; s.dispatchEvent(new Event('change', { bubbles: true })); const i = document.querySelector('[data-testid=api-history-search]'); i.value = 'image.png'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
          await wait(300);
          const imageRows = await historyRows();
          const before = (await run<ApiRequest[]>('api.request.list', {}, ws.id)).length;
          await js(`document.querySelector('[data-testid=api-history-save-row]')?.click()`);
          await wait(900);
          const afterList = await run<ApiRequest[]>('api.request.list', {}, ws.id);
          const kept = afterList.find((r) => r.url.includes('/image.png'));
          check(
            'ui: the history tab lists every send, filters by status and search, and saves an entry as a request',
            allRows.length > 20 && cancelledRows.length > 0 && cancelledRows.every((r) => r.includes('STOP')) && imageRows.length > 0 && imageRows.every((r) => r.includes('image.png')) && afterList.length === before + 1 && kept?.collectionId === null,
            { all: allRows.length, cancelled: cancelledRows.length, image: imageRows.length, saved: kept?.name ?? null },
          );
          if (kept) await run('api.request.delete', { id: kept.id }, ws.id);
          await js(`(() => { for (const tab of document.querySelectorAll('[data-testid=tab]')) if (!/^echo/.test(tab.getAttribute('data-title') ?? '')) tab.querySelector('[aria-label="Close tab"]')?.click(); })()`);
          await wait(300);
          await run('api.collection.delete', { id: target.id }, ws.id);
          await js(`[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('echo'))?.click()`);
          await wait(600);
        }

        // Collections: the settings tab, and a request inside showing what it inherits.
        {
          const outerCol = (await run<ApiCollection[]>('api.collection.list', {}, ws.id)).find((c) => c.name === 'inherit outer');
          await js(`document.querySelector('[data-testid=api-collection][data-name="inherit outer"] [data-testid=api-collection-settings]')?.click()`);
          await wait(900);
          const collectionName = await js(`${visible('[data-testid=api-collection-name]')}?.value ?? null`);
          const collectionAuth = await js(`${visible('[data-testid=api-auth-type]')}?.value ?? null`);
          const baseUrlShown = await js(`${visible('[data-testid=api-collection-base-url]')}?.textContent ?? ''`);
          await shot('03t-collection-tab-light');
          check(
            'ui: the collection tab shows its name, base URL and auth',
            collectionName === 'inherit outer' && collectionAuth === 'bearer' && String(baseUrlShown).includes('{{baseUrl}}'),
            { collectionName, collectionAuth, baseUrlShown },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          await js(`[...document.querySelectorAll('[data-testid=api-request-row]')].find((r) => r.getAttribute('data-name') === 'inherits')?.click()`);
          await wait(900);
          await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim().startsWith('Headers'))?.click()`);
          await wait(300);
          const inheritedRows = (await js(`[...(${visible('[data-testid=api-inherited-headers]')}?.querySelectorAll('tr') ?? [])].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`)) as string[];
          const hint = await js(`${visible('[data-testid=api-base-url-hint]')}?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
          await shot('03u-inherited-headers-light');
          await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim().startsWith('Auth'))?.click()`);
          await wait(300);
          const authType = await js(`${visible('[data-testid=api-auth-type]')}?.value ?? null`);
          const authLine = await js(`${visible('[data-testid=api-auth-inherited]')}?.textContent.trim() ?? null`);
          check(
            'ui: a request inside shows the inherited headers with their collection, the base URL it gets, and what its inherited auth is',
            inheritedRows.length === 2 && inheritedRows.some((r) => r.includes('x-tenant') && r.includes('beta') && r.includes('inherit inner')) && inheritedRows.some((r) => r.includes('X-Outer') && r.includes('inherit outer')) &&
              typeof hint === 'string' && hint.includes('/inherit?x=1') && hint.includes('inherit outer') && authType === 'inherit' && typeof authLine === 'string' && authLine.includes('bearer token') && authLine.includes('inherit outer'),
            { inheritedRows, hint, authType, authLine },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          if (outerCol) await run('api.collection.delete', { id: outerCol.id }, ws.id);
          await js(`[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('echo'))?.click()`);
          await wait(600);
        }

        // Captures in the UI: the Capture segment lists them, and a send shows what was captured.
        {
          const loginReq = (await run<ApiRequest[]>('api.request.list', {}, ws.id)).find((r) => r.name === 'capture login');
          await js(`[...document.querySelectorAll('[data-testid=api-request-row]')].find((r) => r.getAttribute('data-name') === 'capture login')?.click()`);
          await wait(900);
          await js(`${visible('[data-testid=api-section-capture]')}?.click()`);
          await wait(300);
          const segmentLabel = await js(`${visible('[data-testid=api-section-capture]')}?.textContent.trim() ?? null`);
          const captureRows = await js(`[...document.querySelectorAll('[data-testid=api-capture-row]')].filter((r) => r.offsetParent !== null).length`);
          // Ticked where saved so (capReq), and ticked and locked where the name alone makes it secret (capToken, capSession, adminToken).
          const secretBoxes = await js(`[...document.querySelectorAll('[data-testid=api-capture-secret]')].filter((e) => e.offsetParent !== null).map((e) => (e.checked ? '1' : '0') + (e.disabled ? 'd' : ''))`);
          await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === 'Send')?.click()`);
          await wait(1500);
          const strip = (await js(`[...document.querySelectorAll('[data-testid=api-response-captured-item]')].filter((e) => e.offsetParent !== null).map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`)) as string[];
          await shot('03v-request-capture-light');
          check(
            'ui: the Capture segment lists the captures with Secret ticked and locked for a credential-like name, and the response shows each captured value (secret ones masked) or why it failed',
            segmentLabel === 'Capture6' && captureRows === 6 && JSON.stringify(secretBoxes) === '["1d","1d","0","1","0","1d"]' &&
              strip.some((s) => s.startsWith('capToken') && s.includes('••••••••') && !s.includes('cap-tok-123')) && strip.some((s) => s === 'capUser = 7') && strip.some((s) => s.startsWith('capMissing:')),
            { segmentLabel, captureRows, secretBoxes, strip },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          if (loginReq) await run('api.request.delete', { id: loginReq.id }, ws.id);
          const cleaned = await run<Environment>('api.environment.get', { id: env.id }, ws.id);
          await run('api.environment.save', { environment: { ...cleaned, variables: cleaned.variables.filter((v) => !v.key.startsWith('cap')) } }, ws.id);
          await js(`[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('echo'))?.click()`);
          await wait(600);
        }

        // Files in the UI: a binary body shows its file and size, a multipart row its File toggle.
        {
          const requests = await run<ApiRequest[]>('api.request.list', {}, ws.id);
          const fileBody = requests.find((r) => r.name === 'file body');
          const fileUpload = requests.find((r) => r.name === 'file upload');
          const openBody = async (name: string) => {
            await js(`[...document.querySelectorAll('[data-testid=api-request-row]')].find((r) => r.getAttribute('data-name') === ${JSON.stringify(name)})?.click()`);
            await wait(900);
            await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim().startsWith('Body'))?.click()`);
            await wait(500);
          };
          await openBody('file body');
          const binaryPath = await js(`${visible('[data-testid=api-binary-path]')}?.value ?? null`);
          const binaryInfo = await js(`${visible('[data-testid=api-binary-info]')}?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
          await shot('03w-binary-body-light');
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          await openBody('file upload');
          const toggles = await js(`[...document.querySelectorAll('[data-testid=api-form-file-toggle]')].filter((e) => e.offsetParent !== null).map((e) => e.checked)`);
          const browse = await js(`[...document.querySelectorAll('[data-testid=api-form-file-browse]')].filter((e) => e.offsetParent !== null).length`);
          await shot('03x-multipart-files-light');
          check(
            'ui: a binary body shows its path and size, and a multipart file row its ticked File toggle and a Choose button',
            binaryPath === 'uploads/hello.txt' && typeof binaryInfo === 'string' && binaryInfo.includes('10 B') && binaryInfo.includes('in the project') &&
              Array.isArray(toggles) && toggles[0] === true && toggles[1] === false && browse === 1,
            { binaryPath, binaryInfo, toggles, browse },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          for (const r of [fileBody, fileUpload]) if (r) await run('api.request.delete', { id: r.id }, ws.id);
          await fs.rm(path.join(folder, 'uploads'), { recursive: true, force: true });
          await js(`[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('echo'))?.click()`);
          await wait(600);
        }

        // OAuth 2.0 in the UI: the Auth segment's fields and the cached token's state.
        {
          const ccReq = (await run<ApiRequest[]>('api.request.list', {}, ws.id)).find((r) => r.name === 'oauth cc');
          await js(`[...document.querySelectorAll('[data-testid=api-request-row]')].find((r) => r.getAttribute('data-name') === 'oauth cc')?.click()`);
          await wait(900);
          await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim().startsWith('Auth'))?.click()`);
          await wait(600);
          const authType = await js(`${visible('[data-testid=api-auth-type]')}?.value ?? null`);
          const grant = await js(`${visible('[data-testid=api-oauth-grant]')}?.value ?? null`);
          const statusLine = await js(`${visible('[data-testid=api-oauth-status]')}?.textContent.trim() ?? null`);
          const getLabel = await js(`${visible('[data-testid=api-oauth-get]')}?.textContent.trim() ?? null`);
          await shot('03y-oauth-auth-light');
          check(
            'ui: an OAuth 2.0 request shows its grant and the cached token\'s expiry, with Get new token',
            authType === 'oauth2' && grant === 'client_credentials' && typeof statusLine === 'string' && statusLine.startsWith('Token expires') && getLabel === 'Get new token',
            { authType, grant, statusLine, getLabel },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          if (ccReq) await run('api.request.delete', { id: ccReq.id }, ws.id);
          await js(`[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('echo'))?.click()`);
          await wait(600);
        }

        // The cookie jar in the UI: the response's Cookies view says what was kept, and the jar tab lists the cookies.
        {
          const jarReq = await run<ApiRequest>('api.request.create', { name: 'jar probe', url: `{{baseUrl}}/setcookie?c=${encodeURIComponent('uiCookie=u1; Path=/; Max-Age=3600')}&c=${encodeURIComponent('bad=1; Domain=nowhere.test')}` }, ws.id);
          await wait(600);
          await js(`[...document.querySelectorAll('[data-testid=api-request-row]')].find((r) => r.getAttribute('data-name') === 'jar probe')?.click()`);
          await wait(900);
          await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === 'Send')?.click()`);
          await wait(1200);
          await js(`${visible('[data-testid=api-response-cookies-tab]')}?.click()`);
          await wait(300);
          const jarMarks = (await js(`[...document.querySelectorAll('[data-testid=api-response-cookie-jar]')].filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim())`)) as string[];
          await shot('03z-response-cookie-jar-light');
          await js(`document.querySelector('[data-testid=api-open-cookies]')?.click()`);
          await wait(900);
          const jarRows = (await js(`[...document.querySelectorAll('[data-testid=api-cookie-row]')].filter((e) => e.offsetParent !== null).map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`)) as string[];
          await shot('03za-cookie-jar-tab-light');
          check(
            'ui: the response says which cookies the jar kept or refused, and the jar tab lists them by domain',
            jarMarks.length === 2 && jarMarks[0] === 'kept' && jarMarks[1] === 'refused' && jarRows.some((r) => r.startsWith('uiCookie') && r.includes('u1')),
            { jarMarks, jarRows },
          );
          await js(`(() => { for (const tab of document.querySelectorAll('[data-testid=tab]')) if (!/^echo/.test(tab.getAttribute('data-title') ?? '')) tab.querySelector('[aria-label="Close tab"]')?.click(); })()`);
          await wait(300);
          await run('api.request.delete', { id: jarReq.id }, ws.id);
          await run('api.cookie.clear', {}, ws.id);
          await js(`[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('echo'))?.click()`);
          await wait(600);
        }

        // Code in the UI: the Code menu copies as a language, and Show code puts the snippet in the lower pane, remembering the pick.
        {
          await js(`${visible('[data-testid=api-code-menu]')}?.click()`);
          await wait(250);
          const menu = (await js(`[...document.querySelectorAll('[data-testid=context-menu] button')].map((b) => b.textContent.trim())`)) as string[];
          await js(`document.querySelector('[data-testid=api-show-code]')?.click()`);
          await wait(800);
          await js(`(() => { const s = ${visible('[data-testid=api-code-target]')}; s.value = 'python-requests'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await wait(1000);
          const snippet = await js(`${visible('[data-testid=api-code-editor] .cm-content')}?.textContent ?? ''`);
          await shot('03zb-code-view-light');
          const remembered = await run<{ value: string | null }>('workspace.state.get', { key: 'api.codegen.target' }, ws.id);
          await js(`${visible('[data-testid=api-code-close]')}?.click()`);
          await wait(300);
          const backToResponse = await js(`Boolean(${visible('[data-testid=api-response-status]')}) || document.body.innerText.includes('No response yet')`);
          check(
            'ui: the Code menu offers every language and Show code, the code view shows the chosen one and remembers it, and closing it brings the response back',
            menu.includes('Copy as curl') && menu.includes('Copy as Python (requests)') && menu.includes('Show code') && String(snippet).includes('requests.request(') && remembered.value === 'python-requests' && backToResponse === true,
            { menu, snippet: String(snippet).slice(0, 80), remembered: remembered.value, backToResponse },
          );
        }

        // Import from curl: the dialog says which shell it will read the paste as, and the shell can be picked.
        {
          await js(`document.querySelector('[data-testid=api-import-menu]')?.click()`);
          await wait(250);
          const opened = await js(`(() => { const b = document.querySelector('[data-testid=api-import-curl]'); if (b) b.click(); return Boolean(b); })()`);
          await wait(300);
          const typed = await js(
            `(() => { const ta = document.querySelector('textarea'); if (!ta) return false; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ${JSON.stringify('curl ^"https://example.test/x?merchantId=376^" ^\n  -H ^"accept: application/json^" ^\n  --data-raw ^"null^"')}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
          );
          await wait(200);
          const dialog = (await js(
            `(() => { const s = document.querySelector('select[aria-label="Shell"]'); return s ? { options: [...s.options].map((o) => o.textContent), hint: s.parentElement.querySelector('span')?.textContent ?? null } : null; })()`,
          )) as { options: string[]; hint: string | null } | null;
          check(
            'ui: curl import offers the shells and reads a Chrome cmd copy as cmd.exe',
            opened === true && typed === true && dialog?.options.join() === 'Detect,bash/zsh,cmd.exe,PowerShell' && dialog.hint === 'Reads as cmd.exe',
            dialog,
          );
          await shot('03a-curl-import-light');
          await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Cancel'); if (b) b.click(); })()`);
          await wait(200);
        }

        // Variables: {{name}} is marked in inputs and editors, and hovering shows the value, with secrets masked until revealed.
        const hoverVariable = (inputSelector: string, name: string) =>
          js(
            `(() => { const pane = [...document.querySelectorAll('[data-tab-type="api.request"]')].find((el) => !el.classList.contains('hidden')) ?? document; const input = [...pane.querySelectorAll(${JSON.stringify(inputSelector)})].find((i) => (i.getAttribute('data-variables') || '').split(',').includes(${JSON.stringify(name)})); if (!input) return 'no input'; const chip = input.parentElement.querySelector('[data-var-name="${name}"]'); if (!chip) return 'no chip'; const r = chip.getBoundingClientRect(); input.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); return 'ok'; })()`,
          );
        const card = () =>
          js(
            `(() => { const c = document.querySelector('[data-testid=variable-card]'); return c ? { name: c.getAttribute('data-name'), source: c.querySelector('[data-testid=variable-card-source]')?.textContent, value: c.querySelector('[data-testid=variable-card-value]')?.textContent ?? null } : null; })()`,
          ) as Promise<{ name: string; source: string; value: string | null } | null>;
        const hoveredUrl = await hoverVariable('input', 'baseUrl');
        await wait(250);
        const urlCard = await card();
        check(
          'ui: hovering {{baseUrl}} in the URL shows its value and environment',
          hoveredUrl === 'ok' && urlCard?.name === 'baseUrl' && urlCard.value === `http://127.0.0.1:${echoPort}` && urlCard.source === 'Environment · local',
          { hoveredUrl, urlCard },
        );
        await shot('03b-variable-hover-light');
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await js(
          `(() => { const pane = [...document.querySelectorAll('[data-tab-type="api.request"]')].find((el) => !el.classList.contains('hidden')); const tab = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Auth')); if (tab) tab.click(); })()`,
        );
        await wait(300);
        const hoveredToken = await hoverVariable('input', 'token');
        await wait(250);
        const tokenMasked = await card();
        await js(`document.querySelector('[data-testid=variable-card-reveal]')?.click()`);
        await wait(150);
        const tokenRevealed = await card();
        check(
          'ui: a secret variable is masked in the card until revealed',
          hoveredToken === 'ok' && tokenMasked?.value === '••••••••' && tokenRevealed?.value === 's3cret',
          { hoveredToken, tokenMasked, tokenRevealed },
        );
        await js(`document.documentElement.classList.add('dark')`);
        await wait(200);
        await shot('03c-variable-secret-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        const typeUrl = (value: string) =>
          js(
            `(() => { const pane = [...document.querySelectorAll('[data-tab-type="api.request"]')].find((el) => !el.classList.contains('hidden')); const input = [...pane.querySelectorAll('input')].find((i) => i.value.startsWith('{{baseUrl}}')); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
          );
        await typeUrl('{{baseUrl}}/things?x=1&k={{nope}}');
        await wait(200);
        const hoveredMissing = await hoverVariable('input', 'nope');
        await wait(250);
        const missingCard = await card();
        const missingChip = await js(`document.querySelector('[data-var-name=nope]')?.className ?? ''`);
        check(
          'ui: an undefined variable is marked and its card says so',
          hoveredMissing === 'ok' && missingCard?.source === 'Not defined' && typeof missingChip === 'string' && missingChip.includes('bg-danger'),
          { hoveredMissing, missingCard, missingChip },
        );
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

        // A long value scrolls inside the card without closing it, and the card edits the value where it is defined.
        const globalsBeforeUi = host.config.get().globalVariables;
        const longValue = Array.from({ length: 60 }, (_, i) => `segment-${i}`).join('/');
        await run('config.update', { patch: { globalVariables: [...globalsBeforeUi, { id: 'glong', key: 'long', value: longValue, enabled: true }] } }, null);
        await typeUrl('{{baseUrl}}/things?x=1&l={{long}}');
        await wait(400);
        const hoveredLong = await hoverVariable('input', 'long');
        await wait(250);
        const valueBox = (await js(
          `(() => { const el = document.querySelector('[data-testid=variable-card-value]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), overflow: el.scrollHeight > el.clientHeight }; })()`,
        )) as { x: number; y: number; overflow: boolean } | null;
        if (valueBox) {
          win.webContents.sendInputEvent({ type: 'mouseMove', x: valueBox.x, y: valueBox.y });
          await wait(100);
          for (let i = 0; i < 3; i++) {
            win.webContents.sendInputEvent({ type: 'mouseWheel', x: valueBox.x, y: valueBox.y, deltaX: 0, deltaY: -120 });
            await wait(80);
          }
        }
        await wait(300);
        const afterWheel = await js(`(() => { const el = document.querySelector('[data-testid=variable-card-value]'); return el ? el.scrollTop : null; })()`);
        const longCard = await card();
        check(
          'ui: the wheel scrolls a long value inside the card and the card stays open',
          hoveredLong === 'ok' && valueBox?.overflow === true && typeof afterWheel === 'number' && afterWheel > 0 && longCard?.name === 'long',
          { hoveredLong, valueBox, afterWheel, longCard: longCard?.name },
        );
        await shot('03e-variable-long-scrolled-light');

        await js(`document.querySelector('[data-testid=variable-card-edit]')?.click()`);
        await wait(150);
        const editor = await js(
          `(() => { const t = document.querySelector('[data-testid=variable-card-input]'); return t ? { focused: document.activeElement === t, value: t.value } : null; })()`,
        ) as { focused: boolean; value: string } | null;
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await wait(150);
        const afterCancel = await js(
          `(() => { const c = document.querySelector('[data-testid=variable-card]'); return c ? { editing: c.hasAttribute('data-editing'), input: Boolean(c.querySelector('[data-testid=variable-card-input]')) } : null; })()`,
        ) as { editing: boolean; input: boolean } | null;
        check(
          'ui: the card edits a value in place, and Escape backs out of the edit without closing it',
          editor?.focused === true && editor.value === longValue && afterCancel?.editing === false && afterCancel.input === false,
          { editor: editor && { focused: editor.focused, same: editor.value === longValue }, afterCancel },
        );
        await js(`document.querySelector('[data-testid=variable-card-edit]')?.click()`);
        await wait(150);
        await js(
          `(() => { const t = document.querySelector('[data-testid=variable-card-input]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(t, 'short/value'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`,
        );
        await js(`document.documentElement.classList.add('dark')`);
        await wait(200);
        await shot('03f-variable-editing-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await wait(500);
        const edited = await card();
        const editedFlag = await js(`document.querySelector('[data-testid=variable-card]')?.hasAttribute('data-editing') ?? null`);
        check(
          'ui: Enter saves the edited value to where it is defined and the card shows it',
          edited?.value === 'short/value' && editedFlag === false && host.config.get().globalVariables.find((v) => v.key === 'long')?.value === 'short/value',
          { edited, editedFlag, stored: host.config.get().globalVariables.find((v) => v.key === 'long')?.value },
        );
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await run('config.update', { patch: { globalVariables: globalsBeforeUi } }, null);
        await wait(400);

        // With {{long}} gone from the globals, its card offers to define it, here as a secret of the active environment.
        await hoverVariable('input', 'long');
        await wait(250);
        await js(`document.querySelector('[data-testid=variable-card-define]')?.click()`);
        await wait(150);
        const defineForm = await js(
          `(() => { const s = document.querySelector('[data-testid=variable-card-target]'); return s ? { target: s.value, options: [...s.options].map((o) => o.textContent), focused: document.activeElement?.getAttribute('data-testid') } : null; })()`,
        ) as { target: string; options: string[]; focused: string } | null;
        await js(
          `(() => { const s = document.querySelector('[data-testid=variable-card-target]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'global'); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
        );
        await wait(100);
        const secretDisabledForGlobal = await js(`document.querySelector('[data-testid=variable-card-secret]')?.disabled`);
        await js(
          `(() => { const s = document.querySelector('[data-testid=variable-card-target]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(env.id)}); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
        );
        await wait(100);
        await js(`document.querySelector('[data-testid=variable-card-secret]')?.click()`);
        await js(
          `(() => { const t = document.querySelector('[data-testid=variable-card-input]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(t, 'l0ng-secret'); t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); })()`,
        );
        await js(`document.documentElement.classList.add('dark')`);
        await wait(200);
        await shot('03g-variable-define-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await wait(600);
        const definedCard = await card();
        const definedChip = await js(`document.querySelector('[data-var-name=long]')?.className ?? ''`);
        const definedRow = (await run<Environment>('api.environment.get', { id: env.id }, ws.id)).variables.find((v) => v.key === 'long');
        check(
          'ui: an undefined variable can be defined from its card, in the chosen environment and as a secret',
          defineForm?.target === env.id && defineForm.options[0] === 'local (active)' && defineForm.options.includes('Global variables') && defineForm.focused === 'variable-card-input' &&
            secretDisabledForGlobal === true &&
            definedCard?.source === 'Environment · local' && definedCard.value === '••••••••' &&
            typeof definedChip === 'string' && !definedChip.includes('bg-danger') &&
            definedRow?.value === 'l0ng-secret' && definedRow.secret === true,
          { defineForm, secretDisabledForGlobal, definedCard, definedChip, definedRow },
        );
        await shot('03h-variable-defined-light');
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        const envWithLong = await run<Environment>('api.environment.get', { id: env.id }, ws.id);
        await run('api.environment.save', { environment: { ...envWithLong, variables: envWithLong.variables.filter((v) => v.key !== 'long') } }, ws.id);
        await typeUrl('{{baseUrl}}/things?x=1');
        await wait(200);
        check('ui: restoring the URL leaves the request unmodified', (await js(`document.querySelector('[data-testid=tab][aria-selected=true]')?.textContent.includes('echo') && !document.querySelector('[data-testid=tab][aria-selected=true] .bg-warning')`)) === true);

        // A clean request tab follows the file when it changes on disk (an agent, a git pull).
        const saveLabel = () =>
          js(`(() => { const pane = [...document.querySelectorAll('[data-tab-type="api.request"]')].find((el) => !el.classList.contains('hidden')); return [...(pane?.querySelectorAll('button') ?? [])].find((b) => b.textContent.startsWith('Save'))?.textContent ?? null; })()`);
        const labelBefore = await saveLabel();
        const echoes = (await run<ApiRequest[]>('api.request.list', {}, ws.id)).filter((r) => r.name === 'echo');
        const echoReq = echoes[0];
        const echoFile = path.join(folder, '.quiver', 'requests', `${echoReq.id}.json`);
        const echoOriginal = await fs.readFile(echoFile, 'utf8');
        await fs.writeFile(echoFile, JSON.stringify({ ...echoReq, url: '{{baseUrl}}/changed-on-disk' }, null, 2) + '\n');
        await wait(1200);
        const tabUrl = await js(
          `(() => { const pane = [...document.querySelectorAll('[data-tab-type="api.request"]')].find((el) => !el.classList.contains('hidden')); return [...(pane?.querySelectorAll('input') ?? [])].find((i) => i.value.startsWith('{{baseUrl}}'))?.value ?? null; })()`,
        );
        const labelAfter = await saveLabel();
        check('ui: an open request tab without edits picks up a change made on disk', tabUrl === '{{baseUrl}}/changed-on-disk' && labelAfter === 'Save', { tabUrl, labelBefore, labelAfter, echoes: echoes.map((r) => r.url) });
        await fs.writeFile(echoFile, echoOriginal);
        await wait(1200);

        const bodyVars = await run<ApiRequest>('api.request.create', { name: 'vars in body', method: 'POST', url: '{{baseUrl}}/b', body: { type: 'json', content: '{\n  "auth": "{{token}}",\n  "other": "{{nope}}"\n}' } }, ws.id);
        await wait(500);
        await js(`(() => { const row = [...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('vars in body')); if (row) row.click(); })()`);
        await wait(800);
        await js(
          `(() => { const pane = [...document.querySelectorAll('[data-tab-type="api.request"]')].find((el) => !el.classList.contains('hidden')); const tab = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Body')); if (tab) tab.click(); })()`,
        );
        await wait(500);
        const editorMarks = await js(
          `(() => { const pane = [...document.querySelectorAll('[data-tab-type="api.request"]')].find((el) => !el.classList.contains('hidden')); return [...pane.querySelectorAll('.cm-content [data-var-name]')].map((el) => el.getAttribute('data-var-name') + ':' + el.className); })()`,
        );
        await js(
          `(() => { const pane = [...document.querySelectorAll('[data-tab-type="api.request"]')].find((el) => !el.classList.contains('hidden')); const el = pane.querySelector('.cm-content [data-var-name=token]'); if (!el) return; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 2, clientY: r.top + 2 })); })()`,
        );
        await wait(250);
        const editorCard = await card();
        check(
          'ui: the body editor marks known and unknown variables and shows the card on hover',
          Array.isArray(editorMarks) && editorMarks.some((m: string) => m.startsWith('token:') && m.includes('cm-variable') && !m.includes('missing')) && editorMarks.some((m: string) => m.startsWith('nope:') && m.includes('cm-variable-missing')) && editorCard?.name === 'token' && editorCard.value === '••••••••',
          { editorMarks, editorCard },
        );
        await shot('03d-variable-body-light');
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
        await run('api.request.delete', { id: bodyVars.id }, ws.id);
        await wait(300);
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
        await wait(400);
        await shot('04-palette-light');
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await wait(200);

        // GraphQL: request row label, body editor with schema status, docs explorer.
        const clickedApi = await js(
          `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'API client'); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: api module button', clickedApi === true);
        await wait(500);

        // API sidebar: a collapsed collection stays collapsed after leaving the module, and the choice is saved per machine.
        const foldCollection = await run<{ id: string }>('api.collection.create', { name: 'smoke folder' }, ws.id);
        await run('api.request.create', { name: 'inside folder', collectionId: foldCollection.id }, ws.id);
        await wait(600);
        const folderOpen = () => js(`document.querySelector('[data-testid=api-collection][data-name="smoke folder"]')?.getAttribute('data-open') ?? null`);
        const openedByDefault = await folderOpen();
        await js(`document.querySelector('[data-testid=api-collection][data-name="smoke folder"] [role=button]').click()`);
        await wait(200);
        const collapsed = await folderOpen();
        const hiddenChild = await js(`[...document.querySelectorAll('[role=button]')].some((r) => r.textContent.includes('inside folder'))`);
        await js(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Databases').click()`);
        await wait(400);
        await js(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'API client').click()`);
        await wait(600);
        const afterReturn = await folderOpen();
        const savedTree = await run<{ value: Record<string, boolean> | null }>('workspace.state.get', { key: 'ui.tree' }, ws.id);
        check(
          'ui: a collapsed API collection stays collapsed after switching modules and is saved',
          openedByDefault === 'true' && collapsed === 'false' && hiddenChild === false && afterReturn === 'false' && savedTree.value?.[`api/collection/${foldCollection.id}`] === false,
          { openedByDefault, collapsed, hiddenChild, afterReturn, saved: savedTree.value },
        );
        await run('api.collection.delete', { id: foldCollection.id }, ws.id).catch(() => {});
        await wait(300);

        // API sidebar: requests added by an agent show up without a restart, through MCP or written straight to disk.
        const viaMcp = await host.invoke('api.request.create', { name: 'added over mcp' }, { caller: 'mcp', workspaceId: ws.id });
        const onDiskId = 'smokeexternal01';
        await fs.writeFile(
          path.join(folder, '.quiver', 'requests', `${onDiskId}.json`),
          JSON.stringify({ ...(viaMcp.ok ? (viaMcp.result as object) : {}), id: onDiskId, name: 'written to disk', collectionId: null }, null, 2),
        );
        await wait(1200);
        const sidebarRows = await js(`[...document.querySelectorAll('[role=button]')].map((r) => r.textContent)`);
        const sawDiskRow = Array.isArray(sidebarRows) && sidebarRows.some((t: string) => t.includes('written to disk'));
        check(
          'ui: requests created over MCP or written to .quiver by hand appear in the sidebar without a restart',
          viaMcp.ok && Array.isArray(sidebarRows) && sidebarRows.some((t: string) => t.includes('added over mcp')) && sidebarRows.some((t: string) => t.includes('written to disk')),
          viaMcp.ok ? 'ok' : viaMcp.error.message,
        );
        await fs.rm(path.join(folder, '.quiver', 'requests', `${onDiskId}.json`));
        await wait(600);
        const goneRow = await js(`[...document.querySelectorAll('[role=button]')].some((r) => r.textContent.includes('written to disk'))`);
        check('ui: a request file deleted on disk disappears from the sidebar', sawDiskRow && goneRow === false);
        if (viaMcp.ok) await run('api.request.delete', { id: (viaMcp.result as { id: string }).id }, ws.id).catch(() => {});
        await wait(300);
        const gqlRowLabel = await js(
          `(() => { const row = [...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('smoke graphql')); if (!row) return null; const label = row.textContent.slice(0, 3); row.click(); return label; })()`,
        );
        check('ui: graphql request row is labelled GQL', gqlRowLabel === 'GQL', gqlRowLabel);
        await wait(1000);
        const clickedBodyTab = await js(
          `(() => { const pane = [...document.querySelectorAll('[data-tab-type="api.request"]')].find((el) => !el.classList.contains('hidden')); const btn = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Body')); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: body section tab', clickedBodyTab === true);
        await wait(1500);
        const gqlQueryText = await js(`document.querySelector('[data-testid=graphql-query] .cm-content')?.textContent ?? ''`);
        check('ui: graphql editor shows the query', typeof gqlQueryText === 'string' && gqlQueryText.includes('hello(name: $name)'), gqlQueryText);
        const gqlStatus = await js(`document.querySelector('[data-testid=graphql-schema-status]')?.textContent ?? ''`);
        check('ui: schema status shows the cached schema', typeof gqlStatus === 'string' && /Schema: \d+ types/.test(gqlStatus), gqlStatus);
        await shot('17-graphql-light');
        const clickedDocs = await js(`(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Docs'); if (btn) btn.click(); return Boolean(btn); })()`);
        check('ui: docs button opens the schema explorer', clickedDocs === true);
        await wait(1000);
        const typeNames = await js(`[...document.querySelectorAll('[data-testid=graphql-type]')].map((b) => b.textContent)`);
        check('ui: schema explorer lists root and object types', Array.isArray(typeNames) && typeNames.includes('Query') && typeNames.includes('Mutation') && typeNames.includes('User'), typeNames);
        const clickedUser = await js(`(() => { const btn = [...document.querySelectorAll('[data-testid=graphql-type]')].find((b) => b.textContent === 'User'); if (btn) btn.click(); return Boolean(btn); })()`);
        await wait(400);
        const userDetail = await js(`document.querySelector('[data-testid=graphql-type-detail]')?.textContent ?? ''`);
        check(
          'ui: type detail shows fields, description and deprecation',
          clickedUser === true && typeof userDetail === 'string' && userDetail.includes('A person') && userDetail.includes('name') && userDetail.includes('Deprecated'),
          String(userDetail).slice(0, 160),
        );
        await shot('18-graphql-schema-light');

        // Status bar: the environment picker is a themed menu above the bar, not a native select.
        // A second environment to switch to, whichever other parts ran.
        const staging = await run<Environment>('api.environment.create', { name: 'staging' }, ws.id);
        const environmentCount = (await run<Environment[]>('api.environment.list', {}, ws.id)).length;
        await wait(300);
        const pickerLabel = await js(`document.querySelector('[data-testid=env-picker]')?.textContent ?? null`);
        check('ui: status bar names the active environment', pickerLabel === 'local', pickerLabel);
        await js(`document.querySelector('[data-testid=env-picker]').click()`);
        await wait(300);
        const pickerOptions = await js(`[...document.querySelectorAll('[data-testid=env-picker-option]')].map((b) => b.textContent + ':' + b.getAttribute('aria-checked'))`);
        check(
          'ui: the environment menu lists none plus every environment and marks the active one',
          Array.isArray(pickerOptions) && pickerOptions[0] === 'No environment:false' && pickerOptions.includes('local:true') && pickerOptions.includes('staging:false') && pickerOptions.length === environmentCount + 1,
          { pickerOptions, environmentCount },
        );
        await shot('24b-env-picker-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(200);
        await shot('24c-env-picker-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await js(`[...document.querySelectorAll('[data-testid=env-picker-option]')].find((b) => b.textContent !== 'local' && b.getAttribute('data-env-id')).click()`);
        await wait(600);
        const pickedLabel = await js(`document.querySelector('[data-testid=env-picker]')?.textContent ?? null`);
        const pickedActive = await run<{ id: string | null }>('api.environment.active', {}, ws.id);
        check('ui: picking an environment closes the menu and activates it', pickedLabel !== 'local' && pickedActive.id !== null && pickedActive.id !== env.id && (await js(`Boolean(document.querySelector('[data-testid=env-picker-menu]'))`)) === false, { pickedLabel, pickedActive });
        await js(`document.querySelector('[data-testid=env-picker]').click()`);
        await wait(200);
        await js(`document.querySelector('[data-testid=env-picker-menu]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await wait(200);
        check('ui: Escape closes the environment menu', (await js(`Boolean(document.querySelector('[data-testid=env-picker-menu]'))`)) === false);
        await run('api.environment.setActive', { id: env.id }, ws.id);
        await run('api.environment.delete', { id: staging.id }, ws.id);
        await wait(300);

        // Import menu: every format, and a pasted file read as what it is, opened, with what was not imported shown.
        {
          await js(`document.querySelector('[data-testid=api-import-menu]')?.click()`);
          await wait(250);
          const menu = (await js(`[...document.querySelectorAll('[data-testid=context-menu] button')].map((b) => b.textContent.trim())`)) as string[];
          await js(`document.querySelector('[data-testid=api-import-paste]')?.click()`);
          await wait(300);
          const pasted = JSON.stringify({
            openapi: '3.0.0',
            info: { title: 'Pasted API' },
            servers: [{ url: `http://127.0.0.1:${echoPort}` }],
            paths: { '/pasted': { get: { summary: 'Pasted op', parameters: [{ in: 'cookie', name: 'sid' }] } } },
          });
          await js(
            `(() => { const ta = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ${JSON.stringify(pasted)}); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`,
          );
          await wait(200);
          const hint = await js(`document.querySelector('select[aria-label="Format"]')?.parentElement.querySelector('span')?.textContent ?? null`);
          await js(`document.querySelector('form button[type=submit]')?.click()`);
          await until(() => js(`Boolean(document.querySelector('[data-testid=dialog-ok]'))`).then(Boolean), 4000);
          const notice = (await js(
            `(() => { const ok = document.querySelector('[data-testid=dialog-ok]'); const box = ok?.closest('div.flex')?.parentElement; return ok ? { title: box?.querySelector('h2')?.textContent?.trim(), message: document.querySelector('[data-testid=dialog-message]')?.textContent ?? '' } : null; })()`,
          )) as { title: string; message: string } | null;
          await shot('03zc-import-report-light');
          await js(`document.querySelector('[data-testid=dialog-ok]')?.click()`);
          await wait(500);
          const opened = await js(`document.body.innerText.includes('Pasted op') && [...document.querySelectorAll('[role=tab]')].some((t) => t.textContent.includes('Pasted API'))`);
          check(
            'ui: the Import menu offers every format and a paste, the paste is read as OpenAPI, and the import opens with a report of what was not imported',
            ['From curl…', 'From OpenAPI…', 'From Postman…', 'From Insomnia…', 'From HAR…', 'Paste a file…'].every((label) => menu.includes(label)) &&
              hint === 'Reads as OpenAPI' &&
              notice?.title === 'Imported 1 request into Pasted API' &&
              notice.message.includes('Cookie parameters') &&
              opened === true,
            { menu, hint, notice, opened },
          );
        }
        const pastedRoot = (await run<ApiCollection[]>('api.collection.list', {}, ws.id)).find((c) => c.name === 'Pasted API');
        if (pastedRoot) await run('api.collection.delete', { id: pastedRoot.id }, ws.id);

        // Checks and runs in the UI: the Checks segment, the count on the status line and the Checks view, then Run collection and its tab.
        {
          const origin = `http://127.0.0.1:${echoPort}`;
          const uiRun = await run<ApiCollection>('api.collection.create', { name: 'ui run' }, ws.id);
          const add = async (name: string, path: string, checks: ApiRequest['checks']) => {
            const created = await run<ApiRequest>('api.request.create', { name, method: 'GET', url: `${origin}${path}`, collectionId: uiRun.id }, ws.id);
            return run<ApiRequest>('api.request.save', { request: { ...created, checks } }, ws.id);
          };
          await add('ui ok', '/ui/ok', [{ id: 'a', enabled: true, on: 'status', path: '', op: 'eq', expected: '200' }]);
          await add('ui fail', '/ui/fail', [
            { id: 'b', enabled: true, on: 'status', path: '', op: 'eq', expected: '200' },
            { id: 'c', enabled: true, on: 'jsonPath', path: '$.url', op: 'eq', expected: '/elsewhere' },
          ]);
          await until(() => js(`Boolean(document.querySelector('[data-testid=api-collection][data-name="ui run"]'))`).then(Boolean), 3000);
          await js(`(() => { const c = document.querySelector('[data-testid=api-collection][data-name="ui run"]'); if (c?.getAttribute('data-open') === 'false') c.querySelector('[role=button]')?.click(); })()`);
          await wait(400);
          await js(`[...document.querySelectorAll('[data-testid=api-request-row]')].find((r) => r.getAttribute('data-name') === 'ui fail')?.click()`);
          await wait(900);
          await js(`${visible('[data-testid=api-section-checks]')}?.click()`);
          await wait(300);
          const checkRows = await js(`[...document.querySelectorAll('[data-testid=api-check-row]')].filter((r) => r.offsetParent !== null).length`);
          await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === 'Send')?.click()`);
          await until(() => js(`Boolean(${visible('[data-testid=api-response-checks-count]')})`).then(Boolean), 4000);
          const countLabel = await js(`${visible('[data-testid=api-response-checks-count]')}?.textContent.trim() ?? null`);
          await js(`${visible('[data-testid=api-response-checks-count]')}?.click()`);
          await wait(300);
          const badges = await js(`[...document.querySelectorAll('[data-testid=api-response-check-badge]')].filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim())`);
          await shot('03zd-request-checks-light');
          check(
            'ui: the Checks segment lists the checks, the status line counts the passed ones, and the Checks view marks each pass or fail',
            checkRows === 2 && countLabel === '1/2 checks' && JSON.stringify(badges) === '["pass","fail"]',
            { checkRows, countLabel, badges },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);

          await js(`document.querySelector('[data-testid=api-collection][data-name="ui run"] [data-testid=api-collection-menu]')?.click()`);
          await wait(250);
          await js(`document.querySelector('[data-testid=api-menu-collection-run]')?.click()`);
          await until(() => js(`(() => { const rows = [...document.querySelectorAll('[data-testid=api-run-row]')].filter((r) => r.offsetParent !== null); return rows.length === 2 && rows.every((r) => !['pending', 'running'].includes(r.getAttribute('data-status'))); })()`).then(Boolean), 6000);
          await wait(300);
          const runRows = await js(`[...document.querySelectorAll('[data-testid=api-run-row]')].filter((r) => r.offsetParent !== null).map((r) => r.getAttribute('data-status'))`);
          const failedLine = await js(`${visible('[data-testid=api-run-failed-check]')}?.textContent.trim() ?? null`);
          const summary = await js(`${visible('[data-testid=api-run-summary]')}?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
          const badge = await js(`document.querySelector('[data-testid=api-collection][data-name="ui run"] [data-testid=api-collection-last-run]')?.textContent.trim() ?? null`);
          await shot('03ze-collection-run-light');
          check(
            'ui: Run collection opens the run tab with each request\'s result and failed check, and the sidebar shows the last run after the collection',
            JSON.stringify(runRows) === '["failed","passed"]' && String(failedLine).includes('Expected $.url to equal /elsewhere') && String(summary).startsWith('2 of 2 · 1 passed · 1 failed') && badge === '1/2',
            { runRows, failedLine, summary, badge },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          await run('api.collection.delete', { id: uiRun.id }, ws.id);
        }

        // Streams in the UI: the Stream option, a live list of lines while it streams, and a big download saying how far it got.
        {
          const origin = `http://127.0.0.1:${echoPort}`;
          const make = async (name: string, url: string, options?: ApiRequest['options']) => {
            const created = await run<ApiRequest>('api.request.create', { name, method: 'GET', url }, ws.id);
            return run<ApiRequest>('api.request.save', { request: { ...created, ...(options ? { options } : {}) } }, ws.id);
          };
          const streamed = await make('ui stream', `${origin}/ndjson?n=5&ms=150`, { stream: true });
          const big = await make('ui big', `${origin}/big?chunks=24&ms=60`);
          const openRow = async (name: string) => {
            await until(() => js(`Boolean(document.querySelector('[data-testid=api-request-row][data-name="${name}"]'))`).then(Boolean), 3000);
            await js(`document.querySelector('[data-testid=api-request-row][data-name="${name}"]')?.click()`);
            await wait(800);
          };
          const send = () => js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === 'Send')?.click()`);

          await openRow('ui stream');
          await js(`${visible('[data-testid=api-section-settings]')}?.click()`);
          await wait(250);
          const streamOption = await js(`${visible('[data-testid=api-option-stream]')}?.checked ?? null`);
          await send();
          await until(() => js(`(${visible('[data-testid=api-stream-item]')}) !== undefined`).then(Boolean), 3000);
          const whileStreaming = await js(`${visible('[data-testid=api-stream-state]')}?.textContent.trim() ?? null`);
          await until(() => js(`${visible('[data-testid=api-stream-state]')}?.textContent.trim() === 'Ended'`).then(Boolean), 5000);
          const lines = await js(`[...document.querySelectorAll('[data-testid=api-stream-data]')].filter((e) => e.offsetParent !== null).map((e) => e.textContent)`);
          const count = await js(`${visible('[data-testid=api-stream-count]')}?.textContent.trim() ?? null`);
          await shot('03zf-stream-light');
          check(
            'ui: with Stream the response is a live list, Streaming while lines arrive and Ended with all of them after',
            streamOption === true && whileStreaming === 'Streaming' && JSON.stringify(lines) === JSON.stringify([1, 2, 3, 4, 5].map((n) => `{"n":${n}}`)) && String(count).startsWith('5 lines'),
            { streamOption, whileStreaming, lines, count },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);

          // A stream that never ends is closed with its tab: nothing else could close it afterwards.
          const endless = await make('ui stream open', `http://127.0.0.1:${t.fixtures.ssePort}/echo`);
          const openBefore = t.fixtures.sseOpenCount();
          await openRow('ui stream open');
          await send();
          const opened = await until(() => Promise.resolve(t.fixtures.sseOpenCount() > openBefore), 3000);
          await until(() => js(`(${visible('[data-testid=api-stream-item]')}) !== undefined`).then(Boolean), 3000);
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          const closed = await until(() => Promise.resolve(t.fixtures.sseOpenCount() === openBefore), 3000);
          check('ui: closing the tab of a streaming response closes its connection', opened === true && closed === true, { openBefore, now: t.fixtures.sseOpenCount() });
          await run('api.request.delete', { id: endless.id }, ws.id);

          await openRow('ui big');
          await send();
          const receiving = await until(() => js(`/Receiving… \\d/.test(${visible('[data-testid=api-response-sending]')}?.textContent ?? '')`).then(Boolean), 3000);
          const receivingText = await js(`${visible('[data-testid=api-response-sending]')}?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
          await until(() => js(`Boolean(${visible('[data-testid=api-response-status]')})`).then(Boolean), 5000);
          check('ui: a big download says how much has arrived while it downloads', receiving === true, receivingText);
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          await run('api.request.delete', { id: streamed.id }, ws.id);
          await run('api.request.delete', { id: big.id }, ws.id);
        }

        // Compare: the request's Compare opens its last two kept responses side by side, the change marked.
        {
          // A new URL, so this send's response differs from the last kept one.
          const toChange = (await run<ApiRequest[]>('api.request.list', {}, ws.id)).find((r) => r.name === 'diff probe')!;
          await run('api.request.save', { request: { ...toChange, url: toChange.url.replace('v=2', 'v=4') } }, ws.id);
          await until(() => js(`Boolean(document.querySelector('[data-testid=api-request-row][data-name="diff probe"]'))`).then(Boolean), 3000);
          await js(`document.querySelector('[data-testid=api-request-row][data-name="diff probe"]')?.click()`);
          await wait(800);
          await js(`[...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === 'Send')?.click()`);
          await until(() => js(`Boolean(${visible('[data-testid=api-response-compare]')})`).then(Boolean), 4000);
          await js(`${visible('[data-testid=api-response-compare]')}?.click()`);
          await until(() => js(`Boolean(${visible('[data-testid=api-diff-view] .cm-mergeView')})`).then(Boolean), 4000);
          await wait(400);
          const pickers = await js(`[...document.querySelectorAll('[data-testid=api-diff-left], [data-testid=api-diff-right]')].filter((e) => e.offsetParent !== null).map((s) => s.options.length)`);
          const changed = await js(`[...document.querySelectorAll('[data-testid=api-diff-view] .cm-changedText')].filter((e) => e.offsetParent !== null).map((e) => e.textContent)`);
          await shot('03zg-response-diff-light');
          await js(`${visible('[data-testid=api-diff-headers]')}?.click()`);
          await wait(400);
          const withHeaders = await js(`${visible('[data-testid=api-diff-view] .cm-merge-b .cm-content')}?.textContent ?? ''`);
          check(
            'ui: Compare opens the kept responses side by side with the change marked, and Headers adds the status and headers',
            Array.isArray(pickers) && pickers.length === 2 && (pickers as number[]).every((n) => n >= 2) && (changed as string[]).some((t) => t.includes('4') || t.includes('2')) && String(withHeaders).startsWith('200 OK'),
            { pickers, changed, withHeaders: String(withHeaders).slice(0, 60) },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
          const diffProbe = (await run<ApiRequest[]>('api.request.list', {}, ws.id)).find((r) => r.name === 'diff probe');
          if (diffProbe) await run('api.request.delete', { id: diffProbe.id }, ws.id);
        }

        // Network in the UI: the Certificates tab lists a certificate, and Settings has the proxy.
        {
          const certs = path.join(process.cwd(), 'src', 'main', 'smoke', 'certs');
          const cert = await run<{ id: string }>('api.certificate.save', { certificate: { hostPattern: '*.internal.test', pfxPath: path.join(certs, 'client.p12'), caPath: path.join(certs, 'ca.crt'), passphrase: 'smoke-pass' } }, ws.id);
          await js(`document.querySelector('[data-testid=api-open-certificates]')?.click()`);
          await until(() => js(`Boolean(${visible('[data-testid=api-cert-row]')})`).then(Boolean), 3000);
          const certRow = await js(`${visible('[data-testid=api-cert-row]')}?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
          await shot('03zh-certificates-light');
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await run('api.certificate.delete', { id: cert.id }, ws.id);
          await js(`document.querySelector('button[aria-label^="Settings"]')?.click()`);
          await until(() => js(`Boolean(${visible('[data-testid=settings-network]')})`).then(Boolean), 3000);
          await js(`(() => { const s = ${visible('[data-testid=settings-proxy]')}; s.value = 'manual'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await wait(300);
          const proxyFields = await js(`Boolean(${visible('[data-testid=settings-proxy-url]')}) && ${visible('[data-testid=settings-no-proxy]')}?.value === 'localhost, 127.0.0.1, ::1'`);
          await js(`${visible('[data-testid=settings-network]')}?.scrollIntoView()`);
          await shot('03zi-settings-network-light');
          check(
            'ui: the Certificates tab lists a certificate with its file and passphrase, and Settings shows the proxy fields for a manual proxy',
            String(certRow).includes('*.internal.test') && String(certRow).includes('client.p12') && String(certRow).includes('passphrase') && proxyFields === true,
            { certRow, proxyFields },
          );
          await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
          await wait(300);
        }
      },
    };
  },
});
