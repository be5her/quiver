import { QuiverError } from './errors';

// The pure half of the Tools DNS lookup (`tools.dns.lookup`): validating and normalising the name and the resolver,
// following a CNAME chain, classifying resolver errors and ordering the records. The lookups themselves run on
// `node:dns/promises` in the tools module.

export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'CAA', 'PTR', 'ANY'] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];
/** What a lookup asks for when no types are given. */
export const DEFAULT_DNS_TYPES: DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'];

export interface DnsSoa {
  nsname: string;
  hostmaster: string;
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minttl: number;
}

/** The fields of one record, by its type. */
export type DnsRecordData =
  | { address: string }
  | { target: string }
  | { exchange: string; priority: number }
  | { entries: string[] }
  | DnsSoa
  | { target: string; priority: number; weight: number; port: number }
  | { critical: number; tag: string; value: string };

export interface DnsRecord {
  /** The type that was asked for: the record's own type, or ANY for what an ANY query returned. */
  query: DnsRecordType;
  /** The record's own type (for ANY answers, what the server sent). */
  type: string;
  name: string;
  /** Seconds; Node only reports it for A and AAAA. */
  ttl: number | null;
  data: DnsRecordData;
}

export interface DnsServer {
  address: string;
  port: number;
}

export type DnsName = { kind: 'ip'; address: string; version: 4 | 6 } | { kind: 'host'; name: string; asciiName: string };

/** IDNA conversion, `url.domainToASCII` and `url.domainToUnicode` on Node. They return '' for what they cannot convert. */
export interface Idna {
  toAscii(name: string): string;
  toUnicode(name: string): string;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** 4 or 6 for an IP address (an IPv6 address without brackets or a zone), 0 otherwise. */
export function ipVersion(text: string): 0 | 4 | 6 {
  if (IPV4.test(text)) return 4;
  if (!text.includes(':') || /[^0-9a-fA-F:.]/.test(text)) return 0;
  try {
    new URL(`http://[${text}]/`);
    return 6;
  } catch {
    return 0;
  }
}

/** The canonical (compressed, lower case) form of an IPv6 address. */
function canonicalV6(text: string): string {
  return new URL(`http://[${text}]/`).hostname.slice(1, -1);
}

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * Checks and normalises what the user typed as the name to look up: an IP address (looked up in reverse), or a host
 * name with at most one trailing dot, converted to ASCII (IDN). Refuses empty, over 253 characters, labels that are
 * empty, over 63 characters, start or end with a hyphen (so nothing option-like gets through) or hold other characters,
 * and a numeric last label (an IP typed short, which URL parsing would otherwise turn into an address).
 */
export function parseDnsName(input: string, idna: Idna): DnsName {
  const raw = input.trim();
  if (!raw) throw new QuiverError('INVALID_INPUT', 'Give a name to look up.');
  const bare = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  const version = ipVersion(bare);
  if (version === 4) return { kind: 'ip', address: bare, version };
  if (version === 6) return { kind: 'ip', address: canonicalV6(bare), version };
  const name = raw.endsWith('.') ? raw.slice(0, -1) : raw;
  if (!name || name.startsWith('.')) throw new QuiverError('INVALID_INPUT', `"${raw}" is not a host name.`);
  const asciiName = /^[\x00-\x7f]*$/.test(name) ? name.toLowerCase() : idna.toAscii(name);
  if (!asciiName) throw new QuiverError('INVALID_INPUT', `"${raw}" is not a host name.`);
  if (asciiName.length > 253) throw new QuiverError('INVALID_INPUT', `The name is ${asciiName.length} characters long; DNS allows at most 253.`);
  const labels = asciiName.split('.');
  const bad = labels.find((label) => !LABEL.test(label));
  if (bad !== undefined) {
    const why = !bad ? 'has an empty label' : bad.length > 63 ? `has a label of ${bad.length} characters (at most 63)` : `has an invalid label "${bad}"`;
    throw new QuiverError('INVALID_INPUT', `"${raw}" is not a host name: it ${why}.`);
  }
  if (/^\d+$/.test(labels[labels.length - 1])) throw new QuiverError('INVALID_INPUT', `"${raw}" is neither an IP address nor a host name.`);
  return { kind: 'host', name: idna.toUnicode(asciiName) || asciiName, asciiName };
}

/**
 * Reads a resolver given as `ip`, `ip:port`, `[v6]` or `[v6]:port` (a bare IPv6 address takes port 53). Host names
 * are refused, so nothing is looked up to find the resolver.
 */
export function parseDnsServer(input: string): DnsServer {
  const raw = input.trim();
  const refuse = (): never => {
    throw new QuiverError('INVALID_INPUT', `The resolver "${raw}" must be an IP address, optionally with a port (1.1.1.1, 1.1.1.1:53, [2606:4700:4700::1111]:53); host names are not looked up.`);
  };
  let address = raw;
  let port = '';
  const bracketed = /^\[([^\]]+)\](?::(.*))?$/.exec(raw);
  if (bracketed) {
    address = bracketed[1];
    port = bracketed[2] ?? '';
    if (bracketed[2] === '') refuse();
    if (ipVersion(address) !== 6) refuse();
  } else if ((raw.match(/:/g) ?? []).length === 1) {
    [address, port] = raw.split(':');
    if (ipVersion(address) !== 4 || !port) refuse();
  } else if (!ipVersion(raw)) refuse();
  let portNumber = 53;
  if (port) {
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) refuse();
    portNumber = Number(port);
  }
  return { address: ipVersion(address) === 6 ? canonicalV6(address) : address, port: portNumber };
}

