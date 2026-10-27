import { createHash } from 'node:crypto';
import { getServers, type AnyRecord, type CaaRecord } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { domainToASCII, domainToUnicode } from 'node:url';
import {
  DEFAULT_DNS_TYPES,
  DNS_RECORD_TYPES,
  QuiverError,
  classifyDnsError,
  cnameChain,
  defineCommand,
  defineModule,
  formatDnsServer,
  parseDnsName,
  parseDnsServer,
  relativeTime,
  reverseDnsName,
  sortDnsRecords,
  type DnsRecord,
  type DnsRecordData,
  type DnsRecordType,
  type DnsServer,
} from '@quiver/core';
import { JWT_ALGORITHMS, jwtParts, verifyJwt } from '@quiver/core/node';
import { z } from 'zod';

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new QuiverError('INVALID_INPUT', `Invalid JSON: ${(err as Error).message}`);
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

const jsonFormat = defineCommand({
  id: 'tools.json.format',
  title: 'Format JSON',
  description: 'Pretty-prints JSON with the given indent. Optionally sorts object keys.',
  scope: 'global',
  input: z.object({ text: z.string(), indent: z.number().int().min(0).max(8).default(2), sortKeys: z.boolean().default(false) }),
  handler: async ({ text, indent, sortKeys }) => {
    const value = parseJson(text);
    return { text: JSON.stringify(sortKeys ? sortKeysDeep(value) : value, null, indent) };
  },
});

const jsonMinify = defineCommand({
  id: 'tools.json.minify',
  title: 'Minify JSON',
  description: 'Removes whitespace from JSON.',
  scope: 'global',
  input: z.object({ text: z.string() }),
  handler: async ({ text }) => ({ text: JSON.stringify(parseJson(text)) }),
});

const base64Encode = defineCommand({
  id: 'tools.base64.encode',
  title: 'Base64 encode',
  description: 'Encodes UTF-8 text as base64 (standard or URL-safe).',
  scope: 'global',
  input: z.object({ text: z.string(), urlSafe: z.boolean().default(false) }),
  handler: async ({ text, urlSafe }) => ({ text: Buffer.from(text, 'utf8').toString(urlSafe ? 'base64url' : 'base64') }),
});

const base64Decode = defineCommand({
  id: 'tools.base64.decode',
  title: 'Base64 decode',
  description: 'Decodes base64 or base64url into UTF-8 text.',
  scope: 'global',
  input: z.object({ text: z.string() }),
  handler: async ({ text }) => ({ text: Buffer.from(text.trim(), 'base64').toString('utf8') }),
});

const urlEncode = defineCommand({
  id: 'tools.url.encode',
  title: 'URL encode',
  description: 'Percent-encodes text. Component mode also encodes reserved characters like / and ?.',
  scope: 'global',
  input: z.object({ text: z.string(), component: z.boolean().default(true) }),
  handler: async ({ text, component }) => ({ text: component ? encodeURIComponent(text) : encodeURI(text) }),
});

const urlDecode = defineCommand({
  id: 'tools.url.decode',
  title: 'URL decode',
  description: 'Decodes percent-encoded text.',
  scope: 'global',
  input: z.object({ text: z.string() }),
  handler: async ({ text }) => {
    try {
      return { text: decodeURIComponent(text.replace(/\+/g, ' ')) };
    } catch (err) {
      throw new QuiverError('INVALID_INPUT', (err as Error).message);
    }
  },
});

function decodeSegment(segment: string): unknown {
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return parseJson(json);
}

function decodeJwt(token: string) {
  const parts = jwtParts(token);
  const header = decodeSegment(parts[0]) as Record<string, unknown>;
  const payload = decodeSegment(parts[1]) as Record<string, unknown>;
  const toDate = (v: unknown) => (typeof v === 'number' ? new Date(v * 1000).toISOString() : null);
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  return {
    header,
    payload,
    signature: parts[2],
    issuedAt: toDate(payload.iat),
    notBefore: toDate(payload.nbf),
    expiresAt: toDate(exp),
    isExpired: exp !== null ? exp * 1000 < Date.now() : null,
  };
}

const jwtDecode = defineCommand({
  id: 'tools.jwt.decode',
  title: 'Decode JWT',
  description: 'Decodes a JSON Web Token without verifying it. Reports expiry. Takes the token alone or an Authorization header value (Bearer or jwt scheme).',
  scope: 'global',
  input: z.object({ token: z.string() }),
  handler: async ({ token }) => decodeJwt(token),
});

