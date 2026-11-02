import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { connect } from 'node:net';
import { Resolver } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SCAN_PORTS,
  defineCommand,
  newId,
  parseArpTable,
  parseScanTarget,
  QuiverError,
  readPing,
  scanAddresses,
  scanSubnets,
  sortByAddress,
  type NetScanFoundBy,
  type NetScanHost,
  type NetScanSubnet,
} from '@quiver/core';
import { z } from 'zod';

/** A system tool by its full path on Windows, where a bare name would also be looked for in the current folder. */
function systemTool(name: string): string {
  if (process.platform !== 'win32') return name;
  return path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', `${name}.exe`);
}

/** Runs a tool to its end, with what it printed whether it succeeded or not. Null when it could not be started. */
function runTool(file: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<{ output: string; exitCode: number | null } | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, signal, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
      const code = err ? (err as NodeJS.ErrnoException).code : 0;
      resolve({ output: String(stdout), exitCode: typeof code === 'number' ? code : err ? null : 0 });
    });
  });
}

/** One echo request. Null when there is no ping on this machine. */
async function ping(address: string, timeoutMs: number, signal: AbortSignal): Promise<{ alive: boolean; latencyMs: number | null } | null> {
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  const args =
    process.platform === 'win32'
      ? ['-4', '-n', '1', '-w', String(timeoutMs), address]
      : process.platform === 'darwin'
        ? ['-n', '-c', '1', '-t', seconds, address]
        : ['-n', '-c', '1', '-W', seconds, address];
  const result = await runTool(systemTool('ping'), args, timeoutMs + 1000, signal);
  return result && readPing(result.output, result.exitCode, process.platform);
}

/** Tries one TCP port. A refused connection says the machine is there, only the port is closed; silence says nothing. */
function knock(address: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<{ state: 'open' | 'closed' | 'silent'; ms: number }> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = connect({ host: address, port });
    const done = (state: 'open' | 'closed' | 'silent') => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve({ state, ms: performance.now() - started });
    };
    const abort = () => done('silent');
    const timer = setTimeout(abort, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => done('open'));
    socket.once('error', (err: NodeJS.ErrnoException) => done(err.code === 'ECONNREFUSED' ? 'closed' : 'silent'));
  });
}

/** Whatever is known about the machine at one address, or null when it did not answer. */
async function probe(address: string, ports: number[], usePing: boolean, timeoutMs: number, signal: AbortSignal): Promise<NetScanHost | null> {
  const [echo, knocks] = await Promise.all([usePing ? ping(address, timeoutMs, signal).catch(() => null) : null, Promise.all(ports.map((port) => knock(address, port, timeoutMs, signal)))]);
  const answers = knocks.filter((k) => k.state !== 'silent');
  const foundBy: NetScanFoundBy[] = [...(echo?.alive ? (['ping'] as const) : []), ...(answers.length ? (['tcp'] as const) : [])];
  if (!foundBy.length) return null;
  const tcpMs = answers.length ? Math.min(...answers.map((k) => k.ms)) : null;
  const latency = echo?.alive && echo.latencyMs !== null ? echo.latencyMs : tcpMs;
  return {
    address,
    foundBy,
    latencyMs: latency === null ? null : Math.round(latency * 10) / 10,
    hostname: null,
    mac: null,
    openPorts: ports.filter((_port, i) => knocks[i].state === 'open').sort((a, b) => a - b),
  };
}

/** What this machine has learned about its neighbours, which the probes have just refreshed. Empty when it cannot be read. */
async function readArp(signal: AbortSignal): Promise<Map<string, string>> {
  if (process.platform === 'linux') {
    const text = await fs.readFile('/proc/net/arp', 'utf8').catch(() => null);
    if (text !== null) return parseArpTable(text);
  }
  const result = await runTool(systemTool('arp'), ['-a'], 5000, signal).catch(() => null);
  return parseArpTable(result?.output ?? '');
}

