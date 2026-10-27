import { createSocket, type RemoteInfo } from 'node:dgram';

/** A record of the fake zone: its type and its fields in presentation order. */
type Rr =
  | { type: 'A' | 'AAAA'; ttl: number; address: string }
  | { type: 'CNAME' | 'NS' | 'PTR'; ttl: number; target: string }
  | { type: 'MX'; ttl: number; priority: number; exchange: string }
  | { type: 'TXT'; ttl: number; entries: string[] }
  | { type: 'SOA'; ttl: number; nsname: string; hostmaster: string; serial: number; refresh: number; retry: number; expire: number; minttl: number }
  | { type: 'SRV'; ttl: number; priority: number; weight: number; port: number; target: string }
  | { type: 'CAA'; ttl: number; critical: number; tag: string; value: string };

const TYPE_CODES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, ANY: 255, CAA: 257 };
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPE_CODES).map(([k, v]) => [v, k]));

/**
 * The zone the fake answers, as the smoke checks expect it: `quiver.test` with every common type (MX and SRV listed
 * out of order, so the tool's sorting shows), `www.quiver.test` an alias of an alias of it, a PTR for 192.0.2.10,
 * NXDOMAIN for anything else, `refused.quiver.test` answered with REFUSED and `slow.quiver.test` never answered.
 */
export const FAKE_DNS_ZONE: Record<string, Rr[]> = {
  'quiver.test': [
    { type: 'A', ttl: 300, address: '192.0.2.10' },
    { type: 'A', ttl: 300, address: '192.0.2.11' },
    { type: 'AAAA', ttl: 600, address: '2001:db8::10' },
    { type: 'MX', ttl: 3600, priority: 20, exchange: 'mx2.quiver.test' },
    { type: 'MX', ttl: 3600, priority: 10, exchange: 'mx1.quiver.test' },
    { type: 'NS', ttl: 86400, target: 'ns1.quiver.test' },
    { type: 'NS', ttl: 86400, target: 'ns2.quiver.test' },
    { type: 'TXT', ttl: 300, entries: ['v=spf1 -all'] },
    { type: 'TXT', ttl: 300, entries: ['part one', 'part two'] },
    { type: 'SOA', ttl: 3600, nsname: 'ns1.quiver.test', hostmaster: 'hostmaster.quiver.test', serial: 2026102701, refresh: 3600, retry: 600, expire: 86400, minttl: 300 },
    { type: 'CAA', ttl: 3600, critical: 0, tag: 'issue', value: 'letsencrypt.org' },
    { type: 'CAA', ttl: 3600, critical: 128, tag: 'iodef', value: 'mailto:security@quiver.test' },
  ],
  'www.quiver.test': [{ type: 'CNAME', ttl: 300, target: 'edge.quiver.test' }],
  'edge.quiver.test': [{ type: 'CNAME', ttl: 300, target: 'quiver.test' }],
  '_sip._tcp.quiver.test': [
    { type: 'SRV', ttl: 300, priority: 10, weight: 20, port: 5060, target: 'sip1.quiver.test' },
    { type: 'SRV', ttl: 300, priority: 10, weight: 60, port: 5060, target: 'sip2.quiver.test' },
    { type: 'SRV', ttl: 300, priority: 5, weight: 0, port: 5061, target: 'sip3.quiver.test' },
  ],
  '10.2.0.192.in-addr.arpa': [{ type: 'PTR', ttl: 300, target: 'quiver.test' }],
};

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.').filter(Boolean);
  return Buffer.concat([...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'ascii')])), Buffer.from([0])]);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function ipv6Bytes(address: string): Buffer {
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return Buffer.concat(groups.map((g) => u16(parseInt(g, 16))));
}

