import { domainToASCII, domainToUnicode } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyDnsError, cnameChain, formatDnsData, formatDnsServer, groupDnsRecords, ipVersion, parseDnsName, parseDnsServer, reverseDnsName, sortDnsRecords, type DnsRecord } from './dns-lookup';

const idna = { toAscii: domainToASCII, toUnicode: domainToUnicode };
const parse = (name: string) => parseDnsName(name, idna);
const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { code: string; message: string }).code === 'INVALID_INPUT' ? (err as Error).message : `wrong code: ${(err as { code: string }).code}`;
  }
  return null;
};

describe('parseDnsName', () => {
  it('lower-cases a host name and drops one trailing dot', () => {
    expect(parse('  Example.COM. ')).toEqual({ kind: 'host', name: 'example.com', asciiName: 'example.com' });
    expect(parse('_sip._tcp.example.com')).toEqual({ kind: 'host', name: '_sip._tcp.example.com', asciiName: '_sip._tcp.example.com' });
  });
  it('converts an IDN to ASCII and keeps the Unicode form', () => {
    expect(parse('bücher.example')).toEqual({ kind: 'host', name: 'bücher.example', asciiName: 'xn--bcher-kva.example' });
    expect(parse('xn--bcher-kva.example')).toEqual({ kind: 'host', name: 'bücher.example', asciiName: 'xn--bcher-kva.example' });
  });
  it('recognises IPv4 and IPv6 addresses, bracketed or not', () => {
    expect(parse('192.0.2.10')).toEqual({ kind: 'ip', address: '192.0.2.10', version: 4 });
    expect(parse('2001:DB8:0:0::1')).toEqual({ kind: 'ip', address: '2001:db8::1', version: 6 });
    expect(parse('[::1]')).toEqual({ kind: 'ip', address: '::1', version: 6 });
  });
  it('refuses empty, too long, invalid characters, option-like and numeric names', () => {
    expect(refused(() => parse('   '))).toMatch(/Give a name/);
    expect(refused(() => parse(`${'a'.repeat(60)}.`.repeat(5) + 'com'))).toMatch(/at most 253/);
    expect(refused(() => parse(`${'a'.repeat(64)}.com`))).toMatch(/64 characters/);
    expect(refused(() => parse('exa mple.com'))).toMatch(/invalid label "exa mple"/);
    expect(refused(() => parse('a..b'))).toMatch(/empty label/);
    expect(refused(() => parse('.'))).toMatch(/not a host name/);
    expect(refused(() => parse('-x'))).toMatch(/invalid label "-x"/);
    expect(refused(() => parse('--help'))).toMatch(/invalid label/);
    expect(refused(() => parse('example.com/x'))).toMatch(/invalid label/);
    expect(refused(() => parse('1.2'))).toMatch(/neither an IP address nor a host name/);
    expect(refused(() => parse('256.1.1.1'))).toMatch(/neither/);
    expect(refused(() => parse('a.b.c..'))).toMatch(/empty label/);
  });
});

describe('ipVersion', () => {
  it('tells v4, v6 and neither apart', () => {
    expect(ipVersion('10.0.0.1')).toBe(4);
    expect(ipVersion('010.0.0.1')).toBe(0);
    expect(ipVersion('::ffff:10.0.0.1')).toBe(6);
    expect(ipVersion('1:2')).toBe(0);
    expect(ipVersion('fe80::1%eth0')).toBe(0);
    expect(ipVersion('example.com')).toBe(0);
  });
});

describe('parseDnsServer', () => {
  it('reads ip, ip:port, [v6], [v6]:port and a bare v6 address', () => {
    expect(parseDnsServer('1.1.1.1')).toEqual({ address: '1.1.1.1', port: 53 });
    expect(parseDnsServer(' 127.0.0.1:5353 ')).toEqual({ address: '127.0.0.1', port: 5353 });
    expect(parseDnsServer('[2606:4700:4700::1111]')).toEqual({ address: '2606:4700:4700::1111', port: 53 });
    expect(parseDnsServer('[::1]:5300')).toEqual({ address: '::1', port: 5300 });
    expect(parseDnsServer('2001:db8::53')).toEqual({ address: '2001:db8::53', port: 53 });
  });
  it('refuses host names, bad ports and malformed addresses', () => {
    for (const bad of ['dns.google', 'dns.google:53', '1.1.1.1:0', '1.1.1.1:70000', '1.1.1.1:x', '[1.1.1.1]:53', '[::1]:', '[::1', '', '-1.1.1.1']) {
      expect(refused(() => parseDnsServer(bad)), bad).toMatch(/must be an IP address/);
    }
  });
  it('formats a server the way Resolver.setServers takes it', () => {
    expect(formatDnsServer({ address: '127.0.0.1', port: 5353 })).toBe('127.0.0.1:5353');
    expect(formatDnsServer({ address: '::1', port: 53 })).toBe('[::1]:53');
  });
});

