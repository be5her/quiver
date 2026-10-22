import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CLI_EXIT,
  CliUsageError,
  appDataFolder,
  cliPathLines,
  coerceValue,
  exampleFor,
  exitCodeForError,
  fieldRows,
  fieldsToInput,
  lookupSecret,
  parseCliArgs,
  parseTimeout,
  resolveFieldName,
  resultFailures,
  secretEnvName,
  typeLabel,
  type JsonSchema,
} from './cli-args';

/** The schema a command's input reaches the CLI as, exactly as the host writes it. */
const schemaOf = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as JsonSchema;

const runInput = schemaOf(
  z.object({
    collectionId: z.string(),
    environmentId: z.string().nullable().optional(),
    recursive: z.boolean().optional(),
    delayMs: z.number().int().min(0).optional(),
    mode: z.enum(['soft', 'hard']).optional(),
    paths: z.array(z.string()).optional(),
    auth: z.object({ type: z.string(), token: z.string().optional() }).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    value: z.unknown().optional(),
    ratio: z.number().optional(),
  }),
);

describe('parseCliArgs', () => {
  it('reads a command with field flags in both spellings', () => {
    const parsed = parseCliArgs(['todo.add', '--title', 'write the notes', '--notes=a=b', '--done']);
    expect(parsed.verb).toBe('run');
    expect(parsed.target).toBe('todo.add');
    expect(parsed.fields).toEqual([
      { name: 'title', value: 'write the notes' },
      { name: 'notes', value: 'a=b' },
      { name: 'done', value: true },
    ]);
  });

  it('takes the CLI options anywhere, and leaves the rest to the command', () => {
    const parsed = parseCliArgs(['--workspace', '/p', 'run', 'api.collection.run', '--collection', 'c1', '--json', '--reporter', 'junit', '--out', 'r.xml', '--timeout', '90', '-q', '--data-dir=/d', '--secrets', 's.json', '--user-data-dir', '/u']);
    expect(parsed).toMatchObject({ verb: 'run', target: 'api.collection.run', fields: [{ name: 'collection', value: 'c1' }] });
    expect(parsed.options).toEqual({ workspace: '/p', json: true, quiet: true, headless: 'off', all: false, reporter: 'junit', out: 'r.xml', timeoutMs: 90_000, dataDir: '/d', secrets: 's.json', userDataDir: '/u' });
  });

  it('knows the headless modes', () => {
    expect(parseCliArgs(['--headless', 'todo.list']).options.headless).toBe('on');
    expect(parseCliArgs(['todo.list', '--headless=auto']).options.headless).toBe('auto');
    expect(() => parseCliArgs(['--headless=sometimes', 'todo.list'])).toThrow(CliUsageError);
  });

  it('a bare flag before another flag is true, and a negative number is a value', () => {
    expect(parseCliArgs(['x.y', '--force', '--offset', '-5']).fields).toEqual([
      { name: 'force', value: true },
      { name: 'offset', value: '-5' },
    ]);
  });

  it('knows list, describe, help and version', () => {
    expect(parseCliArgs([])).toMatchObject({ verb: 'help' });
    expect(parseCliArgs(['--help'])).toMatchObject({ verb: 'help' });
    expect(parseCliArgs(['--version'])).toMatchObject({ verb: 'version' });
    expect(parseCliArgs(['list', 'git', '--all'])).toMatchObject({ verb: 'list', target: 'git', options: { all: true }, fields: [] });
    expect(parseCliArgs(['describe', 'todo.add'])).toMatchObject({ verb: 'describe', target: 'todo.add' });
    expect(parseCliArgs(['help', 'todo.add'])).toMatchObject({ verb: 'describe', target: 'todo.add' });
    expect(parseCliArgs(['todo.add', '--help'])).toMatchObject({ verb: 'describe', target: 'todo.add' });
  });

  it('keeps --all a field outside list', () => {
    expect(parseCliArgs(['git.stage', '--all']).fields).toEqual([{ name: 'all', value: true }]);
  });

  it('refuses what it cannot use', () => {
    for (const argv of [['run'], ['describe'], ['todo.add', 'stray'], ['list', '--title', 'x'], ['--timeout'], ['--reporter', 'tap', 'x.y'], ['-x'], ['notacommand'], ['todo.add', '--json=yes'], ['todo.add', '---x']]) {
      expect(() => parseCliArgs(argv), argv.join(' ')).toThrow(CliUsageError);
    }
  });

  it('passes everything after -- on as positional', () => {
    expect(() => parseCliArgs(['todo.add', '--', '--title'])).toThrow(/Unexpected argument "--title"/);
  });
});

