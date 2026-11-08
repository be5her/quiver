import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EnvBackup, EnvDiff, EnvFileContent, EnvFileSummary, EnvProfileGroup, Environment } from '@quiver/core';
import { definePart, until } from '../part';

export default definePart({
  name: 'env',
  summary: 'Env files: discovery, parsing, masking, edits, compare, profiles, backups, agents over MCP, the UI',
  async run(t) {
    const { host, check, run, ws, folder, hooksFolder, env, rpc, toolNames: names } = t;

    // ---------- Env files: discovery, parsing, masking, editing, compare, profiles, backups, Quiver environments ----------
    const envRoot = folder;
    const envOriginal = ['# App', 'APP_NAME=smoke', 'PORT=3000', 'DB_PASSWORD="p@ss word" # keep', "API_TOKEN='tok_123'", 'DATABASE_URL=postgres://app:secret@db/app', 'EMPTY=', 'MULTI="line one', 'line two"', 'PORT=3001', ''].join('\n');
    await fs.writeFile(path.join(envRoot, '.env'), envOriginal);
    await fs.writeFile(path.join(envRoot, '.env.example'), ['APP_NAME=', 'PORT=3000', 'DB_PASSWORD=', 'API_TOKEN=', 'DATABASE_URL=', 'FEATURE_FLAG=false # new in the example', 'NEW_KEY=hello', ''].join('\n'));
    await fs.writeFile(path.join(envRoot, '.env.staging'), 'APP_NAME=smoke-staging\nPORT=4000\n');
    await fs.writeFile(path.join(envRoot, '.env.local'), 'LOCAL_ONLY=1\n');
    await fs.mkdir(path.join(envRoot, 'apps', 'web'), { recursive: true });
    await fs.writeFile(path.join(envRoot, 'apps', 'web', '.env'), 'VITE_API=http://localhost\r\n');
    await fs.mkdir(path.join(envRoot, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(envRoot, 'node_modules', 'pkg', '.env'), 'IGNORED=1\n');
    await fs.writeFile(path.join(envRoot, 'docker.env'), 'COMPOSE_PROJECT=smoke\n');
    // A repository where .env is committed (the mistake the warning exists for) and .env.local is ignored.
    const gitConfig = path.join(hooksFolder, 'gitconfig');
    await fs.writeFile(gitConfig, '[user]\n\tname = smoke\n\temail = smoke@example.com\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n\thooksPath = /dev/null\n');
    const git = async (...args: string[]) => {
      try {
        await promisify(execFile)('git', args, { cwd: envRoot, windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' } });
        return true;
      } catch {
        return false;
      }
    };
    await fs.writeFile(path.join(envRoot, '.gitignore'), '.env.local\n.env.*.local\nnode_modules/\n.quiver/local/\n');
    const hasGit = (await git('init', '-q')) && (await git('add', '.env', '.gitignore')) && (await git('commit', '-q', '-m', 'init'));
    console.log(`env files: git ${hasGit ? 'available, .env committed' : 'not available, git checks skipped'}`);

    const envFiles = await run<EnvFileSummary[]>('env.file.list', {}, ws.id);
    check('env files: finds dotenv files up to four folders deep, ordered by kind, skipping node_modules', envFiles.map((f) => f.path).join() === '.env,.env.local,.env.staging,.env.example,docker.env,apps/web/.env', envFiles.map((f) => f.path));
    const envMain = envFiles.find((f) => f.path === '.env')!;
    check('env files: summary counts effective keys, secrets and empties', envMain.kind === 'main' && envMain.keys === 7 && envMain.secrets === 3 && envMain.empty === 1 && envMain.invalid === 0, { keys: envMain.keys, secrets: envMain.secrets, empty: envMain.empty });
    const envOf = (p: string) => envFiles.find((f) => f.path === p);
    check('env files: kinds and profile names', envOf('.env.staging')?.profile === 'staging' && envOf('.env.staging')?.kind === 'profile' && envOf('.env.example')?.kind === 'example' && envOf('.env.local')?.kind === 'local' && envOf('docker.env')?.kind === 'other', envFiles.map((f) => [f.path, f.kind, f.profile]));
    if (hasGit) {
      check(
        'env files: git status flags the committed .env and the unignored profile, not the ignored local file or the example',
        envMain.warning === 'tracked' && envOf('.env.local')?.warning === null && envOf('.env.local')?.git?.ignored === true && envOf('.env.staging')?.warning === 'unignored' && envOf('.env.example')?.warning === null,
        envFiles.map((f) => [f.path, f.git, f.warning]),
      );
    }
    const envRead = await run<EnvFileContent>('env.file.read', { path: '.env' }, ws.id);
    const envEntry = (key: string) => envRead.entries.find((e) => e.key === key && !e.shadowed);
    check(
      'env files: read parses quotes, escapes, comments, multiline values and duplicates',
      envEntry('DB_PASSWORD')?.value === 'p@ss word' && envEntry('DB_PASSWORD')?.comment === 'keep' && envEntry('DB_PASSWORD')?.quote === '"' && envEntry('API_TOKEN')?.value === 'tok_123' && envEntry('MULTI')?.value === 'line one\nline two' && envEntry('PORT')?.value === '3001' && envRead.entries.filter((e) => e.key === 'PORT')[0].shadowed === true && envRead.masked === false,
      envRead.entries.map((e) => [e.key, e.value, e.shadowed]),
    );
    check('env files: secrets detected by key and by credentials in a URL', envEntry('DB_PASSWORD')?.secret === true && envEntry('API_TOKEN')?.secret === true && envEntry('DATABASE_URL')?.secret === true && envEntry('APP_NAME')?.secret === false);
    const agentRead = await host.invoke('env.file.read', { path: '.env' }, { caller: 'mcp', workspaceId: ws.id });
    const agentContent = agentRead.ok ? (agentRead.result as EnvFileContent) : null;
    check(
      'env files: agents get secret values masked in the entries and in the text',
      agentContent?.masked === true && agentContent.entries.find((e) => e.key === 'DB_PASSWORD')?.value === '••••••••' && agentContent.text.includes('DB_PASSWORD="••••••••" # keep') && agentContent.text.includes('APP_NAME=smoke') && !agentContent.text.includes('tok_123') && !agentContent.text.includes('app:secret@'),
      agentContent?.text.split('\n').slice(0, 6),
    );
    const agentReveal = await host.invoke('env.file.read', { path: '.env', reveal: true }, { caller: 'mcp', workspaceId: ws.id });
    check('env files: reveal is gated for agents like a mutation', !agentReveal.ok && agentReveal.error.code === 'MUTATION_BLOCKED', agentReveal.ok ? 'ok?' : agentReveal.error.code);
    const afterSet = await run<EnvFileSummary & { set: string[] }>('env.file.set', { path: '.env', entries: [{ key: 'DB_PASSWORD', value: 'new pass' }, { key: 'ADDED', value: 'x y', comment: 'added by smoke' }] }, ws.id);
    const setText = await fs.readFile(path.join(envRoot, '.env'), 'utf8');
    check(
      'env files: set rewrites the effective line in place, keeps everything else and appends new keys',
      afterSet.keys === 8 && setText.includes('DB_PASSWORD="new pass" # keep') && setText.startsWith('# App\n') && setText.endsWith('ADDED="x y" # added by smoke\n') && setText.includes('MULTI="line one\nline two"') && setText.split('\n').filter((l) => l.startsWith('PORT=')).length === 2,
      setText,
    );
    const badKey = await host.invoke('env.file.set', { path: '.env', entries: [{ key: 'bad key', value: '1' }] }, { caller: 'ui', workspaceId: ws.id });
    const outsideEnv = await host.invoke('env.file.read', { path: '../.env' }, { caller: 'ui', workspaceId: ws.id });
    const notEnv = await host.invoke('env.file.write', { path: 'package.json', text: '{}' }, { caller: 'ui', workspaceId: ws.id });
    check(
      'env files: invalid keys, paths outside the project and files not named like env files are refused',
      !badKey.ok && badKey.error.code === 'INVALID_INPUT' && !outsideEnv.ok && outsideEnv.error.code === 'INVALID_INPUT' && !notEnv.ok && notEnv.error.code === 'INVALID_INPUT',
      [badKey.ok ? 'ok?' : badKey.error.message, outsideEnv.ok ? 'ok?' : outsideEnv.error.message, notEnv.ok ? 'ok?' : notEnv.error.message],
    );
    const afterUnset = await run<EnvFileSummary & { removed: string[] }>('env.file.unset', { path: '.env', keys: ['PORT', 'NOPE'] }, ws.id);
    check('env files: unset removes every occurrence of a key', afterUnset.removed.join() === 'PORT' && afterUnset.keys === 7 && !(await fs.readFile(path.join(envRoot, '.env'), 'utf8')).includes('PORT='), afterUnset.removed);
    const envDiff = await run<EnvDiff>('env.file.diff', { path: '.env', against: '.env.example' }, ws.id);
    check(
      'env files: diff against the example lists missing, extra, empty and different keys',
      envDiff.missing.join() === 'PORT,FEATURE_FLAG,NEW_KEY' && envDiff.extra.join() === 'EMPTY,MULTI,ADDED' && envDiff.empty.length === 0 && envDiff.different.includes('APP_NAME') && envDiff.same.length === 0,
      envDiff,
    );
    const synced = await run<{ added: string[] }>('env.file.sync', { path: '.env', from: '.env.example', keys: ['FEATURE_FLAG', 'NEW_KEY'] }, ws.id);
    const syncedText = await fs.readFile(path.join(envRoot, '.env'), 'utf8');
    check(
      'env files: sync appends the chosen missing keys with the example values under a source comment',
      synced.added.join() === 'FEATURE_FLAG,NEW_KEY' && syncedText.includes('\n# Added from .env.example\nFEATURE_FLAG=false # new in the example\nNEW_KEY=hello\n'),
      syncedText.split('\n').slice(-4),
    );
    const envBackups = await run<EnvBackup[]>('env.backup.list', { path: '.env' }, ws.id);
    check('env files: every change kept a backup naming its cause, newest first', envBackups.length === 3 && envBackups[0].reason.startsWith('added FEATURE_FLAG') && envBackups[1].reason === 'removed PORT' && envBackups[2].reason === 'set DB_PASSWORD, ADDED', envBackups.map((b) => b.reason));
    await run('env.file.write', { path: '.env', text: 'APP_NAME=rewritten\n' }, ws.id);
    const restored = await run<EnvFileSummary>('env.backup.restore', { path: '.env', id: envBackups[2].id }, ws.id);
    check(
      'env files: restoring a backup brings the old text back and keeps the current one as a backup',
      (await fs.readFile(path.join(envRoot, '.env'), 'utf8')) === envOriginal && restored.keys === 7 && (await run<EnvBackup[]>('env.backup.list', { path: '.env' }, ws.id)).length === 5,
      restored.keys,
    );
    const envGroups = await run<EnvProfileGroup[]>('env.profile.list', {}, ws.id);
    check('env files: profiles grouped per folder, none active', envGroups.length === 1 && envGroups[0].dir === '' && envGroups[0].main === '.env' && envGroups[0].profiles.map((p) => p.name).join() === 'staging' && envGroups[0].profiles[0].active === false, envGroups);
    const switched = await run<{ main: EnvFileSummary; from: string; backup: EnvBackup | null }>('env.profile.use', { path: '.env.staging' }, ws.id);
    const envGroupsAfter = await run<EnvProfileGroup[]>('env.profile.list', {}, ws.id);
    check(
      'env files: switching a profile copies it over .env, backs the old one up and marks it active',
      switched.from === '.env.staging' && switched.backup !== null && (await fs.readFile(path.join(envRoot, '.env'), 'utf8')) === 'APP_NAME=smoke-staging\nPORT=4000\n' && envGroupsAfter[0].profiles[0].active === true,
      { from: switched.from, backup: switched.backup?.reason, active: envGroupsAfter[0].profiles[0].active },
    );
    const mainAsProfile = await host.invoke('env.profile.use', { path: '.env' }, { caller: 'ui', workspaceId: ws.id });
    check('env files: .env itself cannot be used as a profile', !mainAsProfile.ok && mainAsProfile.error.code === 'INVALID_INPUT');
    await run('env.backup.restore', { path: '.env', id: switched.backup!.id }, ws.id);
    type ImportOutcome = { environment: Environment; created: boolean; added: number; updated: number };
    const envImported = await run<ImportOutcome>('env.file.import', { path: '.env', name: 'from dotenv' }, ws.id);
    const envImportedVar = (key: string) => envImported.environment.variables.find((v) => v.key === key);
    check(
      'env files: import creates an environment, flagging secret-looking keys as secrets',
      envImported.created && envImported.added === 7 && envImported.updated === 0 && envImportedVar('DB_PASSWORD')?.secret === true && envImportedVar('DB_PASSWORD')?.value === 'p@ss word' && envImportedVar('DATABASE_URL')?.secret === true && envImportedVar('APP_NAME')?.secret === false && envImportedVar('PORT')?.value === '3001',
      envImported.environment.variables.map((v) => [v.key, v.secret]),
    );
    const envImportedFile = JSON.parse(await fs.readFile(path.join(envRoot, '.quiver', 'environments', `${envImported.environment.id}.json`), 'utf8')) as Environment;
    check('env files: the committed environment file carries no secret value', envImportedFile.variables.find((v) => v.key === 'DB_PASSWORD')?.value === '' && envImportedFile.variables.find((v) => v.key === 'APP_NAME')?.value === 'smoke');
    const envReimported = await run<ImportOutcome>('env.file.import', { path: '.env.staging', name: 'From Dotenv' }, ws.id);
    check(
      'env files: re-import into the same environment (name case-insensitive) updates without duplicating',
      !envReimported.created && envReimported.updated === 2 && envReimported.added === 0 && envReimported.environment.variables.length === 7 && envReimported.environment.variables.find((v) => v.key === 'PORT')?.value === '4000' && envReimported.environment.id === envImported.environment.id,
      { created: envReimported.created, updated: envReimported.updated, added: envReimported.added },
    );
    const agentImport = await host.invoke('env.file.import', { path: '.env', environmentId: envImported.environment.id }, { caller: 'mcp', workspaceId: ws.id });
    check('env files: agents get the imported environment with secrets masked', agentImport.ok && (agentImport.result as ImportOutcome).environment.variables.find((v) => v.key === 'DB_PASSWORD')?.value === '••••••••', agentImport.ok ? 'ok' : agentImport.error.message);
    const exported = await run<{ file: EnvFileSummary; exported: number }>('env.file.export', { environmentId: envImported.environment.id, path: 'exported.env' }, ws.id);
    const exportedText = await fs.readFile(path.join(envRoot, 'exported.env'), 'utf8');
    check(
      'env files: export writes a new file with a header and every enabled variable, secrets included',
      exported.exported === 7 && exported.file.kind === 'other' && exportedText.startsWith('# Exported from the Quiver environment "from dotenv"\n') && exportedText.includes('DB_PASSWORD="p@ss word"') && exportedText.includes('PORT=3001') && exportedText.includes('MULTI="line one\\nline two"'),
      exportedText,
    );
    await run('env.file.export', { environmentId: envImported.environment.id, path: '.env.example', includeSecrets: false }, ws.id);
    const exampleText = await fs.readFile(path.join(envRoot, '.env.example'), 'utf8');
    check(
      'env files: exporting into an existing file updates keys in place, appends the rest and can leave secrets empty',
      exampleText.includes('APP_NAME=smoke\nPORT=3001\nDB_PASSWORD=\nAPI_TOKEN=\nDATABASE_URL=\nFEATURE_FLAG=false # new in the example\nNEW_KEY=hello\n') && exampleText.endsWith('EMPTY=\nMULTI="line one\\nline two"\n'),
      exampleText,
    );
    const createdEnv = await run<EnvFileSummary>('env.file.create', { path: 'apps/web/.env.example', from: 'apps/web/.env', values: 'clear' }, ws.id);
    check('env files: create from another file can clear the values and keeps its line endings', createdEnv.path === 'apps/web/.env.example' && createdEnv.kind === 'example' && (await fs.readFile(path.join(envRoot, 'apps', 'web', '.env.example'), 'utf8')) === 'VITE_API=\r\n', createdEnv.path);
    const dupCreate = await host.invoke('env.file.create', { path: 'apps/web/.env.example' }, { caller: 'ui', workspaceId: ws.id });
    check('env files: create refuses to overwrite', !dupCreate.ok && dupCreate.error.code === 'INVALID_INPUT', dupCreate.ok ? 'ok?' : dupCreate.error.message);
    const deletedEnv = await run<{ deleted: boolean; backup: EnvBackup | null }>('env.file.delete', { path: 'exported.env' }, ws.id);
    check('env files: delete removes the file and keeps its content as a backup', deletedEnv.deleted && deletedEnv.backup?.reason === 'deleted' && (await fs.stat(path.join(envRoot, 'exported.env')).catch(() => null)) === null);
    const revived = await run<EnvFileSummary>('env.backup.restore', { path: 'exported.env', id: deletedEnv.backup!.id }, ws.id);
    check('env files: a deleted file comes back from its backup', revived.keys === 7 && (await fs.readFile(path.join(envRoot, 'exported.env'), 'utf8')) === exportedText);
    await run('env.file.delete', { path: 'exported.env' }, ws.id);

    // Env files over MCP: tools listed, secrets masked, writes gated.
    check(
      'mcp lists env tools',
      ['env_file_list', 'env_file_read', 'env_file_set', 'env_file_diff', 'env_file_sync', 'env_profile_list', 'env_profile_use', 'env_backup_list', 'env_file_import', 'env_file_export'].every((n) => names.includes(n)),
      names.filter((n) => n.startsWith('env_')),
    );
    const agentEnv = await rpc('tools/call', { name: 'env_file_read', arguments: { path: '.env' } });
    const agentEnvText = agentEnv.result?.content?.[0]?.text ?? '';
    check('mcp masks env secrets for agents', agentEnv.result?.isError !== true && agentEnvText.includes('••••••••') && agentEnvText.includes('APP_NAME') && !agentEnvText.includes('p@ss word') && !agentEnvText.includes('tok_123'), agentEnvText.slice(0, 160));
    for (const [tool, args] of [
      ['env_file_read', { path: '.env', reveal: true }],
      ['env_file_set', { path: '.env', entries: [{ key: 'X', value: '1' }] }],
      ['env_file_write', { path: '.env', text: '' }],
      ['env_file_unset', { path: '.env', keys: ['APP_NAME'] }],
      ['env_file_create', { path: '.env.new' }],
      ['env_file_delete', { path: '.env' }],
      ['env_file_sync', { path: '.env', from: '.env.example' }],
      ['env_profile_use', { path: '.env.staging' }],
      ['env_backup_restore', { path: '.env', id: 'x' }],
      ['env_file_export', { path: '.env', environmentId: envImported.environment.id }],
    ] as const) {
      const blockedEnv = await rpc('tools/call', { name: tool, arguments: args });
      check(`mcp blocks ${tool} by default`, blockedEnv.result?.isError === true && (blockedEnv.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }
    check('env files: .env untouched by the blocked calls', (await fs.readFile(path.join(envRoot, '.env'), 'utf8')) === envOriginal);

    return {
      ui: async (u) => {
        const { js, wait, shot } = u;
        // Env files: sidebar rows with kinds and git warnings, masked values, reveal, inline edits, the watcher, compare view.
        const clickedEnvModule = await js(
          `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Env files'); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: env files module button', clickedEnvModule === true);
        // The list waits on git status for every file; give it time rather than a fixed pause.
        await until(async () => Number(await js(`document.querySelectorAll('[data-testid=env-file]').length`)) >= 7, 10_000);
        const envRows = await js(`[...document.querySelectorAll('[data-testid=env-file]')].map((r) => [r.getAttribute('data-path'), r.getAttribute('data-kind'), r.getAttribute('data-warning')])`);
        check(
          'ui: env file rows show every file with its kind and git warning',
          Array.isArray(envRows) &&
            envRows.length === 7 &&
            envRows.some((r: string[]) => r[0] === '.env' && r[1] === 'main' && (!hasGit || r[2] === 'tracked')) &&
            envRows.some((r: string[]) => r[0] === '.env.staging' && r[1] === 'profile') &&
            envRows.some((r: string[]) => r[0] === 'apps/web/.env.example' && r[1] === 'example'),
          envRows,
        );
        const clickedEnvRow = await js(`(() => { const row = document.querySelector('[data-testid=env-file][data-path=".env"]'); if (row) row.click(); return Boolean(row); })()`);
        await wait(1200);
        const envValueRows = await js(`[...document.querySelectorAll('[data-testid=env-entry]')].map((r) => r.getAttribute('data-key') + ':' + r.getAttribute('data-masked') + ':' + r.querySelector('[data-testid=env-value]').textContent)`);
        check(
          'ui: secret-looking values are masked, the others shown',
          clickedEnvRow === true && Array.isArray(envValueRows) && envValueRows.includes('DB_PASSWORD:true:••••••••') && envValueRows.includes('API_TOKEN:true:••••••••') && envValueRows.includes('APP_NAME:false:smoke') && envValueRows.includes('EMPTY:false:(empty)'),
          envValueRows,
        );
        const envHeader = await js(`(document.querySelector('[data-testid=env-counts]')?.textContent ?? '') + '|' + (document.querySelector('[data-testid=env-warning]')?.textContent ?? '')`);
        check('ui: tab header shows counts and the git warning', typeof envHeader === 'string' && envHeader.startsWith('7 keys · 3 secret · 1 empty') && (!hasGit || envHeader.endsWith('committed to git')), envHeader);
        await shot('22-env-keys-light');
        const clickedReveal = await js(`(() => { const btn = document.querySelector('[data-testid=env-reveal]'); if (btn) btn.click(); return Boolean(btn); })()`);
        await wait(300);
        const revealedRows = await js(`[...document.querySelectorAll('[data-testid=env-entry]')].map((r) => r.getAttribute('data-key') + ':' + r.querySelector('[data-testid=env-value]').textContent)`);
        check('ui: reveal shows the real values', clickedReveal === true && Array.isArray(revealedRows) && revealedRows.includes('DB_PASSWORD:p@ss word') && revealedRows.includes('API_TOKEN:tok_123'), revealedRows);
        const startedEdit = await js(`(() => { const row = document.querySelector('[data-testid=env-entry][data-key="APP_NAME"]'); const btn = row && row.querySelector('[data-testid=env-value]'); if (btn) btn.click(); return Boolean(btn); })()`);
        await wait(300);
        const typedValue = await js(
          `(() => { const input = document.querySelector('[data-testid=env-value-input]'); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'edited-in-ui'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
        );
        await wait(100);
        const clickedValueSave = await js(`(() => { const btn = document.querySelector('[data-testid=env-value-save]'); if (btn) btn.click(); return Boolean(btn); })()`);
        await wait(1200);
        const editedOnDisk = await fs.readFile(path.join(envRoot, '.env'), 'utf8');
        check(
          'ui: editing a value inline rewrites that line only',
          startedEdit === true && typedValue === true && clickedValueSave === true && editedOnDisk.includes('APP_NAME=edited-in-ui') && editedOnDisk.includes('DB_PASSWORD="p@ss word" # keep') && editedOnDisk.startsWith('# App\n'),
          editedOnDisk.split('\n').slice(0, 3),
        );
        const typedNewKey = await js(
          `(() => { const k = document.querySelector('[data-testid=env-add-key]'); const v = document.querySelector('[data-testid=env-add-value]'); if (!k || !v) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(k, 'FROM_UI'); k.dispatchEvent(new Event('input', { bubbles: true })); setter.call(v, 'yes'); v.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
        );
        await wait(200);
        const clickedAddKey = await js(`(() => { const btn = document.querySelector('[data-testid=env-add]'); if (btn && !btn.disabled) { btn.click(); return true; } return false; })()`);
        await wait(1200);
        check('ui: adding a key appends it to the file', typedNewKey === true && clickedAddKey === true && (await fs.readFile(path.join(envRoot, '.env'), 'utf8')).endsWith('FROM_UI=yes\n'));
        await fs.appendFile(path.join(envRoot, '.env'), 'FROM_DISK=1\n');
        await wait(2000);
        const watched = await js(`[...document.querySelectorAll('[data-testid=env-entry]')].some((r) => r.getAttribute('data-key') === 'FROM_DISK')`);
        check('ui: a change made on disk shows up on its own', watched === true);
        const clickedCompare = await js(
          `(() => { const pane = [...document.querySelectorAll('[data-tab-type="env.file"]')].find((el) => !el.classList.contains('hidden')); const btn = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Compare')); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        // The diff loads after the tab shows, and again on each env.changed: on a busy machine it takes more than a moment.
        await until(async () => Boolean(await js(`document.querySelectorAll('[data-testid=env-compare-missing] li').length > 0`)), 6000);
        const compareAgainst = await js(`document.querySelector('[data-testid=env-compare-select]')?.value ?? ''`);
        const missingKeys = await js(`[...document.querySelectorAll('[data-testid=env-compare-missing] li')].map((li) => li.textContent.replace(/Add$/, '').trim())`);
        check('ui: compare view defaults to the example and lists the missing keys', clickedCompare === true && compareAgainst === '.env.example' && Array.isArray(missingKeys) && missingKeys.join() === 'FEATURE_FLAG,NEW_KEY', { compareAgainst, missingKeys });
        await shot('23-env-compare-light');
        await js(`document.documentElement.classList.add('dark')`);
        await js(
          `(() => { const pane = [...document.querySelectorAll('[data-tab-type="env.file"]')].find((el) => !el.classList.contains('hidden')); const btn = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('Keys')); if (btn) btn.click(); })()`,
        );
        await wait(500);
        await shot('24-env-keys-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(200);

        // Text view: masked while secrets are hidden, the raw text once revealed, saved as a whole; History lists what Quiver kept.
        const clickEnvView = (label: string) =>
          js(
            `(() => { const pane = [...document.querySelectorAll('[data-tab-type="env.file"]')].find((el) => !el.classList.contains('hidden')); const btn = pane && [...pane.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith(${JSON.stringify(label)})); if (btn) btn.click(); return Boolean(btn); })()`,
          );
        const envLabels = () =>
          js(
            `[document.querySelector('[data-testid=env-save]')?.textContent.trim() ?? '', [...document.querySelectorAll('[data-tab-type="env.file"] [role=tab]')].find((b) => b.textContent.startsWith('Text'))?.textContent ?? ''].join('|')`,
          );
        await js(`document.querySelector('[data-testid=env-reveal]')?.click()`);
        await clickEnvView('Text');
        await wait(400);
        const maskedTextView = await js(`document.querySelector('[data-testid=env-text-masked] .cm-content')?.textContent ?? ''`);
        await js(`document.querySelector('[data-testid=env-reveal]')?.click()`);
        await wait(300);
        const envBefore = await fs.readFile(path.join(envRoot, '.env'), 'utf8');
        const typedText = await js(
          `(() => { const content = document.querySelector('[data-testid=env-text] .cm-content'); if (!content) return false; content.focus(); document.execCommand('selectAll'); return document.execCommand('insertText', false, ${JSON.stringify(`${envBefore}FROM_TEXT=1\n`)}); })()`,
        );
        await wait(200);
        const dirtyLabels = await envLabels();
        await js(`document.querySelector('[data-testid=env-save]')?.click()`);
        await wait(1200);
        const envAfter = await fs.readFile(path.join(envRoot, '.env'), 'utf8');
        const savedLabels = await envLabels();
        check(
          'ui: the text view masks secrets until revealed, then edits and saves the whole file',
          typeof maskedTextView === 'string' &&
            maskedTextView.includes('DB_PASSWORD="••••••••" # keep') &&
            !maskedTextView.includes('p@ss word') &&
            typedText === true &&
            dirtyLabels === 'Save*|Text*' &&
            envAfter === `${envBefore}FROM_TEXT=1\n` &&
            savedLabels === 'Save|Text',
          { maskedTextView: String(maskedTextView).slice(0, 120), dirtyLabels, savedLabels, tail: envAfter.split('\n').slice(-3) },
        );
        await clickEnvView('History');
        await wait(800);
        const backupRows = await js(`[...document.querySelectorAll('[data-testid=env-backup]')].map((r) => r.textContent)`);
        check('ui: history lists the backups kept before each change', Array.isArray(backupRows) && backupRows.length >= 3 && backupRows.every((t: string) => t.includes('Restore')), backupRows);
        await clickEnvView('Keys');
        await wait(200);
      },
    };
  },
});
