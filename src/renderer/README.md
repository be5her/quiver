# The shell

The renderer is the frame around the modules: title bar, activity bar, sidebar, tab strip, tab content, status bar, command palette and settings. It talks to the host only through commands (`invoke`) and host events, over the three functions the preload exposes.

The status bar shows the workspace folder, the active environment, the updater, and the MCP server with its port. While the MCP inspector's call recorder is recording, `REC` and the number of calls so far sit next to it and open the recorder.

## Agents

Beside the MCP item, the status bar shows the agent calls of the last minute and, in the warning colour, how many calls wait for approval; a click opens the **Agent activity** tab (`shell.agents`): the calls waiting, with Allow once and Deny, and the last 200 calls with agent, tool, workspace, decision, outcome and duration. The pause button next to it is the Pause agents switch, which the tab and Settings > MCP also have, and the palette has Agent activity, Pause agents and Resume agents. All of it lives in `app/agents/` and reads one `AgentsState` service (`mcp.activity.list`, reloaded on the `mcp.activity` and `mcp.approval.requested` events).

When an agent's call needs asking, the approval dialog (`app/agents/approval-dialog.ts`, mounted once in `app.html` above the other dialogs) shows the oldest one: the agent, the tool and whether it changes data, the workspace, the arguments as the host masked them, a countdown to the 120 second timeout and how many more wait. Allow once, Allow until restart (this tool for this agent), Always allow (adds an allow rule, to the workspace's rules when one of them asked, otherwise the global ones) and Deny answer it through `mcp.approval.respond`, which only the window may call; Escape denies. The dialog focuses itself rather than a button and is drawn afresh for each approval, so an Enter or Space meant for the page underneath, or a second press after answering, never allows a call; an answered approval leaves the dialog at once, and a new one ignores clicks for 400 ms, so a double click cannot answer the next one unseen. When the window is in the background the main process shows a system notification that brings it forward.

Settings > MCP holds the permission mode (refused, ask, allowed), Pause agents, and two rule tables (`AgentRulesEditor`): one for every workspace and one for the active workspace, both kept in the global config on this machine (`mcp.workspaceRules`), never in the project. The match field suggests `*`, every module glob and every tool id, and says how many tools a match covers. Each change goes to the host as one rule set or removed (`mcp.permissions.setRule`, `mcp.permissions.setMode`), so quick changes in a row never undo one another.