const jwtVerify = defineCommand({
  id: 'tools.jwt.verify',
  title: 'Verify JWT',
  description: `Validates a JSON Web Token and decodes it: the signature, then exp and nbf (allowing clockSkewSeconds), then iss and aud when issuer and audience are given (aud may be a string or an array). valid is the verdict and problems says what failed; signatureValid is the signature alone. The key is the shared secret for HS256/384/512 (base64 with base64Secret), or for RS, PS, ES and EdDSA a public key, private key or certificate as PEM, base64-wrapped PEM, bare base64 DER, JWK or JWK set (picked by kid). Supported: ${JWT_ALGORITHMS.join(', ')}.`,
  scope: 'global',
  input: z.object({
    token: z.string(),
    key: z.string(),
    base64Secret: z.boolean().default(false),
    clockSkewSeconds: z.number().int().min(0).max(86400).default(0),
    issuer: z.string().optional(),
    audience: z.string().optional(),
  }),
  handler: async ({ token, key, base64Secret, clockSkewSeconds, issuer, audience }) => {
    const decoded = decodeJwt(token);
    return { ...verifyJwt(token, key, { base64Secret, clockSkewSeconds, issuer: issuer?.trim() || undefined, audience: audience?.trim() || undefined }), ...decoded };
  },
});

const uuidGenerate = defineCommand({
  id: 'tools.uuid.generate',
  title: 'Generate UUID',
  description: 'Generates one or more random v4 UUIDs.',
  scope: 'global',
  input: z.object({ count: z.number().int().min(1).max(100).default(1), uppercase: z.boolean().default(false) }),
  handler: async ({ count, uppercase }) => {
    const ids = Array.from({ length: count }, () => globalThis.crypto.randomUUID());
    const text = (uppercase ? ids.map((i) => i.toUpperCase()) : ids).join('\n');
    return { text, ids };
  },
});

const hashDigest = defineCommand({
  id: 'tools.hash.digest',
  title: 'Hash text',
  description: 'Computes a hex digest of UTF-8 text.',
  scope: 'global',
  input: z.object({ text: z.string(), algorithm: z.enum(['md5', 'sha1', 'sha256', 'sha512']).default('sha256') }),
  handler: async ({ text, algorithm }) => ({ text: createHash(algorithm).update(text, 'utf8').digest('hex'), algorithm }),
});

const timestampConvert = defineCommand({
  id: 'tools.timestamp.convert',
  title: 'Convert timestamp',
  description: 'Accepts unix seconds, unix milliseconds, an ISO date, or "now" and returns every common representation.',
  scope: 'global',
  input: z.object({ value: z.string().default('now') }),
  handler: async ({ value }) => {
    const raw = value.trim();
    let date: Date;
    if (!raw || raw === 'now') date = new Date();
    else if (/^-?\d+$/.test(raw)) {
      const n = Number(raw);
      date = new Date(Math.abs(n) < 1e11 ? n * 1000 : n);
    } else date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new QuiverError('INVALID_INPUT', `Cannot parse "${raw}" as a date`);
    const diff = date.getTime() - Date.now();
    return {
      iso: date.toISOString(),
      unixSeconds: Math.floor(date.getTime() / 1000),
      unixMs: date.getTime(),
      utc: date.toUTCString(),
      local: date.toString(),
      relative: relativeTime(diff),
      dayOfWeek: date.toLocaleDateString('en-US', { weekday: 'long' }),
    };
  },
});

type DnsAnswer = { name: string; target: string };

/** One type's records; `name` is filled in by the caller once the CNAME chain is known. */
async function queryDnsType(resolver: Resolver, type: Exclude<DnsRecordType, 'CNAME'>, name: string): Promise<DnsRecord[]> {
  const rec = (data: DnsRecordData, ttl: number | null = null, recordType: string = type): DnsRecord => ({ query: type, type: recordType, name, ttl, data });
  switch (type) {
    case 'A':
      return (await resolver.resolve4(name, { ttl: true })).map((a) => rec({ address: a.address }, a.ttl));
    case 'AAAA':
      return (await resolver.resolve6(name, { ttl: true })).map((a) => rec({ address: a.address }, a.ttl));
    case 'MX':
      return (await resolver.resolveMx(name)).map((m) => rec({ exchange: m.exchange, priority: m.priority }));
    case 'NS':
      return (await resolver.resolveNs(name)).map((target) => rec({ target }));
    case 'TXT':
      return (await resolver.resolveTxt(name)).map((entries) => rec({ entries }));
    case 'SOA': {
      const s = await resolver.resolveSoa(name);
      return [rec({ nsname: s.nsname, hostmaster: s.hostmaster, serial: s.serial, refresh: s.refresh, retry: s.retry, expire: s.expire, minttl: s.minttl })];
    }
    case 'SRV':
      return (await resolver.resolveSrv(name)).map((s) => rec({ target: s.name, priority: s.priority, weight: s.weight, port: s.port }));
    case 'CAA':
      return (await resolver.resolveCaa(name)).map((c) => rec(caaData(c)));
    case 'PTR':
      return (await resolver.resolvePtr(name)).map((target) => rec({ target }));
    case 'ANY':
      return (await resolver.resolveAny(name)).map((r) => rec(anyData(r), 'ttl' in r && typeof r.ttl === 'number' ? r.ttl : null, r.type));
  }
}

