import { Service, inject, signal, untracked } from '@angular/core';
import { toErrorPayload, type GitBranch, type GitCommit, type GitOperationResult, type GitStash, type GitStatus, type GitPullRequest, type GitTag, type TodoItem } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts, type ContextMenuItem } from '@quiver/ui';
import { errorReason, groupChanges, isPushRejected, remotesOf, splitPath, splitRemoteBranch, type DiffSource, type GitLogPage, type GitRemoteResult, type PrFilter } from './git-format';
import { blameKey, blameTitle, type BlameAt } from './git-format';

/** A ref to pick in `pickRef`: a branch or tag name, and how the list shows it. */
interface RefChoice {
  name: string;
  label?: string;
}

type RemoteOp = 'fetch' | 'pull' | 'push';

/** Opens the Git tabs and runs what the panel's buttons and the palette ask for; whatever is hard to take back asks first. */
@Service()
export class GitActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  /** Fetch, pull and push under way, so their buttons spin and are not pressed twice. */
  readonly busy = signal<ReadonlySet<RemoteOp>>(new Set());

  private scope(): string {
    return untracked(this.app.scope);
  }

  // ---- Tabs ----

  /** A diff: of a working or staged file (or all of them), a commit, two refs compared, or a stash. */
  openDiff(source: DiffSource): void {
    const key = JSON.stringify(source);
    const title = source.path
      ? splitPath(source.path).name
      : source.kind === 'commit'
        ? source.ref.slice(0, 7)
        : source.kind === 'compare'
          ? `${source.from} → ${source.to}`
          : source.kind === 'stash'
            ? `stash@{${source.index}}`
            : 'Changes';
    const suffix = source.kind === 'staged' ? ' (staged)' : source.kind === 'working' && source.path ? ' (working)' : '';
    this.tabs.openTab(this.scope(), { type: 'git.diff', title: title + suffix, data: { id: key, source } }, { singletonKey: `git.diff:${key}` });
  }

  openHistory(): void {
    this.tabs.openTab(this.scope(), { type: 'git.history', title: 'History', data: { id: 'history' } }, { singletonKey: 'git.history:history' });
  }

  /** Who last changed each line of a file, at a ref or in the working tree: one tab per path and ref. */
  openBlame(path: string, ref?: string): void {
    const at: BlameAt = { path, ...(ref ? { ref } : {}) };
    this.tabs.openTab(this.scope(), { type: 'git.blame', title: blameTitle(at), data: { id: blameKey(at), ...at } }, { singletonKey: `git.blame:${blameKey(at)}` });
  }

  /** The palette's Blame file: asks for the path. */
  async blameFromPalette(): Promise<void> {
    const path = await this.dialogs.prompt({ title: 'Blame file', label: 'Path, relative to the repository root', placeholder: 'src/index.ts', confirmLabel: 'Blame' });
    if (path?.trim()) this.openBlame(path.trim());
  }

  openBranches(): void {
    this.tabs.openTab(this.scope(), { type: 'git.branches', title: 'Branches', data: { id: 'branches' } }, { singletonKey: 'git.branches:branches' });
  }

  /** The pull request list, on a filter or on the form for a new one. */
  openPullRequests(options: { filter?: PrFilter; view?: 'list' | 'new' } = {}): void {
    const scope = this.scope();
    const tab = this.tabs.openTab(scope, { type: 'git.prs', title: 'Pull requests', data: { id: 'prs', ...options, nonce: Date.now() } }, { singletonKey: 'git.prs:prs' });
    // A filter asks for the list, also when the tab is on the form.
    const asked = { ...options, ...(options.filter && !options.view ? { view: 'list' as const } : {}) };
    if (asked.filter || asked.view) this.tabs.updateTab(scope, tab.id, { data: { ...tab.data, ...asked, nonce: Date.now() } });
  }

  openPullRequest(pr: Pick<GitPullRequest, 'number' | 'title'>): void {
    this.tabs.openTab(this.scope(), { type: 'git.pr', title: `#${pr.number} ${pr.title}`, data: { id: pr.number } }, { singletonKey: `git.pr:${pr.number}` });
  }

  // ---- Index and commits ----

  async stage(paths: string[]): Promise<void> {
    if (!paths.length) return;
    try {
      await this.host.invoke('git.stage', { paths });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async unstage(paths: string[]): Promise<void> {
    if (!paths.length) return;
    try {
      await this.host.invoke('git.unstage', { paths });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Commit what is staged. Amending a commit that is already on the remote asks first: the push after it needs force. */
  async commit(message: string, amend: boolean, status: GitStatus | undefined): Promise<GitCommit | null> {
    if (amend && status?.upstream && status.ahead === 0 && status.head) {
      const ok = await this.dialogs.confirm({
        title: 'Amend a pushed commit?',
        message: `The last commit is already on ${status.upstream}. Amending replaces it, so the branch can then only be pushed with force.`,
        confirmLabel: 'Amend',
        danger: true,
      });
      if (!ok) return null;
    }
    try {
      const commit = await this.host.invoke<GitCommit>('git.commit', { message, amend });
      this.toasts.notify(`${amend ? 'Amended' : 'Committed'} ${commit.shortHash} ${commit.subject}`, 'success');
      return commit;
    } catch (err) {
      this.toasts.error(err);
      return null;
    }
  }

  /** The last commit's message, for an amend. */
  async lastMessage(): Promise<string> {
    try {
      const page = await this.host.invoke<GitLogPage>('git.log', { limit: 1 });
      const c = page.commits[0];
      return c ? (c.body ? `${c.subject}\n\n${c.body}` : c.subject) : '';
    } catch {
      return '';
    }
  }

  /** The palette's Commit: asks for the message and commits what is staged. */
  async commitFromPalette(): Promise<void> {
    try {
      const status = await this.host.invoke<GitStatus>('git.status', {});
      const groups = groupChanges(status.files);
      if (groups.conflicts.length) {
        await this.dialogs.notice({ title: 'Merge conflicts', message: 'Resolve the conflicts and mark them resolved in the Git sidebar before committing.' });
        return;
      }
      if (!groups.staged.length) {
        await this.dialogs.notice({ title: 'Nothing staged', message: 'Stage changes in the Git sidebar first; the commit takes what is staged.' });
        return;
      }
      const message = await this.dialogs.prompt({ title: `Commit to ${status.branch ?? 'detached HEAD'}`, label: 'Message', multiline: true, confirmLabel: 'Commit' });
      if (message?.trim()) await this.commit(message, false, status);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  // ---- Branches ----

  async checkout(ref: string): Promise<boolean> {
    try {
      await this.host.invoke('git.checkout', { ref });
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  async newBranch(from?: string): Promise<void> {
    const name = await this.dialogs.prompt({ title: from ? `New branch from ${from}` : 'New branch', label: 'Name', placeholder: 'feat/my-change', confirmLabel: 'Create and switch' });
    if (!name?.trim()) return;
    try {
      await this.host.invoke('git.branch.create', { name: name.trim(), ...(from ? { from } : {}), checkout: true });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** The branches, or null after a toast saying why they could not be read. */
  private async loadBranches(): Promise<GitBranch[] | null> {
    try {
      return (await this.host.invoke<GitBranch[]>('git.branch.list', {})).filter((b) => !b.remote || !b.name.endsWith('/HEAD'));
    } catch (err) {
      this.toasts.error(err);
      return null;
    }
  }

  /**
   * Pick a ref from a list, or type any ref. Typed text filters: an exact name or a single match wins, then the one
   * picked in the list when it is among the matches, else the text itself. Null when cancelled.
   */
  private async pickRef(options: { title: string; confirmLabel: string; refs: RefChoice[]; defaultValue?: string; listLabel?: string; typedHint?: string }): Promise<string | null> {
    const names = options.refs.map((r) => r.name);
    const matches = (text: string) => names.filter((n) => n.toLowerCase().includes(text.trim().toLowerCase()));
    const answer = await this.dialogs.promptWithChoice({
      title: options.title,
      label: 'Filter, or any ref',
      placeholder: 'main',
      confirmLabel: options.confirmLabel,
      choice: {
        label: options.listLabel ?? 'Branch',
        options: options.refs.map((r) => ({ value: r.name, label: r.label ?? r.name })),
        defaultValue: options.defaultValue ?? names[0] ?? '',
        hint: (text) => {
          if (!text.trim()) return null;
          const found = matches(text);
          return found.length ? found.slice(0, 4).join(', ') + (found.length > 4 ? ` +${found.length - 4}` : '') : (options.typedHint ?? 'No branch matches; the ref typed is used');
        },
      },
    });
    if (!answer) return null;
    const typed = answer.value.trim();
    const found = typed ? matches(typed) : [];
    return (typed ? (found.find((n) => n === typed) ?? (found.length === 1 ? found[0] : found.includes(answer.choice) ? answer.choice : typed)) : answer.choice) || null;
  }

  /** The palette's Switch branch: pick a local or remote branch, or type any ref. */
  async switchBranch(): Promise<void> {
    const branches = await this.loadBranches();
    if (!branches) return;
    const current = branches.find((b) => b.current);
    const picked = await this.pickRef({
      title: 'Switch branch',
      confirmLabel: 'Switch',
      refs: branches.map((b) => ({ name: b.name, label: b.current ? `${b.name} (current)` : b.name })),
      defaultValue: current?.name,
      typedHint: 'No branch matches; switches to the ref typed',
    });
    if (!picked || picked === current?.name) return;
    const branch = branches.find((b) => b.name === picked);
    // A remote branch is checked out by its name without the remote, which makes a local branch tracking it.
    await this.checkout(branch?.remote ? splitRemoteBranch(picked).branch : picked);
  }

  /** Check out a remote branch as a local branch tracking it (git checkout of its name without the remote). */
  async checkoutRemote(name: string): Promise<boolean> {
    return this.checkout(splitRemoteBranch(name).branch);
  }

  async renameBranch(name: string): Promise<void> {
    const to = await this.dialogs.prompt({ title: `Rename ${name}`, label: 'New name', defaultValue: name, confirmLabel: 'Rename' });
    if (!to?.trim() || to.trim() === name) return;
    try {
      await this.host.invoke('git.branch.rename', { from: name, to: to.trim() });
      this.toasts.notify(`Renamed ${name} to ${to.trim()}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /**
   * Delete a local branch: asks first, and when git says it is not merged asks again before deleting it with force,
   * since its commits are then only in the reflog. Gives true when it went.
   */
  async deleteBranch(name: string, ask = true): Promise<boolean> {
    if (ask && !(await this.dialogs.confirm({ title: `Delete ${name}?`, message: 'The local branch is deleted. Its upstream on the remote, if any, stays.', confirmLabel: 'Delete', danger: true }))) return false;
    try {
      await this.host.invoke('git.branch.delete', { name });
    } catch (err) {
      if (errorReason(toErrorPayload(err)) !== 'not-merged') {
        this.toasts.error(err);
        return false;
      }
      const force = await this.dialogs.confirm({
        title: `${name} is not merged`,
        message: `${name} has commits that are in no other branch. Deleting it anyway leaves them only in the reflog, from which git drops them in time.`,
        confirmLabel: 'Delete anyway',
        danger: true,
      });
      if (!force) return false;
      try {
        await this.host.invoke('git.branch.delete', { name, force: true });
      } catch (err2) {
        this.toasts.error(err2);
        return false;
      }
    }
    this.toasts.notify(`Deleted ${name}`, 'success');
    return true;
  }

  /**
   * Delete the branches Clean up picked, after asking once; those git finds not merged (a gone branch whose pull
   * request was squashed, say) are named in a second question before they go with force. Gives true when it ran.
   */
  async cleanUp(names: string[]): Promise<boolean> {
    if (!names.length) return false;
    const n = names.length;
    if (!(await this.dialogs.confirm({ title: `Delete ${n} branch${n === 1 ? '' : 'es'}?`, message: names.join('\n'), confirmLabel: 'Delete', danger: true }))) return false;
    const unmerged: string[] = [];
    let deleted = 0;
    for (const name of names) {
      try {
        await this.host.invoke('git.branch.delete', { name });
        deleted++;
      } catch (err) {
        if (errorReason(toErrorPayload(err)) === 'not-merged') unmerged.push(name);
        else this.toasts.error(err);
      }
    }
    if (
      unmerged.length &&
      (await this.dialogs.confirm({
        title: `${unmerged.length} branch${unmerged.length === 1 ? ' is' : 'es are'} not merged`,
        message: `These have commits that are in no other branch; deleting them anyway leaves those only in the reflog:\n${unmerged.join('\n')}`,
        confirmLabel: 'Delete anyway',
        danger: true,
      }))
    ) {
      for (const name of unmerged) {
        try {
          await this.host.invoke('git.branch.delete', { name, force: true });
          deleted++;
        } catch (err) {
          this.toasts.error(err);
        }
      }
    }
    if (deleted) this.toasts.notify(`Deleted ${deleted} branch${deleted === 1 ? '' : 'es'}`, 'success');
    return true;
  }

  /** The palette's Delete branch: pick a local branch other than the current one. */
  async deleteBranchFromPalette(): Promise<void> {
    const branches = await this.loadBranches();
    if (!branches) return;
    const local = branches.filter((b) => !b.remote && !b.current);
    if (!local.length) {
      await this.dialogs.notice({ title: 'No branch to delete', message: 'The current branch is the only local branch.' });
      return;
    }
    const picked = await this.pickRef({ title: 'Delete branch', confirmLabel: 'Delete', refs: local.map((b) => ({ name: b.name, label: b.merged ? `${b.name} (merged)` : b.gone ? `${b.name} (gone)` : b.name })) });
    if (picked) await this.deleteBranch(picked);
  }

  /** Delete a branch on its remote (`origin/feature`), after asking and naming the remote. */
  async deleteRemoteBranch(fullName: string): Promise<void> {
    const { remote, branch } = splitRemoteBranch(fullName);
    const ok = await this.dialogs.confirm({
      title: `Delete ${branch} on ${remote}?`,
      message: `The branch ${branch} is deleted on the remote ${remote}, for everyone who uses it, and its pull requests close. Local branches stay.`,
      confirmLabel: `Delete on ${remote}`,
      danger: true,
    });
    if (!ok) return;
    try {
      await this.host.invoke('git.branch.deleteRemote', { remote, name: branch });
      this.toasts.notify(`Deleted ${branch} on ${remote}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Set a branch's upstream to a remote branch picked from the list. */
  async setUpstream(branch: GitBranch): Promise<void> {
    const branches = await this.loadBranches();
    if (!branches) return;
    const remote = branches.filter((b) => b.remote);
    const upstream = await this.pickRef({
      title: `Upstream of ${branch.name}`,
      confirmLabel: 'Set upstream',
      refs: remote.map((b) => ({ name: b.name })),
      defaultValue: branch.upstream ?? remote.find((b) => splitRemoteBranch(b.name).branch === branch.name)?.name,
      listLabel: 'Remote branch',
    });
    if (!upstream) return;
    try {
      await this.host.invoke('git.branch.setUpstream', { branch: branch.name, upstream });
      this.toasts.notify(`${branch.name} now tracks ${upstream}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async unsetUpstream(branch: GitBranch): Promise<void> {
    try {
      await this.host.invoke('git.branch.setUpstream', { branch: branch.name, upstream: null });
      this.toasts.notify(`${branch.name} no longer tracks ${branch.upstream}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** How a ref differs from the current branch: `git diff HEAD <ref>`, in a diff tab. */
  compare(ref: string): void {
    this.openDiff({ kind: 'compare', from: 'HEAD', to: ref });
  }

  // ---- Merge, rebase and the operation in progress ----

  /** Says how a merge, rebase, pick or apply ended; one that stopped on conflicts brings the Git sidebar up, where they are. */
  private reportOperation(result: GitOperationResult, done: string, what: string): void {
    if (!result.conflicts.length) {
      this.toasts.notify(done, 'success');
      return;
    }
    const n = result.conflicts.length;
    this.toasts.notify(`The ${what} stopped on conflicts in ${n} file${n === 1 ? '' : 's'}. Resolve and stage them in the Git sidebar, then continue or abort.`);
    this.app.setActiveModule('git');
  }

  /** Merge a ref into the current branch; `ask` confirms first (from a menu, where one click would do it). */
  async merge(ref: string, ask = true): Promise<void> {
    if (ask && !(await this.dialogs.confirm({ title: `Merge ${ref} into the current branch?`, message: `The commits of ${ref} are merged into the current branch, with a merge commit unless it fast-forwards.`, confirmLabel: 'Merge' }))) return;
    try {
      this.reportOperation(await this.host.invoke<GitOperationResult>('git.merge', { ref }), `Merged ${ref}`, 'merge');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Rebase the current branch onto a ref, after asking: it rewrites the branch's commits. */
  async rebase(onto: string, ask = true): Promise<void> {
    if (
      ask &&
      !(await this.dialogs.confirm({
        title: `Rebase the current branch onto ${onto}?`,
        message: `The commits of the current branch that ${onto} has not are replayed on top of it as new commits. A branch that was pushed can then only be pushed with force.`,
        confirmLabel: 'Rebase',
      }))
    )
      return;
    try {
      this.reportOperation(await this.host.invoke<GitOperationResult>('git.rebase', { onto }), `Rebased onto ${onto}`, 'rebase');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** The palette's Merge branch into current and Rebase onto: pick the branch, which is the confirmation. */
  async mergeOrRebaseFromPalette(kind: 'merge' | 'rebase'): Promise<void> {
    const branches = await this.loadBranches();
    if (!branches) return;
    const current = branches.find((b) => b.current);
    const refs = branches.filter((b) => !b.current).map((b) => ({ name: b.name }));
    const on = current?.name ?? 'HEAD';
    const picked = await this.pickRef(kind === 'merge' ? { title: `Merge into ${on}`, confirmLabel: 'Merge', refs } : { title: `Rebase ${on} onto`, confirmLabel: 'Rebase', refs });
    if (!picked) return;
    await (kind === 'merge' ? this.merge(picked, false) : this.rebase(picked, false));
  }

  /** Continue, skip or abort the operation in progress. Abort and skip ask first: they throw work away. */
  async operation(action: 'continue' | 'skip' | 'abort', operation: NonNullable<GitStatus['operation']>): Promise<void> {
    const name = operation;
    if (action === 'abort' && !(await this.dialogs.confirm({ title: `Abort the ${name}?`, message: `The branch, index and files go back to how they were before the ${name} started; conflicts resolved so far are lost.`, confirmLabel: 'Abort', danger: true }))) return;
    if (action === 'skip' && !(await this.dialogs.confirm({ title: 'Skip this commit?', message: `The commit the ${name} stopped on is left out, with its changes, and the ${name} goes on with the next one.`, confirmLabel: 'Skip', danger: true }))) return;
    try {
      const result = await this.host.invoke<GitOperationResult>(`git.operation.${action}`, {});
      this.reportOperation(result, action === 'abort' ? `Aborted the ${name}` : result.status.operation ? `Went on with the ${name}` : `Finished the ${name}`, name);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** The palette's Continue, Skip and Abort, which stand in for the raw host commands: the same questions as the banner's buttons. */
  async operationFromPalette(action: 'continue' | 'skip' | 'abort'): Promise<void> {
    let status: GitStatus;
    try {
      status = await this.host.invoke<GitStatus>('git.status', { files: false });
    } catch (err) {
      this.toasts.error(err);
      return;
    }
    if (!status.operation) {
      await this.dialogs.notice({ title: 'Nothing in progress', message: 'No merge, rebase, cherry-pick or revert is in progress.' });
      return;
    }
    await this.operation(action, status.operation);
  }

  // ---- Commits ----

  async cherryPick(commit: Pick<GitCommit, 'hash' | 'shortHash'>): Promise<void> {
    try {
      this.reportOperation(await this.host.invoke<GitOperationResult>('git.cherryPick', { commits: [commit.hash] }), `Cherry-picked ${commit.shortHash}`, 'cherry-pick');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async revert(commit: Pick<GitCommit, 'hash' | 'shortHash'>): Promise<void> {
    try {
      this.reportOperation(await this.host.invoke<GitOperationResult>('git.revert', { commit: commit.hash }), `Reverted ${commit.shortHash}`, 'revert');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Move the current branch to a commit. Hard asks first: uncommitted changes are lost for good. */
  async reset(commit: Pick<GitCommit, 'hash' | 'shortHash'>, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    if (
      mode === 'hard' &&
      !(await this.dialogs.confirm({
        title: `Hard reset to ${commit.shortHash}?`,
        message: `The current branch moves to ${commit.shortHash}, and every uncommitted change to tracked files is discarded. That cannot be undone; commits after it stay in the reflog.`,
        confirmLabel: 'Reset',
        danger: true,
      }))
    )
      return;
    try {
      await this.host.invoke('git.reset', { ref: commit.hash, mode });
      this.toasts.notify(`Reset (${mode}) to ${commit.shortHash}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  // ---- Tags ----

  async tagHere(ref: string, label = ref.slice(0, 7)): Promise<void> {
    const name = await this.dialogs.prompt({ title: `Tag ${label}`, label: 'Tag name', placeholder: 'v1.0.0', confirmLabel: 'Create tag' });
    if (!name?.trim()) return;
    try {
      await this.host.invoke<GitTag>('git.tag.create', { name: name.trim(), ref });
      this.toasts.notify(`Tagged ${label} as ${name.trim()}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async deleteTag(name: string): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete the tag ${name}?`, message: 'The local tag is deleted. If it was pushed, it stays on the remote.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await this.host.invoke('git.tag.delete', { name });
      this.toasts.notify(`Deleted the tag ${name}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Push a tag to a remote: the only remote after asking, or the one picked. */
  async pushTag(name: string, branches: GitBranch[]): Promise<void> {
    const remotes = remotesOf(branches);
    let remote: string | null = remotes.length === 1 ? remotes[0] : null;
    if (remotes.length === 1) {
      if (!(await this.dialogs.confirm({ title: `Push ${name} to ${remote}?`, message: `The tag ${name} is pushed to the remote ${remote}.`, confirmLabel: 'Push tag' }))) return;
    } else {
      remote = await this.pickRef({ title: `Push ${name} to`, confirmLabel: 'Push tag', refs: remotes.map((r) => ({ name: r })), defaultValue: remotes.includes('origin') ? 'origin' : remotes[0], listLabel: 'Remote', typedHint: 'No remote matches' });
    }
    if (!remote) return;
    try {
      await this.host.invoke('git.tag.push', { remote, name });
      this.toasts.notify(`Pushed ${name} to ${remote}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  // ---- Stashes and discarding ----

  /** Stash the changes, with a message and whether untracked files go too. */
  async stashChanges(): Promise<void> {
    const answer = await this.dialogs.promptWithChoice({
      title: 'Stash changes',
      label: 'Message (optional)',
      placeholder: 'What these changes are',
      confirmLabel: 'Stash',
      choice: { label: 'Untracked files', options: [{ value: 'no', label: 'Leave them' }, { value: 'yes', label: 'Stash them too' }], defaultValue: 'no' },
    });
    if (!answer) return;
    try {
      await this.host.invoke('git.stash.push', { ...(answer.value.trim() ? { message: answer.value.trim() } : {}), includeUntracked: answer.choice === 'yes' });
      this.toasts.notify('Stashed the changes', 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Apply or pop a stash; its hash goes along, so a list that went stale never applies or drops another stash. */
  async applyStash(stash: Pick<GitStash, 'index' | 'hash' | 'message'>, pop: boolean): Promise<void> {
    try {
      const result = await this.host.invoke<GitOperationResult>('git.stash.apply', { index: stash.index, hash: stash.hash, pop });
      if (result.conflicts.length) {
        // There is no operation to continue: the files are resolved and staged like a merge's, and that is all.
        const n = result.conflicts.length;
        this.toasts.notify(`The stash stopped on conflicts in ${n} file${n === 1 ? '' : 's'}${pop ? ' and is kept' : ''}. Resolve and stage them in the Git sidebar.`);
        this.app.setActiveModule('git');
        return;
      }
      this.toasts.notify(pop ? `Popped ${stash.message}` : `Applied ${stash.message}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async dropStash(stash: Pick<GitStash, 'index' | 'hash' | 'message'>): Promise<void> {
    if (!(await this.dialogs.confirm({ title: 'Drop this stash?', message: `"${stash.message}" is deleted with its changes.`, confirmLabel: 'Drop', danger: true }))) return;
    try {
      await this.host.invoke('git.stash.drop', { index: stash.index, hash: stash.hash });
      this.toasts.notify('Dropped the stash', 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  openStash(stash: Pick<GitStash, 'index' | 'hash' | 'message'>): void {
    const source: DiffSource = { kind: 'stash', index: stash.index, hash: stash.hash };
    const key = JSON.stringify(source);
    this.tabs.openTab(this.scope(), { type: 'git.diff', title: `Stash: ${stash.message}`, data: { id: key, source } }, { singletonKey: `git.diff:${key}` });
  }

  /** Throw away changes after asking: working changes go back to the index, untracked files are deleted. */
  async discard(paths: string[], untracked: boolean): Promise<void> {
    if (!paths.length) return;
    const what = paths.length === 1 ? splitPath(paths[0]).name : `${paths.length} files`;
    const ok = await this.dialogs.confirm(
      untracked
        ? { title: `Delete ${what}?`, message: `Git does not track ${paths.length === 1 ? 'it' : 'them'}, so ${paths.length === 1 ? 'it is' : 'they are'} deleted from disk for good.`, confirmLabel: 'Delete', danger: true }
        : { title: `Discard the changes to ${what}?`, message: 'The working changes are lost for good; what is staged stays.', confirmLabel: 'Discard', danger: true },
    );
    if (!ok) return;
    try {
      await this.host.invoke('git.discard', { paths });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  // ---- Remotes ----

  /** Runs a remote command with its button spinning; gives true when it failed with an error `handled` takes over. */
  private async remote(op: RemoteOp, input: Record<string, unknown>, done: string, handled?: (err: unknown) => boolean): Promise<boolean> {
    if (untracked(this.busy).has(op)) return false;
    this.busy.update((s) => new Set(s).add(op));
    try {
      await this.host.invoke<GitRemoteResult>(`git.${op}`, input);
      this.toasts.notify(done, 'success');
      return false;
    } catch (err) {
      if (handled?.(err)) return true;
      this.toasts.error(err);
      return false;
    } finally {
      this.busy.update((s) => {
        const next = new Set(s);
        next.delete(op);
        return next;
      });
    }
  }

  async fetch(): Promise<void> {
    await this.remote('fetch', {}, 'Fetched');
  }

  async pull(): Promise<void> {
    await this.remote('pull', {}, 'Pulled');
  }

  /**
   * Push; a branch with no upstream yet is published to origin under its own name. When the remote branch has moved
   * on (after an amend or a rebase), it offers a force push with lease, which overwrites it only if nobody pushed
   * since the last fetch.
   */
  async push(status: GitStatus | undefined): Promise<void> {
    const publish = Boolean(status?.branch && !status.upstream);
    const rejected = await this.remote('push', publish ? { setUpstream: true } : {}, publish ? `Published ${status?.branch}` : 'Pushed', (err) => !publish && isPushRejected(toErrorPayload(err).message));
    if (!rejected) return;
    const ok = await this.dialogs.confirm({
      title: 'Force push?',
      message: `${status?.upstream ?? 'The remote branch'} has commits this branch does not, for example after an amend or a rebase. A force push with lease replaces them, and only if nobody pushed there since your last fetch. Pull instead to keep them.`,
      confirmLabel: 'Force push',
      danger: true,
    });
    if (ok) await this.remote('push', { forceWithLease: true }, 'Force pushed');
  }

  // ---- Pull requests ----

  async prOpen(number: number): Promise<void> {
    try {
      await this.host.invoke('git.pr.open', { number });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Check out a pull request's branch. One from a fork asks first, since its `.quiver/` folder comes with it. */
  async prCheckout(number: number): Promise<boolean> {
    try {
      await this.host.invoke('git.pr.checkout', { number });
      this.toasts.notify(`Checked out #${number}`, 'success');
      return true;
    } catch (err) {
      if (errorReason(err as { details?: unknown }) !== 'fork') {
        this.toasts.error(err);
        return false;
      }
    }
    const ok = await this.dialogs.confirm({
      title: `Check out #${number} from a fork?`,
      message:
        "This pull request's branch is in someone else's repository. Its .quiver/ folder comes with it, and MCP servers, mock servers and realtime connections it marks to start with the workspace will run their commands the next time it opens. Check it out only if you trust it.",
      confirmLabel: 'Check out',
      danger: true,
    });
    if (!ok) return false;
    try {
      await this.host.invoke('git.pr.checkout', { number, allowFork: true });
      this.toasts.notify(`Checked out #${number}`, 'success');
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  async prComment(number: number, body: string): Promise<boolean> {
    try {
      await this.host.invoke('git.pr.comment', { number, body });
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  /**
   * A todo for a pull request (`todo.add`): its number and title as the title, its address in the notes. One still open
   * for the same address is not added twice.
   */
  async prTodo(pr: Pick<GitPullRequest, 'number' | 'title' | 'url'>): Promise<boolean> {
    const workspaceId = untracked(this.app.activeWorkspaceId);
    try {
      const todos = await this.host.invoke<TodoItem[]>('todo.list', {}, workspaceId);
      // The address as a whole: `…/pull/1` is not `…/pull/12`, but it may sit in a markdown link or end a sentence.
      const listed = new RegExp(`${pr.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
      if (todos.some((t) => !t.done && listed.test(t.notes))) {
        this.toasts.notify(`#${pr.number} is already on the todo list`);
        return false;
      }
      await this.host.invoke('todo.add', { title: `#${pr.number} ${pr.title}`, notes: pr.url }, workspaceId);
      this.toasts.notify(`Added #${pr.number} to the todo list`, 'success');
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  // ---- Menus ----

  /** The menu of a local or remote branch, in the sidebar and the Branches tab. */
  branchMenu(branch: GitBranch): ContextMenuItem[] {
    const copy: ContextMenuItem = { label: 'Copy name', testId: 'git-menu-copy', select: () => this.toasts.copy(branch.name, 'Branch name copied') };
    const onCurrent: ContextMenuItem[] = [
      { label: 'Merge into current branch…', testId: 'git-menu-merge', disabled: branch.current, select: () => void this.merge(branch.name) },
      { label: 'Rebase current branch onto this…', testId: 'git-menu-rebase', disabled: branch.current, select: () => void this.rebase(branch.name) },
      { label: 'Compare with current branch', testId: 'git-menu-compare', disabled: branch.current, select: () => this.compare(branch.name) },
    ];
    if (branch.remote) {
      return [
        { label: 'Check out as a local branch', testId: 'git-menu-checkout', select: () => void this.checkoutRemote(branch.name) },
        { label: 'New branch from here…', testId: 'git-menu-new-branch', select: () => void this.newBranch(branch.name) },
        'separator',
        ...onCurrent,
        'separator',
        { label: `Delete on ${splitRemoteBranch(branch.name).remote}…`, testId: 'git-menu-delete-remote', danger: true, select: () => void this.deleteRemoteBranch(branch.name) },
        copy,
      ];
    }
    return [
      { label: 'Switch to this branch', testId: 'git-menu-checkout', disabled: branch.current, select: () => void this.checkout(branch.name) },
      { label: 'New branch from here…', testId: 'git-menu-new-branch', select: () => void this.newBranch(branch.name) },
      { label: 'Rename…', testId: 'git-menu-rename', select: () => void this.renameBranch(branch.name) },
      'separator',
      ...onCurrent,
      'separator',
      { label: 'Set upstream…', testId: 'git-menu-set-upstream', select: () => void this.setUpstream(branch) },
      ...(branch.upstream ? [{ label: `Unset upstream (${branch.upstream})`, testId: 'git-menu-unset-upstream', select: () => void this.unsetUpstream(branch) }] : []),
      'separator',
      { label: 'Delete…', testId: 'git-menu-delete', danger: true, disabled: branch.current, select: () => void this.deleteBranch(branch.name) },
      // Only an upstream on a remote (`origin/x`); a local branch as upstream has nothing to delete there.
      ...(branch.upstream?.includes('/') && !branch.gone ? [{ label: `Delete ${branch.upstream} on the remote…`, testId: 'git-menu-delete-remote', danger: true, select: () => void this.deleteRemoteBranch(branch.upstream!) }] : []),
      copy,
    ];
  }

  /** The menu of a tag in the Branches tab; `branches` gives the remotes to push it to. */
  tagMenu(tag: GitTag, branches: GitBranch[]): ContextMenuItem[] {
    return [
      { label: 'Check out (detached)', testId: 'git-menu-checkout', select: () => void this.checkout(tag.name) },
      { label: 'New branch from here…', testId: 'git-menu-new-branch', select: () => void this.newBranch(tag.name) },
      'separator',
      { label: 'Merge into current branch…', testId: 'git-menu-merge', select: () => void this.merge(tag.name) },
      { label: 'Compare with current branch', testId: 'git-menu-compare', select: () => this.compare(tag.name) },
      'separator',
      { label: 'Push to remote…', testId: 'git-menu-push-tag', disabled: !remotesOf(branches).length, select: () => void this.pushTag(tag.name, branches) },
      { label: 'Delete tag…', testId: 'git-menu-delete', danger: true, select: () => void this.deleteTag(tag.name) },
      { label: 'Copy name', testId: 'git-menu-copy', select: () => this.toasts.copy(tag.name, 'Tag name copied') },
    ];
  }

  /** The menu of a commit in the history. */
  commitMenu(commit: GitCommit): ContextMenuItem[] {
    return [
      { label: 'Check out this commit (detached)', testId: 'git-menu-checkout', select: () => void this.checkout(commit.hash) },
      { label: 'New branch here…', testId: 'git-menu-new-branch', select: () => void this.newBranch(commit.hash) },
      { label: 'Tag here…', testId: 'git-menu-tag', select: () => void this.tagHere(commit.hash, commit.shortHash) },
      'separator',
      { label: 'Cherry-pick onto current branch', testId: 'git-menu-cherry-pick', select: () => void this.cherryPick(commit) },
      { label: 'Revert this commit', testId: 'git-menu-revert', select: () => void this.revert(commit) },
      'separator',
      { label: 'Reset current branch here (soft: keep changes staged)', testId: 'git-menu-reset-soft', select: () => void this.reset(commit, 'soft') },
      { label: 'Reset current branch here (mixed: keep changes unstaged)', testId: 'git-menu-reset-mixed', select: () => void this.reset(commit, 'mixed') },
      { label: 'Reset current branch here (hard: discard changes)…', testId: 'git-menu-reset-hard', danger: true, select: () => void this.reset(commit, 'hard') },
      'separator',
      { label: 'Copy hash', testId: 'git-menu-copy', select: () => this.toasts.copy(commit.hash, 'Hash copied') },
    ];
  }
}
