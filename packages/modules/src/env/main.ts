import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import {
  EnvSetEntrySchema,
  QuiverError,
  appendDotenvComment,
  buildDotenv,
  classifyEnvFile,
  compareEnvFiles,
  defineCommand,
  defineModule,
  diffDotenv,
  dotenvEntries,
  dotenvToMap,
  envPathDir,
  envPathName,
  maskDotenv,
  maskEntries,
  newEnvironment,
  newId,
  parseDotenv,
  removeDotenvKey,
  serializeDotenv,
  setDotenvValue,
  type CommandContext,
  type DotenvDocument,
  type EnvBackup,
  type EnvFileContent,
  type EnvFileSummary,
  type EnvGitStatus,
  type EnvProfileGroup,
  type Environment,
  type HostApi,
  type Variable,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { getEnvironment, listEnvironments, saveEnvironment } from '../api/env';
import { EnvWatcher, backupFile, gitStatus, listBackups, readBackup, resolveEnvPath, scanEnvFiles } from './files';

const watcher = new EnvWatcher();

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

async function readText(abs: string): Promise<{ text: string; stat: Stats } | null> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
    return { text, stat };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new QuiverError('REQUEST_FAILED', `Cannot read ${abs}: ${(err as Error).message}`);
  }
}

function warningOf(kind: EnvFileSummary['kind'], git: EnvGitStatus | null): EnvFileSummary['warning'] {
  if (!git || kind === 'example') return null;
  if (git.tracked) return 'tracked';
  if (!git.ignored) return 'unignored';
  return null;
}

function summarize(rel: string, doc: DotenvDocument, stat: Stats, git: EnvGitStatus | null): EnvFileSummary {
  const name = envPathName(rel);
  const { kind, profile } = classifyEnvFile(name);
  const effective = dotenvEntries(doc).filter((e) => !e.shadowed);
  return {
    path: rel,
    dir: envPathDir(rel),
    name,
    kind,
    profile,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    keys: effective.length,
    secrets: effective.filter((e) => e.secret).length,
    empty: effective.filter((e) => !e.value).length,
    invalid: doc.lines.filter((l) => l.kind === 'invalid').length,
    git,
    warning: warningOf(kind, git),
  };
}

function contentOf(rel: string, text: string, stat: Stats, git: EnvGitStatus | null, mask: boolean): EnvFileContent {
  const doc = parseDotenv(text);
  const entries = dotenvEntries(doc);
  return {
    ...summarize(rel, doc, stat, git),
    text: mask ? serializeDotenv(maskDotenv(doc)) : text,
    entries: mask ? maskEntries(entries) : entries,
    masked: mask,
    eol: doc.eol,
  };
}

async function gitOf(w: WorkspaceApi, rel: string): Promise<EnvGitStatus | null> {
  return (await gitStatus(w.path, [rel]))?.get(rel) ?? null;
}

async function listWithText(w: WorkspaceApi, host: HostApi): Promise<{ summary: EnvFileSummary; text: string }[]> {
  const rels = await scanEnvFiles(w.path);
  const git = await gitStatus(w.path, rels);
  const out: { summary: EnvFileSummary; text: string }[] = [];
  for (const rel of rels) {
    const read = await readText(path.join(w.path, rel)).catch(() => null);
    if (!read) continue;
    out.push({ summary: summarize(rel, parseDotenv(read.text), read.stat, git?.get(rel) ?? null), text: read.text });
  }
  out.sort((a, b) => compareEnvFiles(a.summary, b.summary));
  watcher.sync(w, host, [...new Set(out.map((f) => f.summary.dir))]);
  return out;
}

async function listFiles(w: WorkspaceApi, host: HostApi): Promise<EnvFileSummary[]> {
  return (await listWithText(w, host)).map((f) => f.summary);
}

async function readFile(w: WorkspaceApi, rel: string, mask: boolean): Promise<EnvFileContent> {
  const { abs, rel: clean } = resolveEnvPath(w, rel);
  const read = await readText(abs);
  if (!read) throw new QuiverError('NOT_FOUND', `${clean} does not exist`);
  return contentOf(clean, read.text, read.stat, await gitOf(w, clean), mask);
}

