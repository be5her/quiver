import { describe, expect, it } from 'vitest';
import {
  McpServerDraftSchema,
  capabilityLabels,
  describeMcpServer,
  expandEnvRefs,
  expandUriTemplate,
  joinCommandLine,
  newMcpServer,
  parseMcpConfig,
  skeletonFromSchema,
  splitCommandLine,
  templateVariables,
} from './mcp';

describe('command lines', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitCommandLine('npx -y @modelcontextprotocol/server-filesystem /tmp')).toEqual(['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    expect(splitCommandLine(`"C:\\Program Files\\nodejs\\node.exe" server.js --name 'a b'`)).toEqual(['C:\\Program Files\\nodejs\\node.exe', 'server.js', '--name', 'a b']);
    expect(splitCommandLine('python C:\\tools\\srv.py')).toEqual(['python', 'C:\\tools\\srv.py']);
    expect(splitCommandLine('node -e "console.log(\\"hi\\")"')).toEqual(['node', '-e', 'console.log("hi")']);
    expect(splitCommandLine('   ')).toEqual([]);
  });

  it('joins back with quoting and round-trips', () => {
    expect(joinCommandLine('node', ['a b', 'plain', ''])).toBe('node "a b" plain ""');
    const line = joinCommandLine('C:\\Program Files\\node.exe', ['say "hi"']);
    expect(splitCommandLine(line)).toEqual(['C:\\Program Files\\node.exe', 'say "hi"']);
    expect(joinCommandLine('', [])).toBe('');
  });
});

describe('environment references', () => {
  it('expands ${NAME} and ${NAME:-default}, leaving unknown names alone', () => {
    const env = { HOME: '/home/me', EMPTY: '' };
    expect(expandEnvRefs('${HOME}/.cache', env)).toBe('/home/me/.cache');
    expect(expandEnvRefs('${MISSING:-fallback}', env)).toBe('fallback');
    expect(expandEnvRefs('${EMPTY:-x}', env)).toBe('x');
    expect(expandEnvRefs('${MISSING}', env)).toBe('${MISSING}');
    expect(expandEnvRefs('no refs {{var}}', env)).toBe('no refs {{var}}');
  });
});

describe('parseMcpConfig', () => {
  it('reads Claude Code and Cursor style mcpServers', () => {
    const entries = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['-y', 'server'], env: { TOKEN: '${TOKEN}' } },
          remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
          legacy: { type: 'sse', url: 'https://example.com/sse' },
          urlOnly: { url: 'https://example.com/mcp' },
        },
      }),
    );
    expect(entries.map((e) => [e.name, e.draft.transport])).toEqual([
      ['fs', 'stdio'],
      ['remote', 'http'],
      ['legacy', 'sse'],
      ['urlOnly', 'http'],
    ]);
    expect(entries[0].draft.args).toEqual(['-y', 'server']);
    expect(entries[0].draft.env?.[0]).toMatchObject({ key: 'TOKEN', value: '${TOKEN}', enabled: true });
    expect(entries[1].draft.headers?.[0]).toMatchObject({ key: 'Authorization', value: 'Bearer x' });
    expect(McpServerDraftSchema.safeParse(entries[0].draft).success).toBe(true);
  });

  it('reads VS Code servers with comments and trailing commas', () => {
    const text = `{
      // project servers
      "servers": {
        "py": { "type": "stdio", "command": "python", "args": ["srv.py"], },
        "web": { "type": "http", "url": "http://localhost:3000/mcp" },
      },
      "inputs": []
    }`;
    const entries = parseMcpConfig(text);
    expect(entries.map((e) => e.name)).toEqual(['py', 'web']);
    expect(entries[0].draft.command).toBe('python');
    expect(entries[1].draft.url).toBe('http://localhost:3000/mcp');
  });

  it('ignores files without a server table', () => {
    expect(parseMcpConfig('{}')).toEqual([]);
    expect(parseMcpConfig('[]')).toEqual([]);
  });
});

describe('skeletonFromSchema', () => {
  it('fills required properties with placeholders and keeps defaults', () => {
    const skeleton = skeletonFromSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
        mode: { type: 'string', enum: ['fast', 'slow'] },
        verbose: { type: 'boolean', default: true },
        tags: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
        optional: { type: 'string' },
        either: { anyOf: [{ type: 'number' }, { type: 'string' }] },
      },
      required: ['name', 'count', 'mode', 'tags', 'nested', 'either'],
    });
    expect(skeleton).toEqual({ name: '', count: 0, mode: 'fast', verbose: true, tags: [], nested: { id: 0 }, either: 0 });
    expect(skeletonFromSchema({ type: 'object' })).toEqual({});
    expect(skeletonFromSchema(undefined)).toBeNull();
  });
});

describe('capabilityLabels', () => {
  it('names the announced capabilities', () => {
    expect(capabilityLabels({ tools: { listChanged: true }, resources: { subscribe: true }, prompts: {}, logging: {}, experimental: { x: {} } })).toEqual([
      'tools (list changes)',
      'resources (subscribe)',
      'prompts',
      'logging',
      'experimental: x',
    ]);
    expect(capabilityLabels(null)).toEqual([]);
  });
});

describe('URI templates', () => {
  it('lists variables and expands the common forms', () => {
    expect(templateVariables('file:///{path}{?rev,format}')).toEqual(['path', 'rev', 'format']);
    expect(expandUriTemplate('smoke://users/{id}', { id: '4 2' })).toBe('smoke://users/4%202');
    expect(expandUriTemplate('x://{+path}{?a,b}', { path: 'a/b', a: '1' })).toBe('x://a/b?a=1');
    expect(expandUriTemplate('x://{id}', {})).toBe('x://');
  });
});

describe('server model', () => {
  it('applies defaults and describes servers', () => {
    const server = newMcpServer({ name: 'fs', command: 'npx', args: ['-y', 'server'] });
    expect(server.transport).toBe('stdio');
    expect(server.logLimit).toBe(500);
    expect(describeMcpServer(server)).toBe('npx -y server');
    expect(describeMcpServer({ transport: 'http', command: '', args: [], url: 'https://api.example.com/mcp?x=1' })).toBe('HTTP api.example.com');
    expect(describeMcpServer({ transport: 'sse', command: '', args: [], url: '' })).toBe('SSE no URL');
  });
});
