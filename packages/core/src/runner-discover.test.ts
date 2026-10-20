import { describe, expect, it } from 'vitest';
import {
  discoverComposeServices,
  discoverJustRecipes,
  discoverMakeTargets,
  discoverPackageScripts,
  matchSegment,
  normalizePattern,
  packageName,
  pickPackageManager,
  shellWord,
  workspacePatterns,
} from './runner-discover';

const root = { cwd: '', label: '' };

describe('pickPackageManager', () => {
  it('takes the packageManager field first', () => {
    expect(pickPackageManager('{"packageManager":"pnpm@9.1.0"}', ['package-lock.json'])).toBe('pnpm');
    expect(pickPackageManager('{"packageManager":"yarn@4.0.0+sha256.abc"}', [])).toBe('yarn');
  });

  it('falls back to the lockfile, then npm', () => {
    expect(pickPackageManager('{}', ['README.md', 'yarn.lock'])).toBe('yarn');
    expect(pickPackageManager('{}', ['pnpm-lock.yaml', 'package-lock.json'])).toBe('pnpm');
    expect(pickPackageManager('{"packageManager":"bun@1"}', ['package-lock.json'])).toBe('npm');
    expect(pickPackageManager(null, [])).toBe('npm');
    expect(pickPackageManager('not json', ['yarn.lock'])).toBe('yarn');
  });
});

describe('workspacePatterns', () => {
  it('reads workspaces as a list, as { packages }, and from pnpm-workspace.yaml', () => {
    expect(workspacePatterns('{"workspaces":["packages/*","./apps/web/"]}')).toEqual(['packages/*', 'apps/web']);
    expect(workspacePatterns('{"workspaces":{"packages":["libs/*"],"nohoist":["x"]}}')).toEqual(['libs/*']);
    expect(workspacePatterns('{}', "packages:\n  - 'tools/*'\n  - '!tools/old'\n")).toEqual(['tools/*', '!tools/old']);
  });

  it('gives nothing for broken files', () => {
    expect(workspacePatterns('{', 'packages: [')).toEqual([]);
    expect(workspacePatterns(null, null)).toEqual([]);
  });

  it('normalizes patterns and leaves out those that would leave the workspace folder', () => {
    const patterns = ['..\\..\\x', '../x', '/etc', 'C:/x', 'c:x', 'a/../b', '!../x', '.', 'packages//web/', 'apps\\*', '**/**/pkg', '! ./old', '..foo/*'];
    expect(workspacePatterns(JSON.stringify({ workspaces: patterns }))).toEqual(['packages/web', 'apps/*', '**/pkg', '!old', '..foo/*']);
  });
});

describe('normalizePattern', () => {
  it('keeps the ! of an exclusion and refuses climbing out', () => {
    expect(normalizePattern('!packages/./old/')).toBe('!packages/old');
    expect(normalizePattern('!..\\x')).toBeNull();
    expect(normalizePattern('a/**/**/**/b')).toBe('a/**/b');
    expect(normalizePattern('  ')).toBeNull();
  });
});

