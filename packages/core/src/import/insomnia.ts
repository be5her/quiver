import { keyValue, type ApiAuth, type ApiCollection, type ApiRequest, type FormField, type KeyValue, type RequestBody } from '../models/api';
import { isSecretName } from '../redact';
import { Credentials, ImportBuilder, ImportError, arr, isRecord, method, parseStructured, rawBodyType, splitQuery, str, type ImportResult } from './common';

type Json = Record<string, unknown>;
type Skip = (line: string) => void;
type EnvVar = { key: string; value: string; secret?: boolean };

/** Environment values named like a credential are secrets, and the credentials taken out of auths join every environment. */
function withSecrets(vars: { key: string; value: string }[], creds: Credentials): EnvVar[] {
  return [...vars.map((v) => ({ ...v, ...(isSecretName(v.key) ? { secret: true } : {}) })), ...creds.variables.filter((c) => !vars.some((v) => v.key === c.key))];
}

/** `{{ _.name }}` and `{{ name }}` become `{{name}}`; template tags (`{% response … %}`) are noted and left as they are. */
function template(text: string, where: string, skip: Skip): string {
  if (/\{%/.test(text)) skip(`A template tag in ${where} was left as it is: Quiver does not run Insomnia tags`);
  return text.replace(/\{\{\s*(?:_\.)?([\w.-]+)\s*\}\}/g, '{{$1}}');
}

/** Nested environment data as dotted names, which is how Insomnia templates reach them (`_.api.host`). */
function flatten(data: unknown, prefix = ''): { key: string; value: string }[] {
  if (!isRecord(data)) return [];
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(data)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value)) out.push(...flatten(value, name));
    else out.push({ key: name, value: Array.isArray(value) ? JSON.stringify(value) : str(value) });
  }
  return out;
}

/** An Insomnia export: v4 (JSON, `__export_format: 4`) or v5 (YAML, `type: collection.insomnia.rest/5.0`). */
export function importInsomnia(text: string): ImportResult {
  const doc = parseStructured(text, 'Insomnia export');
  if (!isRecord(doc)) throw new ImportError('The file is not an Insomnia export');
  if (/^collection\.insomnia\.rest\/5/.test(str(doc['type']))) return importV5(doc);
  if (str(doc['_type']) !== 'export' || !Array.isArray(doc['resources'])) throw new ImportError('The file is not an Insomnia export: it has no "resources"; export it as Insomnia v4 (JSON) or v5 (YAML)');
  if (Number(doc['__export_format']) < 4) throw new ImportError(`Insomnia export format ${str(doc['__export_format'])} is not supported; v4 and v5 are`);
  return importV4(doc['resources'].filter(isRecord));
}

