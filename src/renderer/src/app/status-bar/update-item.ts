import { Component, inject } from '@angular/core';
import { AppState, Icon } from '@quiver/ui';
import { Download, ExternalLink, RotateCw } from 'lucide';
import { Updates } from '../updates';

/** One entry that follows the updater: checking, a version to fetch, progress, or a restart to finish. */
@Component({
  selector: 'q-update-item',
  imports: [Icon],
  template: `
    @if (update(); as update) {
      @if (update.supported) {
        @switch (update.status) {
          @case ('checking') {
            <span class="flex items-center gap-1" data-testid="update-status"><svg [qIcon]="icons.RotateCw" class="size-3 animate-spin"></svg>Checking for updates…</span>
          }
          @case ('available') {
            @if (update.installable) {
              <button type="button" class="flex items-center gap-1 text-accent hover:text-fg" [title]="'Download Quiver ' + update.version + '; it installs when you restart'" data-testid="update-status" (click)="updates.download()">
                <svg [qIcon]="icons.Download" class="size-3"></svg>Update to {{ update.version }}</button>
            } @else {
              <button type="button" class="flex items-center gap-1 text-accent hover:text-fg" [title]="update.reason ?? ''" data-testid="update-status" (click)="updates.openExternal(update.url)">
                <svg [qIcon]="icons.ExternalLink" class="size-3"></svg>Quiver {{ update.version }} available</button>
            }
          }
          @case ('downloading') {
            <span class="flex items-center gap-1" data-testid="update-status"
              ><svg [qIcon]="icons.Download" class="size-3 animate-pulse"></svg>Downloading {{ update.version }}… {{ update.progress?.percent ?? 0 }}%</span
            >
          }
          @case ('downloaded') {
            <button type="button" class="flex items-center gap-1 text-accent hover:text-fg font-medium" [title]="'Quiver ' + update.version + ' is downloaded'" data-testid="update-status" (click)="updates.install()">
              <svg [qIcon]="icons.RotateCw" class="size-3"></svg>Restart to update</button>
          }
        }
      }
    }
  `,
  host: { class: 'contents' },
})
export class UpdateItem {
  protected readonly updates = inject(Updates);
  protected readonly update = inject(AppState).update;
  protected readonly icons = { Download, ExternalLink, RotateCw };
}
