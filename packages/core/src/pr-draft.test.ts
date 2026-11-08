import { describe, expect, it } from 'vitest';
import { GitPrDraftInputSchema, type GitPrDraftCommit, type GitPrDraftFile } from './models/git';
import {
  capText,
  commitsMarkdown,
  defaultDraftBody,
  draftBody,
  draftTitle,
  fillTemplate,
  filesMarkdown,
  groupFilesByFolder,
  labelsForBranch,
  pickLabels,
  sectionKind,
  titleFromBranch,
} from './pr-draft';

const file = (path: string, over: Partial<GitPrDraftFile> = {}): GitPrDraftFile => ({ path, status: 'modified', additions: 1, deletions: 0, binary: false, ...over });
const commit = (subject: string, body = ''): GitPrDraftCommit => ({ hash: subject.replace(/\W/g, '').toLowerCase(), subject, body });

describe('titleFromBranch and draftTitle', () => {
  it('makes the last part of the branch readable', () => {
    expect(titleFromBranch('feat/git-blame')).toBe('Git blame');
    expect(titleFromBranch('me/fix/null_pointer.crash')).toBe('Null pointer crash');
    expect(titleFromBranch('readme')).toBe('Readme');
    expect(titleFromBranch('feat/')).toBe('Feat');
    expect(titleFromBranch('---')).toBe('---');
  });

  it("takes a single commit's subject, else the branch, else the first subject on a detached HEAD", () => {
    expect(draftTitle('feat/git-blame', [commit('Add blame')])).toBe('Add blame');
    expect(draftTitle('feat/git-blame', [commit('Add blame'), commit('Test it')])).toBe('Git blame');
    expect(draftTitle(null, [commit('Add blame'), commit('Test it')])).toBe('Add blame');
    expect(draftTitle('feat/x', [])).toBe('X');
    expect(draftTitle(null, [])).toBe('');
  });
});

describe('labelsForBranch and pickLabels', () => {
  it('suggests a label from the prefix, also under a namespace', () => {
    expect(labelsForBranch('feat/x')).toEqual(['enhancement']);
    expect(labelsForBranch('Fix/x')).toEqual(['bug']);
    expect(labelsForBranch('me/docs/readme')).toEqual(['documentation']);
    expect(labelsForBranch('chore/deps')).toEqual([]);
    expect(labelsForBranch('feat')).toEqual([]);
    expect(labelsForBranch(null)).toEqual([]);
  });

  it("keeps only the labels the repository has, in the repository's spelling", () => {
    expect(pickLabels(['enhancement'], ['bug', 'Enhancement'])).toEqual(['Enhancement']);
    expect(pickLabels(['documentation'], ['bug'])).toEqual([]);
    expect(pickLabels(['bug', 'bug'], ['bug'])).toEqual(['bug']);
  });
});

describe('groupFilesByFolder and filesMarkdown', () => {
  const files = [file('src/b.ts', { additions: 3, deletions: 1 }), file('README.md'), file('packages/x.ts', { status: 'added', additions: 10 }), file('src/a.ts', { additions: 2, deletions: 2 })];

  it('groups by top folder, folders by name and top-level files last, with sums', () => {
    expect(groupFilesByFolder(files).map((g) => [g.folder, g.files.map((f) => f.path), g.additions, g.deletions])).toEqual([
      ['packages/', ['packages/x.ts'], 10, 0],
      ['src/', ['src/b.ts', 'src/a.ts'], 5, 3],
      ['', ['README.md'], 1, 0],
    ]);
  });

  it('writes each group with its counts and notes renames, new, deleted and binary files', () => {
    const md = filesMarkdown([
      ...files,
      file('src/new name.ts', { status: 'renamed', origPath: 'src/old.ts', additions: 0 }),
      file('logo.png', { binary: true, additions: 0 }),
      file('gone.txt', { status: 'deleted', additions: 0, deletions: 4 }),
    ]);
    expect(md).toBe(
      [
        '**packages/** (1 file, +10 −0)',
        '- `packages/x.ts` (new) +10 −0',
        '',
        '**src/** (3 files, +5 −3)',
        '- `src/b.ts` +3 −1',
        '- `src/a.ts` +2 −2',
        '- `src/new name.ts` (renamed from `src/old.ts`) +0 −0',
        '',
        '**Top level** (3 files, +1 −4)',
        '- `README.md` +1 −0',
        '- `logo.png` binary',
        '- `gone.txt` (deleted) +0 −4',
      ].join('\n'),
    );
  });

  it('lists at most the cap and counts the rest', () => {
    expect(filesMarkdown(files, 2).split('\n').pop()).toBe('… and 2 more files');
  });
});

