import { keyValue, type ApiAuth, type ApiCollection, type ApiRequest, type FormField, type KeyValue, type RequestBody } from '../models/api';
import { isSecretName } from '../redact';
import { Credentials, ImportBuilder, ImportError, arr, isRecord, method, parseStructured, rawBodyType, splitQuery, str, type ImportResult } from './common';

type Json = Record<string, unknown>;

/**
 * A Postman Collection (v2.0 or v2.1) or a Postman environment. Folders become collections,
 * `{{variables}}` stay as they are, collection variables become an environment, and a credential
 * typed into an auth becomes a `{{variable}}` with its value a secret in that environment. Scripts
 * and tests are listed as skipped: Quiver does not run them.
 */
export function importPostman(text: string): ImportResult {
  const doc = parseStructured(text, 'Postman file');
  if (!isRecord(doc)) throw new ImportError('The file is not a Postman collection or environment');
  if (Array.isArray(doc['values']) && !Array.isArray(doc['item'])) return importEnvironment(doc);
  const info = isRecord(doc['info']) ? doc['info'] : null;
  if (!info || !Array.isArray(doc['item'])) {
    if (isRecord(doc['collection'])) return importPostman(JSON.stringify(doc['collection']));
    throw new ImportError('The file is not a Postman collection: it has no "info" and "item"');
  }
  const schema = str(info['schema']);
  if (schema && !/collection\/v2\.[01]\.\d/.test(schema)) throw new ImportError(`This Postman collection format (${schema}) is not supported; export it as Collection v2.1`);
  const b = new ImportBuilder(str(info['name']) || 'Postman import');
  const skip = (line: string) => b.skip(line);
  const description = descriptionOf(info['description'] ?? doc['description']);
  if (description) b.root.description = description;
  const variables = arr(doc['variable']).filter(isRecord);
  const creds = new Credentials(skip, variables.map((v) => str(v['key'])));
  const rootAuth = authOf(doc['auth'], skip, b.root.name, creds);
  if (rootAuth) b.root.auth = rootAuth.type === 'inherit' ? { type: 'none' } : rootAuth;
  noteScripts(doc, b.root.name, skip);

  const pathVariables: { key: string; value: string }[] = [];
  walk(arr(doc['item']), b.root, b, pathVariables, skip, creds);

  const envVars = variables.map((v) => ({ key: str(v['key']), value: str(v['value']), enabled: v['disabled'] !== true, secret: str(v['type']) === 'secret' || isSecretName(str(v['key'])) }));
  for (const v of pathVariables) if (v.value && !envVars.some((e) => e.key === v.key)) envVars.push({ key: v.key, value: v.value, enabled: true, secret: false });
  for (const v of creds.variables) if (!envVars.some((e) => e.key === v.key)) envVars.push({ key: v.key, value: v.value, enabled: true, secret: true });
  if (envVars.length) b.environment(`${b.root.name} variables`, envVars.filter((v) => v.key));
  const result = b.result();
  if (!result.requests.length) throw new ImportError('The Postman collection has no requests');
  return result;
}

function importEnvironment(doc: Json): ImportResult {
  const b = new ImportBuilder('');
  const values = arr(doc['values']).filter(isRecord);
  b.environment(
    str(doc['name']) || 'Postman environment',
    values.filter((v) => str(v['key'])).map((v) => ({ key: str(v['key']), value: str(v['value']), enabled: v['enabled'] !== false, secret: str(v['type']) === 'secret' || isSecretName(str(v['key'])) })),
  );
  const result = b.result();
  return { ...result, collections: [] };
}

