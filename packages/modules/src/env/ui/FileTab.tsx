import { envKindLabel, toErrorPayload, type EnvFileContent, type EnvFileSummary, type EnvProfileGroup } from '@quiver/core';
import { Badge, Button, CodeEditor, IconButton, Segmented, Select, Spinner, cn, invoke, notify, onHostEvent, useInvoke, useTabsStore, type TabProps } from '@quiver/ui';
import { Eye, EyeOff, Save, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CompareView } from './CompareView';
import { HistoryView } from './HistoryView';
import { KeysView } from './KeysView';
import { WARNING_TITLE } from './Sidebar';
import { deleteEnvFile, importIntoEnvironment, useEnvProfile, type FileView } from './index';

export function FileTab({ tab, scope }: TabProps) {
  const filePath = String(tab.data?.path ?? '');
  const [content, setContent] = useState<EnvFileContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<FileView>((tab.data?.view as FileView | undefined) ?? 'keys');
  const [reveal, setReveal] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const [savedText, setSavedText] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const updateTab = useTabsStore((s) => s.updateTab);
  const dirtyRef = useRef(false);
  const files = useInvoke<EnvFileSummary[]>('env.file.list', {}, { refreshOnEvents: ['env.changed'] });
  const profiles = useInvoke<EnvProfileGroup[]>('env.profile.list', {}, { refreshOnEvents: ['env.changed'] });

  const load = useCallback(async () => {
    try {
      const next = await invoke<EnvFileContent>('env.file.read', { path: filePath });
      setContent(next);
      setSavedText(next.text);
      if (!dirtyRef.current) setDraft(next.text);
      setLoadError(null);
    } catch (err) {
      setLoadError(toErrorPayload(err).message);
    }
  }, [filePath]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      onHostEvent('env.changed', (p) => {
        if (!p.path || p.path === filePath) void load();
      }),
    [load, filePath],
  );

  const nonce = tab.data?.nonce;
  useEffect(() => {
    const wanted = tab.data?.view as FileView | undefined;
    if (wanted) setView(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const dirty = useMemo(() => draft !== savedText, [draft, savedText]);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (tab.dirty !== dirty) updateTab(scope, tab.id, { dirty });
  }, [dirty, scope, tab.id, tab.dirty, updateTab]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    setBusy(true);
    try {
      await invoke('env.file.write', { path: filePath, text: draft });
      setSavedText(draft);
      await load();
      return true;
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [filePath, draft, load]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save().then((ok) => ok && dirty && notify('Saved', 'success'));
    }
  };

  if (loadError) return <div className="p-4 text-sm text-danger">{loadError}</div>;
  if (!content)
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );

  const kindLabel = envKindLabel(content.kind, content.profile);
  const group = (profiles.data ?? []).find((g) => g.dir === content.dir);
  const switchable = content.kind === 'main' && group && group.profiles.length > 0 ? group.profiles : [];
  const siblings = (files.data ?? []).filter((f) => f.path !== content.path);

  const pickProfile = async (path: string) => {
    const target = siblings.find((f) => f.path === path);
    if (!target) return;
    await useEnvProfile(target);
  };

  return (
    <div className="flex flex-col h-full min-h-0" onKeyDown={onKeyDown} data-testid="env-file-tab">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-edge shrink-0 min-w-0">
        <span className="font-mono font-medium text-sm truncate" title={content.path}>
          {content.dir && <span className="text-muted">{content.dir}/</span>}
          {content.name}
        </span>
        {kindLabel && <Badge>{kindLabel}</Badge>}
        {content.warning && (
          <span title={WARNING_TITLE[content.warning]} data-testid="env-warning">
            <Badge className={cn(content.warning === 'tracked' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning')}>{content.warning === 'tracked' ? 'committed to git' : 'not gitignored'}</Badge>
          </span>
        )}
        {content.git?.ignored && !content.warning && content.kind !== 'example' && (
          <span title="Covered by .gitignore">
            <Badge>gitignored</Badge>
          </span>
        )}
        <span className="text-xs text-muted shrink-0" data-testid="env-counts">
          {content.keys} keys · {content.secrets} secret · {content.empty} empty
        </span>
        <div className="flex-1 min-w-4" />
        {switchable.length > 0 && (
          <Select value="" onChange={(e) => void pickProfile(e.target.value)} className="h-7 text-xs" title="Copy a profile over this .env" data-testid="env-profile-select">
            <option value="">Switch profile…</option>
            {switchable.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
                {p.active ? ' (active)' : ''}
              </option>
            ))}
          </Select>
        )}
        <Button size="sm" variant="ghost" icon={<Upload className="size-3.5" />} onClick={() => void importIntoEnvironment(content)} title="Copy these keys into a Quiver environment for {{variables}}">
          To environment
        </Button>
        <IconButton label={reveal ? 'Hide secret values' : 'Reveal secret values'} size="sm" onClick={() => setReveal((r) => !r)} data-testid="env-reveal" aria-pressed={reveal}>
          {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </IconButton>
        <IconButton label="Delete file" size="sm" onClick={() => void deleteEnvFile(content)}>
          <Trash2 className="size-3.5" />
        </IconButton>
        {view === 'text' && (
          <Button size="sm" variant={dirty ? 'primary' : 'ghost'} icon={<Save className="size-3.5" />} loading={busy} onClick={() => void save().then((ok) => ok && notify('Saved', 'success'))} title="Ctrl+S" data-testid="env-save">
            Save{dirty ? '*' : ''}
          </Button>
        )}
      </div>
      <Segmented<FileView>
        value={view}
        onChange={setView}
        className="shrink-0 px-1"
        options={[
          { value: 'keys', label: `Keys (${content.keys})` },
          { value: 'text', label: dirty ? 'Text*' : 'Text' },
          { value: 'compare', label: 'Compare' },
          { value: 'history', label: 'History' },
        ]}
      />
      <div className="flex-1 min-h-0">
        {view === 'keys' && <KeysView content={content} reveal={reveal} onChanged={load} />}
        {view === 'text' && (
          <div className="flex flex-col h-full min-h-0">
            {!reveal && content.secrets > 0 ? (
              <div className="flex-1 min-h-0 relative" data-testid="env-text-masked">
                <CodeEditor value={maskedText(content)} readOnly fill language="text" />
                <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 px-3 py-2 border-t border-edge bg-surface text-xs text-muted">
                  Secret values are hidden. Reveal them to edit the raw text.
                  <Button size="sm" variant="secondary" icon={<Eye className="size-3.5" />} onClick={() => setReveal(true)}>
                    Reveal
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex-1 min-h-0" data-testid="env-text">
                <CodeEditor value={draft} onChange={setDraft} fill language="text" onRun={() => void save()} />
              </div>
            )}
            {savedText !== content.text && <div className="px-3 py-1 text-[11px] text-warning border-t border-edge">The file changed on disk since you started editing.</div>}
          </div>
        )}
        {view === 'compare' && <CompareView content={content} files={siblings} onChanged={load} />}
        {view === 'history' && <HistoryView content={content} onChanged={load} />}
      </div>
    </div>
  );
}

/** The raw text with secret values replaced, computed from the parsed entries so the view matches what the Keys table hides. */
function maskedText(content: EnvFileContent): string {
  let text = content.text;
  const lines = text.split(/\r?\n/);
  for (const e of content.entries) {
    if (!e.secret || !e.value) continue;
    const index = e.line - 1;
    if (index < 0 || index >= lines.length) continue;
    const eq = lines[index].indexOf('=');
    if (eq < 0) continue;
    const tail = lines[index].slice(eq + 1);
    const comment = e.comment ? ` # ${e.comment}` : '';
    lines[index] = `${lines[index].slice(0, eq + 1)}${tail.trimStart().startsWith('"') || tail.trimStart().startsWith("'") ? '"••••••••"' : '••••••••'}${comment}`;
    // A quoted value spanning several lines collapses to one masked line.
    const span = e.value.split('\n').length - 1;
    if (span > 0 && e.quote) lines.splice(index + 1, span);
  }
  text = lines.join(content.eol);
  return text;
}