/** Read a file as a document, or start an empty one when it does not exist yet. */
async function loadDoc(w: WorkspaceApi, rel: string): Promise<{ abs: string; rel: string; doc: DotenvDocument; text: string | null }> {
  const { abs, rel: clean } = resolveEnvPath(w, rel);
  const read = await readText(abs);
  return { abs, rel: clean, doc: parseDotenv(read?.text ?? ''), text: read?.text ?? null };
}

/** Write a file, keeping a backup of what it held, and tell the UI. */
async function writeText(w: WorkspaceApi, host: HostApi, rel: string, text: string, reason: string): Promise<{ file: EnvFileSummary; backup: EnvBackup | null }> {
  const { abs, rel: clean } = resolveEnvPath(w, rel);
  const existing = await readText(abs);
  const backup = existing && existing.text !== text ? await backupFile(w, clean, existing.text, reason) : null;
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
  const stat = await fs.stat(abs);
  const file = summarize(clean, parseDotenv(text), stat, await gitOf(w, clean));
  watcher.sync(w, host, [file.dir], { prune: false });
  host.emit('env.changed', { workspaceId: w.id, reason: 'files', path: clean });
  return { file, backup };
}

function applySet(doc: DotenvDocument, key: string, value: string, comment: string | null | undefined): DotenvDocument {
  try {
    return setDotenvValue(doc, key, value, { comment: comment === undefined ? undefined : comment || null });
  } catch (err) {
    throw new QuiverError('INVALID_INPUT', (err as Error).message);
  }
}

const PathInput = z.object({ path: z.string().describe('Project-relative path of the env file, e.g. `.env` or `apps/web/.env.local`') });

// ---------- files ----------

const fileList = defineCommand({
  id: 'env.file.list',
  title: 'List env files',
  description:
    'Finds the dotenv files of the project (`.env`, `.env.<name>`, `<name>.env`, up to four folders deep, skipping node_modules and build output) with their kind (main, example, local, profile), key counts and git status. `warning` is `tracked` when a file with real values is committed and `unignored` when it is not covered by .gitignore.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx) => listFiles(ws(ctx), ctx.host),
});

const fileRead = defineCommand({
  id: 'env.file.read',
  title: 'Read env file',
  description:
    'Returns the text and the parsed entries of an env file: key, value, line, quoting, trailing comment, whether the key looks like a secret, whether it is shadowed by a later duplicate, and whether the value references another variable. For agents the values of secret-looking keys are masked unless `reveal` is true, which needs the same switch as mutating commands.',
  scope: 'workspace',
  mutating: ({ reveal }) => reveal === true,
  input: PathInput.extend({ reveal: z.boolean().default(false) }),
  handler: async ({ path: rel, reveal }, ctx) => readFile(ws(ctx), rel, ctx.caller === 'mcp' && !reveal),
});

const fileWrite = defineCommand({
  id: 'env.file.write',
  title: 'Write env file',
  description: 'Replaces the whole text of an env file (created when missing). The previous content is kept as a backup (env.backup.list).',
  scope: 'workspace',
  mutating: true,
  input: PathInput.extend({ text: z.string() }),
  handler: async ({ path: rel, text }, ctx) => (await writeText(ws(ctx), ctx.host, rel, text, 'edited')).file,
});

const fileSet = defineCommand({
  id: 'env.file.set',
  title: 'Set env values',
  description:
    'Sets one or more keys in an env file, rewriting only the lines that carry them (the last occurrence of a duplicated key) and appending the rest; comments, blank lines and the quoting style of untouched lines are kept. Creates the file when missing. `comment` replaces the trailing comment of a line; an empty string drops it.',
  scope: 'workspace',
  mutating: true,
  input: PathInput.extend({ entries: z.array(EnvSetEntrySchema).min(1) }),
  handler: async ({ path: rel, entries }, ctx) => {
    const w = ws(ctx);
    const loaded = await loadDoc(w, rel);
    let doc = loaded.doc;
    for (const e of entries) doc = applySet(doc, e.key, e.value, e.comment);
    const { file } = await writeText(w, ctx.host, loaded.rel, serializeDotenv(doc), `set ${entries.map((e) => e.key).join(', ')}`);
    return { ...file, set: entries.map((e) => e.key) };
  },
});

