import { Service, inject, signal, untracked } from '@angular/core';
import { defaultWorktreePath, toErrorPayload, type GitBranch, type GitStatus, type GitWorktree, type WorkspaceInfo } from '@quiver/core';
import { AppState, Dialogs, HostBridge, Toasts, type ContextMenuItem } from '@quiver/ui';
import { errorReason } from './git-format';

/** What the worktree rows, the Branches tab and a refused checkout ask for: open, reveal, lock, remove and make worktrees. */
@Service()
export class GitWorktreeActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  /** The New worktree dialog, which the sidebar's Worktrees section draws. */
  readonly dialogOpen = signal(false);

  /**
   * The palette's New worktree: the Git sidebar, with the dialog over it. Outside a repository it says so instead:
   * the sidebar then draws no Worktrees section, and the dialog would stay pending until one did.
   */
  async newWorktree(): Promise<void> {
    try {
      await this.host.invoke('git.worktree.list', {});
    } catch (err) {
      this.toasts.error(err);
      return;
    }
    this.app.setActiveModule('git');
    this.dialogOpen.set(true);
  }

  /** Open a worktree's folder as a workspace of its own and show it, on Git unless it already shows a module. */
  async open(path: string): Promise<void> {
    try {
      const info = await this.host.invoke<WorkspaceInfo | null>('workspace.open', { path }, null);
      if (!info) return;
      this.app.activeWorkspaceId.set(info.id);
      if (!untracked(this.app.activeModuleByScope)[info.id]) this.app.setActiveModule('git');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async reveal(path: string): Promise<void> {
    try {
      await this.host.invoke('git.worktree.reveal', { path });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async lock(wt: GitWorktree): Promise<void> {
    const reason = await this.dialogs.prompt({ title: `Lock ${label(wt)}?`, label: 'Reason (optional)', placeholder: 'On a removable disk', confirmLabel: 'Lock' });
    if (reason === null) return;
    try {
      await this.host.invoke('git.worktree.lock', { path: wt.path, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      this.toasts.notify(`Locked ${label(wt)}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async unlock(wt: GitWorktree): Promise<void> {
    try {
      await this.host.invoke('git.worktree.unlock', { path: wt.path });
      this.toasts.notify(`Unlocked ${label(wt)}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Remove a worktree after asking; one with changes asks again before it goes with force. Gives true when it went. */
  async remove(wt: GitWorktree): Promise<boolean> {
    const ok = await this.dialogs.confirm({
      title: `Remove the worktree ${label(wt)}?`,
      message: `${wt.path} is deleted from disk. ${wt.branch ? `The branch ${wt.branch} stays.` : 'Commits made there stay reachable only if a branch or tag points at them.'}`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return false;
    try {
      await this.host.invoke('git.worktree.remove', { path: wt.path });
    } catch (err) {
      if (errorReason(toErrorPayload(err)) !== 'dirty') {
        this.toasts.error(err);
        return false;
      }
      const force = await this.dialogs.confirm({
        title: `${label(wt)} has uncommitted changes`,
        message: `${wt.path} has changes or untracked files. Removing it anyway deletes them for good.`,
        confirmLabel: 'Remove anyway',
        danger: true,
      });
      if (!force) return false;
      try {
        await this.host.invoke('git.worktree.remove', { path: wt.path, force: true });
      } catch (err2) {
        this.toasts.error(err2);
        return false;
      }
    }
    this.toasts.notify(`Removed the worktree ${label(wt)}`, 'success');
    return true;
  }

  async prune(): Promise<void> {
    try {
      const { pruned } = await this.host.invoke<{ pruned: string[] }>('git.worktree.prune', {});
      this.toasts.notify(pruned.length ? `Pruned ${pruned.join(', ')}` : 'No worktree to prune', pruned.length ? 'success' : 'info');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** A worktree for a branch, at the default folder or one typed; its row in the Worktrees section opens it. */
  async newFromBranch(branch: string): Promise<void> {
    let mainPath: string;
    try {
      const status = await this.host.invoke<GitStatus>('git.status', { files: false });
      mainPath = status.worktree?.mainPath ?? '';
    } catch (err) {
      this.toasts.error(err);
      return;
    }
    const folder = await this.dialogs.prompt({ title: `New worktree for ${branch}`, label: 'Folder', defaultValue: mainPath ? defaultWorktreePath(mainPath, branch) : '', confirmLabel: 'Create worktree' });
    if (!folder?.trim()) return;
    await this.add({ branch, path: folder.trim() });
  }

  /** `git.worktree.add`, then a toast naming its folder; gives the new worktree, or null after a toast saying why not. */
  async add(input: { path?: string; branch?: string; newBranch?: string; from?: string }): Promise<GitWorktree | null> {
    try {
      const wt = await this.host.invoke<GitWorktree>('git.worktree.add', input);
      this.toasts.notify(`Created the worktree ${label(wt)} at ${wt.path}`, 'success');
      return wt;
    } catch (err) {
      this.toasts.error(err);
      return null;
    }
  }

  /** Git refused a checkout because another worktree has the branch: offer to open that worktree instead. Gives true when it was that refusal. */
  async offerOpen(err: unknown): Promise<boolean> {
    const payload = toErrorPayload(err);
    if (errorReason(payload) !== 'checked-out-elsewhere') return false;
    const details = payload.details as { branch?: string; path?: string };
    if (!details.path) return false;
    const ok = await this.dialogs.confirm({
      title: `${details.branch ?? 'This branch'} is checked out in another worktree`,
      message: `Git checks a branch out in one worktree at a time, and ${details.branch ?? 'it'} is in ${details.path}. Open that worktree as a workspace instead?`,
      confirmLabel: 'Open worktree',
    });
    if (ok) await this.open(details.path);
    return true;
  }

  /** What a local branch's menu adds for worktrees. */
  branchItems(branch: GitBranch): ContextMenuItem[] {
    if (branch.remote) return [];
    const path = branch.worktreePath;
    return [
      ...(path ? [{ label: 'Open worktree', testId: 'git-menu-open-worktree', select: () => void this.open(path) }] : []),
      { label: 'New worktree from branch…', testId: 'git-menu-new-worktree', disabled: Boolean(path) || branch.current, select: () => void this.newFromBranch(branch.name) },
    ];
  }

  /** The menu of a worktree row. */
  menu(wt: GitWorktree): ContextMenuItem[] {
    return [
      { label: 'Open as workspace', testId: 'git-menu-open-worktree', disabled: wt.current || wt.bare || wt.prunable, select: () => void this.open(wt.path) },
      { label: 'Reveal in file manager', testId: 'git-menu-reveal', disabled: wt.prunable, select: () => void this.reveal(wt.path) },
      { label: 'Copy path', testId: 'git-menu-copy', select: () => this.toasts.copy(wt.path, 'Path copied') },
      'separator',
      wt.locked
        ? { label: 'Unlock', testId: 'git-menu-unlock', select: () => void this.unlock(wt) }
        : { label: 'Lock…', testId: 'git-menu-lock', disabled: wt.main, select: () => void this.lock(wt) },
      ...(wt.prunable ? [{ label: 'Prune', testId: 'git-menu-prune', disabled: wt.locked, select: () => void this.prune() }] : []),
      { label: 'Remove…', testId: 'git-menu-remove', danger: true, disabled: wt.main || wt.current || wt.locked || wt.prunable, select: () => void this.remove(wt) },
    ];
  }
}

/** A worktree as people name it: its branch, else its folder's name. */
export function label(wt: Pick<GitWorktree, 'branch' | 'path'>): string {
  return wt.branch ?? wt.path.split(/[\\/]/).filter(Boolean).pop() ?? wt.path;
}