Modules add their own items after the environment through `statusItems` on their `ModuleUI`: Git shows the current branch with ahead and behind, the Runner how many tasks are running, and either opens its sidebar on a click. See [Status bar items](#status-bar-items).

Links never open inside the app: a link the page opens (`window.open`, a `target=_blank` anchor) or navigates the window to (a plain anchor) goes to the system's handler through `openExternal` in `src/main/external.ts`, and only for `http:`, `https:` and `mailto:` (`isSafeExternalUrl` in `@quiver/core`). The main window never leaves the app's own page, since the page has the host bridge. Any other scheme (`file:`, `ms-settings:`, `smb:`, a custom protocol) could start a local program from page content such as a response preview, a PR body or a log line, so it is refused and logged once.

## Workspaces and tabs

Open several folders at once and switch instantly. Each workspace has its own tabs, and the open or collapsed state of sidebar folders and sections, restored on return and after a restart (kept under `.quiver/local`). Global-scope tabs (Settings, Tools) are not persisted.

- Drag a tab to reorder the tabs; an accent marker shows where it lands, Escape cancels, and the dropped tab becomes active. The order is restored with the rest. When the tabs do not fit, the strip scrolls with the wheel and follows the active tab instead of squeezing them.
- Right-click a tab for Close (`Ctrl+W`), Close Others, Close to the Right, Close Saved and Close All, as in VS Code. A middle click closes the tab under the pointer (the strip stops the browser's middle-button autoscroll so the click gets through). The menu actions ask once when a tab with unsaved changes is among the ones to close.
- Workspaces in the title bar reorder by dragging the same way, and reopen in that order on the next start (`workspace.reorder`). Right-click one to close it, the others, those to the right or all, copy its path, or reveal it in the file manager.
- The activity bar is yours to arrange: drag its icons to reorder them, and right-click it to hide a module or tick modules on and off ("Reset Order and Visibility" undoes it all). The last visible module cannot be hidden, hiding the module on screen moves to the first one still shown, and hidden modules stay reachable from the command palette. The arrangement lives in the global config, so it applies to every workspace, and a module added in a later version appears at the end.

Reordering is one shared helper (`dragReorder` in `packages/ui/src/drag/drag-reorder.ts`, drawn by `DropMarker`) built on pointer events rather than HTML drag and drop, so the marker follows the pointer and the result is the same on every platform. Beside it, `dragInto` drags an item onto drop targets (elements with `data-drop-target`) the same way; the API sidebar moves requests and collections with it. It clears any text selection when a drag starts, since a press on selected text would start the browser's own drag and cancel the pointer events.

## How it is built

The renderer is an Angular application (`src/renderer`, its own npm workspace) built with the Angular CLI's application builder into `out/renderer`, which Electron loads from disk; electron-vite builds only the main process and the preload. `npm run dev` (`scripts/dev.mjs`) starts `ng serve` and then electron-vite with Electron pointed at the dev server; electron-vite's "renderer config is missing" note is expected. The workspace packages (`@quiver/core`, `@quiver/ui`, `@quiver/modules`) reach the renderer through `node_modules` but are TypeScript sources with Angular components, so `angular.json` excludes them from the dev server's dependency pre-bundling and they are compiled with the app, as in the production build. The renderer workspace pins the TypeScript version the Angular compiler supports, separate from the root's, and the Angular CLI needs Node `^22.22.3`, `^24.15.0` or 26 and later.

Everything follows the current Angular defaults: standalone components, zoneless change detection, `OnPush`, signals (`signal`, `computed`, `linkedSignal`, `effect`, `afterRenderEffect`), signal inputs, outputs and `model()`, `viewChild()`, the built-in control flow, host bindings in the `host` metadata, `inject()`, and `@Service()` for app-wide state. Host data comes in through `invokeResource` (a `resource()` per command, see below); forms use Signal Forms (`form()` and `[formField]`), and editors that are more than one field implement `FormValueControl`, so `[formField]` binds them like a native input. Experimental APIs are left out until they are stable.

`app/startup.ts` loads what the host knows (config, commands, workspaces, MCP and updater status) before the first render (`provideAppInitializer`) and follows the host's events; `app/persistence.ts` restores each workspace's tabs and open sidebar nodes when it is first shown and writes them back; `app/modules.ts` resolves a tab's type to its component, which `NgComponentOutlet` renders with the `tab` and `scope` inputs.

## Theme

Colours are CSS variables (`canvas`, `surface`, `elevated`, `fg`, `muted`, `edge`, `accent`, `accent-hover`, `accent-fg`, `danger`, `success`, `warning`) that Tailwind exposes as `bg-canvas`, `text-accent` and so on. `styles.css` holds the default palette and tells Tailwind to scan `packages/ui` and `packages/modules`; the palettes themselves live in `packages/core/src/palettes.ts`. The `Theme` service toggles the `dark` class and writes the chosen palette into a `<style id="quiver-palette">` whose selectors outrank `styles.css`, so the mode still follows the class. The choice is `palette` in global config beside `theme` (system, light or dark); an unknown key falls back to Slate & Mint. The app icon (`resources/icon.svg`) is the brand's C4 Solid mark on the Slate & Mint dark badge and does not change with the palette; the in-app mark (`app/quiver-mark.ts`) is drawn with the `fg` and `accent` tokens, so it does.

Two things to know when styling: `cn` joins class names without Tailwind merging, so later classes do not override earlier ones (and a `[class]` binding adds to the classes a directive's host sets, it does not replace them); and `styles.css` has an unlayered `*` rule for scrollbars that outranks Tailwind utilities, which is why the tab strip uses the `.no-scrollbar` class from that file. Icons are lucide's icon data drawn by the `svg[qIcon]` directive.

## Shared pieces

`packages/ui` holds what the shell and the modules share:

- The host contract: `HostBridge` (commands and host events over the preload), `invokeResource` (a command as a `resource()` that runs again on store, state or host events and keeps its last value while reloading; `current` is that value only while it is the active workspace's) and `injectHostEvent`.
- State services: `AppState`, `TabsState`, `TreeState`, `UiActions` (the palette's entries), `Toasts`, `Dialogs` (prompt, prompt with a choice, confirm, and a notice with only OK), the context menu and the variable hover.
- `defineModuleUI`, the renderer half of a module: id, title, icon, sidebar component, tab components by type, and palette actions created in an injection context, and status bar items.
- Dragging: `dragReorder` and `DropMarker` for strips, `dragInto` for dropping items on targets.
- Controls as directives on native elements (`button[qButton]`, `button[qIconButton]`, `input[qInput]`, `select[qSelect]`, `input[qCheckbox]`, `span[qBadge]`, `svg[qSpinner]`, `[qAutofocus]`), and components: the segmented tabs, section header, empty state, the key/value editor, the CodeMirror editor (with a merge view, and a conflict editor that highlights git's conflict markers with an accept bar per conflict), the variable input with its hover card, and the toast, dialog and context menu hosts.
- `VariableSource`, the injection token the variable input and hover read `{{variables}}` from; `[qVariables]` provides one, and the API module's `ApiVariables` directive provides the active environment's.

## Status bar items

A module contributes to the status bar by listing components in `statusItems` on its `ModuleUI` (`packages/ui/src/module-ui.ts`):

```ts
export const runnerModuleUI = defineModuleUI({
  id: 'runner',
  // ...
  statusItems: [RunnerStatusItem],
});
```

The status bar (`app/status-bar/status-bar.ts`) draws them with `NgComponentOutlet` after the environment picker, in the activity bar's order, for every module that is shown there (one the user hid contributes nothing, unless its `ModuleUI` sets `statusItemsWhenHidden`, as the Runner does so running processes never go unseen) and available (a `workspace` module only while a workspace is open). They take no inputs, so an item reads its own data, usually with `invokeResource` on the active workspace and a reload on its module's host event, and lives as long as its module is shown. An item:

- renders nothing when it has nothing to say (outside a repository, no task running), so a quiet module leaves no gap; give the component `host: { class: 'contents' }` so the bar's gap applies to what it renders;
- shows the resource's `current` (and `currentError`) rather than `value`: `invokeResource` keeps the last value while the next workspace's loads, and `current` is that value only while it was read for the workspace the resource reads now;
- is a `<button>` at the bar's size (`text-[11px]`, icons `size-3`, `hover:text-fg`) with a tooltip that says what a click does, which is usually `AppState.setActiveModule(<module id>)` to open the module's sidebar;
- carries a `data-testid` for the smoke.

## Verified by

The smoke's `shell` part ([`src/main/smoke/parts/shell.ts`](../main/smoke/parts/shell.ts)) checks the updater state of a dev build, that a `file:` link is refused directly, when the page opens it and when the page navigates to it, that the default palette applies and a saved one recolours the window in both modes, and in the UI the tab strip (scrolling, dragging, Escape during a drag, middle click, the right-click menus), dragging workspaces, hiding and reordering modules in the activity bar, and the About and palette sections of the settings. It also checks the agent permissions in Settings: the mode in place of the old switch, adding, changing and removing global and workspace rules, each row showing its own action, and refusing an invalid match. Settings also has a Network section (the proxy for the API client, realtime and GraphQL introspection), checked by the `api` part, and a Command line section (the folder of the packaged `quiver` shims with a copyable line per shell to put it on PATH, or `npm run cli` in a development build, and whether connected mode is ready), checked by the `cli` part. The approval dialog, the agents status bar item and the Agent activity tab are checked by the `mcp` part. `npm run smoke -- shell --shots` runs it alone with its UI checks. The module status bar items are checked by the parts of their modules (`git` and `runner`, with `--shots`).
