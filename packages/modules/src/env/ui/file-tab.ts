import { Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { envKindLabel, type EnvFileContent, type EnvFileSummary, type EnvProfileGroup } from '@quiver/core';
import { Badge, Button, CodeEditor, HostBridge, Icon, IconButton, Segment, Segmented, Select, Spinner, TabsState, Toasts, injectHostEvent, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Eye, EyeOff, Save, Trash2, Upload } from 'lucide';
import { EnvCompareView } from './compare-view';
import { EnvActions, type FileView } from './env-actions';
import { WARNING_TITLE, maskedText } from './env-format';
import { EnvHistoryView } from './history-view';
import { EnvKeysView } from './keys-view';

/** Text being edited, and the file text the edits started from. */
interface Edit {
  base: string;
  text: string;
}

/** A dotenv file: its keys with secrets masked, the raw text, a comparison with another file, and its backups. */
@Component({
  selector: 'q-env-file-tab',
  imports: [Badge, Button, CodeEditor, EnvCompareView, EnvHistoryView, EnvKeysView, Icon, IconButton, Segment, Segmented, Select, Spinner],
  templateUrl: './file-tab.html',
  host: { class: 'contents', '(keydown)': 'shortcut($event)' },
})
export class EnvFileTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  protected readonly env = inject(EnvActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Eye, EyeOff, Save, Trash2, Upload };
  protected readonly warningTitle = WARNING_TITLE;
  protected readonly importTitle = 'Copy these keys into a Quiver environment for {{variables}}';
  private readonly filePath = computed(() => String(this.tab().data?.['path'] ?? ''));
  protected readonly content = invokeResource<EnvFileContent>('env.file.read', () => ({ path: this.filePath() }));
  private readonly files = invokeResource<EnvFileSummary[]>('env.file.list', () => ({}), { refreshOnEvents: ['env.changed'] });
  private readonly profiles = invokeResource<EnvProfileGroup[]>('env.profile.list', () => ({}), { refreshOnEvents: ['env.changed'] });

  protected readonly loadError = computed(() => this.content.error()?.message ?? null);
  private readonly diskText = computed(() => this.content.value()?.text ?? '');
  /** Follows the file while there are no unsaved edits; keeps the edits (and what they started from) otherwise. */
  private readonly edit = linkedSignal<string, Edit>({
    source: this.diskText,
    computation: (text, previous) => (previous && previous.value.text !== previous.value.base ? previous.value : { base: text, text }),
  });
  protected readonly draft = computed(() => this.edit().text);
  protected readonly dirty = computed(() => Boolean(this.content.value()) && this.edit().text !== this.diskText());
  protected readonly changedOnDisk = computed(() => {
    const edit = this.edit();
    return edit.text !== edit.base && edit.base !== this.diskText();
  });
  /** The section on screen; the sidebar can ask for another one through the tab's data. */
  protected readonly view = linkedSignal<unknown, FileView>({
    source: () => this.tab().data?.['nonce'],
    computation: (_nonce, previous) => untracked(() => (this.tab().data?.['view'] as FileView | undefined)) ?? previous?.value ?? 'keys',
  });
  protected readonly reveal = signal(false);
  protected readonly busy = signal(false);

  protected readonly kindLabel = computed(() => {
    const c = this.content.value();
    return c ? envKindLabel(c.kind, c.profile) : null;
  });
  protected readonly switchable = computed(() => {
    const c = this.content.value();
    const group = (this.profiles.value() ?? []).find((g) => g.dir === c?.dir);
    return c?.kind === 'main' && group ? group.profiles : [];
  });
  protected readonly siblings = computed(() => (this.files.value() ?? []).filter((f) => f.path !== this.content.value()?.path));
  protected readonly masked = computed(() => {
    const c = this.content.value();
    return c ? maskedText(c) : '';
  });

  constructor() {
    injectHostEvent('env.changed', (p) => (!p.path || p.path === this.filePath()) && this.content.reload());

    effect(() => {
      const dirty = this.dirty();
      const tab = this.tab();
      if (tab.dirty !== dirty) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { dirty }));
    });
  }

  protected reload(): void {
    this.content.reload();
  }

  protected setDraft(text: string): void {
    this.edit.update((edit) => ({ ...edit, text }));
  }

  protected shortcut(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      const dirty = this.dirty();
      void this.save().then((ok) => ok && dirty && this.toasts.notify('Saved', 'success'));
    }
  }

  protected async saveAndSay(): Promise<void> {
    if (await this.save()) this.toasts.notify('Saved', 'success');
  }

  protected async save(): Promise<boolean> {
    if (!this.dirty()) return true;
    const text = this.draft();
    this.busy.set(true);
    try {
      await this.host.invoke('env.file.write', { path: this.filePath(), text });
      this.edit.set({ base: text, text });
      this.content.reload();
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** Copy the picked profile over this `.env`; the picker goes back to its prompt. */
  protected async pickProfile(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const target = this.siblings().find((f) => f.path === select.value);
    select.value = '';
    if (target) await this.env.switchProfile(target);
  }
}