/** A CAA record as its RFC 8659 fields: Node gives the tag as the key (`issue`, `issuewild`, `iodef`, …). */
function caaData(c: CaaRecord): DnsRecordData {
  const tag = Object.keys(c).find((k) => k !== 'critical' && k !== 'type') ?? 'issue';
  return { critical: c.critical, tag, value: String((c as unknown as Record<string, unknown>)[tag] ?? '') };
}

function anyData(r: AnyRecord): DnsRecordData {
  switch (r.type) {
    case 'A':
    case 'AAAA':
      return { address: r.address };
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return { target: r.value };
    case 'MX':
      return { exchange: r.exchange, priority: r.priority };
    case 'TXT':
      return { entries: r.entries };
    case 'SOA':
      return { nsname: r.nsname, hostmaster: r.hostmaster, serial: r.serial, refresh: r.refresh, retry: r.retry, expire: r.expire, minttl: r.minttl };
    case 'SRV':
      return { target: r.name, priority: r.priority, weight: r.weight, port: r.port };
    case 'CAA':
      return caaData(r);
    default:
      return { target: JSON.stringify(r) };
  }
}

/**
 * The CNAME links from `name`, one alias at a time until a name is not one (at most 16 hops, stopping at a loop).
 * `missing` is how the first question ended when `name` is not an alias: ENODATA (it exists) or ENOTFOUND (NXDOMAIN).
 */
async function followCnames(resolver: Resolver, name: string): Promise<{ answers: DnsAnswer[]; missing?: 'ENODATA' | 'ENOTFOUND' }> {
  const answers: DnsAnswer[] = [];
  const seen = new Set<string>();
  for (let current = name; answers.length < 16 && !seen.has(current.toLowerCase().replace(/\.$/, '')); ) {
    seen.add(current.toLowerCase().replace(/\.$/, ''));
    let targets: string[];
    try {
      targets = await resolver.resolveCname(current);
    } catch (err) {
      const c = classifyDnsError(err);
      if (c.kind === 'empty') return { answers, ...(answers.length ? {} : { missing: c.code }) };
      throw err;
    }
    if (!targets.length) break;
    answers.push({ name: current, target: targets[0] });
    current = targets[0];
  }
  return { answers, ...(answers.length ? {} : { missing: 'ENODATA' as const }) };
}

/** A system resolver as `getServers()` lists it (`1.1.1.1`, `1.1.1.1:5353`, `::1`, `[::1]:5353`). */
function parseSystemServer(text: string): DnsServer {
  try {
    return parseDnsServer(text);
  } catch {
    return { address: text, port: 53 };
  }
}

