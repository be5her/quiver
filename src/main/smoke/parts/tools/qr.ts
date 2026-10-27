import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog } from 'electron';
import { until, type SmokeSection } from '../../part';

// The QR code encoder (lane A of docs/plans/tools-logs-git-agents-teleport.md): the host encodes text into a square
// matrix with its three finder patterns, picks a larger version for more error correction, refuses empty and
// oversized text, and an agent calls it; the UI types a URL into the QR tab, reads the symbol and its version line,
// saves it as a PNG (the save dialog answered by the smoke) and switches to level H.

interface QrResult {
  svg: string;
  modules: string[];
  version: number;
  size: number;
  errorCorrection: string;
  mode: string;
}

const FINDER = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];

const finderAt = (modules: string[], x: number, y: number) => modules.slice(y, y + 7).map((row) => row.slice(x, x + 7)).join() === FINDER.join();

const qr: SmokeSection = async (t) => {
  const { host, check, run, rpc, toolNames, folder } = t;
  const url = 'https://quiver.test/smoke/qr?from=tools';

  check('mcp lists tools_qr_encode', toolNames.includes('tools_qr_encode'), toolNames.filter((n) => n.startsWith('tools_')));

  const code = await run<QrResult>('tools.qr.encode', { text: url }, null);
  const n = code.size;
  check(
    'tools.qr.encode: a square matrix with finder patterns in three corners, size 17 + 4 × version, level M by default',
    code.size === 17 + 4 * code.version &&
      code.modules.length === n &&
      code.modules.every((row) => row.length === n && /^[01]+$/.test(row)) &&
      finderAt(code.modules, 0, 0) &&
      finderAt(code.modules, n - 7, 0) &&
      finderAt(code.modules, 0, n - 7) &&
      !finderAt(code.modules, n - 7, n - 7) &&
      code.errorCorrection === 'M' &&
      code.mode === 'byte' &&
      code.svg.startsWith('<svg') &&
      (code.svg.match(/h1v1h-1z/g)?.length ?? 0) === code.modules.join('').replace(/0/g, '').length,
    { version: code.version, size: code.size, mode: code.mode },
  );

  const text = 'Quiver encodes this sentence at two error correction levels to see the symbol grow.';
  const low = await run<QrResult>('tools.qr.encode', { text, errorCorrection: 'L' }, null);
  const high = await run<QrResult>('tools.qr.encode', { text, errorCorrection: 'H' }, null);
  check('tools.qr.encode: level H takes a larger version than level L for the same text', high.version > low.version && high.errorCorrection === 'H', { low: low.version, high: high.version });

  const empty = await host.invoke('tools.qr.encode', { text: '' }, { caller: 'ui', workspaceId: null });
  const oversized = await host.invoke('tools.qr.encode', { text: 'a'.repeat(2954), errorCorrection: 'L' }, { caller: 'ui', workspaceId: null });
  check(
    'tools.qr.encode: empty text and text over 2953 bytes are refused',
    !empty.ok && empty.error.code === 'INVALID_INPUT' && !oversized.ok && oversized.error.code === 'INVALID_INPUT' && /2953 bytes/.test(oversized.error.message),
    { empty, oversized: oversized.ok ? null : oversized.error },
  );

  const agent = await rpc('tools/call', { name: 'tools_qr_encode', arguments: { text: 'HELLO WORLD', errorCorrection: 'Q' } });
  const agentResult = (() => {
    try {
      return JSON.parse(agent.result?.content?.[0]?.text ?? 'null') as QrResult | null;
    } catch {
      return null;
    }
  })();
  check(
    'mcp: an agent calls tools_qr_encode',
    !agent.result?.isError && agentResult?.version === 1 && agentResult.mode === 'alphanumeric' && agentResult.modules[0] === '111111100001001111111',
    agent.result?.isError ? agent : { version: agentResult?.version, mode: agentResult?.mode },
  );

  return {
    ui: async (u) => {
      const { js, wait, shot } = u;
      await js(`document.documentElement.classList.remove('dark')`);
      const clickedTools = await js(`(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Tools'); if (btn) btn.click(); return Boolean(btn); })()`);
      await wait(300);
      const openedQr = await js(`(() => { const btn = [...document.querySelectorAll('aside button')].find((b) => b.textContent.includes('QR code')); if (btn) btn.click(); return Boolean(btn); })()`);
      await wait(500);
      const pane = `[...document.querySelectorAll('[data-tab-type="tools.tool"]')].find((el) => !el.classList.contains('hidden'))`;
      const typed = await js(`(() => { const c = ${pane}?.querySelector('.cm-content'); if (!c) return false; c.focus(); document.execCommand('insertText', false, ${JSON.stringify(url)}); return true; })()`);
      await wait(700);
      const shown = (await js(
        `(() => { const p = ${pane}; const path = p?.querySelector('[data-testid=qr-svg] path')?.getAttribute('d') ?? ''; return { squares: (path.match(/h1v1h-1z/g) ?? []).length, viewBox: p?.querySelector('[data-testid=qr-svg]')?.getAttribute('viewBox') ?? null, info: p?.querySelector('[data-testid=qr-info]')?.textContent.trim() ?? null, save: p?.querySelector('[data-testid=qr-save]')?.disabled ?? null }; })()`,
      )) as { squares: number; viewBox: string | null; info: string | null; save: boolean | null };
      await shot('08d-qr-code');
      // Save PNG: the save dialog answers with a path in the workspace, and the file is written through api.response.save.
      const pngPath = path.join(folder, 'qr-smoke.png');
      const showSaveDialog = dialog.showSaveDialog;
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: pngPath })) as unknown as typeof dialog.showSaveDialog;
      let png: Buffer | null = null;
      try {
        await js(`${pane}?.querySelector('[data-testid=qr-save]')?.click()`);
        await until(async () => (png = await fs.readFile(pngPath).catch(() => null)) !== null, 5000);
      } finally {
        dialog.showSaveDialog = showSaveDialog;
      }
      const side = (code.size + 8) * 8;
      const saved = png as Buffer | null;
      check(
        'ui: Save PNG writes the code as a PNG of (size + 2 × margin) × module size pixels',
        saved !== null && saved.subarray(1, 4).toString() === 'PNG' && saved.readUInt32BE(16) === side && saved.readUInt32BE(20) === side,
        saved ? { bytes: saved.length, width: saved.readUInt32BE(16), expected: side } : 'no file',
      );
      const dark = code.modules.join('').replace(/0/g, '').length;
      check(
        'ui: the QR tab draws the code of a typed URL with its version line',
        clickedTools === true &&
          openedQr === true &&
          typed === true &&
          shown.squares === dark &&
          shown.viewBox === `0 0 ${code.size + 8} ${code.size + 8}` &&
          shown.info === `Version ${code.version} · ${code.size}×${code.size} modules · byte · level M` &&
          shown.save === false,
        { shown, expected: { squares: dark, version: code.version } },
      );
      // Level H from the options header: a larger symbol, and the version line follows.
      await js(`(() => { const s = ${pane}?.querySelector('select'); if (!s) return; s.value = 'H'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await wait(600);
      const atH = await js(`${pane}?.querySelector('[data-testid=qr-info]')?.textContent.trim() ?? null`);
      const expectedH = await run<QrResult>('tools.qr.encode', { text: url, errorCorrection: 'H' }, null);
      await js(`document.documentElement.classList.add('dark')`);
      await wait(200);
      await shot('08e-qr-code-dark');
      check('ui: the QR tab re-encodes at level H when the option changes', atH === `Version ${expectedH.version} · ${expectedH.size}×${expectedH.size} modules · byte · level H` && expectedH.version > code.version, { atH, expected: expectedH.version });
      await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
      await wait(200);
    },
  };
};

export default qr;