describe('parseTimeout', () => {
  it('reads seconds and units', () => {
    expect(parseTimeout('30')).toBe(30_000);
    expect(parseTimeout('1.5')).toBe(1500);
    expect(parseTimeout('500ms')).toBe(500);
    expect(parseTimeout('2m')).toBe(120_000);
    expect(() => parseTimeout('soon')).toThrow(CliUsageError);
    expect(() => parseTimeout('0')).toThrow(CliUsageError);
  });
});

describe('resolveFieldName', () => {
  it('matches exact, kebab-case, a left-off Id and no-', () => {
    expect(resolveFieldName('collectionId', runInput)).toEqual({ key: 'collectionId', negate: false });
    expect(resolveFieldName('collection', runInput)).toEqual({ key: 'collectionId', negate: false });
    expect(resolveFieldName('environment-id', runInput)).toEqual({ key: 'environmentId', negate: false });
    expect(resolveFieldName('delay-ms', runInput)).toEqual({ key: 'delayMs', negate: false });
    expect(resolveFieldName('no-recursive', runInput)).toEqual({ key: 'recursive', negate: true });
  });

  it('refuses a name an object does not list, but a record takes any key', () => {
    expect(resolveFieldName('colection', runInput)).toBeNull();
    expect(resolveFieldName('no-collection', runInput)).toBeNull();
    expect(resolveFieldName('X-Trace', runInput.properties!.headers)).toEqual({ key: 'X-Trace', negate: false });
    expect(resolveFieldName('anything', undefined)).toEqual({ key: 'anything', negate: false });
  });
});

describe('coerceValue', () => {
  const p = runInput.properties!;
  it('turns text into the type the schema wants', () => {
    expect(coerceValue('250', p.delayMs, 'delay-ms')).toBe(250);
    expect(coerceValue('0.5', p.ratio, 'ratio')).toBe(0.5);
    expect(coerceValue('false', p.recursive, 'recursive')).toBe(false);
    expect(coerceValue(true, p.recursive, 'recursive')).toBe(true);
    expect(coerceValue('null', p.environmentId, 'environment')).toBeNull();
    expect(coerceValue('42', p.collectionId, 'collection')).toBe('42');
    expect(coerceValue('a.txt', p.paths, 'paths')).toEqual(['a.txt']);
    expect(coerceValue('["a","b"]', p.paths, 'paths')).toEqual(['a', 'b']);
    expect(coerceValue('{"type":"bearer"}', p.auth, 'auth')).toEqual({ type: 'bearer' });
    expect(coerceValue('{"n":1}', p.value, 'value')).toEqual({ n: 1 });
    expect(coerceValue('plain', p.value, 'value')).toBe('plain');
  });

  it('says what was wrong', () => {
    expect(() => coerceValue('soon', p.delayMs, 'delay-ms')).toThrow(/takes a number/);
    expect(() => coerceValue('1.5', p.delayMs, 'delay-ms')).toThrow(/whole number/);
    expect(() => coerceValue(true, p.collectionId, 'collection')).toThrow(/needs a value/);
    expect(() => coerceValue('yes', p.recursive, 'recursive')).toThrow(/true or false/);
    expect(() => coerceValue('{oops', p.auth, 'auth')).toThrow(/not valid JSON/);
  });
});

