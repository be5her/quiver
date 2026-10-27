import { describe, expect, it } from 'vitest';
import { buildFileTree, fileTreeItems, flattenTree, type FileTreeNode } from './file-tree';

const items = (...paths: string[]) => paths.map((path) => ({ path }));

/** `name@depth` per node, folders with their count, in tree order. */
function outline<T>(nodes: FileTreeNode<T>[]): string[] {
  return nodes.flatMap((n) => [n.kind === 'folder' ? `${n.name}/@${n.depth} (${n.count})` : `${n.name}@${n.depth}`, ...outline(n.children ?? [])]);
}

describe('buildFileTree', () => {
  it('nests files under their folders, folders first', () => {
    const tree = buildFileTree(items('readme.md', 'src/a/x.ts', 'src/a/b/y.ts', 'docs/guide.md', 'src/main.ts'), { compact: false });
    expect(outline(tree)).toEqual(['docs/@0 (1)', 'guide.md@1', 'src/@0 (3)', 'a/@1 (2)', 'b/@2 (1)', 'y.ts@3', 'x.ts@2', 'main.ts@1', 'readme.md@0']);
    expect(tree[1].path).toBe('src');
    expect(tree[1].children?.[0].path).toBe('src/a');
    expect(tree[1].children?.[0].children?.[0].path).toBe('src/a/b');
  });

  it('keeps the item and its full path on file rows', () => {
    const item = { path: 'src/app/main.ts', status: 'M' };
    const [folder] = buildFileTree([item], { compact: false });
    const file = folder.children![0].children![0];
    expect(file).toMatchObject({ kind: 'file', name: 'main.ts', path: 'src/app/main.ts', depth: 2 });
    expect(file.item).toBe(item);
  });

  it('compacts a chain of single-folder folders into one row', () => {
    const tree = buildFileTree(items('src/app/settings/a.ts', 'src/app/settings/b.ts'), { compact: true });
    expect(outline(tree)).toEqual(['src/app/settings/@0 (2)', 'a.ts@1', 'b.ts@1']);
    expect(tree[0].path).toBe('src/app/settings');
  });

  it('does not compact a folder that holds a file and a folder', () => {
    const tree = buildFileTree(items('src/a/x.ts', 'src/a/b/y.ts'), { compact: true });
    // src holds only a, so they merge; a holds a file and a folder, so b stays its own row.
    expect(outline(tree)).toEqual(['src/a/@0 (2)', 'b/@1 (1)', 'y.ts@2', 'x.ts@1']);
    expect(tree[0].children?.[0].path).toBe('src/a/b');
  });

  it('does not compact a folder with two folders', () => {
    const tree = buildFileTree(items('src/a/x.ts', 'src/b/y.ts'), { compact: true });
    expect(outline(tree)).toEqual(['src/@0 (2)', 'a/@1 (1)', 'x.ts@2', 'b/@1 (1)', 'y.ts@2']);
  });

  it('leaves compaction off when asked', () => {
    expect(outline(buildFileTree(items('a/b/c.txt'), { compact: false }))).toEqual(['a/@0 (1)', 'b/@1 (1)', 'c.txt@2']);
  });

  it('sorts folders and files without regard to case', () => {
    const tree = buildFileTree(items('b.txt', 'A.txt', 'Zeta/x', 'alpha/x', 'c.TXT', 'B.md'), { compact: false });
    expect(tree.map((n) => n.name)).toEqual(['alpha', 'Zeta', 'A.txt', 'B.md', 'b.txt', 'c.TXT']);
  });

  it('keeps paths with spaces and dots intact', () => {
    const tree = buildFileTree(items('my folder/.env.local', 'my folder/file name.d.ts', '.github/workflows/ci.yml'), { compact: true });
    expect(outline(tree)).toEqual(['.github/workflows/@0 (1)', 'ci.yml@1', 'my folder/@0 (2)', '.env.local@1', 'file name.d.ts@1']);
    expect(tree[1].children?.[1].path).toBe('my folder/file name.d.ts');
  });

  it('places a rename under its new path', () => {
    const tree = buildFileTree([{ path: 'lib/new.ts', origPath: 'src/old.ts' }], { compact: true });
    expect(outline(tree)).toEqual(['lib/@0 (1)', 'new.ts@1']);
    expect(tree[0].children?.[0].item?.origPath).toBe('src/old.ts');
  });

  it('keeps an untracked folder entry as one row with its slash', () => {
    const tree = buildFileTree(items('new/', 'src/gen/'), { compact: true });
    expect(outline(tree)).toEqual(['src/@0 (1)', 'gen/@1', 'new/@0']);
    expect(tree[1]).toMatchObject({ kind: 'file', path: 'new/' });
  });

  it('never produces a Windows separator', () => {
    const tree = buildFileTree(items('src\\a\\x.ts', 'src/a/y.ts'), { compact: true });
    const all = flattenTree(tree, new Set());
    expect(all.map((r) => r.path)).toEqual(['src/a', 'src/a/x.ts', 'src/a/y.ts']);
    expect(all.some((r) => r.name.includes('\\') || r.path.includes('\\'))).toBe(false);
  });

  it('is empty for no items', () => {
    expect(buildFileTree([], { compact: true })).toEqual([]);
  });
});

describe('flattenTree', () => {
  const tree = buildFileTree(items('src/a/x.ts', 'src/a/b/y.ts', 'docs/d.md', 'root.txt'), { compact: true });

  it('lists every row with its depth and open state when nothing is collapsed', () => {
    expect(flattenTree(tree, new Set()).map((r) => `${r.path}@${r.depth}${r.kind === 'folder' ? (r.expanded ? '+' : '-') : ''}`)).toEqual([
      'docs@0+',
      'docs/d.md@1',
      'src/a@0+',
      'src/a/b@1+',
      'src/a/b/y.ts@2',
      'src/a/x.ts@1',
      'root.txt@0',
    ]);
  });

  it('hides what is under a collapsed folder, and keeps the folder row', () => {
    const rows = flattenTree(tree, new Set(['src/a/b']));
    expect(rows.map((r) => r.path)).toEqual(['docs', 'docs/d.md', 'src/a', 'src/a/b', 'src/a/x.ts', 'root.txt']);
    expect(rows.find((r) => r.path === 'src/a/b')?.expanded).toBe(false);
    expect(flattenTree(tree, new Set(['src/a'])).map((r) => r.path)).toEqual(['docs', 'docs/d.md', 'src/a', 'root.txt']);
  });

  it('marks files as not expanded', () => {
    expect(flattenTree(tree, new Set()).filter((r) => r.kind === 'file').every((r) => !r.expanded)).toBe(true);
  });
});

describe('fileTreeItems', () => {
  it('gives every file under a folder, and a file its own item', () => {
    const tree = buildFileTree(items('src/a/x.ts', 'src/a/b/y.ts', 'docs/d.md'), { compact: true });
    expect(fileTreeItems(tree[1]).map((i) => i.path)).toEqual(['src/a/b/y.ts', 'src/a/x.ts']);
    expect(fileTreeItems(tree[0].children![0]).map((i) => i.path)).toEqual(['docs/d.md']);
  });
});