/** The reverse DNS names of the hosts found, each given a second and a half at most. */
async function addHostnames(hosts: NetScanHost[], signal: AbortSignal): Promise<void> {
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  const stop = () => resolver.cancel();
  signal.addEventListener('abort', stop, { once: true });
  try {
    await eachLimited(hosts, 16, signal, async (host) => {
      const names = await resolver.reverse(host.address).catch(() => []);
      host.hostname = names[0] ?? null;
    });
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/** Runs `work` over the items, at most `limit` at a time, starting no more once `signal` has aborted. */
async function eachLimited<T>(items: readonly T[], limit: number, signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The scans under way, by id, so `tools.netscan.cancel` can reach them. */
const running = new Map<string, AbortController>();

export const netScanInterfaces = defineCommand({
  id: 'tools.netscan.interfaces',
  title: 'Network scanner: this machine\'s networks',
  description:
    'The private IPv4 networks this machine sits on, the likeliest first (virtual adapters and link-local addresses last): the adapter, its address and target, the subnet to give tools.netscan.run. A subnet too large for one scan is narrowed to the /24 around the address (narrowed). Sends nothing on the network.',
  scope: 'global',
  input: z.object({}),
  handler: async (): Promise<NetScanSubnet[]> => scanSubnets(networkInterfaces()),
});

export const netScanRun = defineCommand({
  id: 'tools.netscan.run',
  title: 'Scan the network',
  description: `Finds the machines on a private network and the TCP ports they have open: an echo request to each address (with ping: true, the default) and a connection attempt to each port, then the ARP table for machines that answer neither. Returns the hosts by address with how each was found (foundBy: ping, tcp, arp), latencyMs, hostname (reverse DNS), mac and openPorts, plus scanned, durationMs and cancelled (with the hosts found so far). target is an IPv4 address (192.168.1.7), a subnet (192.168.1.0/24, without its network and broadcast addresses) or a range (192.168.1.10-50, 192.168.1.10-192.168.1.50); at most 4096 addresses, all in one private block (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 127/8): public addresses are refused. ports defaults to ${DEFAULT_SCAN_PORTS.join(', ')}; an empty list only pings. A machine on another network has no mac, and a firewall that drops everything hides it. scanId lets tools.netscan.cancel stop it, and names its tools.netscan.progress events.`,
  scope: 'global',
  // It sends traffic to other people's machines, which a security system may well notice.
  mutating: true,
  input: z.object({
    target: z.string().min(1).describe('An address, a subnet in CIDR notation or a range'),
    ports: z.array(z.number().int().min(1).max(65535)).max(64).optional(),
    ping: z.boolean().default(true),
    timeoutMs: z.number().int().min(100).max(10_000).default(800).describe('How long to wait for each answer'),
    concurrency: z.number().int().min(1).max(256).default(64).describe('Addresses probed at a time'),
    scanId: z.string().min(1).max(64).optional(),
  }),
  handler: async ({ target, ports, ping: usePing, timeoutMs, concurrency, scanId }, ctx) => {
    const parsed = parseScanTarget(target);
    const id = scanId ?? newId();
    if (running.has(id)) throw new QuiverError('INVALID_INPUT', `A scan with the id ${id} is already running`);
    const controller = new AbortController();
    running.set(id, controller);
    const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
    const started = performance.now();
    const addresses = scanAddresses(parsed);
    const list = ports ?? DEFAULT_SCAN_PORTS;
    const hosts = new Map<string, NetScanHost>();
    let done = 0;
    try {
      await eachLimited(addresses, concurrency, signal, async (address) => {
        const host = await probe(address, list, usePing, timeoutMs, signal);
        done += 1;
        // A probe an abort cut short may have heard nothing, but what it did hear is true.
        if (host) hosts.set(address, host);
        ctx.host.emit('tools.netscan.progress', { scanId: id, done, total: addresses.length, ...(host ? { host } : {}) });
      });
      const cancelled = signal.aborted;
      if (!cancelled) {
        const inRange = new Set(addresses);
        for (const [address, mac] of await readArp(signal)) {
          if (!inRange.has(address)) continue;
          const known = hosts.get(address);
          if (known) known.mac = mac;
          else hosts.set(address, { address, foundBy: ['arp'], latencyMs: null, hostname: null, mac, openPorts: [] });
        }
        await addHostnames([...hosts.values()], signal);
      }
      return {
        scanId: id,
        target: parsed.label,
        ports: list,
        scanned: done,
        total: addresses.length,
        hosts: sortByAddress([...hosts.values()]),
        durationMs: Math.round(performance.now() - started),
        cancelled: signal.aborted,
      };
    } finally {
      running.delete(id);
    }
  },
});

export const netScanCancel = defineCommand({
  id: 'tools.netscan.cancel',
  title: 'Stop the network scan',
  description: 'Stops a scan started with that scanId; tools.netscan.run then returns what it found so far, with cancelled: true. cancelled here says whether one was running.',
  scope: 'global',
  input: z.object({ scanId: z.string().min(1) }),
  handler: async ({ scanId }) => {
    const scan = running.get(scanId);
    scan?.abort();
    return { cancelled: Boolean(scan) };
  },
});
