import { envKindLabel, type EnvFileSummary, type EnvProfileGroup } from '@quiver/core';
import { Button, IconButton, SectionHeader, Spinner, cn, useInvoke } from '@quiver/ui';
import { File, FileKey, FileLock2, FileSliders, FileText, Plus, RefreshCw, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react';
import { createEnvFile, deleteEnvFile, openFileTab } from './index';

const KIND_ICON: Record<EnvFileSummary['kind'], LucideIcon> = {
  main: FileKey,
  example: FileText,
  local: FileLock2,
  profile: FileSliders,
  other: File,
};

export const WARNING_TITLE: Record<NonNullable<EnvFileSummary['warning']>, string> = {
  tracked: 'Committed to git with its values',
  unignored: 'Not covered by .gitignore: the next `git add .` commits it',
};

export function EnvSidebar() {
  const files = useInvoke<EnvFileSummary[]>('env.file.list', {}, { refreshOnEvents: ['env.changed'] });
  const profiles = useInvoke<EnvProfileGroup[]>('env.profile.list', {}, { refreshOnEvents: ['env.changed'] });
  const list = files.data ?? [];
  const groups = new Map<string, EnvFileSummary[]>();
  for (const f of list) groups.set(f.dir, [...(groups.get(f.dir) ?? []), f]);
  const active = new Set((profiles.data ?? []).flatMap((g) => g.profiles.filter((p) => p.active).map((p) => p.path)));
  const rootExample = list.find((f) => f.dir === '' && f.kind === 'example');
  const rootMain = list.some((f) => f.dir === '' && f.kind === 'main');

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto text-sm">
      <SectionHeader
        title="Env files"
        actions={
          <>
            <IconButton label="Rescan the project" size="sm" onClick={() => void files.refresh()}>
              <RefreshCw className="size-3.5" />
            </IconButton>
            <IconButton label="New env file" size="sm" onClick={() => void createEnvFile()}>
              <Plus className="size-3.5" />
            </IconButton>
          </>
        }
      />
      {files.loading && !files.data && (
        <div className="px-3 py-2">
          <Spinner />
        </div>
      )}
      {[...groups.entries()].map(([dir, items]) => (
        <div key={dir || '.'}>
          {dir && <div className="px-3 pt-2 pb-0.5 text-[11px] text-muted font-mono truncate" title={dir}>{dir}/</div>}
          {items.map((file) => (
            <FileRow key={file.path} file={file} active={active.has(file.path)} />
          ))}
        </div>
      ))}
      {files.data && !rootMain && rootExample && (
        <div className="px-3 py-2">
          <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => void createEnvFile(rootExample.path, '.env')} data-testid="env-create-from-example">
            Create .env from {rootExample.name}
          </Button>
        </div>
      )}
      {files.data?.length === 0 && (
        <div className="px-3 py-2 flex flex-col gap-2">
          <p className="text-xs text-muted">No dotenv files in this project yet. Files are found up to four folders deep; node_modules and build output are skipped.</p>
          <div>
            <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => void createEnvFile()}>
              Create .env
            </Button>
          </div>
        </div>
      )}
      {files.error && <p className="px-3 py-2 text-xs text-danger">{files.error.message}</p>}
    </div>
  );
}

function FileRow({ file, active }: { file: EnvFileSummary; active: boolean }) {
  const Icon = KIND_ICON[file.kind];
  const label = envKindLabel(file.kind, file.profile);
  const open = () => openFileTab(file);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
      className="group flex items-center gap-1.5 pl-3 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0"
      title={`${file.path} · ${file.keys} keys${file.warning ? ` · ${WARNING_TITLE[file.warning]}` : ''}`}
      data-testid="env-file"
      data-path={file.path}
      data-kind={file.kind}
      data-warning={file.warning ?? ''}
    >
      <Icon className={cn('size-3.5 shrink-0', file.kind === 'main' ? 'text-accent' : 'text-muted')} />
      <span className="truncate text-[13px] font-mono">{file.name}</span>
      {label && <span className="text-[10px] text-muted shrink-0 truncate">{label}</span>}
      {active && (
        <span className="text-[10px] rounded-full bg-success/15 text-success px-1.5 shrink-0" title={`.env currently has this profile's content`}>
          active
        </span>
      )}
      <span className="flex-1" />
      {file.warning && <TriangleAlert className={cn('size-3.5 shrink-0', file.warning === 'tracked' ? 'text-danger' : 'text-warning')} aria-label={WARNING_TITLE[file.warning]} />}
      <span className="text-[10px] rounded-full bg-elevated px-1.5 text-muted shrink-0 group-hover:hidden" title={`${file.keys} keys, ${file.secrets} secret-looking, ${file.empty} empty`}>
        {file.keys}
      </span>
      <span className="hidden group-hover:flex items-center">
        <IconButton label="Delete file" size="sm" onClick={(e) => stop(e, () => deleteEnvFile(file))}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </span>
    </div>
  );
}

function stop(e: React.MouseEvent, fn: () => unknown) {
  e.stopPropagation();
  void fn();
}
