import { keyValue, type ApiCollection, type ApiRequest, type FormField, type KeyValue, type RequestBody } from '../models/api';
import { ImportBuilder, ImportError, arr, isRecord, maskCredentialBody, maskCredentialRows, method, parseStructured, rawBodyType, splitAuthScheme, splitQuery, str, variableName, type CredentialMask, type ImportResult } from './common';

type Json = Record<string, unknown>;

export interface HarImportOptions {
  /** Only entries to this host (`api.example.com`), or to hosts ending in `.example.com` when it starts with a dot. */
  host?: string;
}

/** Headers a browser or the connection sets, which a request sent again sets on its own. */
const DROPPED_HEADERS = /^(:|host$|content-length$|connection$|cookie$|accept-encoding$|keep-alive$|transfer-encoding$|upgrade$|te$|priority$)/i;
/** What a browser loads for a page rather than an API call. */
const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack', 'ping', 'preflight', 'websocket', 'eventsource']);
const STATIC_MIME = /^(image|font|audio|video)\/|^text\/css|javascript|^application\/(font|wasm)/i;

/**
 * HAR 1.2, as browsers save it: one request per API call, by host. Cookies are dropped and
 * credentials (Authorization, API key headers and parameters) replaced by `{{variables}}`, so a
 * recording of a signed-in session does not become committed requests carrying its tokens.
 */
export function importHar(text: string, options: HarImportOptions = {}): ImportResult {
  const doc = parseStructured(text, 'HAR file');
  const log = isRecord(doc) && isRecord(doc['log']) ? doc['log'] : null;
  if (!log || !Array.isArray(log['entries'])) throw new ImportError('The file is not a HAR file: it has no "log.entries"');
  const b = new ImportBuilder('HAR import');
  const skip = (line: string) => b.skip(line);
  const filter = options.host?.trim().toLowerCase() ?? '';
  const seen = new Set<string>();
  const masked = new Map<string, string>();
  let staticCount = 0;
  let duplicates = 0;
  let filtered = 0;
  const built: { host: string; request: Partial<ApiRequest> }[] = [];

  for (const entry of log['entries'].filter(isRecord)) {
    const req = isRecord(entry['request']) ? entry['request'] : null;
    if (!req) continue;
    const m = method(req['method']);
    let parsed: URL;
    try {
      parsed = new URL(str(req['url']));
    } catch {
      continue;
    }
    if (!m || !/^https?:$/.test(parsed.protocol)) continue;
    const host = parsed.host.toLowerCase();
    const response = isRecord(entry['response']) ? entry['response'] : {};
    const content = isRecord(response['content']) ? response['content'] : {};
    const resourceType = str(entry['_resourceType']).toLowerCase();
    if (resourceType ? STATIC_TYPES.has(resourceType) : STATIC_MIME.test(str(content['mimeType']))) {
      staticCount++;
      continue;
    }
    if (resourceType === 'document' && m === 'GET') {
      staticCount++;
      continue;
    }
    if (filter && !(filter.startsWith('.') ? parsed.hostname.endsWith(filter) || parsed.hostname === filter.slice(1) : host === filter || parsed.hostname === filter)) {
      filtered++;
      continue;
    }
    // A recording's values are never kept: the variable is left for the user to define. The scheme of an Authorization header stays: `Bearer {{authorization}}`.
    const mask: CredentialMask = (name, value) => {
      const variable = variableName(name);
      masked.set(name.toLowerCase(), variable);
      return `${splitAuthScheme(value).scheme}{{${variable}}}`;
    };
    const headers: KeyValue[] = maskCredentialRows(
      arr(req['headers'])
        .filter(isRecord)
        .filter((h) => !DROPPED_HEADERS.test(str(h['name'])))
        .map((h) => keyValue(str(h['name']), str(h['value']))),
      mask,
    );
    const split = splitQuery(`${parsed.origin}${parsed.pathname}${parsed.search}`);
    const params = maskCredentialRows(split.params, mask);
    const body = maskCredentialBody(bodyOf(req['postData'], headers), mask);
    const key = JSON.stringify([m, split.url, params.map((p) => [p.key, p.value]), body]);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const path = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/, '');
    built.push({ host, request: { name: `${m} ${path}`, method: m, url: split.url, params, headers, body, auth: { type: 'inherit' } } });
  }

  if (!built.length) {
    if (filtered) throw new ImportError(`No API request in the HAR file goes to ${filter}`);
    throw new ImportError('The HAR file has no API requests to import');
  }
  // One host: the requests sit at the root; several: a collection each.
  const hosts = [...new Set(built.map((x) => x.host))];
  if (hosts.length === 1) b.root.name = hosts[0];
  const folders = new Map<string, ApiCollection>();
  for (const { host, request } of built) {
    let folder = hosts.length === 1 ? b.root : folders.get(host);
    if (!folder) folders.set(host, (folder = b.folder(host)));
    b.request(folder, request);
  }
  for (const [name, variable] of masked) skip(`The ${name} credential was replaced with {{${variable}}}; define it in an environment`);
  if (staticCount) skip(`${staticCount} page load${staticCount === 1 ? '' : 's'} (documents, scripts, styles, images, fonts) left out`);
  if (duplicates) skip(`${duplicates} repeated request${duplicates === 1 ? '' : 's'} left out`);
  if (filtered) skip(`${filtered} request${filtered === 1 ? '' : 's'} to other hosts left out`);
  return b.result();
}

function bodyOf(raw: unknown, headers: KeyValue[]): RequestBody {
  if (!isRecord(raw)) return { type: 'none' };
  const mime = (str(raw['mimeType']) || headers.find((h) => h.key.toLowerCase() === 'content-type')?.value || '').toLowerCase();
  const fields = arr(raw['params']).filter(isRecord);
  const text = str(raw['text']);
  if (mime.startsWith('application/x-www-form-urlencoded')) {
    if (fields.length) return { type: 'urlencoded', fields: fields.map((f) => keyValue(decodeForm(str(f['name'])), decodeForm(str(f['value'])))) };
    return { type: 'urlencoded', fields: splitQuery(`?${text}`).params };
  }
  if (mime.startsWith('multipart/form-data')) {
    // The file a browser sent is not in the recording: its field is left to pick a file for.
    const out: FormField[] = fields.map((f) => (str(f['fileName']) ? { ...keyValue(str(f['name']), ''), kind: 'file', fileName: str(f['fileName']), ...(str(f['contentType']) ? { contentType: str(f['contentType']) } : {}) } : keyValue(str(f['name']), str(f['value']))));
    // The browser's boundary would not match the one Quiver writes.
    const at = headers.findIndex((h) => h.key.toLowerCase() === 'content-type');
    if (at >= 0) headers.splice(at, 1);
    return { type: 'form', fields: out };
  }
  if (!text) return { type: 'none' };
  return { type: rawBodyType(mime, text), content: text };
}

function decodeForm(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}