function rdata(rr: Rr): Buffer {
  switch (rr.type) {
    case 'A':
      return Buffer.from(rr.address.split('.').map(Number));
    case 'AAAA':
      return ipv6Bytes(rr.address);
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return encodeName(rr.target);
    case 'MX':
      return Buffer.concat([u16(rr.priority), encodeName(rr.exchange)]);
    case 'TXT':
      return Buffer.concat(rr.entries.map((e) => Buffer.concat([Buffer.from([Buffer.byteLength(e)]), Buffer.from(e)])));
    case 'SOA':
      return Buffer.concat([encodeName(rr.nsname), encodeName(rr.hostmaster), u32(rr.serial), u32(rr.refresh), u32(rr.retry), u32(rr.expire), u32(rr.minttl)]);
    case 'SRV':
      return Buffer.concat([u16(rr.priority), u16(rr.weight), u16(rr.port), encodeName(rr.target)]);
    case 'CAA':
      return Buffer.concat([Buffer.from([rr.critical, rr.tag.length]), Buffer.from(rr.tag), Buffer.from(rr.value)]);
  }
}

/** One answer record; the owner is written as a pointer to the question when it is the name asked. */
function encodeRr(owner: string, qname: string, rr: Rr): Buffer {
  const data = rdata(rr);
  const name = owner === qname ? Buffer.from([0xc0, 0x0c]) : encodeName(owner);
  return Buffer.concat([name, u16(TYPE_CODES[rr.type]), u16(1), u32(rr.ttl), u16(data.length), data]);
}

/** The answers for a name and type, following CNAMEs inside the zone the way a recursive resolver would. */
function answer(name: string, type: string, depth = 0): { owner: string; rr: Rr }[] | null {
  const node = FAKE_DNS_ZONE[name];
  if (!node) return depth ? [] : null;
  if (type === 'ANY') return node.map((rr) => ({ owner: name, rr }));
  const alias = node.find((rr) => rr.type === 'CNAME');
  if (alias && type !== 'CNAME' && alias.type === 'CNAME' && depth < 8) return [{ owner: name, rr: alias }, ...(answer(alias.target, type, depth + 1) ?? [])];
  return node.filter((rr) => rr.type === type).map((rr) => ({ owner: name, rr }));
}

export interface FakeDns {
  port: number;
  /** `127.0.0.1:<port>`, as the tool's `server` takes it. */
  server: string;
  /** Every question received, in order. */
  questions: { name: string; type: string }[];
  close(): Promise<void>;
}

/** A UDP DNS responder on a free port of 127.0.0.1 that answers {@link FAKE_DNS_ZONE} and logs each question. */
export function startFakeDns(): Promise<FakeDns> {
  const socket = createSocket('udp4');
  const questions: { name: string; type: string }[] = [];

  const reply = (msg: Buffer, from: RemoteInfo) => {
    if (msg.length < 12 || msg.readUInt16BE(4) !== 1) return;
    const labels: string[] = [];
    let at = 12;
    while (at < msg.length && msg[at] !== 0) {
      labels.push(msg.subarray(at + 1, at + 1 + msg[at]).toString('ascii'));
      at += msg[at] + 1;
    }
    const questionEnd = at + 5;
    if (questionEnd > msg.length) return;
    const qname = labels.join('.').toLowerCase();
    const qtype = TYPE_NAMES[msg.readUInt16BE(at + 1)] ?? String(msg.readUInt16BE(at + 1));
    questions.push({ name: qname, type: qtype });
    if (qname === 'slow.quiver.test') return;
    const refused = qname === 'refused.quiver.test';
    const found = refused ? [] : answer(qname, qtype);
    const rcode = refused ? 5 : found === null ? 3 : 0;
    // QR, the query's opcode and RD, AA and RA, and the response code.
    const flags = 0x8000 | (msg.readUInt16BE(2) & 0x7900) | 0x0400 | 0x0080 | rcode;
    const header = Buffer.concat([msg.subarray(0, 2), u16(flags), u16(1), u16(found?.length ?? 0), u16(0), u16(0)]);
    const body = (found ?? []).map((a) => encodeRr(a.owner, qname, a.rr));
    socket.send(Buffer.concat([header, msg.subarray(12, questionEnd), ...body]), from.port, from.address);
  };

  socket.on('message', reply);
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address();
      resolve({ port, server: `127.0.0.1:${port}`, questions, close: () => new Promise((done) => socket.close(() => done())) });
    });
  });
}
