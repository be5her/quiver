import { keyValue, type ApiAuth, type ApiCollection, type ApiRequest, type FormField, type HttpMethod, type KeyValue, type RequestBody } from '../models/api';
import { ImportBuilder, ImportError, arr, isRecord, parseStructured, str, variableName, type ImportResult } from './common';

type Json = Record<string, unknown>;
type Deref = (value: unknown, seen: string[]) => { value: unknown; seen: string[] };

const METHODS: HttpMethod[] = ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'];
const MAX_DEPTH = 8;
/** Nodes one example may hold in all: schemas that reference each other many times over would otherwise grow exponentially. */
const MAX_NODES = 2000;

/** Resolves `$ref`s inside the document; a reference to another file is noted and read as empty. */
class Resolver {
  constructor(
    private readonly doc: Json,
    private readonly skip: (line: string) => void,
  ) {}

  /** The value with its `$ref` (chains too) followed, and the refs followed on the way. */
  readonly deref: Deref = (value, seen = []) => {
    let current = value;
    const trail = [...seen];
    while (isRecord(current) && typeof current['$ref'] === 'string') {
      const ref = current['$ref'];
      if (trail.includes(ref)) return { value: {}, seen: trail };
      trail.push(ref);
      if (!ref.startsWith('#/')) {
        this.skip(`The reference ${ref} points outside the document and was left empty`);
        return { value: {}, seen: trail };
      }
      current = ref
        .slice(2)
        .split('/')
        .map((part) => decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce<unknown>((node, key) => (isRecord(node) || Array.isArray(node) ? (node as Json)[key] : undefined), this.doc);
      if (current === undefined) {
        this.skip(`The reference ${ref} does not exist in the document`);
        return { value: {}, seen: trail };
      }
    }
    return { value: current, seen: trail };
  };

  get(value: unknown): Json {
    const { value: v } = this.deref(value, []);
    return isRecord(v) ? v : {};
  }
}

/**
 * A value shaped like the schema: its example, default or first enum value, else a placeholder of its
 * type. Null past MAX_DEPTH, and once the example holds MAX_NODES values (`budget` is shared by one walk).
 */
export function exampleFromSchema(schema: unknown, deref: Deref = (value) => ({ value, seen: [] }), seen: string[] = [], depth = 0, budget = { nodes: MAX_NODES }): unknown {
  if (depth > MAX_DEPTH || --budget.nodes < 0) return null;
  const followed = deref(schema, seen);
  const s = followed.value;
  if (!isRecord(s)) return null;
  const next = (child: unknown) => exampleFromSchema(child, deref, followed.seen, depth + 1, budget);
  if ('example' in s) return s['example'];
  if (Array.isArray(s['examples']) && s['examples'].length) return s['examples'][0];
  if ('default' in s) return s['default'];
  if ('const' in s) return s['const'];
  if (Array.isArray(s['enum']) && s['enum'].length) return s['enum'][0];
  if (Array.isArray(s['allOf'])) {
    const parts = s['allOf'].map(next);
    return parts.length && parts.every((p) => isRecord(p)) ? Object.assign({}, ...parts) : (parts[0] ?? null);
  }
  for (const key of ['oneOf', 'anyOf']) {
    const options = s[key];
    if (Array.isArray(options) && options.length) return next(options[0]);
  }
  const types = Array.isArray(s['type']) ? (s['type'] as unknown[]).map(str) : [str(s['type'])];
  const type = types.find((t) => t && t !== 'null') ?? (isRecord(s['properties']) ? 'object' : s['items'] ? 'array' : '');
  switch (type) {
    case 'object': {
      const out: Json = {};
      if (isRecord(s['properties'])) for (const [key, prop] of Object.entries(s['properties'])) out[key] = next(prop);
      return out;
    }
    case 'array':
      return s['items'] ? [next(s['items'])] : [];
    case 'integer':
    case 'number':
      return typeof s['minimum'] === 'number' ? s['minimum'] : 0;
    case 'boolean':
      return true;
    case 'string':
      return stringExample(str(s['format']));
    default:
      return null;
  }
}

function stringExample(format: string): string {
  switch (format) {
    case 'date-time':
      return '2024-01-01T00:00:00Z';
    case 'date':
      return '2024-01-01';
    case 'email':
      return 'user@example.com';
    case 'uuid':
      return '00000000-0000-0000-0000-000000000000';
    case 'uri':
    case 'url':
      return 'https://example.com';
    case 'binary':
      return '';
    default:
      return 'string';
  }
}

/** A parameter or property value as text for a row: objects as JSON. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** `{id}` becomes `{{id}}`, so a path parameter is a variable. */
function pathTemplate(path: string): string {
  return path.replace(/\{([^{}]+)\}/g, '{{$1}}');
}

/** OpenAPI 3.0 and 3.1, or Swagger 2.0, JSON or YAML: a collection per tag, a request per operation. */
export function importOpenApi(text: string): ImportResult {
  const doc = parseStructured(text, 'OpenAPI document');
  if (!isRecord(doc)) throw new ImportError('The file is not an OpenAPI document');
  const v3 = /^3\./.test(str(doc['openapi']));
  const v2 = str(doc['swagger']) === '2.0';
  if (!v3 && !v2) {
    const version = str(doc['openapi']) || str(doc['swagger']);
    throw new ImportError(version ? `OpenAPI ${version} is not supported; 3.0, 3.1 and Swagger 2.0 are` : 'The file is not an OpenAPI document: it has no "openapi" or "swagger" version');
  }
  const paths = doc['paths'];
  if (!isRecord(paths) || !Object.keys(paths).length) throw new ImportError('The OpenAPI document has no paths');
  const info = isRecord(doc['info']) ? doc['info'] : {};
  const b = new ImportBuilder(str(info['title']) || 'OpenAPI import');
  const skip = (line: string) => b.skip(line);
  const r = new Resolver(doc, skip);
  if (str(info['description'])) b.root.description = str(info['description']);

  b.root.baseUrl = baseUrl(doc, v3);
  if (!b.root.baseUrl) {
    b.root.baseUrl = '{{baseUrl}}';
    b.skip('The document names no server: set the baseUrl variable, or the base URL of the collection');
  }

  const schemes = r.get(v3 ? r.get(doc['components'])['securitySchemes'] : doc['securityDefinitions']);
  const authFor = (requirement: unknown): ApiAuth | null => securityAuth(requirement, schemes, r, v3, skip);
  const docAuth = 'security' in doc ? authFor(doc['security']) : null;
  if (docAuth) b.root.auth = docAuth;

  const tags = arr(doc['tags']).filter(isRecord);
  const tagDescriptions = new Map(tags.map((t) => [str(t['name']), str(t['description'])]));
  const folders = new Map<string, ApiCollection>();
  // Declared tags first, in their order; the rest as operations use them.
  for (const tag of tags.map((t) => str(t['name'])).filter(Boolean)) folders.set(tag, b.folderNamed(tag));
  const folderFor = (name: string | null): ApiCollection => {
    if (!name) return b.root;
    let folder = folders.get(name);
    if (!folder) folders.set(name, (folder = b.folderNamed(name)));
    const description = tagDescriptions.get(name);
    if (description && !folder.description) folder.description = description;
    return folder;
  };

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = r.get(rawItem);
    const shared = arr(item['parameters']);
    for (const m of METHODS) {
      const op = item[m.toLowerCase()];
      if (!isRecord(op)) continue;
      const tag = arr(op['tags']).map(str).find(Boolean) ?? path.split('/').find((seg) => seg && !seg.includes('{')) ?? null;
      const request = b.request(folderFor(tag), operationRequest(m, path, op, shared, r, v3, doc, skip));
      const own = 'security' in op ? (authFor(op['security']) ?? { type: 'none' as const }) : null;
      request.auth = !own || (docAuth && JSON.stringify(own) === JSON.stringify(docAuth)) ? { type: 'inherit' } : own;
    }
    if (isRecord(item['trace'])) b.skip(`TRACE ${path} was not imported: Quiver does not send TRACE`);
  }
  const result = b.result();
  if (!result.requests.length) throw new ImportError('The OpenAPI document has no operations');
  // A tag declared but never used would be an empty folder.
  const used = new Set(result.requests.map((req) => req.collectionId));
  result.collections = result.collections.filter((c) => c === b.root || used.has(c.id));
  return result;
}

