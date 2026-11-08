/**
 * Changed files as a tree, as VS Code's "View as Tree" draws them: folders first, then files, each sorted without
 * regard to case, and a chain of folders that each hold only one folder compacted into one row (`src/app/settings`).
 * Paths are repository-relative with `/`; a `\` is read as a separator too, so no row ever shows one.
 */

export interface FileTreeNode<T> {
  /** What the row shows: a file's base name, a folder's name, or a compacted chain of them (`src/app`). */
  name: string;
  /** A folder's full path (`src/app`), or the file item's own path. */
  path: string;
  kind: 'folder' | 'file';
  /** 0 at the top. */
  depth: number;
  /** A folder's children, folders first. */
  children?: FileTreeNode<T>[];
  /** A file's item. */
  item?: T;
  /** A folder's number of files, however deep. */
  count?: number;
}

/** One visible row of a tree: a node with whether it is open (always false for a file). */
export interface FileTreeRow<T> extends FileTreeNode<T> {
  expanded: boolean;
}

export interface FileTreeOptions {
  /** Merge a folder whose only child is a folder into one row with it. */
  compact: boolean;
}

interface Building<T> {
  folders: Map<string, Building<T>>;
  files: { name: string; item: T; path: string }[];
}

function segments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter((s) => s.length > 0 && s !== '.');
}

function byName(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The tree of `items` by their `path`. A path ending in `/` (git's untracked folder entry, `new/`) is a file row named
 * with its slash, since it is one entry of the list. A rename is placed under its new path.
 */
export function buildFileTree<T extends { path: string }>(items: readonly T[], options: FileTreeOptions): FileTreeNode<T>[] {
  const root: Building<T> = { folders: new Map(), files: [] };
  for (const item of items) {
    const parts = segments(item.path);
    if (!parts.length) continue;
    const folderEntry = /[\\/]$/.test(item.path);
    const name = parts.pop()! + (folderEntry ? '/' : '');
    let at = root;
    for (const part of parts) {
      let next = at.folders.get(part);
      if (!next) {
        next = { folders: new Map(), files: [] };
        at.folders.set(part, next);
      }
      at = next;
    }
    at.files.push({ name, item, path: [...parts, name].join('/') });
  }
  return convert(root, '', 0, options.compact);
}

function convert<T>(node: Building<T>, prefix: string, depth: number, compact: boolean): FileTreeNode<T>[] {
  const folders = [...node.folders.entries()]
    .sort(([a], [b]) => byName(a, b))
    .map(([name, child]) => {
      let label = name;
      let path = prefix ? `${prefix}/${name}` : name;
      let at = child;
      while (compact && at.files.length === 0 && at.folders.size === 1) {
        const [nextName, next] = [...at.folders.entries()][0];
        label = `${label}/${nextName}`;
        path = `${path}/${nextName}`;
        at = next;
      }
      const children = convert(at, path, depth + 1, compact);
      const count = children.reduce((n, c) => n + (c.kind === 'file' ? 1 : (c.count ?? 0)), 0);
      return { name: label, path, kind: 'folder' as const, depth, children, count };
    });
  const files = [...node.files]
    .sort((a, b) => byName(a.name, b.name))
    .map((f) => ({ name: f.name, path: (f.item as { path: string }).path.replace(/\\/g, '/'), kind: 'file' as const, depth, item: f.item }));
  return [...folders, ...files];
}

/** The rows on screen: every node whose folders above are open. A folder is open unless `collapsed` has its path. */
export function flattenTree<T>(nodes: readonly FileTreeNode<T>[], collapsed: ReadonlySet<string>): FileTreeRow<T>[] {
  const rows: FileTreeRow<T>[] = [];
  const walk = (list: readonly FileTreeNode<T>[]) => {
    for (const node of list) {
      const expanded = node.kind === 'folder' && !collapsed.has(node.path);
      rows.push({ ...node, expanded });
      if (expanded && node.children) walk(node.children);
    }
  };
  walk(nodes);
  return rows;
}

/** The items of a node: the file's own, or every file under a folder, in tree order. */
export function fileTreeItems<T>(node: FileTreeNode<T>): T[] {
  if (node.kind === 'file') return node.item === undefined ? [] : [node.item];
  return (node.children ?? []).flatMap((c) => fileTreeItems(c));
}
