# The shell

The renderer is the frame around the modules: title bar, activity bar, sidebar, tab strip, tab content, status bar, command palette and settings. It talks to the host only through commands (`invoke`) and host events, over the three functions the preload exposes.

The status bar shows the workspace folder, the active environment, the updater, and the MCP server with its port. While the MCP inspector's call recorder is recording, `REC` and the number of calls so far sit next to it and open the recorder.

## Workspaces and tabs

Open several folders at once and switch instantly. Each workspace has its own tabs, and the open or collapsed state of sidebar folders and sections, restored on return and after a restart (kept under `.quiver/local`). Global-scope tabs (Settings, Tools) are not persisted.

- Drag a tab to reorder the tabs; an accent marker shows where it lands, Escape cancels, and the dropped tab becomes active. The order is restored with the rest. When the tabs do not fit, the strip scrolls with the wheel and follows the active tab instead of squeezing them.
- Right-click a tab for Close (`Ctrl+W`), Close Others, Close to the Right, Close Saved and Close All, as in VS Code. A middle click closes the tab under the pointer (the strip stops the browser's middle-button autoscroll so the click gets through). The menu actions ask once when a tab with unsaved changes is among the ones to close.
- Workspaces in the title bar reorder by dragging the same way, and reopen in that order on the next start (`workspace.reorder`). Right-click one to close it, the others, those to the right or all, copy its path, or reveal it in the file manager.
- The activity bar is yours to arrange: drag its icons to reorder them, and right-click it to hide a module or tick modules on and off ("Reset Order and Visibility" undoes it all). The last visible module cannot be hidden, hiding the module on screen moves to the first one still shown, and hidden modules stay reachable from the command palette. The arrangement lives in the global config, so it applies to every workspace, and a module added in a later version appears at the end.

Reordering is one shared helper (`app/drag-reorder.ts`, drawn by `app/drop-marker.ts`) built on pointer events rather than HTML drag and drop, so the marker follows the pointer and the result is the same on every platform.

## How it is built

The renderer is an Angular application (`src/renderer`, its own npm workspace) built with the Angular CLI's application builder into `out/renderer`, which Electron loads from disk; electron-vite builds only the main process and the preload. `npm run dev` (`scripts/dev.mjs`) starts `ng serve` and then electron-vite with Electron pointed at the dev server; electron-vite's "renderer config is missing" note is expected. The workspace packages (`@quiver/core`, `@quiver/ui`, `@quiver/modules`) reach the renderer through `node_modules` but are TypeScript sources with Angular components, so `angular.json` excludes them from the dev server's dependency pre-bundling and they are compiled with the app, as in the production build. The renderer workspace pins the TypeScript version the Angular compiler supports, separate from the root's, and the Angular CLI needs Node `^22.22.3`, `^24.15.0` or 26 and later.

Everything follows the current Angular defaults: standalone components, zoneless change detection, `OnPush`, signals (`signal`, `computed`, `linkedSignal`, `effect`, `afterRenderEffect`), signal inputs, outputs and `model()`, `viewChild()`, the built-in control flow, host bindings in the `host` metadata, `inject()`, and `@Service()` for app-wide state. Host data comes in through `invokeResource` (a `resource()` per command, see below); forms use Signal Forms (`form()` and `[formField]`), and editors that are more than one field implement `FormValueControl`, so `[formField]` binds them like a native input. Experimental APIs are left out until they are stable.

`app/startup.ts` loads what the host knows (config, commands, workspaces, MCP and updater status) before the first render (`provideAppInitializer`) and follows the host's events; `app/persistence.ts` restores each workspace's tabs and open sidebar nodes when it is first shown and writes them back; `app/modules.ts` resolves a tab's type to its component, which `NgComponentOutlet` renders with the `tab` and `scope` inputs.

## Theme

Colours are CSS variables (`canvas`, `surface`, `elevated`, `fg`, `muted`, `edge`, `accent`, `accent-hover`, `accent-fg`, `danger`, `success`, `warning`) that Tailwind exposes as `bg-canvas`, `text-accent` and so on. `styles.css` holds the default palette and tells Tailwind to scan `packages/ui` and `packages/modules`; the palettes themselves live in `packages/core/src/palettes.ts`. The `Theme` service toggles the `dark` class and writes the chosen palette into a `<style id="quiver-palette">` whose selectors outrank `styles.css`, so the mode still follows the class. The choice is `palette` in global config beside `theme` (system, light or dark); an unknown key falls back to Slate & Mint. The app icon (`resources/icon.svg`) is the brand's C4 Solid mark on the Slate & Mint dark badge and does not change with the palette; the in-app mark (`app/quiver-mark.ts`) is drawn with the `fg` and `accent` tokens, so it does.

Two things to know when styling: `cn` joins class names without Tailwind merging, so later classes do not override earlier ones (and a `[class]` binding adds to the classes a directive's host sets, it does not replace them); and `styles.css` has an unlayered `*` rule for scrollbars that outranks Tailwind utilities, which is why the tab strip uses the `.no-scrollbar` class from that file. Icons are lucide's icon data drawn by the `svg[qIcon]` directive.

## Shared pieces

`packages/ui` holds what the shell and the modules share:

- The host contract: `HostBridge` (commands and host events over the preload), `invokeResource` (a command as a `resource()` that runs again on store, state or host events and keeps its last value while reloading) and `injectHostEvent`.
- State services: `AppState`, `TabsState`, `TreeState`, `UiActions` (the palette's entries), `Toasts`, `Dialogs`, the context menu and the variable hover.
- `defineModuleUI`, the renderer half of a module: id, title, icon, sidebar component, tab components by type, and palette actions created in an injection context.
- Controls as directives on native elements (`button[qButton]`, `button[qIconButton]`, `input[qInput]`, `select[qSelect]`, `input[qCheckbox]`, `span[qBadge]`, `svg[qSpinner]`, `[qAutofocus]`), and components: the segmented tabs, section header, empty state, the key/value editor, the CodeMirror editor, the variable input with its hover card, and the toast, dialog and context menu hosts.
- `VariableSource`, the injection token the variable input and hover read `{{variables}}` from; `[qVariables]` provides one, and the API module's `ApiVariables` directive provides the active environment's.