function baseUrl(doc: Json, v3: boolean): string {
  if (v3) {
    const server = arr(doc['servers']).find(isRecord);
    if (!server) return '';
    const vars = isRecord(server['variables']) ? server['variables'] : {};
    return str(server['url'])
      .replace(/\{([^{}]+)\}/g, (whole, name: string) => {
        const variable = vars[name];
        return isRecord(variable) && str(variable['default']) ? str(variable['default']) : whole;
      })
      .replace(/\/+$/, '');
  }
  const host = str(doc['host']);
  const basePath = str(doc['basePath']).replace(/\/+$/, '');
  if (!host) return basePath;
  const schemes = arr(doc['schemes']).map(str);
  const scheme = schemes.includes('https') ? 'https' : (schemes[0] ?? 'https');
  return `${scheme}://${host}${basePath}`;
}

function operationRequest(m: HttpMethod, path: string, op: Json, shared: unknown[], r: Resolver, v3: boolean, doc: Json, skip: (line: string) => void): Partial<ApiRequest> {
  const summary = str(op['summary']).trim();
  const operationId = str(op['operationId']);
  const name = summary || operationId || `${m} ${path}`;
  const notes = [str(op['description']).trim(), summary && operationId ? `operationId: ${operationId}` : '', op['deprecated'] === true ? 'Deprecated.' : ''].filter(Boolean);
  // Operation parameters override path-level ones of the same name and place.
  const byKey = new Map<string, Json>();
  for (const p of [...shared, ...arr(op['parameters'])]) {
    const param = r.get(p);
    byKey.set(`${str(param['in'])}:${str(param['name'])}`, param);
  }
  const params: KeyValue[] = [];
  const headers: KeyValue[] = [];
  let body: RequestBody = { type: 'none' };
  const formParams: Json[] = [];
  for (const param of byKey.values()) {
    const where = str(param['in']);
    // Required parameters are on; optional ones are there to switch on.
    const row = keyValue(str(param['name']), asText(paramExample(param, r)), param['required'] === true);
    if (where === 'query') params.push(row);
    else if (where === 'header') {
      if (!/^(accept|content-type|authorization)$/i.test(row.key)) headers.push(row);
    } else if (where === 'cookie') skip(`Cookie parameters were not imported (${row.key} on ${m} ${path}); set them as a Cookie header`);
    else if (where === 'body') body = jsonBody(param['schema'] ? exampleFromSchema(param['schema'], r.deref) : null);
    else if (where === 'formData') formParams.push(param);
  }
  let contentType = '';
  if (v3 && op['requestBody']) {
    const built = requestBody(r.get(op['requestBody']), r);
    body = built.body;
    contentType = built.contentType;
  } else if (!v3) {
    const consumes = arr(op['consumes'] ?? doc['consumes']).map(str);
    if (formParams.length) {
      const multipart = consumes.includes('multipart/form-data') || formParams.some((p) => str(p['type']) === 'file');
      const rows = formParams.map((p) => ({ key: str(p['name']), file: str(p['type']) === 'file', value: str(p['type']) === 'file' ? '' : asText(paramExample(p, r)) }));
      body = multipart
        ? { type: 'form', fields: rows.map((f): FormField => ({ ...keyValue(f.key, f.value), ...(f.file ? { kind: 'file' } : {}) })) }
        : { type: 'urlencoded', fields: rows.map((f) => keyValue(f.key, f.value)) };
    } else if (body.type === 'json' && consumes[0] && !/^application\/json$/i.test(consumes[0])) contentType = consumes[0];
  }
  if (contentType) headers.unshift(keyValue('Content-Type', contentType));
  const produces = v3 ? null : arr(op['produces'] ?? doc['produces']).map(str)[0];
  if (produces && produces !== 'application/json') headers.unshift(keyValue('Accept', produces));
  return { name, method: m, url: pathTemplate(path), params, headers, body, ...(notes.length ? { description: notes.join('\n\n') } : {}) };
}