function importV4(resources: Json[]): ImportResult {
  const workspaces = resources.filter((r) => r['_type'] === 'workspace');
  const b = new ImportBuilder(workspaces.length === 1 ? str(workspaces[0]['name']) : 'Insomnia import');
  const skip: Skip = (line) => b.skip(line);
  const environments = resources.filter((r) => r['_type'] === 'environment');
  const creds = new Credentials(skip, environments.flatMap((e) => flatten(e['data']).map((v) => v.key)));
  const children = new Map<string, Json[]>();
  for (const r of resources) {
    const parent = str(r['parentId']);
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const bySort = (a: Json, z: Json) => Number(a['metaSortKey'] ?? 0) - Number(z['metaSortKey'] ?? 0);
  const place = (parentId: string, into: ApiCollection) => {
    for (const r of [...(children.get(parentId) ?? [])].sort(bySort)) {
      const type = str(r['_type']);
      const name = str(r['name']);
      if (type === 'request_group') {
        const folder = b.folder(name || 'Folder', into);
        if (str(r['description'])) folder.description = str(r['description']);
        const auth = authOf(r['authentication'], name, skip, creds);
        if (auth) folder.auth = auth;
        place(str(r['_id']), folder);
      } else if (type === 'request') {
        const built = requestOf(r, skip, creds);
        if (built) b.request(into, built);
      } else if (type === 'grpc_request' || type === 'websocket_request') {
        skip(`${name || type} was not imported: ${type === 'grpc_request' ? 'gRPC' : 'WebSocket'} requests belong to other modules`);
      }
    }
  };
  for (const w of workspaces) place(str(w['_id']), workspaces.length === 1 ? b.root : b.folder(str(w['name']) || 'Workspace'));
  // Requests whose parent is not in the file: at the root.
  const known = new Set(resources.map((r) => str(r['_id'])));
  for (const r of resources) if (r['_type'] === 'request' && !known.has(str(r['parentId']))) {
    const built = requestOf(r, skip, creds);
    if (built) b.request(b.root, built);
  }

  // The base environment sits under the workspace, its sub-environments under it; each sub-environment imports with the base merged in.
  const workspaceIds = new Set(workspaces.map((w) => str(w['_id'])));
  let made = 0;
  for (const base of environments.filter((e) => workspaceIds.has(str(e['parentId'])))) {
    const subs = environments.filter((e) => str(e['parentId']) === str(base['_id']));
    const baseVars = flatten(base['data']);
    if (!subs.length) {
      if (baseVars.length) {
        b.environment(str(base['name']) || 'Base Environment', withSecrets(baseVars, creds));
        made++;
      }
      continue;
    }
    for (const sub of subs) {
      const own = flatten(sub['data']);
      b.environment(str(sub['name']) || 'Environment', withSecrets([...baseVars.filter((v) => !own.some((o) => o.key === v.key)), ...own], creds));
      made++;
    }
  }
  // Credentials taken out of the auths need somewhere to live when the export has no environment.
  if (!made && creds.variables.length) b.environment(`${b.root.name} credentials`, creds.variables);
  if (resources.some((r) => r['_type'] === 'cookie_jar' && arr(r['cookies']).length)) skip('Cookies in the export were not imported');
  const result = b.result();
  if (!result.requests.length) throw new ImportError('The Insomnia export has no requests');
  return result;
}

function importV5(doc: Json): ImportResult {
  const b = new ImportBuilder(str(doc['name']) || 'Insomnia import');
  const skip: Skip = (line) => b.skip(line);
  const envs = isRecord(doc['environments']) ? doc['environments'] : null;
  const subs = envs ? arr(envs['subEnvironments']).filter(isRecord) : [];
  const creds = new Credentials(skip, envs ? [...flatten(envs['data']), ...subs.flatMap((s) => flatten(s['data']))].map((v) => v.key) : []);
  const place = (items: unknown[], into: ApiCollection) => {
    for (const item of items.filter(isRecord)) {
      if (Array.isArray(item['children'])) {
        const folder = b.folder(str(item['name']) || 'Folder', into);
        const auth = authOf(item['authentication'], folder.name, skip, creds);
        if (auth) folder.auth = auth;
        place(item['children'], folder);
      } else if ('url' in item) {
        const built = requestOf(item, skip, creds);
        if (built) b.request(into, built);
      }
    }
  };
  place(arr(doc['collection']), b.root);
  let made = 0;
  if (envs) {
    const baseVars = flatten(envs['data']);
    if (!subs.length && baseVars.length) {
      b.environment(str(envs['name']) || 'Base Environment', withSecrets(baseVars, creds));
      made++;
    }
    for (const sub of subs) {
      const own = flatten(sub['data']);
      b.environment(str(sub['name']) || 'Environment', withSecrets([...baseVars.filter((v) => !own.some((o) => o.key === v.key)), ...own], creds));
      made++;
    }
  }
  if (!made && creds.variables.length) b.environment(`${b.root.name} credentials`, creds.variables);
  const result = b.result();
  if (!result.requests.length) throw new ImportError('The Insomnia export has no requests');
  return result;
}

function requestOf(r: Json, skip: Skip, creds: Credentials): Partial<ApiRequest> | null {
  const name = str(r['name']) || 'Request';
  const m = method(r['method'] || 'GET');
  if (!m) {
    skip(`${name} was not imported: Quiver does not send ${str(r['method'])}`);
    return null;
  }
  const split = splitQuery(template(str(r['url']), name, skip));
  const params: KeyValue[] = [...split.params, ...arr(r['parameters']).filter(isRecord).map((p) => keyValue(str(p['name']), template(str(p['value']), name, skip), p['disabled'] !== true))];
  const headers = arr(r['headers'])
    .filter(isRecord)
    .map((h) => keyValue(str(h['name']), template(str(h['value']), name, skip), h['disabled'] !== true));
  const body = bodyOf(r['body'], name, skip);
  const auth = authOf(r['authentication'], name, skip, creds);
  const description = str(r['description']).trim();
  return { name, method: m, url: split.url, params, headers, body, auth: auth ?? { type: 'inherit' }, ...(description ? { description } : {}) };
}

function bodyOf(raw: unknown, name: string, skip: Skip): RequestBody {
  if (!isRecord(raw)) return { type: 'none' };
  const mime = str(raw['mimeType']).toLowerCase();
  const text = template(str(raw['text']), name, skip);
  const fields = arr(raw['params']).filter(isRecord);
  if (mime === 'application/x-www-form-urlencoded') return { type: 'urlencoded', fields: fields.map((f) => keyValue(str(f['name']), template(str(f['value']), name, skip), f['disabled'] !== true)) };
  if (mime === 'multipart/form-data')
    return {
      type: 'form',
      fields: fields.map((f): FormField =>
        str(f['type']) === 'file' ? { ...keyValue(str(f['name']), str(f['fileName']), f['disabled'] !== true), kind: 'file' } : keyValue(str(f['name']), template(str(f['value']), name, skip), f['disabled'] !== true),
      ),
    };
  if (mime === 'application/graphql') {
    try {
      const parsed = JSON.parse(text) as Json;
      return { type: 'graphql', query: str(parsed['query']), variables: parsed['variables'] ? JSON.stringify(parsed['variables'], null, 2) : '' };
    } catch {
      return { type: 'graphql', query: text, variables: '' };
    }
  }
  if (mime === 'application/octet-stream' || str(raw['fileName'])) return { type: 'binary', path: str(raw['fileName']) };
  if (!text) return { type: 'none' };
  return { type: rawBodyType(mime, text), content: text };
}

/** The auth of a request or folder; a literal credential in it goes to `creds` and a `{{variable}}` takes its place. */
function authOf(raw: unknown, where: string, skip: Skip, creds: Credentials): ApiAuth | null {
  if (!isRecord(raw) || !str(raw['type'])) return null;
  if (raw['disabled'] === true) return { type: 'none' };
  const t = (key: string) => template(str(raw[key]), where, skip);
  switch (str(raw['type'])) {
    case 'none':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', token: creds.take('token', t('token'), where) };
    case 'basic':
      return { type: 'basic', username: t('username'), password: creds.take('password', t('password'), where) };
    case 'apikey': {
      const key = t('key') || 'X-API-Key';
      return { type: 'apikey', key, value: creds.take(key, t('value'), where), in: str(raw['addTo']) === 'queryParams' ? 'query' : 'header' };
    }
    case 'oauth2': {
      const grant = str(raw['grantType']);
      if (grant === 'client_credentials' || grant === 'authorization_code') {
        return {
          type: 'oauth2',
          grant,
          tokenUrl: t('accessTokenUrl'),
          ...(t('authorizationUrl') ? { authUrl: t('authorizationUrl') } : {}),
          clientId: t('clientId'),
          clientSecret: creds.take('client_secret', t('clientSecret'), where),
          scopes: t('scope'),
          ...(t('audience') ? { audience: t('audience') } : {}),
          clientAuth: str(raw['credentialsInBody']) === 'true' || raw['credentialsInBody'] === true ? 'body' : 'basic',
          pkce: raw['usePkce'] === true,
        };
      }
      skip(`The OAuth 2.0 grant ${grant || '(none)'} on ${where} is not supported; client credentials and authorization code are`);
      return null;
    }
    default:
      skip(`The ${str(raw['type'])} auth on ${where} is not supported`);
      return null;
  }
}
