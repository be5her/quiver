import { describe, expect, it } from 'vitest';
import { intToIpv4, ipv4ToInt, isPrivateIpv4, NET_SCAN_MAX_HOSTS, parseArpTable, parsePorts, parseScanTarget, readPing, scanAddresses, scanSubnets, sortByAddress } from './net-scan';

describe('parseScanTarget', () => {
  it('reads a subnet without its network and broadcast addresses', () => {
    const t = parseScanTarget(' 192.168.1.77/24 ');
    expect(t.label).toBe('192.168.1.0/24');
    expect(t.count).toBe(254);
    const all = scanAddresses(t);
    expect(all[0]).toBe('192.168.1.1');
    expect(all[all.length - 1]).toBe('192.168.1.254');
  });

  it('keeps every address of a /31 and a /32', () => {
    expect(scanAddresses(parseScanTarget('10.0.0.4/31'))).toEqual(['10.0.0.4', '10.0.0.5']);
    expect(scanAddresses(parseScanTarget('10.0.0.4/32'))).toEqual(['10.0.0.4']);
    expect(scanAddresses(parseScanTarget('10.0.0.0/30'))).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('reads a single address and both forms of range', () => {
    expect(parseScanTarget('192.168.1.7')).toMatchObject({ label: '192.168.1.7', count: 1 });
    expect(parseScanTarget('192.168.1.10-50')).toMatchObject({ label: '192.168.1.10-192.168.1.50', count: 41 });
    expect(parseScanTarget('192.168.1.250-192.168.2.3')).toMatchObject({ count: 10 });
    expect(parseScanTarget('192.168.1.5 - 5')).toMatchObject({ label: '192.168.1.5', count: 1 });
  });

  it('refuses what cannot be read', () => {
    for (const bad of ['', 'nas.local', '192.168.1', '192.168.1.256', '192.168.1.0/33', '192.168.1.0/x', '192.168.1.1-', '192.168.1.1-300', '192.168.1.1-2-3', '-192.168.1.1', '::1']) {
      expect(() => parseScanTarget(bad), bad).toThrow(/not something to scan/);
    }
    expect(() => parseScanTarget('192.168.1.50-10')).toThrow(/ends before it starts/);
  });

  it('refuses public addresses and ranges that leave a private block', () => {
    for (const bad of ['8.8.8.8', '1.1.1.0/24', '172.32.0.1', '192.169.0.1', '224.0.0.1', '192.168.255.250-192.169.0.3', '10.255.255.255-11.0.0.1', '9.255.255.255-10.0.0.3']) {
      expect(() => parseScanTarget(bad), bad).toThrow(/private/);
    }
    // A prefix so short the subnet leaves the block.
    expect(() => parseScanTarget('192.168.0.0/8')).toThrow(/private/);
  });

  it('caps one scan at a /20', () => {
    expect(parseScanTarget('10.0.0.0/20').count).toBe(4094);
    expect(parseScanTarget('10.0.0.1-10.0.16.0').count).toBe(NET_SCAN_MAX_HOSTS);
    expect(() => parseScanTarget('10.0.0.0/19')).toThrow(/at most 4,096/);
    expect(() => parseScanTarget('10.0.0.0/8')).toThrow(/at most 4,096/);
  });
});

describe('addresses', () => {
  it('converts both ways above 127.255.255.255 without going negative', () => {
    expect(ipv4ToInt('192.168.1.1')).toBe(3232235777);
    expect(intToIpv4(3232235777)).toBe('192.168.1.1');
    expect(intToIpv4(ipv4ToInt('255.255.255.255')!)).toBe('255.255.255.255');
    expect(ipv4ToInt('1.2.3')).toBeNull();
  });

  it('tells private from public at the edges of the blocks', () => {
    for (const yes of ['10.0.0.0', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '100.64.0.1', '100.127.255.255', '127.0.0.1']) expect(isPrivateIpv4(yes), yes).toBe(true);
    for (const no of ['9.255.255.255', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '8.8.8.8', 'x']) expect(isPrivateIpv4(no), no).toBe(false);
  });

  it('sorts by number, not by text', () => {
    expect(sortByAddress([{ address: '10.0.0.10' }, { address: '10.0.0.9' }, { address: '10.0.1.1' }]).map((h) => h.address)).toEqual(['10.0.0.9', '10.0.0.10', '10.0.1.1']);
  });
});

describe('scanSubnets', () => {
  const v4 = (address: string, cidr: string, internal = false) => ({ address, cidr, family: 'IPv4', internal });

  it('lists real adapters first and leaves out loopback, IPv6, public addresses and a /32', () => {
    const out = scanSubnets({
      'vEthernet (WSL)': [v4('172.20.16.1', '172.20.16.1/20')],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', '127.0.0.1/8', true)],
      'Wi-Fi': [v4('192.168.1.23', '192.168.1.23/24'), { address: 'fe80::1', cidr: 'fe80::1/64', family: 'IPv6', internal: false }],
      Ethernet: [v4('169.254.10.2', '169.254.10.2/16')],
      Public: [v4('8.8.4.4', '8.8.4.4/24')],
      VPN: [v4('10.8.0.2', '10.8.0.2/32')],
    });
    expect(out.map((s) => [s.name, s.target])).toEqual([
      ['Wi-Fi', '192.168.1.0/24'],
      ['vEthernet (WSL)', '172.20.16.0/20'],
      ['Ethernet', '169.254.10.0/24'],
    ]);
  });

  it('narrows a subnet too large for one scan to the /24 around the address', () => {
    expect(scanSubnets({ Office: [v4('10.20.30.40', '10.20.30.40/16')] })).toEqual([{ name: 'Office', address: '10.20.30.40', target: '10.20.30.0/24', narrowed: true }]);
    expect(scanSubnets({ Office: [v4('10.20.30.40', '10.20.30.40/20')] })[0]).toMatchObject({ target: '10.20.16.0/20', narrowed: false });
  });
});

describe('readPing', () => {
  it('needs a TTL on Windows, which exits 0 when a router says unreachable', () => {
    expect(readPing('Reply from 192.168.1.1: bytes=32 time=3ms TTL=64', 0, 'win32')).toEqual({ alive: true, latencyMs: 3 });
    expect(readPing('Reply from 192.168.1.1: bytes=32 time<1ms TTL=64', 0, 'win32')).toEqual({ alive: true, latencyMs: 1 });
    expect(readPing('Antwort von 192.168.1.1: Bytes=32 Zeit=12ms TTL=64', 0, 'win32')).toEqual({ alive: true, latencyMs: 12 });
    expect(readPing('Reply from 192.168.1.23: Destination host unreachable.', 0, 'win32').alive).toBe(false);
    expect(readPing('Request timed out.', 1, 'win32').alive).toBe(false);
  });

  it('goes by the exit code elsewhere', () => {
    expect(readPing('64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=0.42 ms', 0, 'linux')).toEqual({ alive: true, latencyMs: 0.42 });
    expect(readPing('64 octets de 10.0.0.1 : icmp_seq=1 ttl=64 temps=1,5 ms', 0, 'darwin')).toEqual({ alive: true, latencyMs: 1.5 });
    expect(readPing('', 0, 'linux')).toEqual({ alive: true, latencyMs: null });
    expect(readPing('1 packets transmitted, 0 received', 1, 'linux').alive).toBe(false);
  });
});

describe('parseArpTable', () => {
  it('reads Windows arp -a', () => {
    const out = ['Interface: 192.168.1.23 --- 0x7', '  Internet Address      Physical Address      Type', '  192.168.1.1           AA-BB-CC-DD-EE-01     dynamic', '  192.168.1.255         ff-ff-ff-ff-ff-ff     static', '  224.0.0.22            01-00-5e-00-00-16     static', ''].join('\r\n');
    expect([...parseArpTable(out)]).toEqual([['192.168.1.1', 'aa:bb:cc:dd:ee:01']]);
  });

  it('reads macOS and BSD arp -a, whose octets may lack a leading zero', () => {
    const out = '? (192.168.1.1) at a:b:c:d:e:f on en0 ifscope [ethernet]\n? (192.168.1.9) at (incomplete) on en0 ifscope [ethernet]\nnas.lan (192.168.1.5) at aa:bb:cc:dd:ee:02 on en0 [ethernet]\n';
    expect([...parseArpTable(out)]).toEqual([
      ['192.168.1.1', '0a:0b:0c:0d:0e:0f'],
      ['192.168.1.5', 'aa:bb:cc:dd:ee:02'],
    ]);
  });

  it('reads /proc/net/arp, where an incomplete entry has a zero address', () => {
    const out = 'IP address       HW type     Flags       HW address            Mask     Device\n192.168.1.1      0x1         0x2         aa:bb:cc:dd:ee:03     *        eth0\n192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        eth0\n';
    expect([...parseArpTable(out)]).toEqual([['192.168.1.1', 'aa:bb:cc:dd:ee:03']]);
  });
});

describe('parsePorts', () => {
  it('reads separators of any kind and drops repeats', () => {
    expect(parsePorts('22, 80 443;80')).toEqual([22, 80, 443]);
    expect(parsePorts('  ')).toEqual([]);
  });

  it('refuses what is no port', () => {
    for (const bad of ['0', '65536', 'http', '80-90', '-1']) expect(() => parsePorts(bad), bad).toThrow(/not a TCP port/);
  });
});