function paramExample(param: Json, r: Resolver): unknown {
  if ('example' in param) return param['example'];
  if (isRecord(param['examples'])) {
    const first = Object.values(param['examples'])[0];
    if (first !== undefined) return r.get(first)['value'];
  }
  if (param['schema']) return exampleFromSchema(param['schema'], r.deref);
  // Swagger 2.0 keeps the type on the parameter itself.
  if (param['type']) return exampleFromSchema(param);
  return '';
}

function jsonBody(example: unknown): RequestBody {
  return { type: 'json', content: example === null || example === undefined ? '' : JSON.stringify(example, null, 2) };
}

/** The media types Quiver has a body for, in the order one is preferred. */
const MEDIA_ORDER: ((type: string) => boolean)[] = [
  (t) => /^application\/json\b/i.test(t),
  (t) => /\+json\b/i.test(t),
  (t) => /^application\/x-www-form-urlencoded\b/i.test(t),
  (t) => /^multipart\/form-data\b/i.test(t),
  (t) => /xml/i.test(t),
  (t) => /^text\//i.test(t),
  () => true,
];

/** Media types whose body type already sets the Content-Type Quiver sends. */
const PLAIN_TYPES = /^(application\/json|application\/x-www-form-urlencoded|multipart\/form-data|application\/xml|text\/plain)$/i;