const fileUnset = defineCommand({
  id: 'env.file.unset',
  title: 'Remove env keys',
  description: 'Removes every line that defines one of the given keys from an env file.',
  scope: 'workspace',
  mutating: true,
  input: PathInput.extend({ keys: z.array(z.string().min(1)).min(1) }),
  handler: async ({ path: rel, keys }, ctx) => {
    const w = ws(ctx);
    const loaded = await loadDoc(w, rel);
    if (loaded.text === null) throw new QuiverError('NOT_FOUND', `${loaded.rel} does not exist`);
    let doc = loaded.doc;
    const removed: string[] = [];
    for (const key of keys) {
      const next = removeDotenvKey(doc, key);
      if (next.removed) removed.push(key);
      doc = next.doc;
    }
    if (!removed.length) return { ...(await readFile(w, loaded.rel, false)), removed };
    const { file } = await writeText(w, ctx.host, loaded.rel, serializeDotenv(doc), `removed ${removed.join(', ')}`);
    return { ...file, removed };
  },
});

const fileCreate = defineCommand({
  id: 'env.file.create',
  title: 'New env file',
  description:
    'Creates an env file, empty or copied from another one (`from`, typically `.env.example`). `values` controls what happens to the copied values: `keep`, `clear` (every value emptied, for making an example from a real file) or `clearSecrets` (only secret-looking keys emptied). Fails when the file exists.',
  scope: 'workspace',
  mutating: true,
  input: PathInput.extend({ from: z.string().optional(), values: z.enum(['keep', 'clear', 'clearSecrets']).default('keep') }),
  handler: async ({ path: rel, from, values }, ctx) => {
    const w = ws(ctx);
    const target = resolveEnvPath(w, rel);
    if (await readText(target.abs)) throw new QuiverError('INVALID_INPUT', `${target.rel} already exists`);
    let text = '';
    if (from) {
      const source = await readFile(w, from, false);
      let doc = parseDotenv(source.text);
      if (values !== 'keep') {
        for (const e of source.entries) if (e.value && (values === 'clear' || e.secret)) doc = setDotenvValue(doc, e.key, '');
      }
      text = serializeDotenv(doc);
    }
    return (await writeText(w, ctx.host, target.rel, text, 'created')).file;
  },
});

const fileDelete = defineCommand({
  id: 'env.file.delete',
  title: 'Delete env file',
  description: 'Deletes an env file. Its content stays available as a backup (env.backup.list, env.backup.restore) until the workspace backups are cleared.',
  scope: 'workspace',
  mutating: true,
  input: PathInput,
  handler: async ({ path: rel }, ctx) => {
    const w = ws(ctx);
    const { abs, rel: clean } = resolveEnvPath(w, rel);
    const existing = await readText(abs);
    if (!existing) throw new QuiverError('NOT_FOUND', `${clean} does not exist`);
    const backup = await backupFile(w, clean, existing.text, 'deleted');
    await fs.unlink(abs);
    ctx.host.emit('env.changed', { workspaceId: w.id, reason: 'files', path: clean });
    return { deleted: true, path: clean, backup };
  },
});

const fileDiff = defineCommand({
  id: 'env.file.diff',
  title: 'Compare env files',
  description:
    'Compares the keys of two env files, e.g. `.env` against `.env.example`: `missing` (in `against` only), `extra` (in `path` only), `empty` (present but empty in `path`), `different` and `same`. Values are not returned.',
  scope: 'workspace',
  input: PathInput.extend({ against: z.string().describe('The file to compare with, e.g. `.env.example`') }),
  handler: async ({ path: rel, against }, ctx) => {
    const w = ws(ctx);
    const a = await readFile(w, rel, false);
    const b = await readFile(w, against, false);
    return diffDotenv(a.path, a.entries, b.path, b.entries);
  },
});