describe('matchSegment', () => {
  it('matches * and ? and nothing else as a wildcard', () => {
    expect(matchSegment('*', 'core')).toBe(true);
    expect(matchSegment('*', '')).toBe(true);
    expect(matchSegment('app-*', 'app-web')).toBe(true);
    expect(matchSegment('app-*', 'lib-web')).toBe(false);
    expect(matchSegment('v?', 'v2')).toBe(true);
    expect(matchSegment('v?', 'v')).toBe(false);
    expect(matchSegment('a.b', 'axb')).toBe(false);
    expect(matchSegment('*-web-*', 'my-web-app')).toBe(true);
    expect(matchSegment('*a*b', 'xaxbxb')).toBe(true);
    expect(matchSegment('*a*b', 'xaxbxc')).toBe(false);
    expect(matchSegment('(x)[y]', '(x)[y]')).toBe(true);
  });

  it('answers at once for patterns a regular expression would backtrack on', () => {
    const started = Date.now();
    expect(matchSegment(`${'*'.repeat(40)}z`, 'a'.repeat(255))).toBe(false);
    expect(matchSegment(`${'*a'.repeat(30)}b`, 'a'.repeat(255))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('packageName', () => {
  it('reads the name or gives null', () => {
    expect(packageName('{"name":"@quiver/core"}')).toBe('@quiver/core');
    expect(packageName('{"name":""}')).toBeNull();
    expect(packageName('nope')).toBeNull();
  });
});

describe('shellWord', () => {
  it('keeps plain words and double-quotes those that mean nothing to sh or cmd.exe inside quotes', () => {
    expect(shellWord('build:prod')).toBe('build:prod');
    expect(shellWord('docs/serve')).toBe('docs/serve');
    expect(shellWord('my script')).toBe('"my script"');
    expect(shellWord('lint & fix')).toBe('"lint & fix"');
    expect(shellWord("it's (ok) | <yes>; ^")).toBe(`"it's (ok) | <yes>; ^"`);
  });

  it('gives null for what either shell would read differently, and for options', () => {
    for (const word of ['a"b', 'a"&calc&"', '100%', 'x%OS%y', '$HOME', 'a`id`', 'a\\b', 'wow!', 'a\nb', 'a\tb', '', '-x', '--eval=1']) expect(shellWord(word)).toBeNull();
  });
});

describe('discoverPackageScripts', () => {
  const pkg = JSON.stringify({
    scripts: { dev: 'vite', prebuild: 'rm -rf dist', build: 'vite build', postinstall: 'husky', 'test:unit': 'vitest', 'pretty please': 'x', preview: 'vite preview', nope: 1 },
  });

  it('lists the scripts with the package manager, without lifecycle scripts and pre/post hooks', () => {
    expect(discoverPackageScripts(pkg, 'pnpm', root)).toEqual([
      { source: 'npm', name: 'dev', command: 'pnpm run dev', cwd: '', file: 'package.json' },
      { source: 'npm', name: 'build', command: 'pnpm run build', cwd: '', file: 'package.json' },
      { source: 'npm', name: 'test:unit', command: 'pnpm run test:unit', cwd: '', file: 'package.json' },
      { source: 'npm', name: 'pretty please', command: 'pnpm run "pretty please"', cwd: '', file: 'package.json' },
      // "preview" is not a hook: there is no "view" script.
      { source: 'npm', name: 'preview', command: 'pnpm run preview', cwd: '', file: 'package.json' },
    ]);
  });

  it('names a workspace package script after its package and runs it in its folder', () => {
    expect(discoverPackageScripts('{"scripts":{"test":"vitest"}}', 'npm', { cwd: 'packages/core', label: '@q/core' })).toEqual([
      { source: 'npm', name: '@q/core: test', command: 'npm run test', cwd: 'packages/core', file: 'packages/core/package.json' },
    ]);
  });

  it('gives nothing without scripts or for broken json', () => {
    expect(discoverPackageScripts('{"name":"x"}', 'npm', root)).toEqual([]);
    expect(discoverPackageScripts('{', 'npm', root)).toEqual([]);
    expect(discoverPackageScripts('{"scripts":["echo x"]}', 'npm', root)).toEqual([]);
  });

  it('treats only pre<script> and post<script> of a script that exists as hooks', () => {
    const scripts = { view: 'x', preview: 'x', postcss: 'x', pre: 'x', post: 'x', prepost: 'x' };
    expect(discoverPackageScripts(JSON.stringify({ scripts }), 'npm', root).map((t) => t.name)).toEqual(['view', 'postcss', 'pre', 'post']);
  });

  it('leaves out scripts whose names a shell would read as something else', () => {
    const scripts = { ok: 'x', 'say "hi"': 'x', 'a"&calc&"': 'x', 'x%PATH%': 'x', 'two\nlines': 'x', '--flag': 'x', 'and & or': 'x' };
    expect(discoverPackageScripts(JSON.stringify({ scripts }), 'npm', root).map((t) => t.command)).toEqual(['npm run ok', 'npm run "and & or"']);
  });
});

describe('discoverMakeTargets', () => {
  it('lists explicit targets and skips special, pattern, variable and recipe lines', () => {
    const text = [
      '.PHONY: build test',
      'CC := gcc',
      'FLAGS = -a:b',
      'X ::= y',
      'OUT ?= out',
      '.DEFAULT_GOAL := build',
      '',
      '# lint: not a target',
      'build: deps ## Build it',
      '\tgo build ./... && echo done: ok',
      'test lint: build',
      '\tgo test',
      'clean::',
      '\trm -rf out',
      '%.o: %.c',
      '$(OUT)/bin: build',
      'define TEMPLATE',
      'inside: nope',
      'endef',
      'deploy-prod:',
      'build: again',
    ].join('\r\n');
    expect(discoverMakeTargets(text, 'Makefile', root).map((t) => t.name)).toEqual(['build', 'test', 'lint', 'clean', 'deploy-prod']);
    expect(discoverMakeTargets('serve:\n', 'makefile', { cwd: 'web', label: 'web' })).toEqual([
      { source: 'make', name: 'web: serve', command: 'make serve', cwd: 'web', file: 'web/makefile' },
    ]);
  });

  it('leaves out targets a shell would read as something else', () => {
    expect(discoverMakeTargets('a"&calc&": x\nok:\n-flag:\nwith%:\n', 'Makefile', root).map((t) => t.command)).toEqual(['make ok']);
  });

  it('reads a very long line without backtracking', () => {
    const started = Date.now();
    expect(discoverMakeTargets(`a${' '.repeat(1_000_000)}\nok:\n`, 'Makefile', root).map((t) => t.name)).toEqual(['ok']);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('discoverJustRecipes', () => {
  it('lists public recipes and skips settings, aliases, variables, bodies and private ones', () => {
    const text = [
      'set shell := ["bash", "-c"]',
      'alias b := build',
      'export RUST_LOG := "info"',
      'version := `git describe`',
      'import "other.just"',
      '',
      '# Build it',
      'build target="debug": clean',
      '    cargo build --profile {{target}}',
      '',
      '@test *args:',
      '  cargo test {{args}}',
      '_helper:',
      '  echo hidden',
      '[private]',
      'secret:',
      '  echo hidden',
      "[group('dev')]",
      '',
      'serve-docs:',
      '  mdbook serve',
      'clean:',
    ].join('\n');
    expect(discoverJustRecipes(text, 'justfile', root)).toEqual(
      ['build', 'test', 'serve-docs', 'clean'].map((name) => ({ source: 'just', name, command: `just ${name}`, cwd: '', file: 'justfile' })),
    );
  });

  it('takes private only as an attribute of its own', () => {
    const text = ['[no-cd, private]', 'a:', '[ private ]', 'b:', '[doc("not private")]', 'c:', "[group('private-tools')]", 'd:'].join('\n');
    expect(discoverJustRecipes(text, 'justfile', root).map((t) => t.name)).toEqual(['c', 'd']);
  });

  it('reads a very long line without backtracking', () => {
    const started = Date.now();
    expect(discoverJustRecipes(`a${' '.repeat(1_000_000)}\nok:\n`, 'justfile', root).map((t) => t.name)).toEqual(['ok']);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('discoverComposeServices', () => {
  it('lists the services to bring up with the file', () => {
    const text = 'services:\n  db:\n    image: postgres\n  api:\n    build: .\nvolumes:\n  data: {}\n';
    expect(discoverComposeServices(text, 'compose.yaml', root)).toEqual([
      { source: 'compose', name: 'db', command: 'docker compose -f compose.yaml up db', cwd: '', file: 'compose.yaml' },
      { source: 'compose', name: 'api', command: 'docker compose -f compose.yaml up api', cwd: '', file: 'compose.yaml' },
    ]);
  });

  it('gives nothing without services or for broken yaml', () => {
    expect(discoverComposeServices('version: "3"\n', 'docker-compose.yml', root)).toEqual([]);
    expect(discoverComposeServices('services: [', 'docker-compose.yml', root)).toEqual([]);
    expect(discoverComposeServices('services:\n  - a\n', 'docker-compose.yml', root)).toEqual([]);
  });

  it('leaves out service names Docker Compose would refuse', () => {
    const text = 'services:\n  web.1_a-b: {}\n  \'x" & calc & "\': {}\n  "%PATH%": {}\n  -opt: {}\n';
    expect(discoverComposeServices(text, 'compose.yaml', root).map((t) => t.command)).toEqual(['docker compose -f compose.yaml up web.1_a-b']);
  });
});
