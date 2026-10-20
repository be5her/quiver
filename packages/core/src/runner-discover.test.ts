import { describe, expect, it } from 'vitest';
import {
  discoverComposeServices,
  discoverJustRecipes,
  discoverMakeTargets,
  discoverPackageScripts,
  matchSegment,
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
});

describe('matchSegment', () => {
  it('matches * and ? and nothing else as a wildcard', () => {
    expect(matchSegment('*', 'core')).toBe(true);
    expect(matchSegment('app-*', 'app-web')).toBe(true);
    expect(matchSegment('app-*', 'lib-web')).toBe(false);
    expect(matchSegment('v?', 'v2')).toBe(true);
    expect(matchSegment('a.b', 'axb')).toBe(false);
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
  it('keeps plain words and quotes the rest', () => {
    expect(shellWord('build:prod')).toBe('build:prod');
    expect(shellWord('docs/serve')).toBe('docs/serve');
    expect(shellWord('my script')).toBe('"my script"');
    expect(shellWord('a"b')).toBe('"a\\"b"');
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
});