describe('commitsMarkdown', () => {
  it('lists subjects with bodies indented and trailers dropped', () => {
    const md = commitsMarkdown([commit('Add the parser', 'It reads porcelain.\n\nSecond paragraph.\n\nCo-Authored-By: Someone <a@b>'), commit('Test it')]);
    expect(md).toBe(['- Add the parser', '  It reads porcelain.', '', '  Second paragraph.', '- Test it'].join('\n'));
  });

  it('counts the earlier commits left out, before the newest ones listed', () => {
    expect(commitsMarkdown([commit('Three')], 3)).toBe('- … 2 earlier commits not listed\n- Three');
    expect(commitsMarkdown([commit('Two'), commit('Three')], 3)).toBe('- … 1 earlier commit not listed\n- Two\n- Three');
  });
});

describe('sectionKind', () => {
  it('knows what-changed and files headings whatever the case, emoji or punctuation', () => {
    expect(sectionKind('What changed')).toBe('summary');
    expect(sectionKind('📝 Summary:')).toBe('summary');
    expect(sectionKind('What’s Changed')).toBe('summary');
    expect(sectionKind('Changes')).toBe('summary');
    expect(sectionKind('Files changed')).toBe('files');
    expect(sectionKind('How it was verified')).toBeNull();
  });
});

describe('fillTemplate', () => {
  const parts = { commits: '- Add blame\n- Test it', files: '**src/** (1 file, +1 −0)\n- `src/a.ts` +1 −0' };

  it("fills the repository's own template, keeping its hints and the other sections", () => {
    const template = [
      '## What changed',
      '',
      '<!-- A few sentences: what, and why. -->',
      '',
      '## How it was verified',
      '',
      '- [ ] `npm run typecheck`',
      '',
      '## Worth knowing',
      '',
      '<!-- Decisions. -->',
      '',
    ].join('\n');
    expect(fillTemplate(template, parts)).toBe(
      [
        '## What changed',
        '',
        '<!-- A few sentences: what, and why. -->',
        '',
        '- Add blame',
        '- Test it',
        '',
        '## How it was verified',
        '',
        '- [ ] `npm run typecheck`',
        '',
        '## Worth knowing',
        '',
        '<!-- Decisions. -->',
        '',
      ].join('\n'),
    );
  });

  it('fills a files section and the first summary heading only, keeping CRLF and text before the first heading', () => {
    const template = ['Thanks!', '# Summary', '## Files', 'x', '# Description', ''].join('\r\n');
    expect(fillTemplate(template, parts)).toBe(
      ['Thanks!', '# Summary', '', '- Add blame', '- Test it', '', '## Files', '', 'x', '', '**src/** (1 file, +1 −0)', '- `src/a.ts` +1 −0', '', '# Description', ''].join('\r\n'),
    );
  });

  it('ignores headings inside code fences and HTML comments', () => {
    const template = ['```', '## Summary', '```', '<!--', '## Changes', '-->', '## Notes', ''].join('\n');
    expect(fillTemplate(template, parts)).toBe(template);
  });

  it('leaves a template with no known section, or nothing to fill, as it is', () => {
    expect(fillTemplate('## Checklist\n- [ ] tests\n', parts)).toBe('## Checklist\n- [ ] tests\n');
    expect(fillTemplate('## Summary\n', { commits: '', files: '' })).toBe('## Summary\n');
  });
});

describe('defaultDraftBody and draftBody', () => {
  it('has Summary and Changes without a template, and nothing without commits or files', () => {
    expect(defaultDraftBody({ commits: '- A', files: '- `x`' })).toBe('## Summary\n\n- A\n\n## Changes\n\n- `x`\n');
    expect(defaultDraftBody({ commits: '', files: '' })).toBe('');
  });

  it('uses the template when there is one', () => {
    expect(draftBody('## Summary\n', [commit('A')], [file('x')])).toBe('## Summary\n\n- A\n');
    expect(draftBody(null, [commit('A')], [file('x')])).toContain('## Changes\n\n**Top level** (1 file, +1 −0)\n- `x` +1 −0');
  });
});

describe('capText', () => {
  it('keeps text under the cap and cuts longer text at a line end', () => {
    expect(capText('a\nb\n', 10)).toEqual({ text: 'a\nb\n', truncated: false });
    expect(capText('one\ntwo\nthree\n', 9)).toEqual({ text: 'one\ntwo\n', truncated: true });
  });

  it('counts bytes, not characters, and never ends in half a character', () => {
    expect(capText('ééé', 3)).toEqual({ text: 'é', truncated: true });
    expect(capText('é\nb', 2)).toEqual({ text: 'é', truncated: true });
  });
});

describe('GitPrDraftInputSchema', () => {
  it('refuses an option-like base and defaults includePatch to false', () => {
    expect(GitPrDraftInputSchema.safeParse({ base: '--output=x' }).success).toBe(false);
    expect(GitPrDraftInputSchema.parse({})).toEqual({ includePatch: false });
    expect(GitPrDraftInputSchema.parse({ base: 'origin/main', includePatch: true })).toEqual({ base: 'origin/main', includePatch: true });
  });
});