function requestBody(rb: Json, r: Resolver): { body: RequestBody; contentType: string } {
  const content = isRecord(rb['content']) ? rb['content'] : {};
  const types = Object.keys(content);
  const type = MEDIA_ORDER.map((test) => types.find(test)).find((t): t is string => Boolean(t));
  if (!type) return { body: { type: 'none' }, contentType: '' };
  const media = r.get(content[type]);
  const example = mediaExample(media, r);
  const contentType = PLAIN_TYPES.test(type) ? '' : type;
  if (/json/i.test(type)) return { body: jsonBody(example), contentType };
  if (/^application\/x-www-form-urlencoded/i.test(type)) return { body: { type: 'urlencoded', fields: objectRows(example) }, contentType };
  if (/^multipart\/form-data/i.test(type)) {
    const schema = r.get(media['schema']);
    const props = isRecord(schema['properties']) ? schema['properties'] : {};
    const fields = objectRows(example).map((row): FormField => {
      const prop = r.get(props[row.key]);
      return str(prop['format']) === 'binary' || str(prop['contentMediaType']) ? { ...row, value: '', kind: 'file' } : row;
    });
    return { body: { type: 'form', fields }, contentType };
  }
  const textValue = typeof example === 'string' ? example : '';
  if (/xml/i.test(type)) return { body: { type: 'xml', content: textValue }, contentType };
  if (/^text\//i.test(type)) return { body: { type: 'text', content: textValue }, contentType };
  return { body: { type: 'binary', path: '', contentType: type }, contentType: '' };
}

function mediaExample(media: Json, r: Resolver): unknown {
  if ('example' in media) return media['example'];
  if (isRecord(media['examples'])) {
    const first = Object.values(media['examples'])[0];
    if (first !== undefined) return r.get(first)['value'];
  }
  return media['schema'] ? exampleFromSchema(media['schema'], r.deref) : null;
}

function objectRows(example: unknown): KeyValue[] {
  return isRecord(example) ? Object.entries(example).map(([k, v]) => keyValue(k, asText(v))) : [];
}

/**
 * The auth of a security requirement list: the first requirement's first scheme. Credentials are
 * variables (`{{token}}`, `{{clientSecret}}`), never values. An empty list means no auth.
 */
function securityAuth(requirement: unknown, schemes: Json, r: Resolver, v3: boolean, skip: (line: string) => void): ApiAuth | null {
  if (!Array.isArray(requirement)) return null;
  const list = requirement.filter(isRecord);
  const first = list[0];
  const names = first ? Object.keys(first) : [];
  if (!first || !names.length) return { type: 'none' };
  if (names.length > 1 || list.length > 1) skip(`Only the first security scheme of a requirement is used (${names[0]})`);
  const scheme = r.get(schemes[names[0]]);
  const scopes = arr(first[names[0]]).map(str).join(' ');
  const type = str(scheme['type']);
  if ((v3 && type === 'http') || type === 'basic') {
    const kind = v3 ? str(scheme['scheme']).toLowerCase() : 'basic';
    if (kind === 'bearer') return { type: 'bearer', token: '{{token}}' };
    if (kind === 'basic') return { type: 'basic', username: '{{username}}', password: '{{password}}' };
    skip(`The HTTP auth scheme ${kind} of ${names[0]} is not supported`);
    return null;
  }
  if (type === 'apiKey') {
    const where = str(scheme['in']);
    const key = str(scheme['name']);
    if (where === 'header' || where === 'query') return { type: 'apikey', key, value: `{{${variableName(key)}}}`, in: where };
    skip(`The API key ${key} of ${names[0]} is sent in a cookie, which auth cannot do; set it as a Cookie header`);
    return null;
  }
  if (type === 'oauth2') {
    const base = { type: 'oauth2' as const, clientId: '{{clientId}}', clientSecret: '{{clientSecret}}', scopes, clientAuth: 'basic' as const };
    if (v3) {
      const flows = r.get(scheme['flows']);
      const cc = r.get(flows['clientCredentials']);
      if (str(cc['tokenUrl'])) return { ...base, grant: 'client_credentials', tokenUrl: str(cc['tokenUrl']), pkce: false };
      const code = r.get(flows['authorizationCode']);
      if (str(code['tokenUrl'])) return { ...base, grant: 'authorization_code', tokenUrl: str(code['tokenUrl']), authUrl: str(code['authorizationUrl']), pkce: true };
    } else {
      const flow = str(scheme['flow']);
      if (flow === 'application') return { ...base, grant: 'client_credentials', tokenUrl: str(scheme['tokenUrl']), pkce: false };
      if (flow === 'accessCode') return { ...base, grant: 'authorization_code', tokenUrl: str(scheme['tokenUrl']), authUrl: str(scheme['authorizationUrl']), pkce: true };
    }
    skip(`The OAuth 2.0 flow of ${names[0]} is not supported; client credentials and authorization code are`);
    return null;
  }
  skip(`The security scheme ${names[0]} (${type || 'unknown'}) is not supported`);
  return null;
}
