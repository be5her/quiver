import { Service, inject, signal, untracked } from '@angular/core';
import type { GitBranch, GitCommit, GitStatus, GitPullRequest } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts, type ContextMenuItem } from '@quiver/ui';
import { errorReason, splitPath, type DiffSource, type GitLogPage, type GitRemoteResult, type PrFilter } from './git-format';

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

  /** A diff: of a working or staged file (or all of them), or of a commit. */
  openDiff(source: DiffSource): void {
    const key = JSON.stringify(source);
    const title = source.path ? splitPath(source.path).name : source.kind === 'commit' ? source.ref.slice(0, 7) : 'Changes';
    const suffix = source.kind === 'staged' ? ' (staged)' : source.kind === 'working' && source.path ? ' (working)' : '';
    this.tabs.openTab(this.scope(), { type: 'git.diff', title: title + suffix, data: { id: key, source } }, { singletonKey: `git.diff:${key}` });
  }

  openHistory(): void {
    this.tabs.openTab(this.scope(), { type: 'git.history', title: 'History', data: { id: 'history' } }, { singletonKey: 'git.history:history' });
  }

  /** The pull request list, on a filter or on the form for a new one. */
  openPullRequests(options: { filter?: PrFilter; view?: 'list' | 'new' } = {}): void {
    const scope = this.scope();
    const tab = this.tabs.openTab(scope, { type: 'git.prs', title: 'Pull requests', data: { id: 'prs', ...options, nonce: Date.now() } }, { singletonKey: 'git.prs:prs' });
    if (options.filter || options.view) this.tabs.updateTab(scope, tab.id, { data: { ...tab.data, ...options, nonce: Date.now() } });
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
      if (!status.files.some((f) => f.index !== '.' && f.index !== '?')) {
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

  /** The palette's Switch branch: pick a local or remote branch, or type any ref. */
  async switchBranch(): Promise<void> {
    let branches: GitBranch[];
    try {
      branches = (await this.host.invoke<GitBranch[]>('git.branch.list', {})).filter((b) => !b.remote || !b.name.endsWith('/HEAD'));
    } catch (err) {
      this.toasts.error(err);
      return;
    }
    const current = branches.find((b) => b.current);
    const names = branches.map((b) => b.name);
    const matches = (text: string) => names.filter((n) => n.toLowerCase().includes(text.trim().toLowerCase()));
    const answer = await this.dialogs.promptWithChoice({
      title: 'Switch branch',
      label: 'Filter, or any ref',
      placeholder: 'main',
      confirmLabel: 'Switch',
      choice: {
        label: 'Branch',
        options: branches.map((b) => ({ value: b.name, label: b.current ? `${b.name} (current)` : b.name })),
        defaultValue: current?.name ?? names[0] ?? '',
        hint: (text) => {
          if (!text.trim()) return null;
          const found = matches(text);
          return found.length ? found.slice(0, 4).join(', ') + (found.length > 4 ? ` +${found.length - 4}` : '') : 'No branch matches; switches to the ref typed';
        },
      },
    });
    if (!answer) return;
    const typed = answer.value.trim();
    const found = typed ? matches(typed) : [];
    const picked = typed ? (found.find((n) => n === typed) ?? (found.length === 1 ? found[0] : typed)) : answer.choice;
    if (!picked || picked === current?.name) return;
    const branch = branches.find((b) => b.name === picked);
    // A remote branch is checked out by its name without the remote, which makes a local branch tracking it.
    const ref = branch?.remote ? picked.slice(picked.indexOf('/') + 1) : picked;
    await this.checkout(ref);
  }

  // ---- Remotes ----

  private async remote(op: RemoteOp, input: Record<string, unknown>, done: string): Promise<void> {
    if (untracked(this.busy).has(op)) return;
    this.busy.update((s) => new Set(s).add(op));
    try {
      await this.host.invoke<GitRemoteResult>(`git.${op}`, input);
      this.toasts.notify(done, 'success');
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.update((s) => {
        const next = new Set(s);
        next.delete(op);
        return next;
      });
    }
  }

  fetch(): Promise<void> {
    return this.remote('fetch', {}, 'Fetched');
  }

  pull(): Promise<void> {
    return this.remote('pull', {}, 'Pulled');
  }

  /** Push; a branch with no upstream yet is published to origin under its own name. */
  push(status: GitStatus | undefined): Promise<void> {
    const publish = Boolean(status?.branch && !status.upstream);
    return this.remote('push', publish ? { setUpstream: true } : {}, publish ? `Published ${status?.branch}` : 'Pushed');
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

  // ---- Menus ----

  /** The right-click menu of a branch in the sidebar. */
  branchMenu(branch: GitBranch): ContextMenuItem[] {
    return [
      { label: 'Switch to this branch', disabled: branch.current, select: () => void this.checkout(branch.name) },
      { label: 'New branch from here…', select: () => void this.newBranch(branch.name) },
      { label: 'Copy name', select: () => this.toasts.copy(branch.name, 'Branch name copied') },
    ];
  }
}
