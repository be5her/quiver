import { describe, expect, it } from 'vitest';
import {
  ENV_MASK,
  appendDotenvComment,
  buildDotenv,
  classifyEnvFile,
  compareEnvFiles,
  diffDotenv,
  dotenvEntries,
  dotenvToMap,
  isEnvFileName,
  maskDotenv,
  normalizeEnvPath,
  parseDotenv,
  quoteDotenvValue,
  removeDotenvKey,
  serializeDotenv,
  setDotenvValue,
} from './env';

const SAMPLE = `# Database
DB_HOST=localhost
DB_PORT = 5432
export DB_PASSWORD='p#ss word' # keep quiet
DB_URL="postgres://app:\${DB_PASSWORD}@\${DB_HOST}/app"
GREETING="hello
world" # two lines
API_KEY=abc123 # inline
EMPTY=
YAML: style value
SINGLE='it''s'
TICK=\`raw $x\`
ESCAPED="tab\\there \\"quoted\\""
DB_HOST=override
this line is broken

UNCLOSED="oops # trailing
`;

describe('parseDotenv', () => {
  const doc = parseDotenv(SAMPLE);
  const entries = dotenvEntries(doc);
  const byKey = (key: string) => entries.filter((e) => e.key === key);

  it('keeps comments, blanks and invalid lines and round-trips byte for byte', () => {
    expect(doc.lines.filter((l) => l.kind === 'comment')).toHaveLength(1);
    expect(doc.lines.filter((l) => l.kind === 'blank')).toHaveLength(1);
    expect(doc.lines.filter((l) => l.kind === 'invalid').map((l) => l.raw[0])).toEqual(['this line is broken']);
    expect(serializeDotenv(doc)).toBe(SAMPLE);
  });

  it('reads unquoted, spaced, exported and yaml-style pairs', () => {
    expect(byKey('DB_HOST')[0].value).toBe('localhost');
    expect(byKey('DB_PORT')[0].value).toBe('5432');
    expect(byKey('DB_PASSWORD')[0]).toMatchObject({ value: 'p#ss word', exported: true, quote: "'", comment: 'keep quiet', secret: true });
    expect(byKey('YAML')[0].value).toBe('style value');
    expect(byKey('EMPTY')[0].value).toBe('');
  });

  it('cuts unquoted values at the first hash and keeps the comment', () => {
    expect(byKey('API_KEY')[0]).toMatchObject({ value: 'abc123', comment: 'inline', secret: true });
  });

  it('expands escapes in double quotes only', () => {
    expect(byKey('ESCAPED')[0].value).toBe('tab\there "quoted"');
    expect(byKey('SINGLE')[0].value).toBe('it');
    expect(byKey('TICK')[0].value).toBe('raw $x');
    expect(byKey('TICK')[0].interpolates).toBe(false);
  });

  it('joins quoted values that span lines', () => {
    const g = byKey('GREETING')[0];
    expect(g.value).toBe('hello\nworld');
    expect(g.comment).toBe('two lines');
    expect(g.line).toBe(6);
    expect(byKey('API_KEY')[0].line).toBe(8);
  });

  it('treats an unclosed quote as an unquoted value', () => {
    expect(byKey('UNCLOSED')[0]).toMatchObject({ value: '"oops', quote: null, comment: 'trailing' });
  });

  it('flags duplicates, interpolation and secrets; the last duplicate wins', () => {
    expect(byKey('DB_HOST').map((e) => e.shadowed)).toEqual([true, false]);
    expect(dotenvToMap(doc).DB_HOST).toBe('override');
    expect(byKey('DB_URL')[0]).toMatchObject({ interpolates: true, secret: true });
    expect(byKey('GREETING')[0].secret).toBe(false);
  });

  it('keeps CRLF and a missing trailing newline', () => {
    const crlf = parseDotenv('A=1\r\nB=2');
    expect(crlf.eol).toBe('\r\n');
    expect(crlf.trailingNewline).toBe(false);
    expect(serializeDotenv(crlf)).toBe('A=1\r\nB=2');
    expect(serializeDotenv(setDotenvValue(crlf, 'C', '3'))).toBe('A=1\r\nB=2\r\nC=3\r\n');
  });
});