describe('fieldsToInput', () => {
  it('builds the input, nested and repeated, on top of --input', () => {
    const input = fieldsToInput(
      [
        { name: 'collection', value: 'c1' },
        { name: 'no-recursive', value: true },
        { name: 'paths', value: 'a' },
        { name: 'paths', value: 'b' },
        { name: 'auth.type', value: 'bearer' },
        { name: 'auth.token', value: 't' },
        { name: 'headers.X-Trace', value: '1' },
      ],
      runInput,
      { collectionId: 'from-input', delayMs: 5 },
    );
    expect(input).toEqual({ collectionId: 'c1', delayMs: 5, recursive: false, paths: ['a', 'b'], auth: { type: 'bearer', token: 't' }, headers: { 'X-Trace': '1' } });
  });

  it('refuses unknown and twice-given fields', () => {
    expect(() => fieldsToInput([{ name: 'colection', value: 'x' }], runInput, {}, 'api.collection.run')).toThrow(/Unknown field --colection for api.collection.run/);
    expect(() => fieldsToInput([{ name: 'collection', value: 'a' }, { name: 'collection', value: 'b' }], runInput)).toThrow(/given twice/);
    expect(() => fieldsToInput([{ name: 'collection.x', value: 'a' }], runInput)).toThrow(CliUsageError);
    // Inherited names never resolve, also in a record that takes any key, so nothing reaches Object.prototype.
    const record = { type: 'object', properties: { headers: { type: 'object', additionalProperties: { type: 'string' } } } } as const;
    expect(() => fieldsToInput([{ name: '__proto__.polluted', value: 'x' }], record)).toThrow(CliUsageError);
    expect(() => fieldsToInput([{ name: 'headers.__proto__.polluted', value: 'x' }], record)).toThrow(CliUsageError);
    expect(() => fieldsToInput([{ name: 'constructor', value: 'x' }], runInput)).toThrow(CliUsageError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(fieldsToInput([{ name: 'headers.x-trace', value: '1' }], record)).toEqual({ headers: { 'x-trace': '1' } });
    expect(() => fieldsToInput([{ name: 'x', value: 'a' }], schemaOf(z.object({})))).toThrow(/Unknown field/);
  });

  it('does not change the --input it builds on', () => {
    const base = { auth: { type: 'basic' } };
    fieldsToInput([{ name: 'auth.type', value: 'bearer' }], runInput, base);
    expect(base.auth.type).toBe('basic');
  });
});

describe('describe helpers', () => {
  it('labels types', () => {
    const p = runInput.properties!;
    expect(typeLabel(p.collectionId)).toBe('string');
    expect(typeLabel(p.environmentId)).toBe('string | null');
    expect(typeLabel(p.mode)).toBe('soft | hard');
    expect(typeLabel(p.paths)).toBe('string[]');
    expect(typeLabel(p.delayMs)).toBe('integer');
  });

  it('lists fields with the required ones first', () => {
    const rows = fieldRows(schemaOf(z.object({ notes: z.string().optional().describe('More text'), title: z.string() })));
    expect(rows).toEqual([
      { name: 'title', type: 'string', required: true },
      { name: 'notes', type: 'string', required: false, description: 'More text' },
    ]);
  });

  it('gives an example with the required fields', () => {
    const example = exampleFor('git.reset', schemaOf(z.object({ ref: z.string(), mode: z.enum(['soft', 'hard']), force: z.boolean(), paths: z.array(z.string()).min(1), note: z.string().optional() })));
    expect(example.args).toEqual(['quiver', 'git.reset', '--ref', '<string>', '--mode', 'soft', '--force', '--paths', `'[]'`]);
    expect(example.input).toEqual({ ref: '', mode: 'soft', force: false, paths: [] });
    expect(exampleFor('todo.list', schemaOf(z.object({}))).args).toEqual(['quiver', 'todo.list']);
  });
});

describe('results and exit codes', () => {
  it('counts failed checks in a run and in a response', () => {
    expect(resultFailures({ items: [], failed: 2, status: 'failed' })).toBe(2);
    expect(resultFailures({ items: [], failed: 0, status: 'failed' })).toBe(1);
    expect(resultFailures({ items: [], failed: 0, status: 'passed' })).toBe(0);
    expect(resultFailures({ status: 200, checks: [{ ok: true }, { ok: false }] })).toBe(1);
    expect(resultFailures([{ ok: false }])).toBe(0);
    expect(resultFailures('text')).toBe(0);
  });

  it('maps host errors to exit codes', () => {
    expect(exitCodeForError('INVALID_INPUT')).toBe(CLI_EXIT.usage);
    expect(exitCodeForError('UNKNOWN_COMMAND')).toBe(CLI_EXIT.usage);
    expect(exitCodeForError('NOT_FOUND')).toBe(CLI_EXIT.failed);
    expect(exitCodeForError('SECRET_UNAVAILABLE')).toBe(CLI_EXIT.failed);
  });
});

describe('secrets for headless runs', () => {
  it('names the environment variable after the secret', () => {
    expect(secretEnvName('token')).toBe('QUIVER_SECRET_TOKEN');
    expect(secretEnvName('apiToken')).toBe('QUIVER_SECRET_API_TOKEN');
    expect(secretEnvName('api.token')).toBe('QUIVER_SECRET_API_TOKEN');
    expect(secretEnvName(' fina-token ')).toBe('QUIVER_SECRET_FINA_TOKEN');
  });

  it('reads the file first, then the environment', () => {
    const env = { QUIVER_SECRET_TOKEN: 'from-env', QUIVER_SECRET_API_KEY: 'k-env' };
    expect(lookupSecret('token', env)).toBe('from-env');
    expect(lookupSecret('token', env, { token: 'from-file' })).toBe('from-file');
    expect(lookupSecret('apiKey', env, { 'api-key': 'k-file' })).toBe('k-file');
    expect(lookupSecret('missing', env, { missing: 3 })).toBeUndefined();
    expect(lookupSecret('  ', env)).toBeUndefined();
  });
});

describe('where things are', () => {
  it('finds the OS application data folder', () => {
    expect(appDataFolder('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a')).toBe('C:\\Users\\a\\AppData\\Roaming');
    expect(appDataFolder('darwin', {}, '/Users/a')).toBe('/Users/a/Library/Application Support');
    expect(appDataFolder('linux', { XDG_CONFIG_HOME: '/x' }, '/home/a')).toBe('/x');
    expect(appDataFolder('linux', {}, '/home/a')).toBe('/home/a/.config');
  });

  it('writes PATH lines that quote the folder', () => {
    const win = cliPathLines('win32', "C:\\Program Files\\Bob's Quiver\\resources\\cli");
    expect(win[0].line).toBe("[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';C:\\Program Files\\Bob''s Quiver\\resources\\cli', 'User')");
    expect(win[1].line).toBe("$env:Path += ';C:\\Program Files\\Bob''s Quiver\\resources\\cli'");
    const mac = cliPathLines('darwin', '/Applications/Quiver.app/Contents/Resources/cli');
    expect(mac[0]).toEqual({ shell: 'zsh', line: `echo 'export PATH="$PATH:'"/Applications/Quiver.app/Contents/Resources/cli"'"' >> ~/.zshrc` });
    expect(mac[1].line).toBe('sudo ln -sf "/Applications/Quiver.app/Contents/Resources/cli"/quiver /usr/local/bin/quiver');
    expect(cliPathLines('linux', '/opt/Quiver/resources/cli')[0].line).toContain('>> ~/.bashrc');
  });
});
