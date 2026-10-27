import type { DnsRecord } from '@quiver/core';
import type { SmokeSection } from '../../part';
import { startFakeDns } from '../../fake-dns';

type Lookup = {
  name: string;
  asciiName: string;
  server: { address: string; port: number; source: string };
  systemServers: string[];
  types: string[];
  records: DnsRecord[];
  chain: { name: string; target: string }[];
  reverse?: { address: string; names: string[] };
  empty: { type: string; code: string }[];
  errors: { type: string; code: string; message: string }[];
  durationMs: number;
};

// Tools: the DNS lookup against a fake UDP DNS server on 127.0.0.1, which this section starts and closes (after the UI).
const section: SmokeSection = async ({ host, check, run, rpc, toolNames }) => {
  const fake = await startFakeDns();
  try {
    const lookup = (name: string, extra: Record<string, unknown> = {}) => run<Lookup>('tools.dns.lookup', { name, server: fake.server, ...extra }, null);
    const failure = async (input: unknown) => {
      const out = await host.invoke('tools.dns.lookup', input, { caller: 'ui', workspaceId: null });
      return out.ok ? 'ok' : `${out.error.code}: ${out.error.message}`;
    };
    const rows = (r: Lookup, type: string) => r.records.filter((rec) => rec.query === type);

    // Every default type of quiver.test, in the order asked, with the TTLs Node reports (A and AAAA only).
    const zone = await lookup('Quiver.Test.');
    const data = (type: string) => rows(zone, type).map((rec) => rec.data);
    check(
      'dns: quiver.test returns every default type in order, A and AAAA with their TTLs, the others without',
      zone.asciiName === 'quiver.test' &&
        zone.types.join() === 'A,AAAA,CNAME,MX,NS,TXT,SOA,CAA' &&
        zone.server.address === '127.0.0.1' &&
        zone.server.port === fake.port &&
        zone.server.source === 'custom' &&
        JSON.stringify(rows(zone, 'A').map((rec) => [rec.data, rec.ttl])) === JSON.stringify([[{ address: '192.0.2.10' }, 300], [{ address: '192.0.2.11' }, 300]]) &&
        JSON.stringify(rows(zone, 'AAAA').map((rec) => [rec.data, rec.ttl])) === JSON.stringify([[{ address: '2001:db8::10' }, 600]]) &&
        // The fake lists MX 20 before MX 10: the result is sorted by priority.
        JSON.stringify(data('MX')) === JSON.stringify([{ exchange: 'mx1.quiver.test', priority: 10 }, { exchange: 'mx2.quiver.test', priority: 20 }]) &&
        JSON.stringify(data('NS')) === JSON.stringify([{ target: 'ns1.quiver.test' }, { target: 'ns2.quiver.test' }]) &&
        JSON.stringify(data('TXT')) === JSON.stringify([{ entries: ['v=spf1 -all'] }, { entries: ['part one', 'part two'] }]) &&
        JSON.stringify(data('SOA')) === JSON.stringify([{ nsname: 'ns1.quiver.test', hostmaster: 'hostmaster.quiver.test', serial: 2026102701, refresh: 3600, retry: 600, expire: 86400, minttl: 300 }]) &&
        JSON.stringify(data('CAA')) === JSON.stringify([{ critical: 0, tag: 'issue', value: 'letsencrypt.org' }, { critical: 128, tag: 'iodef', value: 'mailto:security@quiver.test' }]) &&
        zone.records.filter((rec) => rec.query !== 'A' && rec.query !== 'AAAA').every((rec) => rec.ttl === null) &&
        zone.records.map((rec) => rec.query).join() === 'A,A,AAAA,MX,MX,NS,NS,TXT,TXT,SOA,CAA,CAA' &&
        zone.chain.length === 0 &&
        zone.empty.map((e) => `${e.type}:${e.code}`).join() === 'CNAME:ENODATA' &&
        zone.errors.length === 0 &&
        fake.questions.some((q) => q.name === 'quiver.test' && q.type === 'CAA'),
      zone,
    );

    // www is an alias of edge, an alias of quiver.test: the chain is followed and the A records are the target's.
    const alias = await lookup('www.quiver.test', { types: ['CNAME', 'A'] });
    check(
      'dns: the CNAME chain www → edge → quiver.test is followed and the addresses belong to its end',
      JSON.stringify(alias.chain) === JSON.stringify([{ name: 'www.quiver.test', target: 'edge.quiver.test' }, { name: 'edge.quiver.test', target: 'quiver.test' }]) &&
        rows(alias, 'CNAME').length === 2 &&
        rows(alias, 'A').length === 2 &&
        rows(alias, 'A').every((rec) => rec.name === 'quiver.test' && rec.ttl === 300),
      alias,
    );

    // An IP address is looked up in reverse.
    const reverse = await lookup('192.0.2.10', { types: ['A', 'MX'] });
    check(
      'dns: an IP address runs a PTR lookup instead of the types asked',
      reverse.types.join() === 'PTR' &&
        reverse.asciiName === '10.2.0.192.in-addr.arpa' &&
        JSON.stringify(reverse.reverse) === JSON.stringify({ address: '192.0.2.10', names: ['quiver.test'] }) &&
        JSON.stringify(rows(reverse, 'PTR').map((rec) => [rec.name, rec.data])) === JSON.stringify([['10.2.0.192.in-addr.arpa', { target: 'quiver.test' }]]) &&
        fake.questions.some((q) => q.name === '10.2.0.192.in-addr.arpa' && q.type === 'PTR'),
      reverse,
    );

    // No records of a type is an empty answer; so is NXDOMAIN, per type. SRV sorts by priority, then weight.
    const srv = await lookup('_sip._tcp.quiver.test', { types: ['SRV', 'A'] });
    const missing = await lookup('missing.quiver.test');
    const missingCname = await lookup('missing.quiver.test', { types: ['CNAME'] });
    check(
      'dns: ENODATA and NXDOMAIN come back as empty per type, not as errors, and SRV is sorted',
      rows(srv, 'SRV').map((rec) => (rec.data as { target: string }).target).join() === 'sip3.quiver.test,sip2.quiver.test,sip1.quiver.test' &&
        srv.empty.map((e) => `${e.type}:${e.code}`).join() === 'A:ENODATA' &&
        srv.errors.length === 0 &&
        missing.records.length === 0 &&
        missing.errors.length === 0 &&
        missing.empty.length === 8 &&
        missing.empty.every((e) => e.code === 'ENOTFOUND') &&
        // Asked for CNAME alone, NXDOMAIN still reads as no such name, not as no records.
        missingCname.empty.map((e) => `${e.type}:${e.code}`).join() === 'CNAME:ENOTFOUND' &&
        missingCname.errors.length === 0,
      { srv, missing, missingCname },
    );

    // A refusal and a timeout are errors of their type.
    const refused = await lookup('refused.quiver.test', { types: ['A'] });
    // The timeout bounds the whole lookup, retries included.
    const slow = await lookup('slow.quiver.test', { types: ['A'], timeoutMs: 500 });
    check(
      'dns: a refused query and a timeout are reported as errors of their type, the timeout within timeoutMs',
      refused.errors.map((e) => `${e.type}:${e.code}`).join() === 'A:EREFUSED' && slow.errors.map((e) => `${e.type}:${e.code}`).join() === 'A:ETIMEOUT' && slow.durationMs < 1000,
      { refused: refused.errors, slow: slow.errors, ms: slow.durationMs },
    );

    // The resolver must be an IP (nothing is looked up to find it), and the name must be a host name or an IP.
    const hostServer = await failure({ name: 'quiver.test', server: 'dns.google' });
    const hostServerPort = await failure({ name: 'quiver.test', server: 'localhost:53' });
    const optionName = await failure({ name: '--help', server: fake.server });
    const dashName = await failure({ name: '-x.quiver.test', server: fake.server });
    const spaced = await failure({ name: 'a b', server: fake.server });
    const empty = await failure({ name: '  ', server: fake.server });
    const asked = fake.questions.length;
    check(
      'dns: a host name as the resolver, an option-like name, invalid characters and an empty name are refused before any query',
      /^INVALID_INPUT: .*must be an IP address/.test(hostServer) &&
        /^INVALID_INPUT: .*must be an IP address/.test(hostServerPort) &&
        /^INVALID_INPUT: .*invalid label "--help"/.test(optionName) &&
        /^INVALID_INPUT: .*invalid label "-x"/.test(dashName) &&
        /^INVALID_INPUT/.test(spaced) &&
        /^INVALID_INPUT: Give a name/.test(empty) &&
        fake.questions.length === asked &&
        !fake.questions.some((q) => q.name.startsWith('-')),
      { hostServer, hostServerPort, optionName, dashName, spaced, empty },
    );

    // An agent may call it.
    const agent = await rpc('tools/call', { name: 'tools_dns_lookup', arguments: { name: 'quiver.test', server: fake.server, types: ['MX'] } });
    const agentGot = JSON.parse(agent.result?.content?.[0]?.text ?? '{}') as Partial<Lookup>;
    check(
      'dns: an agent calls tools_dns_lookup',
      toolNames.includes('tools_dns_lookup') && agent.result?.isError !== true && agentGot.records?.map((rec) => (rec.data as { exchange: string }).exchange).join() === 'mx1.quiver.test,mx2.quiver.test',
      agent.error ?? agentGot,
    );
  } catch (err) {
    await fake.close();
    throw err;
  }

  return {
    ui: async ({ js, wait, shot }) => {
      await js(`document.documentElement.classList.remove('dark')`);
      await js(`(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Tools'); if (btn) btn.click(); })()`);
      await wait(300);
      const opened = await js(`(() => { const btn = [...document.querySelectorAll('aside button')].find((b) => b.textContent.includes('DNS lookup')); if (btn) btn.click(); return Boolean(btn); })()`);
      await wait(500);
      const pane = `[...document.querySelectorAll('[data-tab-type="tools.tool"]')].find((el) => !el.classList.contains('hidden'))`;
      const setInput = (testid: string, value: string) =>
        js(`(() => { const i = ${pane}?.querySelector('[data-testid=${testid}]'); if (!i) return false; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      const readOutput = () =>
        js(`(() => {
          const out = ${pane}?.querySelector('[data-testid=dns-output]');
          if (!out) return null;
          const groups = Object.fromEntries([...out.querySelectorAll('section[data-testid^=dns-group-]')].map((s) => [
            s.dataset.testid.slice('dns-group-'.length),
            { rows: [...s.querySelectorAll('[data-testid=dns-row]')].map((r) => [...r.cells].map((c) => c.textContent.trim())), note: s.querySelector('[data-testid=dns-group-empty],[data-testid=dns-group-error]')?.textContent.trim() ?? null },
          ]));
          return { chain: out.querySelector('[data-testid=dns-chain]')?.textContent.trim() ?? null, meta: out.querySelector('[data-testid=dns-meta]')?.textContent.trim() ?? null, error: out.querySelector('[data-testid=dns-error]')?.textContent.trim() ?? null, groups };
        })()`) as Promise<{ chain: string | null; meta: string | null; error: string | null; groups: Record<string, { rows: string[][]; note: string | null }> } | null>;

      // The alias, with SRV ticked on top of the defaults, through Enter in the name field.
      const typed = (await setInput('dns-name', 'www.quiver.test')) && (await setInput('dns-server', fake.server));
      await js(`${pane}?.querySelector('[data-testid=dns-type-SRV]')?.click()`);
      await js(`${pane}?.querySelector('[data-testid=dns-name]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      let out = await readOutput();
      for (let i = 0; i < 40 && !out?.meta; i++) {
        await wait(100);
        out = await readOutput();
      }
      await wait(200);
      await shot('08d-dns-lookup-light');
      check(
        'ui: the DNS lookup tab shows the CNAME chain, the resolver and time, and a table per type',
        opened === true &&
          typed === true &&
          out?.chain === 'www.quiver.test → edge.quiver.test → quiver.test' &&
          new RegExp(`^Resolver 127\\.0\\.0\\.1:${fake.port} · \\d+ ms$`).test(out?.meta ?? '') &&
          JSON.stringify(out?.groups['A']?.rows) === JSON.stringify([['quiver.test', '300', '192.0.2.10'], ['quiver.test', '300', '192.0.2.11']]) &&
          JSON.stringify(out?.groups['MX']?.rows) === JSON.stringify([['quiver.test', '—', '10', 'mx1.quiver.test'], ['quiver.test', '—', '20', 'mx2.quiver.test']]) &&
          out?.groups['CNAME']?.rows.length === 2 &&
          out?.groups['SRV']?.note === 'No records' &&
          Object.keys(out?.groups ?? {}).join() === 'A,AAAA,CNAME,MX,NS,TXT,SOA,SRV,CAA',
        out,
      );

      // Dark, a name that does not exist (NXDOMAIN per type), then the Lookup button with a host name as resolver.
      await js(`document.documentElement.classList.add('dark')`);
      await setInput('dns-name', 'quiver.test');
      await js(`${pane}?.querySelector('[data-testid=dns-lookup]')?.click()`);
      await wait(600);
      await shot('08e-dns-lookup-dark');
      const zoneOut = await readOutput();
      await setInput('dns-name', 'missing.quiver.test');
      await js(`${pane}?.querySelector('[data-testid=dns-lookup]')?.click()`);
      await wait(600);
      const missingOut = await readOutput();
      await setInput('dns-server', 'dns.google');
      await js(`${pane}?.querySelector('[data-testid=dns-lookup]')?.click()`);
      await wait(400);
      const refusedOut = await readOutput();
      check(
        'ui: the DNS lookup tab formats SOA, TXT and CAA, says NXDOMAIN per type, and shows a refused resolver',
        JSON.stringify(zoneOut?.groups['SOA']?.rows) === JSON.stringify([['quiver.test', '—', 'ns1.quiver.test', 'hostmaster.quiver.test', '2026102701', '3600', '600', '86400', '300']]) &&
          JSON.stringify(zoneOut?.groups['TXT']?.rows.map((r) => r[2])) === JSON.stringify(['"v=spf1 -all"', '"part one" "part two"']) &&
          JSON.stringify(zoneOut?.groups['CAA']?.rows.map((r) => r.slice(2))) === JSON.stringify([['0', 'issue', 'letsencrypt.org'], ['128', 'iodef', 'mailto:security@quiver.test']]) &&
          zoneOut?.chain === null &&
          Object.values(missingOut?.groups ?? {}).length === 9 &&
          Object.values(missingOut?.groups ?? {}).every((g) => g.note === 'No such name (NXDOMAIN)') &&
          /must be an IP address/.test(refusedOut?.error ?? ''),
        { zoneOut, missingOut, refusedOut },
      );
      await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
      await wait(200);
    },
    after: () => fake.close(),
  };
};

export default section;
