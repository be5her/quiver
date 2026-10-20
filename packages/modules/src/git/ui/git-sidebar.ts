import { Component } from '@angular/core';
import { SectionHeader } from '@quiver/ui';

/** Placeholder until the UI lane lands. */
@Component({
  selector: 'q-git-sidebar',
  imports: [SectionHeader],
  template: `
    <q-section-header title="Git" />
    <p class="px-3 py-2 text-xs text-muted" data-testid="git-placeholder">Coming soon.</p>
  `,
  host: { class: 'flex flex-col h-full' },
})
export class GitSidebar {}
