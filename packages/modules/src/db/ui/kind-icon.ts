import { Component, ElementRef, Renderer2, afterRenderEffect, computed, inject, input } from '@angular/core';
import { DB_KIND_LABELS, type DbAccess, type DbKind } from '@quiver/core';
import { Icon, drawIcon } from '@quiver/ui';
import { Cable, ShieldCheck } from 'lucide';
import { KIND_COLORS, KIND_ICONS } from './db-format';

/** The icon of a connection kind in its colour: `<svg [qKindIcon]="conn.kind"></svg>`. */
@Component({
  selector: 'svg[qKindIcon]',
  template: '',
  host: {
    width: '24',
    height: '24',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    '[class]': 'classes()',
    '[attr.aria-label]': 'label()',
  },
})
export class KindIcon {
  readonly qKindIcon = input.required<DbKind>();

  protected readonly classes = computed(() => `size-3.5 shrink-0 ${KIND_COLORS[this.qKindIcon()]}`);
  protected readonly label = computed(() => DB_KIND_LABELS[this.qKindIcon()]);

  constructor() {
    const svg = inject<ElementRef<SVGElement>>(ElementRef).nativeElement;
    const renderer = inject(Renderer2);
    afterRenderEffect({ write: () => drawIcon(renderer, svg, KIND_ICONS[this.qKindIcon()]) });
  }
}

/** Small marker for connections that go through a tunnel; nothing for direct ones. */
@Component({
  selector: 'q-access-badge',
  imports: [Icon],
  template: `@if (badge(); as badge) {<svg [qIcon]="badge.icon" class="size-3 shrink-0 text-muted" [attr.aria-label]="badge.title"></svg>}`,
  host: { class: 'contents' },
})
export class AccessBadge {
  readonly access = input.required<DbAccess>();

  protected readonly badge = computed(() => {
    const access = this.access();
    if (access.type === 'direct') return null;
    return access.type === 'teleport'
      ? { icon: ShieldCheck, title: `Teleport tunnel: ${access.database} as ${access.dbUser}` }
      : { icon: Cable, title: `Tunnel command: ${access.command}` };
  });
}