/** The form `Resolver.setServers` takes, and the one the result shows: `1.1.1.1:53`, `[::1]:5353`. */
export function formatDnsServer(server: DnsServer): string {
  return server.address.includes(':') ? `[${server.address}]:${server.port}` : `${server.address}:${server.port}`;
}

function expandV6(address: string): string[] {
  let text = canonicalV6(address);
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    text = text.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.map((g) => g.padStart(4, '0'));
}

/** The name a PTR query asks for: `10.2.0.192.in-addr.arpa`, or the 32 nibbles of an IPv6 address under `ip6.arpa`. */
export function reverseDnsName(address: string): string {
  if (ipVersion(address) === 4) return `${address.split('.').reverse().join('.')}.in-addr.arpa`;
  return `${expandV6(address).join('').split('').reverse().join('.')}.ip6.arpa`;
}

const bareName = (name: string) => name.toLowerCase().replace(/\.$/, '');

/** The CNAME chain from `start`, one link per alias, from the answers seen (each `name` pointing at `target`). Stops at a loop or after 16 links. */
export function cnameChain(start: string, answers: { name: string; target: string }[]): { name: string; target: string }[] {
  const byName = new Map<string, string>();
  for (const a of answers) if (!byName.has(bareName(a.name))) byName.set(bareName(a.name), bareName(a.target));
  const chain: { name: string; target: string }[] = [];
  const seen = new Set<string>();
  for (let name = bareName(start); byName.has(name) && !seen.has(name) && chain.length < 16; ) {
    seen.add(name);
    const target = byName.get(name)!;
    chain.push({ name, target });
    name = target;
  }
  return chain;
}

const ERROR_MESSAGES: Record<string, string> = {
  ETIMEOUT: 'The resolver did not answer in time.',
  ECONNREFUSED: 'The resolver refused the connection.',
  EREFUSED: 'The resolver refused the query.',
  ESERVFAIL: 'The resolver failed to answer (SERVFAIL).',
  ENOTIMP: 'The resolver does not implement this query.',
  EFORMERR: 'The resolver says the query was malformed.',
  EBADRESP: 'The resolver sent a response that could not be read.',
  ECANCELLED: 'The query was cancelled.',
};

/**
 * What a failed query means: `empty` for "no records of this type" (ENODATA) and "no such name" (ENOTFOUND, NXDOMAIN),
 * which are answers, not failures; `error` with a readable message for everything else (a timeout, a refusal).
 */
export function classifyDnsError(err: unknown): { kind: 'empty'; code: 'ENODATA' | 'ENOTFOUND' } | { kind: 'error'; code: string; message: string } {
  const code = String((err as { code?: unknown })?.code ?? 'EUNKNOWN');
  if (code === 'ENODATA' || code === 'ENOTFOUND') return { kind: 'empty', code };
  return { kind: 'error', code, message: ERROR_MESSAGES[code] ?? ((err as { message?: string })?.message || code) };
}

/** Orders records as the types were asked (`types`), keeping the server's order within a type except MX (by priority) and SRV (by priority, then weight, heavier first). */
export function sortDnsRecords(records: DnsRecord[], types: readonly string[]): DnsRecord[] {
  const rank = (r: DnsRecord) => {
    const i = types.indexOf(r.query);
    return i < 0 ? types.length : i;
  };
  const num = (r: DnsRecord, key: string) => Number((r.data as unknown as Record<string, unknown>)[key] ?? 0);
  return records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const byType = rank(a.r) - rank(b.r);
      if (byType) return byType;
      if (a.r.query === 'MX' && a.r.type === 'MX') return num(a.r, 'priority') - num(b.r, 'priority') || a.i - b.i;
      if (a.r.query === 'SRV' && a.r.type === 'SRV') return num(a.r, 'priority') - num(b.r, 'priority') || num(b.r, 'weight') - num(a.r, 'weight') || a.i - b.i;
      return a.i - b.i;
    })
    .map(({ r }) => r);
}

/** One table per type asked, in the order asked, with its records (empty when none came back). */
export function groupDnsRecords(records: DnsRecord[], types: readonly string[]): { type: string; records: DnsRecord[] }[] {
  const sorted = sortDnsRecords(records, types);
  return [...new Set(types)].map((type) => ({ type, records: sorted.filter((r) => r.query === type) }));
}

/** A record's fields as one line for display and for agents reading a table: `10 mail.example.com`, `"v=spf1 …"`. */
export function formatDnsData(type: string, data: DnsRecordData): string {
  const d = data as unknown as Record<string, unknown>;
  switch (type) {
    case 'A':
    case 'AAAA':
      return String(d['address']);
    case 'MX':
      return `${d['priority']} ${d['exchange']}`;
    case 'SRV':
      return `${d['priority']} ${d['weight']} ${d['port']} ${d['target']}`;
    case 'TXT':
      return (d['entries'] as string[]).map((e) => JSON.stringify(e)).join(' ');
    case 'SOA':
      return `${d['nsname']} ${d['hostmaster']} ${d['serial']} ${d['refresh']} ${d['retry']} ${d['expire']} ${d['minttl']}`;
    case 'CAA':
      return `${d['critical']} ${d['tag']} ${JSON.stringify(d['value'])}`;
    default:
      return 'target' in d ? String(d['target']) : JSON.stringify(d);
  }
}
