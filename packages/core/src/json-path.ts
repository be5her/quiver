/**
 * A small JSON path, the subset that covers everyday filtering of a response:
 * `$`, `.key`, `['key']` or `["key"]`, `[0]`, negative indexes (`[-1]`), `.*` and `[*]`, and `..key` or
 * `..*` for a key at any depth. No filter expressions, slices or unions. The leading `$` may be left out.
 */

type Segment =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'deep'; key: string | null };

const IDENT = /^[A-Za-z_$][\w$-]*/;

export function parseJsonPath(path: string): Segment[] {
  let rest = path.trim();
  if (rest.startsWith('$')) rest = rest.slice(1);
  else if (rest && !rest.startsWith('.') && !rest.startsWith('[')) rest = `.${rest}`;
  const segments: Segment[] = [];
  while (rest) {
    if (rest.startsWith('..')) {
      rest = rest.slice(2);
      if (rest.startsWith('*')) {
        segments.push({ kind: 'deep', key: null });
        rest = rest.slice(1);
        continue;
      }
      if (rest.startsWith('[')) {
        const { segment, length } = bracket(rest, path);
        if (segment.kind !== 'key' && segment.kind !== 'wildcard') throw new Error(`"..[index]" is not supported in ${path}`);
        segments.push({ kind: 'deep', key: segment.kind === 'key' ? segment.key : null });
        rest = rest.slice(length);
        continue;
      }
      const name = IDENT.exec(rest)?.[0];
      if (!name) throw new Error(`Expected a key after ".." in ${path}`);
      segments.push({ kind: 'deep', key: name });
      rest = rest.slice(name.length);
    } else if (rest.startsWith('.')) {
      rest = rest.slice(1);
      if (rest.startsWith('*')) {
        segments.push({ kind: 'wildcard' });
        rest = rest.slice(1);
        continue;
      }
      const name = IDENT.exec(rest)?.[0];
      if (!name) throw new Error(`Expected a key after "." in ${path}; use ['key'] for other characters`);
      segments.push({ kind: 'key', key: name });
      rest = rest.slice(name.length);
    } else if (rest.startsWith('[')) {
      const { segment, length } = bracket(rest, path);
      segments.push(segment);
      rest = rest.slice(length);
    } else {
      throw new Error(`Unexpected "${rest[0]}" in ${path}`);
    }
  }
  return segments;
}

function bracket(text: string, path: string): { segment: Segment; length: number } {
  const quote = text[1];
  if (quote === "'" || quote === '"') {
    let key = '';
    for (let i = 2; i < text.length; i++) {
      const c = text[i];
      if (c === '\\' && i + 1 < text.length) {
        key += text[++i];
      } else if (c === quote) {
        if (text[i + 1] !== ']') throw new Error(`Expected "]" after the quoted key in ${path}`);
        return { segment: { kind: 'key', key }, length: i + 2 };
      } else {
        key += c;
      }
    }
    throw new Error(`Unterminated quoted key in ${path}`);
  }
  const end = text.indexOf(']');
  if (end < 0) throw new Error(`Missing "]" in ${path}`);
  const inner = text.slice(1, end).trim();
  if (inner === '*') return { segment: { kind: 'wildcard' }, length: end + 1 };
  if (/^-?\d+$/.test(inner)) return { segment: { kind: 'index', index: Number(inner) }, length: end + 1 };
  throw new Error(`"[${inner}]" is not supported in ${path}: use an index, * or a quoted key`);
}

/** Values a path may select, at most: `$..*` on a big document would otherwise select every node of it. */
export const MAX_JSON_PATH_RESULTS = 50_000;

function children(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function hasKey(value: unknown, key: string): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Every value the path selects, in document order, each node once. Throws on a path it cannot
 * read, or one that selects more than MAX_JSON_PATH_RESULTS values.
 */
export function jsonPath(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const segment of parseJsonPath(path)) {
    const next: unknown[] = [];
    // A `..` walks each object once, however many of the current values contain it: after `$..a` the
    // current values nest in each other, and walking every one of them again would square the work.
    const seen = new Set<object>();
    const deep = (node: unknown, key: string | null, self: boolean): void => {
      if (node !== null && typeof node === 'object') {
        if (seen.has(node)) return;
        seen.add(node);
      }
      if (key === null) {
        if (!self) next.push(node);
      } else if (hasKey(node, key)) {
        next.push(node[key]);
      }
      for (const child of children(node)) deep(child, key, false);
    };
    for (const value of current) {
      switch (segment.kind) {
        case 'key':
          if (hasKey(value, segment.key)) next.push(value[segment.key]);
          break;
        case 'index':
          if (Array.isArray(value)) {
            const i = segment.index < 0 ? value.length + segment.index : segment.index;
            if (i >= 0 && i < value.length) next.push(value[i]);
          }
          break;
        case 'wildcard':
          next.push(...children(value));
          break;
        case 'deep':
          deep(value, segment.key, true);
          break;
      }
    }
    if (next.length > MAX_JSON_PATH_RESULTS) throw new Error(`${path} selects more than ${MAX_JSON_PATH_RESULTS} values`);
    current = next;
  }
  return current;
}
