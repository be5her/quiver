import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PALETTE, resolvePalette } from '@quiver/core';
import type { UpdateState, WorkspaceInfo } from '@quiver/core';
import { externalUrlRefused, openExternal } from '../../external';
import { definePart, until } from '../part';

export default definePart({
  name: 'shell',
  summary: 'Shell: updater, theme, settings, tabs, workspaces and the activity bar',
  async run(t) {
    const { host, check, run, ws, folder, rpc } = t;

    // Updater: a dev build reports that it cannot update itself, and the mutating commands are gated for agents.
    const updateState = await run<UpdateState>('app.update.check', {}, null);
    check(
      'update: dev build reports unsupported',
      updateState.supported === false && updateState.status === 'idle' && updateState.current === host.api.version && Boolean(updateState.reason),
      updateState,
    );
    const infoWithUpdate = await run<{ version: string; update: UpdateState }>('app.info', {}, null);
    check('update: app.info carries the updater state', infoWithUpdate.update?.supported === false && infoWithUpdate.version === updateState.current);
    check('update: follows stable by default, beta is not offered in a dev build', updateState.channel === 'stable' && updateState.betaSupported === false && host.api.config.get().updates.channel === 'stable', {
      channel: updateState.channel,
      betaSupported: updateState.betaSupported,
    });
    const onBeta = await run<UpdateState>('app.update.channel', { channel: 'beta' }, null);
    check('update: switching to beta is stored in the global config and reported', onBeta.channel === 'beta' && host.api.config.get().updates.channel === 'beta', onBeta);
    const onStable = await run<UpdateState>('app.update.channel', { channel: 'stable' }, null);
    check('update: switching back to stable', onStable.channel === 'stable' && host.api.config.get().updates.channel === 'stable', onStable);
    const badChannel = await run('app.update.channel', { channel: 'nightly' }, null).then(
      () => false,
      () => true,
    );
    check('update: an unknown channel is rejected', badChannel && host.api.config.get().updates.channel === 'stable');
    for (const tool of ['app_update_download', 'app_update_install', 'app_update_channel']) {
      const blockedUpdate = await rpc('tools/call', { name: tool, arguments: tool === 'app_update_channel' ? { channel: 'beta' } : {} });
      check(`mcp blocks ${tool} by default`, blockedUpdate.result?.isError === true && (blockedUpdate.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }

    const revealedFolder = await run<{ path: string; revealed: boolean }>('workspace.reveal', { id: ws.id }, null);
    const revealByAgent = await host.invoke('workspace.reveal', { id: ws.id }, { caller: 'mcp', workspaceId: null });
    check('workspace.reveal: answers the folder for the UI and refuses agents', revealedFolder.path === folder && !revealByAgent.ok, { revealedFolder, agent: revealByAgent.ok });

    // Links: only http, https and mailto go to the system; a file: link (which could start a program) is refused.
    const fileLink = pathToFileURL(path.join(os.tmpdir(), 'quiver-smoke-refused-link.txt')).href;
    check('links: a file: URL is not opened', (await openExternal(fileLink)) === false && externalUrlRefused(fileLink), fileLink);
    const pageFileLink = pathToFileURL(path.join(os.tmpdir(), 'quiver-smoke-refused-window-open.txt')).href;
    const navFileLink = pathToFileURL(path.join(os.tmpdir(), 'quiver-smoke-refused-navigation.txt')).href;

    // A second workspace for the title bar checks, opened before the window so that the first one stays on screen.
    const otherFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-other-'));
    const otherWs = await run<WorkspaceInfo>('workspace.open', { path: otherFolder }, null);

    return {
      renderer: async (win) => {
        // A file: link the page asks to open (window.open, as a link in a preview would) is refused by the window's handler.
        await win.webContents.executeJavaScript(`void window.open(${JSON.stringify(pageFileLink)}, '_blank', 'noopener')`);
        check('links: a file: URL opened from the page is refused', await until(() => externalUrlRefused(pageFileLink), 3000), pageFileLink);
        // A plain anchor navigates the window itself: the window stays on the app and the link is refused the same way.
        const appUrl = win.webContents.getURL();
        await win.webContents.executeJavaScript(`location.href = ${JSON.stringify(navFileLink)}`);
        check('links: navigating the window to a file: URL is refused and it stays on the app', (await until(() => externalUrlRefused(navFileLink), 3000)) && win.webContents.getURL() === appUrl, { url: win.webContents.getURL(), appUrl });

        // Theme: the brand palette is the default, and a palette saved in config recolours the running UI in both modes.
        {
          const cssVar = (name: string) => win.webContents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`) as Promise<string>;
          const isDark = () => win.webContents.executeJavaScript(`document.documentElement.classList.contains('dark')`) as Promise<boolean>;
          const setDark = (dark: boolean) => win.webContents.executeJavaScript(`document.documentElement.classList.toggle('dark', ${dark})`);
          const waitFor = async (predicate: () => Promise<boolean>) => {
            for (let i = 0; i < 40 && !(await predicate()); i++) await new Promise((r) => setTimeout(r, 50));
          };
          check('theme: default palette in config', host.config.get().palette === DEFAULT_PALETTE, host.config.get().palette);
          const mode = (await isDark()) ? 'dark' : 'light';
          check('theme: default palette applied', (await cssVar('--accent')) === resolvePalette(DEFAULT_PALETTE)[mode].accent, await cssVar('--accent'));
          await run('config.update', { patch: { palette: 'signal-blue' } }, null);
          const blue = resolvePalette('signal-blue');
          await waitFor(async () => (await cssVar('--accent')) === blue[mode].accent);
          check('theme: palette change recolours the UI', (await cssVar('--accent')) === blue[mode].accent, await cssVar('--accent'));
          await setDark(mode === 'light');
          const other = mode === 'light' ? 'dark' : 'light';
          check('theme: palette follows the dark class', (await cssVar('--canvas')) === blue[other].canvas, await cssVar('--canvas'));
          await setDark(mode === 'dark');
          await run('config.update', { patch: { palette: 'no-such-palette' } }, null);
          await waitFor(async () => (await cssVar('--accent')) === resolvePalette(DEFAULT_PALETTE)[mode].accent);
          check('theme: unknown palette falls back to the default', (await cssVar('--accent')) === resolvePalette(DEFAULT_PALETTE)[mode].accent, await cssVar('--accent'));
          await run('config.update', { patch: { palette: DEFAULT_PALETTE } }, null);
        }
      },
      ui: async (u) => {
        const { win, js, wait, shot } = u;
        // Enough request tabs to overflow the strip, whichever parts opened tabs before.
        await js(`document.querySelector('[data-testid=activity-item][data-drag-id=api]').click()`);
        const tabNames = Array.from({ length: 14 }, (_, i) => `shell tab ${String(i + 1).padStart(2, '0')}`);
        for (const name of tabNames) await run('api.request.create', { name, url: '{{baseUrl}}/tabs' }, ws.id);
        await wait(800);
        for (const name of tabNames) {
          await js(`[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes(${JSON.stringify(name)}))?.click()`);
          await wait(150);
        }
        await wait(400);
        // Right-click menus: tabs get VS Code's close actions, workspaces get close, copy path and reveal.
        const rightClick = (selector: string) =>
          js(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 })); return true; })()`,
          );
        const menuLabels = () => js(`[...document.querySelectorAll('[data-testid=context-menu] [role=menuitem]')].map((b) => b.textContent)`);
        const tabTitles = () => js(`[...document.querySelectorAll('[data-testid=tab]')].map((t) => t.getAttribute('data-title'))`) as Promise<string[]>;
        // Dragging a tab with the mouse reorders the strip and the new order is saved with the workspace.
        const orderBefore = await tabTitles();
        const stripScrolled = await js(`(() => { const strip = document.querySelector('[data-testid=tab]')?.parentElement; if (!strip) return null; const scrolled = strip.scrollLeft > 0 && strip.scrollWidth > strip.clientWidth; strip.scrollLeft = 0; return scrolled; })()`);
        check('ui: with many tabs open the strip scrolls to the active tab instead of squeezing the tabs', stripScrolled === true, stripScrolled);
        const wheeled = await js(`(() => { const strip = document.querySelector('[data-testid=tab]').parentElement; strip.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })); const moved = strip.scrollLeft; strip.scrollLeft = 0; return moved; })()`);
        check('ui: the mouse wheel scrolls the tab strip sideways', typeof wheeled === 'number' && wheeled > 0, wheeled);
        await wait(100);
        const tabRects = (await js(
          `[...document.querySelectorAll('[data-testid=tab]')].map((t) => { const r = t.getBoundingClientRect(); return { x: Math.round(r.left + 16), right: Math.round(r.right), y: Math.round(r.top + r.height / 2) }; })`,
        )) as { x: number; right: number; y: number }[];
        let markerShown = false;
        if (tabRects.length >= 3) {
          const from = tabRects[0];
          const to = tabRects[2].right - 4;
          win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
          win.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
          for (let step = 1; step <= 8; step++) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + ((to - from.x) * step) / 8), y: from.y, button: 'left', modifiers: ['leftbuttondown'] });
            await wait(30);
          }
          await wait(150);
          markerShown = (await js(`Boolean(document.querySelector('[data-testid=tab-drop-marker]'))`)) === true;
          await shot('24g-tab-drag-light');
          win.webContents.sendInputEvent({ type: 'mouseUp', x: to, y: from.y, button: 'left', clickCount: 1 });
        }
        await wait(700);
        const orderAfter = await tabTitles();
        const expectedOrder = [orderBefore[1], orderBefore[2], orderBefore[0], ...orderBefore.slice(3)];
        const draggedActive = await js(`document.querySelector('[data-testid=tab][aria-selected=true]')?.getAttribute('data-title') ?? null`);
        const savedTabs = await run<{ value: { tabs: { title: string }[] } | null }>('workspace.state.get', { key: 'ui.tabs' }, ws.id);
        check(
          'ui: dragging a tab past its neighbours reorders the tabs, activates it and saves the order',
          orderBefore.length >= 3 && markerShown && JSON.stringify(orderAfter) === JSON.stringify(expectedOrder) && draggedActive === orderBefore[0] && JSON.stringify(savedTabs.value?.tabs.map((t) => t.title)) === JSON.stringify(expectedOrder),
          { orderBefore, orderAfter, markerShown, draggedActive, saved: savedTabs.value?.tabs.map((t) => t.title) },
        );
        // Escape during a drag puts everything back.
        const escRects = (await js(
          `[...document.querySelectorAll('[data-testid=tab]')].map((t) => { const r = t.getBoundingClientRect(); return { x: Math.round(r.left + 16), y: Math.round(r.top + r.height / 2) }; })`,
        )) as { x: number; y: number }[];
        let markerBeforeEsc = false;
        if (escRects.length >= 2) {
          win.webContents.sendInputEvent({ type: 'mouseDown', x: escRects[0].x, y: escRects[0].y, button: 'left', clickCount: 1 });
          for (let step = 1; step <= 5; step++) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: escRects[0].x + ((escRects[1].x + 40 - escRects[0].x) * step) / 5, y: escRects[0].y, button: 'left', modifiers: ['leftbuttondown'] });
            await wait(30);
          }
          await wait(100);
          markerBeforeEsc = (await js(`Boolean(document.querySelector('[data-testid=tab-drop-marker]'))`)) === true;
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
          await wait(100);
          win.webContents.sendInputEvent({ type: 'mouseUp', x: escRects[1].x + 40, y: escRects[0].y, button: 'left', clickCount: 1 });
        }
        await wait(300);
        const orderAfterEsc = await tabTitles();
        check('ui: Escape cancels a tab drag and keeps the order', markerBeforeEsc && JSON.stringify(orderAfterEsc) === JSON.stringify(expectedOrder) && (await js(`Boolean(document.querySelector('[data-testid=tab-drop-marker]'))`)) === false, orderAfterEsc);

        // A middle click closes the tab under the pointer; the scrollable strip must not start the browser's autoscroll instead.
        const middleTabs = await tabTitles();
        const middleTarget = (await js(
          `(() => { const strip = document.querySelector('[role=tablist]').getBoundingClientRect(); const tabs = [...document.querySelectorAll('[data-testid=tab]')]; const t = tabs.reverse().find((t) => { const r = t.getBoundingClientRect(); return r.left >= strip.left && r.right <= strip.right; }); if (!t) return null; const r = t.getBoundingClientRect(); return { title: t.getAttribute('data-title'), x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) }; })()`,
        )) as { title: string; x: number; y: number } | null;
        if (middleTabs.length >= 4 && middleTarget) {
          win.webContents.sendInputEvent({ type: 'mouseMove', x: middleTarget.x, y: middleTarget.y });
          win.webContents.sendInputEvent({ type: 'mouseDown', x: middleTarget.x, y: middleTarget.y, button: 'middle', clickCount: 1 });
          await wait(50);
          win.webContents.sendInputEvent({ type: 'mouseUp', x: middleTarget.x, y: middleTarget.y, button: 'middle', clickCount: 1 });
        }
        await wait(400);
        const afterMiddle = await tabTitles();
        check(
          'ui: middle-clicking a tab closes it',
          middleTabs.length >= 4 && middleTarget !== null && afterMiddle.length === middleTabs.length - 1 && !afterMiddle.includes(middleTarget.title),
          { middleTabs, middleTarget, afterMiddle },
        );

        const tabsBefore = await tabTitles();
        const secondTab =`[data-testid=tab][data-title=${JSON.stringify(tabsBefore[1] ?? '')}]`;
        const openedTabMenu = await rightClick(secondTab);
        await wait(200);
        const tabMenu = await menuLabels();
        check(
          'ui: right-clicking a tab shows Close, Close Others, Close to the Right, Close Saved and Close All',
          openedTabMenu === true && tabsBefore.length >= 3 && JSON.stringify(tabMenu) === JSON.stringify(['CloseCtrl+W', 'Close Others', 'Close to the Right', 'Close Saved', 'Close All']),
          { tabs: tabsBefore.length, tabMenu },
        );
        await shot('24d-tab-menu-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(200);
        await shot('24e-tab-menu-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await js(`document.querySelector('[data-testid=tab-menu-close-right]').click()`);
        await wait(300);
        const tabsAfterRight = await tabTitles();
        check('ui: Close to the Right keeps the tabs up to the clicked one', JSON.stringify(tabsAfterRight) === JSON.stringify(tabsBefore.slice(0, 2)), tabsAfterRight);
        await rightClick(secondTab);
        await wait(200);
        await js(`document.querySelector('[data-testid=tab-menu-close-others]').click()`);
        await wait(300);
        const tabsAfterOthers = await tabTitles();
        const activeTitle = await js(`document.querySelector('[data-testid=tab][aria-selected=true]')?.getAttribute('data-title') ?? null`);
        check('ui: Close Others leaves only the clicked tab, active', JSON.stringify(tabsAfterOthers) === JSON.stringify([tabsBefore[1]]) && activeTitle === tabsBefore[1], { tabsAfterOthers, activeTitle });
        await rightClick('[data-testid=workspace-tab]');
        await wait(200);
        const workspaceMenu = await menuLabels();
        check(
          'ui: right-clicking a workspace shows close actions, Copy Path and reveal',
          Array.isArray(workspaceMenu) && ['Close', 'Close Others', 'Close to the Right', 'Close All', 'Copy Path'].every((l) => workspaceMenu.includes(l)) && workspaceMenu.length === 6,
          workspaceMenu,
        );
        await shot('24f-workspace-menu-light');
        await js(`document.querySelector('[data-testid=context-menu]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await wait(200);
        check('ui: Escape closes a context menu', (await js(`Boolean(document.querySelector('[data-testid=context-menu]'))`)) === false);
        // Workspaces reorder by dragging too, and the host keeps the order for the next start.
        const workspaceOrder = () => js(`[...document.querySelectorAll('[data-testid=workspace-tab]')].map((t) => t.getAttribute('data-drag-id'))`) as Promise<string[]>;
        const wsBefore = await workspaceOrder();
        const wsRects = (await js(
          `[...document.querySelectorAll('[data-testid=workspace-tab]')].map((t) => { const r = t.getBoundingClientRect(); return { x: Math.round(r.left + 14), right: Math.round(r.right), y: Math.round(r.top + r.height / 2) }; })`,
        )) as { x: number; right: number; y: number }[];
        let wsMarker = false;
        if (wsRects.length >= 2) {
          const from = wsRects[0];
          const to = wsRects[1].right - 4;
          win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
          win.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
          for (let step = 1; step <= 8; step++) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + ((to - from.x) * step) / 8), y: from.y, button: 'left', modifiers: ['leftbuttondown'] });
            await wait(30);
          }
          await wait(150);
          wsMarker = (await js(`Boolean(document.querySelector('[data-testid=workspace-drop-marker]'))`)) === true;
          await shot('24h-workspace-drag-light');
          win.webContents.sendInputEvent({ type: 'mouseUp', x: to, y: from.y, button: 'left', clickCount: 1 });
        }
        await wait(600);
        const wsAfter = await workspaceOrder();
        const hostOrder = (await run<WorkspaceInfo[]>('workspace.list', {}, null)).map((w) => w.id);
        const openOrder = host.config.get().openWorkspaces;
        const expectedWs = [wsBefore[1], wsBefore[0], ...wsBefore.slice(2)];
        check(
          'ui: dragging a workspace reorders the title bar, the host list and the folders reopened on start',
          wsBefore.length >= 2 && wsMarker && JSON.stringify(wsAfter) === JSON.stringify(expectedWs) && JSON.stringify(hostOrder) === JSON.stringify(expectedWs) && openOrder.indexOf(folder) > 0,
          { wsBefore, wsAfter, hostOrder, wsMarker, openOrder },
        );
        await run('workspace.reorder', { ids: [ws.id] }, null);
        await wait(300);
        check('workspace.reorder: listed ids go first and the rest keep their order', (await workspaceOrder())[0] === ws.id && host.config.get().openWorkspaces[0] === folder, await workspaceOrder());

        // The activity bar: right-click to hide modules (VS Code's ticked list), drag to reorder, reset.
        const activityOrder = () => js(`[...document.querySelectorAll('[data-testid=activity-item]')].map((b) => b.getAttribute('data-drag-id'))`) as Promise<string[]>;
        const activeActivity = () => js(`document.querySelector('[data-testid=activity-item][data-active]')?.getAttribute('data-drag-id') ?? null`);
        const activityDefault = await activityOrder();
        await rightClick('[data-testid=activity-item]');
        await wait(200);
        const activityMenu = (await js(
          `[...document.querySelectorAll('[data-testid=context-menu] [role^=menuitem]')].map((b) => ({ label: b.textContent, checked: b.getAttribute('aria-checked'), disabled: b.disabled }))`,
        )) as { label: string; checked: string | null; disabled: boolean }[];
        check(
          'ui: right-clicking the activity bar offers Hide, every module ticked, and a reset',
          activityMenu[0]?.label.startsWith('Hide ') &&
            activityMenu.filter((i) => i.checked === 'true').length === activityDefault.length &&
            activityMenu[activityMenu.length - 1]?.label === 'Reset Order and Visibility' && activityMenu[activityMenu.length - 1].disabled,
          activityMenu,
        );
        await js(`document.documentElement.classList.add('dark')`);
        await wait(200);
        await shot('25a-activity-menu-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        const toHide = activityDefault[1];
        await js(`document.querySelector('[data-testid=activity-menu-${toHide}]').click()`);
        await wait(300);
        const afterHide = await activityOrder();
        check(
          'ui: unticking a module hides it from the activity bar and keeps that in the config',
          !afterHide.includes(toHide) && afterHide.length === activityDefault.length - 1 && host.config.get().activityBar.hidden.includes(toHide),
          { afterHide, saved: host.config.get().activityBar },
        );
        const itemRects = (await js(
          `[...document.querySelectorAll('[data-testid=activity-item]')].map((b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), bottom: Math.round(r.bottom) }; })`,
        )) as { x: number; y: number; bottom: number }[];
        let activityMarker = false;
        if (itemRects.length >= 3) {
          const from = itemRects[0];
          const to = itemRects[2].bottom - 3;
          win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
          win.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
          for (let step = 1; step <= 8; step++) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y: Math.round(from.y + ((to - from.y) * step) / 8), button: 'left', modifiers: ['leftbuttondown'] });
            await wait(30);
          }
          await wait(150);
          activityMarker = (await js(`Boolean(document.querySelector('[data-testid=activity-drop-marker]'))`)) === true;
          await shot('25b-activity-drag-light');
          win.webContents.sendInputEvent({ type: 'mouseUp', x: from.x, y: to, button: 'left', clickCount: 1 });
        }
        await wait(400);
        const afterDrag = await activityOrder();
        check(
          'ui: dragging an activity bar icon reorders the modules and keeps the order in the config',
          activityMarker && JSON.stringify(afterDrag) === JSON.stringify([afterHide[1], afterHide[2], afterHide[0], ...afterHide.slice(3)]) && host.config.get().activityBar.order.filter((id) => id !== toHide).slice(0, 3).join() === afterDrag.slice(0, 3).join(),
          { afterHide, afterDrag, activityMarker, saved: host.config.get().activityBar },
        );
        const toActivate = afterDrag[1];
        await js(`document.querySelector('[data-testid=activity-item][data-drag-id=${toActivate}]').click()`);
        await wait(200);
        await rightClick(`[data-testid=activity-item][data-drag-id=${toActivate}]`);
        await wait(200);
        await js(`document.querySelector('[data-testid=activity-menu-hide]').click()`);
        await wait(300);
        const afterHideActive = await activityOrder();
        const nowActive = await activeActivity();
        check(
          'ui: hiding the module on screen switches to the first module still shown',
          !afterHideActive.includes(toActivate) && nowActive === afterHideActive[0],
          { toActivate, afterHideActive, nowActive },
        );
        await shot('25c-activity-arranged-light');
        await rightClick('[data-testid=activity-bar]');
        await wait(200);
        await js(`document.querySelector('[data-testid=activity-menu-reset]').click()`);
        await wait(300);
        const afterReset = await activityOrder();
        check(
          'ui: Reset Order and Visibility brings back every module in the default order',
          JSON.stringify(afterReset) === JSON.stringify(activityDefault) && host.config.get().activityBar.order.length === 0 && host.config.get().activityBar.hidden.length === 0,
          { afterReset, saved: host.config.get().activityBar },
        );

        // Settings: the About section shows the version and says that a dev build does not update itself.
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
        await wait(600);
        const aboutVersion = await js(
          `(() => { const el = document.querySelector('[data-testid=about-version]'); if (el) el.scrollIntoView(); return el ? el.textContent : null; })()`,
        );
        check('ui: about shows the running version', typeof aboutVersion === 'string' && aboutVersion.includes(host.api.version), aboutVersion);
        const updateNote = await js(`(() => { const el = document.querySelector('[data-testid=update-note]'); return el ? el.textContent : null; })()`);
        check('ui: about says updates are off in dev builds', typeof updateNote === 'string' && updateNote.includes('installed builds'), updateNote);
        const betaToggle = await js(`Boolean(document.querySelector('[data-testid=update-beta]'))`);
        check('ui: the beta builds checkbox is hidden where beta builds are not offered', betaToggle === false);
        const markInTitle = await js(`Boolean(document.querySelector('header [data-testid=quiver-mark]'))`);
        check('ui: title bar shows the logo mark', markInTitle === true);
        await wait(200);
        await shot('25-settings-about-light');

        // Settings: the palette picker lists every brand palette and applies the one clicked.
        const paletteCount = await js(`document.querySelectorAll('[data-testid=palette-option]').length`);
        check('ui: settings lists the palettes', paletteCount === 6, paletteCount);
        await js(`(() => { const el = document.querySelector('[data-testid=palette-option][data-palette=ember]'); el.scrollIntoView({ block: 'center' }); el.click(); })()`);
        await wait(500);
        const emberAccent = await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
        const emberMode = (await js(`document.documentElement.classList.contains('dark')`)) ? 'dark' : 'light';
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(200);
        check('ui: clicking a palette applies it', emberAccent === resolvePalette('ember')[emberMode].accent && host.config.get().palette === 'ember', { emberAccent, saved: host.config.get().palette });
        await shot('26-settings-palette-ember-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(200);
        await shot('27-settings-palette-ember-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await js(`document.querySelector('[data-testid=palette-option][data-palette=${DEFAULT_PALETTE}]').click()`);
        await wait(300);

        // Settings: agent permissions. The mode replaces the old mutations switch, and rules are added, changed and removed in a table, globally and for the workspace.
        {
          const mcpBefore = structuredClone(host.config.get().mcp);
          const setField = (selector: string, value: string) =>
            js(`(() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return false;
              const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
              el.dispatchEvent(new Event('input', { bubbles: true }));
              if (el instanceof HTMLSelectElement) el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            })()`);
          const rows = (table: string) => js(`[...document.querySelectorAll('[data-testid=${table}] [data-testid=agent-rule]')].map((r) => r.getAttribute('data-match') + ':' + r.getAttribute('data-action'))`) as Promise<string[]>;
          const shown = await js(
            `(() => { const s = document.querySelector('[data-testid=settings-mcp]'); if (!s) return null; s.scrollIntoView(); return { mode: s.querySelector('[data-testid=mcp-mode]')?.value, oldToggle: s.textContent.includes('Allow mutating commands'), workspaceTable: Boolean(s.querySelector('[data-testid=mcp-rules-workspace]')) }; })()`,
          );
          check('ui: settings show the permission mode in place of the mutations switch, and a workspace rules table', JSON.stringify(shown) === JSON.stringify({ mode: 'read-only', oldToggle: false, workspaceTable: true }), shown);
          await setField('[data-testid=mcp-rules-global] [data-testid=agent-rule-match]', 'git.*');
          await setField('[data-testid=mcp-rules-global] [data-testid=agent-rule-action]', 'deny');
          await wait(150);
          const hint = await js(`document.querySelector('[data-testid=mcp-rules-global]')?.textContent.includes('Matches')`);
          await js(`document.querySelector('[data-testid=mcp-rules-global] [data-testid=agent-rule-add]')?.click()`);
          await until(() => host.config.get().mcp.permissions.rules.some((r) => r.match === 'git.*'), 2000);
          await setField('[data-testid=mcp-rules-global] [data-testid=agent-rule-match]', 'git.status');
          await setField('[data-testid=mcp-rules-global] [data-testid=agent-rule-action]', 'allow');
          await wait(150);
          await js(`document.querySelector('[data-testid=mcp-rules-global] [data-testid=agent-rule-add]')?.click()`);
          await until(() => host.config.get().mcp.permissions.rules.length === 2, 2000);
          await setField('[data-testid=mcp-mode]', 'ask');
          await until(() => host.config.get().mcp.permissions.mode === 'ask', 2000);
          await wait(300);
          const globalRows = await rows('mcp-rules-global');
          check(
            'ui: rules added in settings are saved in the global config with the mode',
            hint === true && JSON.stringify(globalRows) === JSON.stringify(['git.*:deny', 'git.status:allow']) && host.config.get().mcp.permissions.mode === 'ask' && host.config.get().mcp.allowMutating === false,
            { globalRows, saved: host.config.get().mcp.permissions },
          );
          await setField('[data-testid=mcp-rules-workspace] [data-testid=agent-rule-match]', 'todo.remove');
          await setField('[data-testid=mcp-rules-workspace] [data-testid=agent-rule-action]', 'allow');
          await wait(150);
          await js(`document.querySelector('[data-testid=mcp-rules-workspace] [data-testid=agent-rule-add]')?.click()`);
          await until(async () => (await run<{ rules: unknown[] }>('mcp.permissions.workspace', {}, ws.id)).rules.length === 1, 2000);
          await wait(300);
          const wsRows = await rows('mcp-rules-workspace');
          const shownActions = await js(`[...document.querySelectorAll('[data-testid=mcp-rules-global] [data-testid=agent-rule-row-action]')].map((el) => el.value)`);
          check('ui: each rule row shows its own action', JSON.stringify(shownActions) === JSON.stringify(['deny', 'allow']), shownActions);
          check('ui: a workspace rule is saved for the workspace only', JSON.stringify(wsRows) === JSON.stringify(['todo.remove:allow']) && !host.config.get().mcp.permissions.rules.some((r) => r.match === 'todo.remove'), wsRows);
          await setField('[data-testid=mcp-rules-global] [data-testid=agent-rule-match]', 'not valid');
          await wait(150);
          const addDisabled = await js(`document.querySelector('[data-testid=mcp-rules-global] [data-testid=agent-rule-add]')?.disabled`);
          check('ui: an invalid match cannot be added', addDisabled === true);
          await js(`document.querySelector('[data-testid=settings-mcp]')?.scrollIntoView()`);
          // Saving the config re-applies the theme setting, which follows the system: the light shot wants light.
          await js(`document.documentElement.classList.remove('dark')`);
          await wait(200);
          await shot('27b-settings-agent-permissions-light');
          await js(`document.documentElement.classList.add('dark')`);
          await wait(200);
          await shot('27c-settings-agent-permissions-dark');
          await js(`document.documentElement.classList.remove('dark')`);
          await js(`document.querySelector('[data-testid=mcp-rules-global] [data-testid=agent-rule][data-match="git.status"] button')?.click()`);
          await until(() => host.config.get().mcp.permissions.rules.length === 1, 2000);
          check('ui: the remove button deletes a rule', JSON.stringify(host.config.get().mcp.permissions.rules) === JSON.stringify([{ match: 'git.*', action: 'deny' }]), host.config.get().mcp.permissions.rules);
          await run('mcp.permissions.setWorkspace', { rules: [] }, ws.id);
          await run('config.update', { patch: { mcp: { ...host.config.get().mcp, permissions: mcpBefore.permissions, allowMutating: mcpBefore.allowMutating } } }, null);
        }
      },
      after: async () => {
        await run('workspace.close', { id: otherWs.id }, null);
        await run('workspace.forgetRecent', { path: otherFolder }, null);
        await fs.rm(otherFolder, { recursive: true, force: true }).catch(() => {});
      },
    };
  },
});