function walk(items: unknown[], parent: ApiCollection, b: ImportBuilder, pathVariables: { key: string; value: string }[], skip: (line: string) => void, creds: Credentials): void {
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const name = str(raw['name']);
    if (Array.isArray(raw['item'])) {
      const folder = b.folder(name || 'Folder', parent);
      const description = descriptionOf(raw['description']);
      if (description) folder.description = description;
      const auth = authOf(raw['auth'], skip, folder.name, creds);
      if (auth) folder.auth = auth;
      noteScripts(raw, folder.name, skip);
      walk(raw['item'], folder, b, pathVariables, skip, creds);
      continue;
    }
    if (raw['request'] === undefined) continue;
    const built = requestOf(raw, pathVariables, skip, creds);
    if (built) b.request(parent, built);
    noteScripts(raw, name || 'a request', skip);
  }
}

function requestOf(item: Json, pathVariables: { key: string; value: string }[], skip: (line: string) => void, creds: Credentials): Partial<ApiRequest> | null {
  const req = typeof item['request'] === 'string' ? { url: item['request'], method: 'GET' } : isRecord(item['request']) ? item['request'] : {};
  const name = str(item['name']) || 'Request';
  const m = method(req['method'] || 'GET');
  if (!m) {
    skip(`${name} was not imported: Quiver does not send ${str(req['method'])}`);
    return null;
  }
  const { url, params } = urlOf(req['url'], pathVariables);
  const headers: KeyValue[] = arr(req['header'])
    .filter(isRecord)
    .map((h) => keyValue(str(h['key']), str(h['value']), h['disabled'] !== true));
  const contentType = headers.find((h) => h.enabled && h.key.toLowerCase() === 'content-type')?.value ?? '';
  const body = bodyOf(req['body'], contentType, name, skip);
  const auth = authOf(req['auth'], skip, name, creds);
  const description = descriptionOf(req['description']);
  return { name, method: m, url, params, headers, body, auth: auth ?? { type: 'inherit' }, ...(description ? { description } : {}) };
}

