import { NgComponentOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { AppState, EmptyState } from '@quiver/ui';
import { moduleById } from '../modules';

/** The active module's sidebar, under its title. Workspace modules wait for a folder. */
@Component({
  selector: 'aside[qSidebar]',
  imports: [EmptyState, NgComponentOutlet],
  template: `
    @if (module(); as mod) {
      <div class="flex items-center h-9 px-3 text-xs font-semibold uppercase tracking-wide text-muted border-b border-edge shrink-0">{{ mod.title }}</div>
      <div class="flex-1 min-h-0 overflow-y-auto">
        @if (blocked()) {
          <q-empty-state title="No workspace open" hint="Open a project folder to use this module." />
        } @else {
          <ng-container *ngComponentOutlet="mod.sidebar" />
        }
      </div>
    }
  `,
  host: { '[class]': 'module() ? "flex flex-col w-[270px] border-r border-edge bg-surface shrink-0 min-h-0" : "hidden"' },
})
export class Sidebar {
  private readonly app = inject(AppState);

  protected readonly module = computed(() => moduleById(this.app.activeModule()));
  protected readonly blocked = computed(() => this.module()?.availability === 'workspace' && !this.app.hasWorkspace());
}
