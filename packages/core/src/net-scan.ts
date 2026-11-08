import { QuiverError } from './errors';

// The pure half of the Tools network scanner (`tools.netscan.run`): reading what to scan, picking the subnets this
// machine sits on and reading the output of ping and the ARP table. The probes themselves run in the tools module.

/** One scan covers at most this many addresses: a /20. */
export const NET_SCAN_MAX_HOSTS = 4096;
/** The TCP ports tried when none are given: the ones a machine on a network most often answers on. */
export const DEFAULT_SCAN_PORTS = [22, 53, 80, 135, 139, 443, 445, 3389, 5353, 8080, 8443, 9100];

export type NetScanFoundBy = 'ping' | 'tcp' | 'arp';

export interface NetScanHost {
  address: string;
  /** How it answered: an ICMP echo reply, a TCP answer (a refused connection counts) or an entry in the ARP table. */
  foundBy: NetScanFoundBy[];
  /** Round trip in milliseconds, of the ping or else the first TCP answer; null for a host only the ARP table knows. */
  latencyMs: number | null;
  /** The reverse DNS name, when the resolver has one. */
  hostname: string | null;
  /** Lower case, colon separated; only for hosts on the same network segment. */
  mac: string | null;
  openPorts: number[];
}

export interface NetScanTarget {
  /** Normalised: `192.168.1.0/24`, `192.168.1.10-192.168.1.50` or `192.168.1.7`. */
  label: string;
  /** First and last address as unsigned integers, both scanned. */
  first: number;
  last: number;
  count: number;
}

export interface NetScanSubnet {
  /** The adapter's name. */
  name: string;
  address: string;
  /** What to scan: the adapter's subnet, or the /24 around its address when that subnet is too large for one scan. */
  target: string;
  /** Its subnet was larger than one scan and was narrowed to the /24. */
  narrowed: boolean;
}

/** The address blocks a scan may touch. Public addresses belong to someone else, so they are refused. */
const PRIVATE_BLOCKS: readonly [string, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
];

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function ipv4ToInt(address: string): number | null {
  const m = IPV4.exec(address);
  if (!m) return null;
  return Number(m[1]) * 2 ** 24 + Number(m[2]) * 2 ** 16 + Number(m[3]) * 2 ** 8 + Number(m[4]);
}

export function intToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function privateBlockOf(value: number): number | null {
  for (let i = 0; i < PRIVATE_BLOCKS.length; i++) {
    const [base, prefix] = PRIVATE_BLOCKS[i];
    if ((value & maskOf(prefix)) >>> 0 === ipv4ToInt(base)) return i;
  }
  return null;
}

export function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  return value !== null && privateBlockOf(value) !== null;
}

function bad(text: string, why: string): QuiverError {
  return new QuiverError('INVALID_INPUT', `${text ? `"${text}"` : 'The target'} ${why}`);
}

const SYNTAX = 'is not something to scan: give an address (192.168.1.7), a subnet (192.168.1.0/24) or a range (192.168.1.10-50 or 192.168.1.10-192.168.1.50)';

/**
 * Reads what to scan: an IPv4 address, a subnet in CIDR notation or a range, whose end may be just the last octet. A
 * subnet leaves out its network and broadcast addresses, except a /31 and a /32, which have none. Refuses anything
 * outside the private blocks (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 127/8), and more than
 * `NET_SCAN_MAX_HOSTS` addresses.
 */
export function parseScanTarget(input: string): NetScanTarget {
  const text = input.trim();
  let first: number;
  let last: number;
  let label: string;
  const cidr = /^([^/]+)\/(\d{1,2})$/.exec(text);
  const range = /^([^-]+)-([^-]+)$/.exec(text);
  if (cidr) {
    const value = ipv4ToInt(cidr[1]);
    const prefix = Number(cidr[2]);
    if (value === null || prefix > 32) throw bad(text, SYNTAX);
    const network = (value & maskOf(prefix)) >>> 0;
    const broadcast = network + 2 ** (32 - prefix) - 1;
    first = prefix >= 31 ? network : network + 1;
    last = prefix >= 31 ? broadcast : broadcast - 1;
    label = `${intToIpv4(network)}/${prefix}`;
  } else if (range) {
    const from = ipv4ToInt(range[1].trim());
    const end = range[2].trim();
    // "192.168.1.10-50": the end replaces the last octet.
    const to = from !== null && /^\d{1,3}$/.test(end) && Number(end) <= 255 ? ((from & 0xffffff00) >>> 0) + Number(end) : ipv4ToInt(end);
    if (from === null || to === null) throw bad(text, SYNTAX);
    first = from;
    last = to;
    if (last < first) throw bad(text, 'ends before it starts');
    label = first === last ? intToIpv4(first) : `${intToIpv4(first)}-${intToIpv4(last)}`;
  } else {
    const only = ipv4ToInt(text);
    if (only === null) throw bad(text, SYNTAX);
    first = last = only;
    label = text;
  }
  const block = privateBlockOf(first);
  if (block === null || block !== privateBlockOf(last)) {
    throw bad(text, 'is not all in one private network. Only private addresses are scanned (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10 and 127/8)');
  }
  const count = last - first + 1;
  if (count > NET_SCAN_MAX_HOSTS) throw bad(text, `has ${count.toLocaleString('en-US')} addresses; one scan covers at most ${NET_SCAN_MAX_HOSTS.toLocaleString('en-US')} (a /20)`);
  return { label, first, last, count };
}