const fileSync = defineCommand({
  id: 'env.file.sync',
  title: 'Add missing keys',
  description:
    'Appends to `path` the keys that `from` defines and `path` lacks, with the values and comments `from` has (placeholders, for an example file), under a comment naming the source. `keys` limits which ones. Creates `path` when missing.',
  scope: 'workspace',
  mutating: true,
  input: PathInput.extend({ from: z.string(), keys: z.array(z.string()).optional() }),
  handler: async ({ path: rel, from, keys }, ctx) => {
    const w = ws(ctx);
    const source = await readFile(w, from, false);
    const loaded = await loadDoc(w, rel);
    const have = dotenvToMap(loaded.doc);
    const wanted = keys ? new Set(keys) : null;
    const missing = source.entries.filter((e) => !e.shadowed && !(e.key in have) && (!wanted || wanted.has(e.key)));
    if (!missing.length) return { path: loaded.rel, from: source.path, added: [] as string[], file: loaded.text === null ? null : await readFile(w, loaded.rel, false) };
    let doc = appendDotenvComment(loaded.doc, `Added from ${source.path}`);
    for (const e of missing) doc = applySet(doc, e.key, e.value, e.comment);
    const { file } = await writeText(w, ctx.host, loaded.rel, serializeDotenv(doc), `added ${missing.map((e) => e.key).join(', ')} from ${source.path}`);
    return { path: loaded.rel, from: source.path, added: missing.map((e) => e.key), file };
  },
});

// ---------- profiles ----------

function sameContent(a: string, b: string): boolean {
  return a.replace(/\r\n/g, '\n').trimEnd() === b.replace(/\r\n/g, '\n').trimEnd();
}

const profileList = defineCommand({
  id: 'env.profile.list',
  title: 'List env profiles',
  description:
    'Profiles are the `.env.<name>` files next to a `.env` (staging, production, ...; example and local files are not profiles). One group per folder that has profiles, with `main` (the folder\'s `.env`, or null) and which profile is active, meaning `.env` has exactly its content.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx): Promise<EnvProfileGroup[]> => {
    const files = await listWithText(ws(ctx), ctx.host);
    const byDir = new Map<string, typeof files>();
    for (const f of files) byDir.set(f.summary.dir, [...(byDir.get(f.summary.dir) ?? []), f]);
    const out: EnvProfileGroup[] = [];
    for (const [dir, group] of byDir) {
      const main = group.find((f) => f.summary.kind === 'main') ?? null;
      const profiles = group.filter((f) => f.summary.kind === 'profile');
      if (!profiles.length) continue;
      out.push({
        dir,
        main: main?.summary.path ?? null,
        profiles: profiles.map((p) => ({ name: p.summary.profile ?? p.summary.name, path: p.summary.path, active: main ? sameContent(main.text, p.text) : false })),
      });
    }
    return out;
  },
});

const profileUse = defineCommand({
  id: 'env.profile.use',
  title: 'Switch env profile',
  description: 'Copies a profile file (or any env file, e.g. `.env.example` to reset) over the `.env` of its folder. The previous `.env` is kept as a backup.',
  scope: 'workspace',
  mutating: true,
  input: PathInput,
  handler: async ({ path: rel }, ctx) => {
    const w = ws(ctx);
    const source = await readFile(w, rel, false);
    if (source.kind === 'main') throw new QuiverError('INVALID_INPUT', `${source.path} is the .env itself`);
    const main = source.dir ? `${source.dir}/.env` : '.env';
    const { file, backup } = await writeText(w, ctx.host, main, source.text, `switched to ${source.name}`);
    return { main: file, from: source.path, backup };
  },
});

// ---------- backups ----------

const backupList = defineCommand({
  id: 'env.backup.list',
  title: 'List env file backups',
  description: 'The last 20 versions Quiver kept of an env file before changing it (newest first), with what caused each one.',
  scope: 'workspace',
  input: PathInput,
  handler: async ({ path: rel }, ctx) => listBackups(ws(ctx), resolveEnvPath(ws(ctx), rel).rel),
});

const backupRestore = defineCommand({
  id: 'env.backup.restore',
  title: 'Restore env file backup',
  description: 'Writes a backup back over the file (the current content becomes a backup itself).',
  scope: 'workspace',
  mutating: true,
  input: PathInput.extend({ id: z.string() }),
  handler: async ({ path: rel, id }, ctx) => {
    const w = ws(ctx);
    const clean = resolveEnvPath(w, rel).rel;
    const text = await readBackup(w, clean, id);
    return (await writeText(w, ctx.host, clean, text, 'restored a backup')).file;
  },
});

// ---------- Quiver environments ----------

function defaultEnvironmentName(file: EnvFileSummary): string {
  const base = file.profile ?? (file.kind === 'local' ? 'local' : file.name);
  return file.dir ? `${file.dir}/${base}` : base;
}

