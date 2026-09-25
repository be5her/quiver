import { toErrorPayload } from '@quiver/core';
import { Kbd, invoke, notify, useActionsStore, useAppStore } from '@quiver/ui';
import { Command } from 'cmdk';
import { useEffect, useMemo } from 'react';

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  const actions = useActionsStore((s) => s.actions);
  const commands = useAppStore((s) => s.commands);
  const hasWorkspace = useAppStore((s) => s.activeWorkspaceId !== null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  const groups = useMemo(() => {
    const visible = actions.filter((a) => !a.when || a.when());
    const map = new Map<string, typeof visible>();
    for (const a of visible) map.set(a.group, [...(map.get(a.group) ?? []), a]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [actions, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // A UI action with the same id as a host command wraps it with proper feedback, so the raw command steps aside.
  const runnable = useMemo(
    () => commands.filter((c) => !c.hidden && c.noInput && (c.scope === 'global' || hasWorkspace) && !actions.some((a) => a.id === c.id)),
    [commands, hasWorkspace, actions],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center pt-[12vh]" onMouseDown={() => setOpen(false)}>
      <div className="w-[560px] max-w-[92vw] rounded-lg border border-edge bg-canvas shadow-2xl overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <Command label="Command palette" loop>
          <Command.Input autoFocus placeholder="Type a command…" />
          <Command.List>
            <Command.Empty>No matching commands.</Command.Empty>
            {groups.map(([group, items]) => (
              <Command.Group key={group} heading={group}>
                {items.map((a) => (
                  <Command.Item
                    key={a.id}
                    value={`${a.title} ${a.keywords?.join(' ') ?? ''} ${a.description ?? ''}`}
                    onSelect={() => {
                      setOpen(false);
                      void a.run();
                    }}
                  >
                    <span className="flex-1">{a.title}</span>
                    {a.shortcut && <Kbd>{a.shortcut}</Kbd>}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
            {runnable.length > 0 && (
              <Command.Group heading="Host commands">
                {runnable.map((c) => (
                  <Command.Item
                    key={c.id}
                    value={`${c.title} ${c.id} ${c.description}`}
                    onSelect={() => {
                      setOpen(false);
                      void runHostCommand(c.id);
                    }}
                  >
                    <span className="flex-1">{c.title}</span>
                    <span className="text-[10px] font-mono text-muted">{c.id}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

async function runHostCommand(id: string): Promise<void> {
  try {
    const result = await invoke(id, {});
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    notify(`${id}: ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`, 'success');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}
