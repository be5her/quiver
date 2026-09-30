# The shell

The renderer is the frame around the modules: title bar, activity bar, sidebar, tab strip, tab content, status bar, command palette and settings. It talks to the host only through commands (`invoke`) and host events, over the three functions the preload exposes.

The status bar shows the workspace folder, the active environment, the updater, and the MCP server with its port. While the MCP inspector's call recorder is recording, `REC` and the number of calls so far sit next to it and open the recorder.

## Workspaces and tabs

Open several folders at once and switch instantly. Each workspace has its own tabs, and the open or collapsed state of sidebar folders and sections, restored on return and after a restart (kept under `.quiver/local`). Global-scope tabs (Settings, Tools) are not persisted.

- Drag a tab to reorder the tabs; an accent marker shows where it lands, Escape cancels, and the dropped tab becomes active. The order is restored with the rest. When the tabs do not fit, the strip scrolls with the wheel and follows the active tab instead of squeezing them.
- Right-click a tab for Close (`Ctrl+W`), Close Others, Close to the Right, Close Saved and Close All, as in VS Code. The menu actions ask once when a tab with unsaved changes is among the ones to close.
- Workspaces in the title bar reorder by dragging the same way, and reopen in that order on the next start (`workspace.reorder`). Right-click one to close it, the others, those to the right or all, copy its path, or reveal it in the file manager.
- The activity bar is yours to arrange: drag its icons to reorder them, and right-click it to hide a module or tick modules on and off ("Reset Order and Visibility" undoes it all). The last visible module cannot be hidden, hiding the module on screen moves to the first one still shown, and hidden modules stay reachable from the command palette. The arrangement lives in the global config, so it applies to every workspace, and a module added in a later version appears at the end.

Reordering is one shared hook (`shell/useDragReorder.tsx`) built on pointer events rather than HTML drag and drop, so the marker follows the pointer and the result is the same on every platform.

## Theme

Colours are CSS variables (`canvas`, `surface`, `elevated`, `fg`, `muted`, `edge`, `accent`, `accent-hover`, `accent-fg`, `danger`, `success`, `warning`) that Tailwind exposes as `bg-canvas`, `text-accent` and so on. `styles.css` holds the default palette; the palettes themselves live in `packages/core/src/palettes.ts`. `applyTheme` toggles the `dark` class and writes the chosen palette into a `<style id="quiver-palette">` whose selectors outrank `styles.css`, so the mode still follows the class. The choice is `palette` in global config beside `theme` (system, light or dark); an unknown key falls back to Slate & Mint. The app icon (`resources/icon.svg`) is the brand's C4 Solid mark on the Slate & Mint dark badge and does not change with the palette; the in-app mark (`shell/Logo.tsx`) is drawn with the `fg` and `accent` tokens, so it does.

Two things to know when styling: `cn` is plain clsx without Tailwind merging, so later classes do not override earlier ones; and `styles.css` has an unlayered `*` rule for scrollbars that outranks Tailwind utilities, which is why the tab strip uses the `.no-scrollbar` class from that file.

## Shared pieces

`packages/ui` holds what the shell and the modules share: the stores (app, tabs, tree, dialogs, context menu, variable hover), `useInvoke` (a query hook that re-runs on store, state or host events), and the components: primitives, the key/value editor, the CodeMirror editor, the context menu (with checkbox items), the variable hover card and the toast and dialog hosts.