describe('reverseDnsName', () => {
  it('builds in-addr.arpa and ip6.arpa names', () => {
    expect(reverseDnsName('192.0.2.10')).toBe('10.2.0.192.in-addr.arpa');
    expect(reverseDnsName('2001:db8::1')).toBe(`1.${'0.'.repeat(23)}8.b.d.0.1.0.0.2.ip6.arpa`);
    expect(reverseDnsName('::ffff:1.2.3.4')).toBe('4.0.3.0.2.0.1.0.f.f.f.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa');
  });
});

describe('cnameChain', () => {
  it('follows aliases in order, case and trailing dots aside', () => {
    const answers = [
      { name: 'b.example', target: 'C.example.' },
      { name: 'WWW.example', target: 'b.example' },
    ];
    expect(cnameChain('www.example.', answers)).toEqual([
      { name: 'www.example', target: 'b.example' },
      { name: 'b.example', target: 'c.example' },
    ]);
  });
  it('is empty for a name that is not an alias and stops at a loop', () => {
    expect(cnameChain('example.com', [{ name: 'other', target: 'x' }])).toEqual([]);
    expect(cnameChain('a', [{ name: 'a', target: 'b' }, { name: 'b', target: 'a' }])).toEqual([
      { name: 'a', target: 'b' },
      { name: 'b', target: 'a' },
    ]);
  });
});

describe('classifyDnsError', () => {
  it('treats no data and no such name as empty answers and the rest as errors', () => {
    expect(classifyDnsError({ code: 'ENODATA' })).toEqual({ kind: 'empty', code: 'ENODATA' });
    expect(classifyDnsError({ code: 'ENOTFOUND' })).toEqual({ kind: 'empty', code: 'ENOTFOUND' });
    expect(classifyDnsError({ code: 'ETIMEOUT', message: 'queryA ETIMEOUT x' })).toEqual({ kind: 'error', code: 'ETIMEOUT', message: 'The resolver did not answer in time.' });
    expect(classifyDnsError({ code: 'ENOTIMP' })).toMatchObject({ kind: 'error', code: 'ENOTIMP' });
    expect(classifyDnsError(new Error('boom'))).toEqual({ kind: 'error', code: 'EUNKNOWN', message: 'boom' });
  });
});

describe('sortDnsRecords and groupDnsRecords', () => {
  const rec = (query: DnsRecord['query'], data: DnsRecord['data'], type: string = query): DnsRecord => ({ query, type, name: 'example.com', ttl: null, data });
  const records = [
    rec('MX', { exchange: 'b.mx', priority: 20 }),
    rec('A', { address: '192.0.2.2' }),
    rec('SRV', { target: 'x', priority: 10, weight: 5, port: 1 }),
    rec('MX', { exchange: 'a.mx', priority: 10 }),
    rec('SRV', { target: 'y', priority: 10, weight: 60, port: 1 }),
    rec('A', { address: '192.0.2.1' }),
    rec('SRV', { target: 'z', priority: 0, weight: 0, port: 1 }),
  ];
  it('orders by the types asked, MX by priority, SRV by priority then weight, the rest as the server sent them', () => {
    const sorted = sortDnsRecords(records, ['A', 'MX', 'SRV']).map((r) => formatDnsData(r.type, r.data));
    expect(sorted).toEqual(['192.0.2.2', '192.0.2.1', '10 a.mx', '20 b.mx', '0 0 1 z', '10 60 1 y', '10 5 1 x']);
  });
  it('gives one group per type asked, empty ones included', () => {
    const groups = groupDnsRecords(records, ['MX', 'TXT', 'A']);
    expect(groups.map((g) => [g.type, g.records.length])).toEqual([
      ['MX', 2],
      ['TXT', 0],
      ['A', 2],
    ]);
  });
  it('keeps what an ANY query returned under ANY with its own types', () => {
    const any = [rec('ANY', { address: '192.0.2.1' }, 'A'), rec('ANY', { exchange: 'mx', priority: 1 }, 'MX')];
    expect(groupDnsRecords(any, ['ANY'])[0].records.map((r) => r.type)).toEqual(['A', 'MX']);
  });
});

describe('formatDnsData', () => {
  it('formats each type on one line', () => {
    expect(formatDnsData('TXT', { entries: ['v=spf1 -all', 'b'] })).toBe('"v=spf1 -all" "b"');
    expect(formatDnsData('SOA', { nsname: 'ns1', hostmaster: 'h', serial: 1, refresh: 2, retry: 3, expire: 4, minttl: 5 })).toBe('ns1 h 1 2 3 4 5');
    expect(formatDnsData('CAA', { critical: 0, tag: 'issue', value: 'letsencrypt.org' })).toBe('0 issue "letsencrypt.org"');
    expect(formatDnsData('CNAME', { target: 'x.example' })).toBe('x.example');
  });
});