export function scanAddresses(target: Pick<NetScanTarget, 'first' | 'last'>): string[] {
  const out: string[] = [];
  for (let v = target.first; v <= target.last; v++) out.push(intToIpv4(v));
  return out;
}

export function sortByAddress<T extends { address: string }>(hosts: readonly T[]): T[] {
  return [...hosts].sort((a, b) => (ipv4ToInt(a.address) ?? 0) - (ipv4ToInt(b.address) ?? 0));
}

/** Adapters a virtual machine, container or VPN brings along: rarely the network someone means, so they are listed last. */
const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-?v|vmware|virtualbox|vbox|docker|^br-|^veth|utun|tailscale|zerotier|wireguard|loopback/i;

/** The IPv4 networks this machine sits on and could scan, the likeliest first. `interfaces` is `os.networkInterfaces()`. */
export function scanSubnets(interfaces: Record<string, readonly { address: string; family: string | number; internal: boolean; cidr?: string | null }[] | undefined>): NetScanSubnet[] {
  const out: (NetScanSubnet & { rank: number })[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const a of addresses ?? []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || !isPrivateIpv4(a.address)) continue;
      const prefix = Number(a.cidr?.split('/')[1] ?? 24);
      // A /32 (some VPNs) has nothing else on it to find.
      if (prefix >= 32) continue;
      const value = ipv4ToInt(a.address)!;
      const hosts = prefix >= 31 ? 2 : 2 ** (32 - prefix) - 2;
      const narrowed = hosts > NET_SCAN_MAX_HOSTS;
      const use = narrowed ? 24 : prefix;
      const target = `${intToIpv4((value & maskOf(use)) >>> 0)}/${use}`;
      const linkLocal = a.address.startsWith('169.254.');
      out.push({ name, address: a.address, target, narrowed, rank: (VIRTUAL_ADAPTER.test(name) ? 1 : 0) + (linkLocal ? 2 : 0) });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...subnet }) => subnet);
}

/**
 * Whether a ping got a reply, and how long it took. Windows' ping also exits 0 on "destination host unreachable", sent
 * by the local router, so there a reply is the line holding "TTL=", which stays the same in every language.
 */
export function readPing(output: string, exitCode: number | null, platform: string): { alive: boolean; latencyMs: number | null } {
  const alive = platform === 'win32' ? /\bttl[=:]\s*\d/i.test(output) : exitCode === 0;
  if (!alive) return { alive: false, latencyMs: null };
  // "time=1.23 ms", "Zeit<1ms", "temps=4 ms"; the word changes with the language, the shape does not.
  const time = /[=<]\s*(\d+(?:[.,]\d+)?)\s*ms/i.exec(output);
  return { alive: true, latencyMs: time ? Number(time[1].replace(',', '.')) : null };
}

/** `aa-bb-c-d-e-f` as `aa:bb:0c:0d:0e:0f`, or null for what is no machine: all zeros, broadcast and multicast. */
function normalizeMac(mac: string): string | null {
  const text = mac
    .toLowerCase()
    .split(/[:-]/)
    .map((p) => p.padStart(2, '0'))
    .join(':');
  if (text === '00:00:00:00:00:00' || text === 'ff:ff:ff:ff:ff:ff' || text.startsWith('01:00:5e') || text.startsWith('33:33')) return null;
  return text;
}

/** The ARP table as address to MAC, from the output of `arp -a` on any platform or Linux's `/proc/net/arp`. Incomplete entries are left out. */
export function parseArpTable(output: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const address = /\b\d{1,3}(?:\.\d{1,3}){3}\b/.exec(line)?.[0];
    const mac = /(?<![0-9a-f])[0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5}(?![0-9a-f])/i.exec(line)?.[0];
    if (!address || !mac || ipv4ToInt(address) === null) continue;
    const normal = normalizeMac(mac);
    if (normal) table.set(address, normal);
  }
  return table;
}

/** A list of TCP ports as typed (`22, 80 443`), without repeats. An empty text is no ports. */
export function parsePorts(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    const port = /^\d+$/.test(part) ? Number(part) : 0;
    if (port < 1 || port > 65535) throw new QuiverError('INVALID_INPUT', `"${part}" is not a TCP port (1 to 65535)`);
    out.add(port);
  }
  return [...out];
}
