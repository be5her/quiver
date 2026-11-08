import { parse as parseYaml } from 'yaml';
import { newId } from '../ids';
import { HttpMethodSchema, keyValue, newApiRequest, newCollection, newEnvironment, type ApiCollection, type ApiRequest, type Environment, type HttpMethod, type KeyValue, type RequestBody } from '../models/api';
import { isSecretName } from '../redact';

/** What an import creates, ready to save: the first collection is the root, the rest sit under it. */
export interface ImportResult {
  collections: ApiCollection[];
  requests: ApiRequest[];
  environments: Environment[];
  /** What was found but not imported, one line each: scripts, unsupported auth, external references. */
  skipped: string[];
}

/** A file that is not what the importer reads, or is broken. Nothing is saved for it. */
export class ImportError extends Error {
  override name = 'ImportError';
}

/** JSON, or YAML (a superset of it). Throws an ImportError naming the line for a broken file. */
export function parseStructured(text: string, what: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new ImportError(`The ${what} is empty`);
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new ImportError(`The ${what} is not valid JSON: ${(err as Error).message}`);
    }
  }
  try {
    return parseYaml(trimmed, { maxAliasCount: 1000 });
  } catch (err) {
    throw new ImportError(`The ${what} is neither JSON nor valid YAML: ${(err as Error).message.split('\n')[0]}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A method Quiver sends, or null for one it does not (TRACE, CONNECT, custom verbs). */
export function method(value: unknown): HttpMethod | null {
  const parsed = HttpMethodSchema.safeParse(str(value).toUpperCase());
  return parsed.success ? parsed.data : null;
}

/** A variable name Quiver accepts, from any text: `X-API-Key` → `x_api_key`. */
export function variableName(text: string): string {
  const name = text
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[^A-Za-z_]+/, '')
    .toLowerCase();
  return name || 'value';
}

/**
 * Literal credentials found in an import, turned into `{{variables}}` so none reaches a committed
 * file: the request keeps the reference, the imported environment gets the value as a secret. A
 * value that is already a `{{reference}}`, or empty, is left as it is.
 */
export class Credentials {
  readonly variables: { key: string; value: string; secret: true }[] = [];
  private readonly taken: Set<string>;

  /** `reserved` are the names the import defines itself; a credential never takes one of those. */
  constructor(
    private readonly skip: (line: string) => void,
    reserved: Iterable<string> = [],
  ) {
    this.taken = new Set(reserved);
  }

  /** What the request keeps for this credential: `{{name}}` for a literal value, which goes to the environment. */
  take(name: string, value: string, where: string): string {
    if (!value || /\{\{[^}]*\}\}/.test(value)) return value;
    const base = variableName(name);
    const same = this.variables.find((v) => v.value === value && (v.key === base || v.key.startsWith(`${base}_`)));
    if (same) return `{{${same.key}}}`;
    let key = base;
    for (let n = 2; this.taken.has(key); n++) key = `${base}_${n}`;
    this.taken.add(key);
    this.variables.push({ key, value, secret: true });
    this.skip(`The ${name} credential on ${where} was replaced with {{${key}}}; its value is a secret in the imported environment`);
    return `{{${key}}}`;
  }
}

/** What replaces the literal value of a credential named `name`. */
export type CredentialMask = (name: string, value: string) => string;

const AUTH_SCHEME = /^(bearer|basic|token|digest|negotiate)\s+/i;

/** The scheme an `Authorization` value starts with (`Bearer `), kept in front of the mask, and the rest. */
export function splitAuthScheme(value: string): { scheme: string; rest: string } {
  const scheme = AUTH_SCHEME.exec(value)?.[0] ?? '';
  return { scheme, rest: value.slice(scheme.length) };
}

/** A mask that takes each literal credential on `where` into `creds`, so a header reads `Bearer {{authorization}}`. */
export function credentialMask(creds: Credentials, where: string): CredentialMask {
  return (name, value) => {
    const { scheme, rest } = splitAuthScheme(value);
    return scheme + creds.take(name, rest, where);
  };
}

/** Headers, parameters or form fields with the literal values of credential-named rows (never files) masked. */
export function maskCredentialRows<T extends KeyValue>(rows: T[], mask: CredentialMask): T[] {
  return rows.map((row) => ((row as { kind?: string }).kind !== 'file' && row.value && isSecretName(row.key) ? { ...row, value: mask(row.key, row.value) } : row));
}

/**
 * A body with its credentials masked: `password`, `client_secret`, `token` fields of a URL-encoded
 * or multipart body, and of a JSON body at any depth. Other bodies are left as they are.
 */
export function maskCredentialBody(body: RequestBody, mask: CredentialMask): RequestBody {
  if (body.type === 'urlencoded' || body.type === 'form') return { ...body, fields: maskCredentialRows(body.fields, mask) } as RequestBody;
  if (body.type !== 'json') return body;
  let changed = false;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && v && isSecretName(k)) {
        const masked = mask(k, v);
        if (masked !== v) changed = true;
        out[k] = masked;
      } else out[k] = walk(v);
    }
    return out;
  };
  try {
    const masked = walk(JSON.parse(body.content));
    return changed ? { type: 'json', content: JSON.stringify(masked, null, 2) } : body;
  } catch {
    return body;
  }
}

/** Collects collections and requests under one root, keeping the order they were found in. */
export class ImportBuilder {
  readonly root: ApiCollection;
  private readonly collections: ApiCollection[];
  private readonly requests: ApiRequest[] = [];
  private readonly environments: Environment[] = [];
  private readonly skipped: string[] = [];
  private readonly byPath = new Map<string, ApiCollection>();

  constructor(name: string) {
    this.root = newCollection(name.trim() || 'Imported');
    this.collections = [this.root];
  }

  folder(name: string, parent: ApiCollection = this.root): ApiCollection {
    const collection = newCollection(name.trim() || 'Folder', parent.id);
    this.collections.push(collection);
    return collection;
  }

  /** The folder of this name under the parent, made the first time it is asked for. */
  folderNamed(name: string, parent: ApiCollection = this.root): ApiCollection {
    const key = `${parent.id}/${name}`;
    let found = this.byPath.get(key);
    if (!found) {
      found = this.folder(name, parent);
      this.byPath.set(key, found);
    }
    return found;
  }

  request(collection: ApiCollection, partial: Partial<ApiRequest>): ApiRequest {
    const request = newApiRequest({ ...partial, collectionId: collection.id });
    this.requests.push(request);
    return request;
  }

  environment(name: string, variables: { key: string; value: string; secret?: boolean; enabled?: boolean }[]): Environment {
    const env = newEnvironment(name.trim() || 'Imported');
    env.variables = variables.map((v) => ({ id: newId(), key: v.key, value: v.value, enabled: v.enabled ?? true, ...(v.secret ? { secret: true } : {}) }));
    this.environments.push(env);
    return env;
  }

  skip(line: string): void {
    if (!this.skipped.includes(line)) this.skipped.push(line);
  }

  result(): ImportResult {
    return { collections: this.collections, requests: this.requests, environments: this.environments, skipped: this.skipped };
  }
}

/** The query of a URL as rows, and the URL without it. A URL that does not parse keeps its query in the text. */
export function splitQuery(url: string): { url: string; params: KeyValue[] } {
  const at = url.indexOf('?');
  if (at < 0) return { url, params: [] };
  const params: KeyValue[] = [];
  for (const part of url.slice(at + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    params.push(keyValue(decode(eq < 0 ? part : part.slice(0, eq)), eq < 0 ? '' : decode(part.slice(eq + 1))));
  }
  return { url: url.slice(0, at), params };
}

/** The body type a Content-Type reads as, for raw text bodies. */
export function rawBodyType(contentType: string, text: string): 'json' | 'xml' | 'text' {
  const type = contentType.toLowerCase();
  if (/json/.test(type)) return 'json';
  if (/xml/.test(type)) return 'xml';
  if (!type) {
    const t = text.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && isJson(t)) return 'json';
    if (t.startsWith('<')) return 'xml';
  }
  return 'text';
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