const fileImport = defineCommand({
  id: 'env.file.import',
  title: 'Import env file into an environment',
  description:
    'Copies the keys of an env file into a Quiver environment (used for {{variables}} in requests and connections): the one given by `environmentId`, else the one named `name`, created when missing (named after the profile or file by default). Existing variables with the same key are updated, others kept unless `replace`. `secrets` decides which variables are stored encrypted: `auto` (secret-looking keys), `all` or `none`.',
  scope: 'workspace',
  input: PathInput.extend({
    environmentId: z.string().optional(),
    name: z.string().optional(),
    secrets: z.enum(['auto', 'all', 'none']).default('auto'),
    replace: z.boolean().default(false),
  }),
  handler: async ({ path: rel, environmentId, name, secrets, replace }, ctx) => {
    const w = ws(ctx);
    const file = await readFile(w, rel, false);
    let env: Environment | undefined;
    let created = false;
    if (environmentId) {
      env = await getEnvironment(w, ctx.host, environmentId);
      if (!env) throw new QuiverError('NOT_FOUND', `Environment ${environmentId} not found`);
    } else {
      const wanted = (name ?? defaultEnvironmentName(file)).trim();
      env = (await listEnvironments(w, ctx.host)).find((e) => e.name.toLowerCase() === wanted.toLowerCase());
      if (!env) {
        env = newEnvironment(wanted);
        created = true;
      }
    }
    const variables: Variable[] = replace ? [] : [...env.variables];
    let updated = 0;
    let added = 0;
    for (const e of file.entries) {
      if (e.shadowed) continue;
      const secret = secrets === 'all' ? true : secrets === 'none' ? false : e.secret;
      const index = variables.findIndex((v) => v.key === e.key);
      if (index >= 0) {
        variables[index] = { ...variables[index], value: e.value, secret: variables[index].secret || secret };
        updated++;
      } else {
        variables.push({ id: newId(), key: e.key, value: e.value, enabled: true, secret });
        added++;
      }
    }
    const saved = await saveEnvironment(w, ctx.host, { ...env, variables });
    const environment = ctx.caller === 'mcp' ? await getEnvironment(w, ctx.host, saved.id, true) : saved;
    return { environment, created, added, updated, path: file.path };
  },
});

const fileExport = defineCommand({
  id: 'env.file.export',
  title: 'Export an environment to an env file',
  description:
    'Writes the enabled variables of a Quiver environment into an env file: existing keys are updated in place, new ones appended, other lines kept; a missing file is created with a header. `includeSecrets: false` leaves secret variables empty (for an example file).',
  scope: 'workspace',
  mutating: true,
  input: PathInput.extend({ environmentId: z.string(), includeSecrets: z.boolean().default(true) }),
  handler: async ({ path: rel, environmentId, includeSecrets }, ctx) => {
    const w = ws(ctx);
    const env = await getEnvironment(w, ctx.host, environmentId);
    if (!env) throw new QuiverError('NOT_FOUND', `Environment ${environmentId} not found`);
    const loaded = await loadDoc(w, rel);
    let doc = loaded.text === null ? parseDotenv(buildDotenv([], `Exported from the Quiver environment "${env.name}"`)) : loaded.doc;
    const variables = env.variables.filter((v) => v.enabled && v.key.trim());
    for (const v of variables) doc = applySet(doc, v.key.trim(), includeSecrets || !v.secret ? v.value : '', undefined);
    const { file, backup } = await writeText(w, ctx.host, loaded.rel, serializeDotenv(doc), `exported "${env.name}"`);
    return { file, exported: variables.length, backup };
  },
});

export const envModule = defineModule({
  id: 'env',
  commands: [fileList, fileRead, fileWrite, fileSet, fileUnset, fileCreate, fileDelete, fileDiff, fileSync, profileList, profileUse, backupList, backupRestore, fileImport, fileExport],
  onWorkspaceOpen: async (workspace, host) => {
    await listFiles(workspace, host).catch((err) => console.warn(`[quiver] env files of "${workspace.name}" not scanned: ${(err as Error).message}`));
  },
  onWorkspaceClose: (workspace) => watcher.stop(workspace),
  onStop: () => watcher.stopAll(),
});