const dnsLookup = defineCommand({
  id: 'tools.dns.lookup',
  title: 'DNS lookup',
  description:
    'Looks a name up in DNS, several record types at once: A, AAAA, CNAME, MX, NS, TXT, SOA and CAA by default; SRV, PTR and ANY on request. Returns the records in the order of the types (TTL for A and AAAA only), the CNAME chain when the name is an alias, the resolver used and the time taken. An IP address is looked up in reverse (PTR) instead. server is an IP with an optional port (1.1.1.1, 8.8.8.8:53, [2606:4700:4700::1111]:53), the system resolvers when left out; host names are refused. Types with no records ("no data") or a name that does not exist (NXDOMAIN, "ENOTFOUND") are listed under empty; failures such as timeouts or refusals under errors.',
  scope: 'global',
  input: z.object({
    name: z.string().max(1024),
    types: z.array(z.enum(DNS_RECORD_TYPES)).max(DNS_RECORD_TYPES.length).optional(),
    server: z.string().max(80).optional(),
    timeoutMs: z.number().int().min(500).max(20000).default(5000),
  }),
  handler: async ({ name: input, types, server, timeoutMs }) => {
    const started = performance.now();
    const target = parseDnsName(input, { toAscii: domainToASCII, toUnicode: domainToUnicode });
    const custom = server?.trim() ? parseDnsServer(server) : null;
    const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
    if (custom) resolver.setServers([formatDnsServer(custom)]);
    const systemServers = getServers();
    const used = custom ?? (systemServers[0] ? parseSystemServer(systemServers[0]) : { address: '', port: 53 });
    const asked: DnsRecordType[] = target.kind === 'ip' ? ['PTR'] : [...new Set(types?.length ? types : DEFAULT_DNS_TYPES)];
    const asciiName = target.kind === 'ip' ? reverseDnsName(target.address) : target.asciiName;
    const records: DnsRecord[] = [];
    const errors: { type: string; code: string; message: string }[] = [];
    const empty: { type: string; code: 'ENODATA' | 'ENOTFOUND' }[] = [];
    const fail = (type: string, err: unknown) => {
      const c = classifyDnsError(err);
      if (c.kind === 'empty') empty.push({ type, code: c.code });
      else errors.push({ type, code: c.code, message: c.message });
    };
    let chain: DnsAnswer[] = [];
    let reverse: { address: string; names: string[] } | undefined;
    try {
      if (target.kind === 'ip') {
        reverse = { address: target.address, names: [] };
        try {
          reverse.names = await resolver.reverse(target.address);
          records.push(...reverse.names.map((n): DnsRecord => ({ query: 'PTR', type: 'PTR', name: asciiName, ttl: null, data: { target: n } })));
          if (!reverse.names.length) empty.push({ type: 'PTR', code: 'ENODATA' });
        } catch (err) {
          fail('PTR', err);
        }
      } else {
        // Every type runs at once; the resolver follows an alias for them, so their records belong to the chain's end.
        const wantsCname = asked.includes('CNAME');
        let cnameMissing: 'ENODATA' | 'ENOTFOUND' | undefined;
        const [followed, ...found] = await Promise.all([
          followCnames(resolver, asciiName).then(
            ({ answers, missing }) => {
              cnameMissing = missing;
              return cnameChain(asciiName, answers);
            },
            (err) => {
              if (wantsCname) fail('CNAME', err);
              return [];
            },
          ),
          ...asked
            .filter((t): t is Exclude<DnsRecordType, 'CNAME'> => t !== 'CNAME')
            .map((type) =>
              queryDnsType(resolver, type, asciiName).then(
                (list) => {
                  if (!list.length) empty.push({ type, code: 'ENODATA' });
                  return list;
                },
                (err) => {
                  fail(type, err);
                  return [];
                },
              ),
            ),
        ]);
        chain = followed;
        const owner = chain.length ? chain[chain.length - 1].target : asciiName;
        if (wantsCname) {
          records.push(...chain.map((link): DnsRecord => ({ query: 'CNAME', type: 'CNAME', name: link.name, ttl: null, data: { target: link.target } })));
          // Not an alias: say whether the name exists at all, as the CNAME question found out.
          if (!chain.length && !errors.some((e) => e.type === 'CNAME')) empty.push({ type: 'CNAME', code: cnameMissing ?? 'ENODATA' });
        }
        for (const r of found.flat()) records.push({ ...r, name: r.type === 'PTR' || r.query === 'ANY' ? asciiName : owner });
      }
    } finally {
      resolver.cancel();
    }
    const order = (type: string) => asked.indexOf(type as DnsRecordType);
    return {
      name: target.kind === 'ip' ? target.address : target.name,
      asciiName,
      server: { address: used.address, port: used.port, source: custom ? ('custom' as const) : ('system' as const) },
      systemServers,
      types: asked,
      records: sortDnsRecords(records, asked),
      chain,
      ...(reverse ? { reverse } : {}),
      empty: empty.sort((a, b) => order(a.type) - order(b.type)),
      errors: errors.sort((a, b) => order(a.type) - order(b.type)),
      durationMs: Math.round(performance.now() - started),
    };
  },
});

export const toolsModule = defineModule({
  id: 'tools',
  commands: [jsonFormat, jsonMinify, base64Encode, base64Decode, urlEncode, urlDecode, jwtDecode, jwtVerify, uuidGenerate, hashDigest, timestampConvert, dnsLookup],
});
