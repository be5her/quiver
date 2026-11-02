import { createServer, type Server } from 'node:net';
import type { NetScanHost, NetScanSubnet } from '@quiver/core';
import { until, type SmokeSection } from '../../part';

type Scan = { scanId: string; target: string; ports: number[]; scanned: number; total: number; hosts: NetScanHost[]; durationMs: number; cancelled: boolean };

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));

// Tools: the network scanner on the loopback block, against a TCP listener this section starts and closes (after the UI).
const section: SmokeSection = async ({ host, check, run, toolNames }) => {
  const server = createServer((socket) => socket.destroy());
  const open = await listen(server);
  // A port that was just free and is closed again: nothing listens there.
  const spare = createServer();
  const closed = await listen(spare);
  await new Promise((resolve) => spare.close(resolve));

  try {
    const failure = async (input: unknown) => {
      const out = await host.invoke('tools.netscan.run', input, { caller: 'ui', workspaceId: null });
      return out.ok ? 'ok' : out.error.message;
    };

    const scan = await run<Scan>('tools.netscan.run', { target: '127.0.0.1', ports: [closed, open], ping: false, timeoutMs: 1500 }, null);
    check(
      'netscan: a listening port is reported open with its latency, the closed one is not',
      scan.target === '127.0.0.1' && scan.scanned === 1 && !scan.cancelled && scan.hosts.length === 1 && scan.hosts[0].address === '127.0.0.1' && scan.hosts[0].foundBy.join() === 'tcp' && scan.hosts[0].openPorts.join() === String(open) && typeof scan.hosts[0].latencyMs === 'number',
      scan,
    );

    // The listener is on 127.0.0.1 only. The rest of 127/8 is this machine too: where the system answers for it (Windows, Linux), a refused connection counts as there, with no port open.
    const range = await run<Scan>('tools.netscan.run', { target: '127.0.0.1-3', ports: [open], ping: false, timeoutMs: 300 }, null);
    check(
      'netscan: a range covers every address, in order, and a port is open only where something listens',
      range.target === '127.0.0.1-127.0.0.3' && range.total === 3 && range.scanned === 3 && range.hosts[0]?.address === '127.0.0.1' && range.hosts[0].openPorts.join() === String(open) && range.hosts.slice(1).every((h) => h.openPorts.length === 0 && h.foundBy.join() === 'tcp'),
      range,
    );

    const pinged = await run<Scan>('tools.netscan.run', { target: '127.0.0.1', ports: [], timeoutMs: 2000 }, null);
    check('netscan: no ports only pings, and this machine answers', pinged.hosts[0]?.foundBy.join() === 'ping' && pinged.hosts[0].openPorts.length === 0, pinged);

    const refused = {
      public: await failure({ target: '8.8.8.0/30', ports: [53] }),
      leaving: await failure({ target: '192.168.255.254-192.169.0.1', ports: [53] }),
      large: await failure({ target: '10.0.0.0/16', ports: [53] }),
      junk: await failure({ target: 'nas.local; rm -rf /', ports: [53] }),
    };
    check(
      'netscan: public addresses, a range leaving its block, over 4096 addresses and junk are refused before anything is sent',
      /private/.test(refused.public) && /private/.test(refused.leaving) && /at most 4,096/.test(refused.large) && /not something to scan/.test(refused.junk),
      refused,
    );

    // A stopped scan hands back what it found so far, and the id is free again afterwards.
    const stopping = run<Scan>('tools.netscan.run', { target: '127.0.0.0/22', ports: [open], ping: false, timeoutMs: 400, concurrency: 2, scanId: 'smoke-stop' }, null);
    const twin = await failure({ target: '127.0.0.1', ports: [open], ping: false, scanId: 'smoke-stop' });
    const stopped = await run<{ cancelled: boolean }>('tools.netscan.cancel', { scanId: 'smoke-stop' }, null);
    const halted = await stopping;
    const after = await run<{ cancelled: boolean }>('tools.netscan.cancel', { scanId: 'smoke-stop' }, null);
    check(
      'netscan: a scan id runs once at a time, and cancel stops it early with what it had',
      /already running/.test(twin) && stopped.cancelled && halted.cancelled && halted.scanned < halted.total && !after.cancelled,
      { twin, stopped, scanned: halted.scanned, total: halted.total, after },
    );

    const subnets = await run<NetScanSubnet[]>('tools.netscan.interfaces', {}, null);
    check('netscan: the networks offered are private subnets of this machine', Array.isArray(subnets) && subnets.every((s) => /^(10|172|192|169|100)\./.test(s.address) && s.target.includes('/')), subnets);

    const agentScan = await host.invoke('tools.netscan.run', { target: '127.0.0.1', ports: [open], ping: false }, { caller: 'mcp', workspaceId: null });
    const agentInterfaces = await host.invoke('tools.netscan.interfaces', {}, { caller: 'mcp', workspaceId: null });
    check(
      'netscan: agents may read the networks, but a scan is gated, since it sends traffic to other machines',
      toolNames.includes('tools_netscan_run') && !agentScan.ok && agentScan.error.code === 'MUTATION_BLOCKED' && agentInterfaces.ok,
      { agentScan: agentScan.ok || agentScan.error.code, agentInterfaces: agentInterfaces.ok },
    );
  } catch (err) {
    server.close();
    throw err;
  }

  return {
    ui: async ({ js, wait, shot }) => {
      await js(`(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Tools'); if (btn) btn.click(); })()`);
      await wait(300);
      const opened = await js(`(() => { const btn = [...document.querySelectorAll('aside button')].find((b) => b.textContent.includes('Network scanner')); if (btn) btn.click(); return Boolean(btn); })()`);
      await until(() => js(`Boolean(document.querySelector('[data-testid=netscan-target]'))`) as Promise<boolean>, 5000);
      const pane = `[...document.querySelectorAll('[data-tab-type="tools.tool"]')].find((el) => !el.classList.contains('hidden'))`;
      const setInput = (testid: string, value: string) => js(`(() => { const i = ${pane}?.querySelector('[data-testid=${testid}]'); if (!i) return false; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      const click = (testid: string) => js(`(() => { const b = ${pane}?.querySelector('[data-testid=${testid}]'); if (b) b.click(); return Boolean(b); })()`);
      const text = (testid: string) => js(`${pane}?.querySelector('[data-testid=${testid}]')?.textContent.trim() ?? null`) as Promise<string | null>;

      const typed = (await setInput('netscan-target', '127.0.0.1-2')) && (await setInput('netscan-ports', `${open}`));
      await wait(100);
      await click('netscan-run');
      await until(async () => /host/.test((await text('netscan-meta')) ?? '') && (await js(`Boolean(${pane}?.querySelector('[data-testid=netscan-run]'))`)) === true, 15000);
      const rows = (await js(`[...(${pane}?.querySelectorAll('[data-testid=netscan-row]') ?? [])].map((r) => ({ address: r.dataset.address, ports: [...r.querySelectorAll('[data-testid=netscan-port]')].map((p) => p.textContent.trim()), cells: r.cells.length }))`)) as { address: string; ports: string[]; cells: number }[];
      const meta = await text('netscan-meta');
      const local = rows.find((r) => r.address === '127.0.0.1');
      check(
        'ui: the network scanner tab scans a typed range and shows the host with its open port',
        opened === true && typed === true && local?.ports.join() === String(open) && local.cells === 6 && /127\.0\.0\.1-127\.0\.0\.2/.test(meta ?? ''),
        { opened, typed, rows, meta },
      );
      await shot('tools-netscan');

      await setInput('netscan-target', '8.8.8.8');
      await wait(100);
      await click('netscan-run');
      await until(async () => Boolean(await text('netscan-error')), 5000);
      check('ui: a public address shows why it is refused, and no rows', /private/.test((await text('netscan-error')) ?? '') && (await js(`${pane}?.querySelectorAll('[data-testid=netscan-row]').length`)) === 0, await text('netscan-error'));
      await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
      await wait(200);
    },
    after: async () => {
      server.close();
    },
  };
};

export default section;
