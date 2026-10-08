import { NgComponentOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { AppState, TabsState } from '@quiver/ui';
import { resolveTabComponent } from '../modules';
import { Welcome } from '../welcome/welcome';

/**
 * Every open tab stays rendered (hidden when inactive) so editors, responses and scroll positions
 * survive switching, in both directions, without re-fetching.
 */
@Component({
  selector: 'q-tab-content',
  imports: [NgComponentOutlet, Welcome],
  template: `
    @if (current().tabs.length) {
      <div class="relative flex-1 min-h-0">
        @for (tab of current().tabs; track tab.id) {
          <div [class]="tab.id === current().activeTabId ? 'absolute inset-0 flex flex-col' : 'hidden'" [attr.data-tab-type]="tab.type">
            @if (component(tab.type); as tabComponent) {
              <ng-container *ngComponentOutlet="tabComponent; inputs: { tab, scope: scope() }" />
            } @else {
              <div class="p-4 text-sm text-muted">No renderer for tab type "{{ tab.type }}".</div>
            }
          </div>
        }
      </div>
    } @else {
      <q-welcome />
    }
  `,
  host: { class: 'contents' },
})
export class TabContent {
  private readonly app = inject(AppState);
  private readonly tabs = inject(TabsState);

  protected readonly scope = this.app.scope;
  protected readonly current = computed(() => this.tabs.scope(this.scope()));
  protected readonly component = resolveTabComponent;
}