/** The URL with `:name` path segments as `{{name}}`, and the query as rows (disabled ones kept off). */
function urlOf(raw: unknown, pathVariables: { key: string; value: string }[]): { url: string; params: KeyValue[] } {
  if (!isRecord(raw)) {
    const split = splitQuery(str(raw));
    return { url: pathParams(split.url), params: split.params };
  }
  for (const v of arr(raw['variable']).filter(isRecord)) pathVariables.push({ key: str(v['key']), value: str(v['value']) });
  const rawUrl = str(raw['raw']);
  const base = splitQuery(rawUrl).url;
  const query = arr(raw['query']).filter(isRecord);
  const params = query.length ? query.map((q) => keyValue(str(q['key']), q['value'] === null ? '' : str(q['value']), q['disabled'] !== true)) : splitQuery(rawUrl).params;
  if (base) return { url: pathParams(base), params };
  // No raw: put it together from its parts.
  const host = Array.isArray(raw['host']) ? raw['host'].map(str).join('.') : str(raw['host']);
  const path = Array.isArray(raw['path']) ? raw['path'].map(str).join('/') : str(raw['path']);
  const protocol = str(raw['protocol']);
  return { url: pathParams(`${protocol ? `${protocol}://` : ''}${host}${path ? `/${path}` : ''}`), params };
}

function pathParams(url: string): string {
  return url.replace(/(\/):([A-Za-z_][\w-]*)(?=\/|$)/g, '$1{{$2}}');
}

function bodyOf(raw: unknown, contentType: string, name: string, skip: (line: string) => void): RequestBody {
  if (!isRecord(raw) || raw['disabled'] === true) return { type: 'none' };
  const mode = str(raw['mode']);
  switch (mode) {
    case 'raw': {
      const text = str(raw['raw']);
      const options = isRecord(raw['options']) && isRecord(raw['options']['raw']) ? raw['options']['raw'] : {};
      const language = str(options['language']).toLowerCase();
      const type = language === 'json' ? 'json' : language === 'xml' || language === 'html' ? 'xml' : rawBodyType(contentType, text);
      return text ? { type, content: text } : { type: 'none' };
    }
    case 'urlencoded':
      return { type: 'urlencoded', fields: arr(raw['urlencoded']).filter(isRecord).map((f) => keyValue(str(f['key']), str(f['value']), f['disabled'] !== true)) };
    case 'formdata':
      return {
        type: 'form',
        fields: arr(raw['formdata'])
          .filter(isRecord)
          .map((f): FormField => {
            const enabled = f['disabled'] !== true;
            if (str(f['type']) !== 'file') return { ...keyValue(str(f['key']), str(f['value']), enabled), ...(str(f['contentType']) ? { contentType: str(f['contentType']) } : {}) };
            const src = Array.isArray(f['src']) ? str(f['src'][0]) : str(f['src']);
            return { ...keyValue(str(f['key']), src, enabled), kind: 'file', ...(str(f['contentType']) ? { contentType: str(f['contentType']) } : {}) };
          }),
      };
    case 'graphql': {
      const gql = isRecord(raw['graphql']) ? raw['graphql'] : {};
      return { type: 'graphql', query: str(gql['query']), variables: str(gql['variables']) };
    }
    case 'file': {
      const file = isRecord(raw['file']) ? raw['file'] : {};
      return { type: 'binary', path: str(file['src']), ...(contentType ? { contentType } : {}) };
    }
    case '':
      return { type: 'none' };
    default:
      skip(`The ${mode} body of ${name} was not imported`);
      return { type: 'none' };
  }
}

/** Postman auth: v2.1 keeps its fields as `[{ key, value }]`, v2.0 as an object. Undefined auth inherits. Literal credentials go to `creds`. */
function authOf(raw: unknown, skip: (line: string) => void, where: string, creds: Credentials): ApiAuth | null {
  if (!isRecord(raw)) return null;
  const type = str(raw['type']);
  const fields = (key: string): Json => {
    const value = raw[key];
    if (Array.isArray(value)) return Object.fromEntries(value.filter(isRecord).map((f) => [str(f['key']), f['value']]));
    return isRecord(value) ? value : {};
  };
  switch (type) {
    case 'noauth':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', token: creds.take('token', str(fields('bearer')['token']), where) };
    case 'basic': {
      const f = fields('basic');
      return { type: 'basic', username: str(f['username']), password: creds.take('password', str(f['password']), where) };
    }
    case 'apikey': {
      const f = fields('apikey');
      const key = str(f['key']) || 'X-API-Key';
      return { type: 'apikey', key, value: creds.take(key, str(f['value']), where), in: str(f['in']) === 'query' ? 'query' : 'header' };
    }
    case 'oauth2': {
      const f = fields('oauth2');
      const grant = str(f['grant_type']);
      if (grant === 'client_credentials' || grant === 'authorization_code' || grant === 'authorization_code_with_pkce') {
        return {
          type: 'oauth2',
          grant: grant === 'client_credentials' ? 'client_credentials' : 'authorization_code',
          tokenUrl: str(f['accessTokenUrl']),
          ...(str(f['authUrl']) ? { authUrl: str(f['authUrl']) } : {}),
          clientId: str(f['clientId']),
          clientSecret: creds.take('client_secret', str(f['clientSecret']), where),
          scopes: str(f['scope']),
          clientAuth: str(f['client_authentication']) === 'body' ? 'body' : 'basic',
          pkce: grant !== 'client_credentials',
        };
      }
      skip(`The OAuth 2.0 grant ${grant || '(none)'} on ${where} is not supported; client credentials and authorization code are`);
      return null;
    }
    default:
      skip(`The ${type} auth on ${where} is not supported`);
      return null;
  }
}

function descriptionOf(raw: unknown): string {
  if (isRecord(raw)) return str(raw['content']).trim();
  return str(raw).trim();
}

function noteScripts(item: Json, where: string, skip: (line: string) => void): void {
  for (const event of arr(item['event']).filter(isRecord)) {
    const script = isRecord(event['script']) ? event['script'] : {};
    const lines = Array.isArray(script['exec']) ? script['exec'].map(str) : [str(script['exec'])];
    if (!lines.join('').trim()) continue;
    skip(`The ${str(event['listen']) === 'test' ? 'test script' : 'pre-request script'} on ${where} was not imported`);
  }
}