describe('editing', () => {
  it('rewrites only the effective line and keeps quote style and comment', () => {
    const doc = parseDotenv(SAMPLE);
    const next = setDotenvValue(doc, 'DB_PASSWORD', 'new one');
    const text = serializeDotenv(next);
    expect(text).toContain("export DB_PASSWORD='new one' # keep quiet");
    expect(text.split('\n').length).toBe(SAMPLE.split('\n').length);
    expect(dotenvToMap(next).DB_PASSWORD).toBe('new one');
    const host = serializeDotenv(setDotenvValue(doc, 'DB_HOST', 'db.internal'));
    expect(host).toContain('DB_HOST=localhost');
    expect(host).toContain('DB_HOST=db.internal');
    expect(host).not.toContain('DB_HOST=override');
  });

  it('appends a missing key, quoting when needed, and replaces or drops comments on request', () => {
    const doc = parseDotenv('A=1');
    let text = serializeDotenv(setDotenvValue(doc, 'B', 'has space', { comment: 'why' }));
    expect(text).toBe('A=1\nB="has space" # why\n');
    text = serializeDotenv(setDotenvValue(parseDotenv('A=1 # old'), 'A', '2', { comment: null }));
    expect(text).toBe('A=2');
    text = serializeDotenv(setDotenvValue(parseDotenv('A="x"\n'), 'A', ''));
    expect(text).toBe('A=""\n');
    expect(() => setDotenvValue(doc, 'bad key', 'x')).toThrow(/Invalid key/);
  });

  it('removes every occurrence of a key', () => {
    const { doc, removed } = removeDotenvKey(parseDotenv(SAMPLE), 'DB_HOST');
    expect(removed).toBe(true);
    expect(dotenvEntries(doc).some((e) => e.key === 'DB_HOST')).toBe(false);
    expect(removeDotenvKey(doc, 'NOPE').removed).toBe(false);
  });

  it('quotes values the way an author would', () => {
    expect(quoteDotenvValue('plain')).toBe('plain');
    expect(quoteDotenvValue('with space')).toBe('"with space"');
    expect(quoteDotenvValue('a#b')).toBe('"a#b"');
    expect(quoteDotenvValue('line\nbreak')).toBe('"line\\nbreak"');
    expect(quoteDotenvValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteDotenvValue('plain', '"')).toBe('"plain"');
    expect(quoteDotenvValue("it's", "'")).toBe('"it\'s"');
    expect(quoteDotenvValue('$HOME/x')).toBe('"$HOME/x"');
  });

  it('masks secrets in the text without touching other lines', () => {
    const masked = serializeDotenv(maskDotenv(parseDotenv(SAMPLE)));
    expect(masked).toContain(`export DB_PASSWORD='${ENV_MASK}' # keep quiet`);
    expect(masked).toContain(`API_KEY=${ENV_MASK} # inline`);
    expect(masked).toContain('DB_HOST=localhost');
    expect(masked).toContain('GREETING="hello\nworld"');
  });

  it('appends comments and builds files', () => {
    expect(serializeDotenv(appendDotenvComment(parseDotenv('A=1\n'), 'Added'))).toBe('A=1\n\n# Added\n');
    expect(buildDotenv([{ key: 'A', value: '1' }, { key: 'B', value: 'x y', comment: 'c' }], 'Exported')).toBe('# Exported\nA=1\nB="x y" # c\n');
  });
});

describe('files', () => {
  it('recognises and classifies env file names', () => {
    expect(['.env', '.env.local', '.env.production', 'docker.env', 'a.env'].every(isEnvFileName)).toBe(true);
    expect(['env', '.environment', 'x.envrc', '.env-old'].some(isEnvFileName)).toBe(false);
    expect(classifyEnvFile('.env')).toEqual({ kind: 'main', profile: null });
    expect(classifyEnvFile('.env.example')).toEqual({ kind: 'example', profile: null });
    expect(classifyEnvFile('.env.sample')).toEqual({ kind: 'example', profile: null });
    expect(classifyEnvFile('.env.local')).toEqual({ kind: 'local', profile: null });
    expect(classifyEnvFile('.env.production.local')).toEqual({ kind: 'local', profile: 'production' });
    expect(classifyEnvFile('.env.staging')).toEqual({ kind: 'profile', profile: 'staging' });
    expect(classifyEnvFile('docker.env')).toEqual({ kind: 'other', profile: null });
  });

  it('diffs two files by key', () => {
    const a = dotenvEntries(parseDotenv('A=1\nB=\nC=3\nD=4'));
    const b = dotenvEntries(parseDotenv('A=1\nB=2\nC=x\nE=5'));
    expect(diffDotenv('.env', a, '.env.example', b)).toEqual({ path: '.env', against: '.env.example', missing: ['E'], extra: ['D'], empty: ['B'], different: ['C'], same: ['A'] });
  });

  it('normalises and orders paths', () => {
    expect(normalizeEnvPath('.\\apps\\web\\.env')).toBe('apps/web/.env');
    expect(normalizeEnvPath('/.env')).toBe('.env');
    const files = [
      { dir: 'apps/web', kind: 'main' as const, name: '.env' },
      { dir: '', kind: 'example' as const, name: '.env.example' },
      { dir: '', kind: 'main' as const, name: '.env' },
      { dir: '', kind: 'profile' as const, name: '.env.staging' },
    ];
    expect([...files].sort(compareEnvFiles).map((f) => `${f.dir}/${f.name}`)).toEqual(['/.env', '/.env.staging', '/.env.example', 'apps/web/.env']);
  });
});
