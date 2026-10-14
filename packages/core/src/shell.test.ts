import { describe, expect, it } from 'vitest';
import { detectShellDialect, tokenizeCmd, tokenizePosix, tokenizePowerShell, type ShellDialect } from './shell';

const values = (tokens: { value: string }[]) => tokens.map((t) => t.value);

describe('detectShellDialect', () => {
  it.each<[string, ShellDialect]>([
    ['curl ^"https://x.test^" ^\n  -H ^"a: b^"', 'cmd'],
    ['curl ^"https://x.test^"', 'cmd'],
    ['curl https://x.test ^\n  -k', 'cmd'],
    ['curl.exe https://x.test', 'powershell'],
    ["curl 'https://x.test' `\n  -H 'a: b'", 'powershell'],
    ["curl 'https://x.test' \\\n  -H 'a: b'", 'posix'],
    ["curl 'https://x.test' --data-raw $'a\\nb'", 'posix'],
    // A caret or backtick inside a POSIX quote is not a continuation.
    ["curl 'https://x.test' --data-raw '^\"x'", 'posix'],
  ])('%j is %s', (source, dialect) => {
    expect(detectShellDialect(source)).toBe(dialect);
  });
});

describe('tokenizePosix', () => {
  it.each<[string, string[]]>([
    [`a 'b c' "d e"`, ['a', 'b c', 'd e']],
    [`'it'\\''s'`, ["it's"]],
    [`"a \\" \\\\ \\$ \\\` \\x"`, ['a " \\ $ ` \\x']],
    [`$'x\\ny\\t\\\\\\'\\x41\\u00e9\\101'`, ["x\ny\t\\'AéA"]],
    [`a\\ b \\'c`, ['a b', "'c"]],
    [`a \\\n  b \\\r\n  c`, ['a', 'b', 'c']],
    [`'' ""`, ['', '']],
    [`a # comment\nb`, ['a', 'b']],
    [`"a$"`, ['a$']],
  ])('%j', (source, expected) => {
    expect(values(tokenizePosix(source))).toEqual(expected);
  });

  it.each([
    [`'abc`, /bash\/zsh: unterminated ' quote starting at line 1, column 1/],
    [`a "b`, /unterminated " quote starting at line 1, column 3/],
    [`$'abc`, /unterminated \$' quote/],
    [`a $HOME`, /expand/],
    [`a "$(id)"`, /expand/],
    ['a `id`', /command substitution/],
    [`a https://x?a=1&b=2`, /unquoted & /],
  ])('rejects %j', (source, error) => {
    expect(() => tokenizePosix(source)).toThrow(error);
  });
});

describe('tokenizeCmd', () => {
  it.each<[string, string[]]>([
    // cmd layer
    ['^"a b^"', ['a b']],
    ['a^&b', ['a&b']],
    ['a ^\n  b', ['a', 'b']],
    ['^"x^\n\ny^"', ['x\ny']],
    ['^"x^\r\n\r\ny^"', ['x\ny']],
    ['"a^b"', ['a^b']],
    ['%^2F', ['%2F']],
    // MSVC argv layer
    ['^"a \\^"b\\^" c^"', ['a "b" c']],
    ['a\\b', ['a\\b']],
    ['a\\\\"b c"', ['a\\b c']],
    ['a\\\\\\"b', ['a\\"b']],
    ['^"^"', ['']],
  ])('%j', (source, expected) => {
    expect(values(tokenizeCmd(source))).toEqual(expected);
  });

  it.each([
    ['curl ^"https://x.test', /cmd\.exe: unterminated quote .* at line 1, column 6/],
    ['curl "abc', /unterminated quote/],
    ['curl a&b', /unescaped &/],
    ['curl a^', /\^ at the end/],
  ])('rejects %j', (source, error) => {
    expect(() => tokenizeCmd(source)).toThrow(error);
  });
});

describe('tokenizePowerShell', () => {
  it.each<[string, string[]]>([
    [`'it''s' "a \`"b\`" c"`, ["it's", 'a "b" c']],
    ['"x`ny`t``"', ['x\ny\t`']],
    ['a `\n  b `\r\n  c', ['a', 'b', 'c']],
    ['"a""b"', ['a"b']],
    ['"cost `$5"', ['cost $5']],
    ['& curl.exe x', ['curl.exe', 'x']],
    ['“typographic” ‘quotes’', ['typographic', 'quotes']],
  ])('%j', (source, expected) => {
    expect(values(tokenizePowerShell(source))).toEqual(expected);
  });

  it.each([
    [`'abc`, /PowerShell: unterminated ' quote/],
    [`"abc`, /unterminated " quote/],
    [`"$env:TOKEN"`, /expand/],
    [`{{baseUrl}}/a`, /unquoted \{/],
  ])('rejects %j', (source, error) => {
    expect(() => tokenizePowerShell(source)).toThrow(error);
  });
});
