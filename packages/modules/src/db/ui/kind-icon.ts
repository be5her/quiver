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

/** What the "via Grafana" marker says on hover. */
export function grafanaAccessTitle(access: Extract<DbAccess, { type: 'grafana' }>): string {
  return `Through Grafana data source ${access.datasourceName || access.datasourceUid || '…'} at ${access.grafanaUrl || '…'}: commands run with the permissions of the Grafana user signed in on this machine`;
}

/** Small marker for connections that go through a tunnel or Grafana; nothing for direct ones. */
@Component({
  selector: 'q-access-badge',
  imports: [Icon],
  template: `@if (grafana(); as title) {
      <span class="text-[9px] text-muted border border-edge rounded px-1 leading-4 shrink-0 whitespace-nowrap" data-testid="db-via-grafana" [title]="title">via Grafana</span>
    } @else if (badge(); as badge) {
      <svg [qIcon]="badge.icon" class="size-3 shrink-0 text-muted" [attr.aria-label]="badge.title"></svg>
    }`,
  host: { class: 'contents' },
})
export class AccessBadge {
  readonly access = input.required<DbAccess>();

  protected readonly grafana = computed(() => {
    const access = this.access();
    return access.type === 'grafana' ? grafanaAccessTitle(access) : null;
  });
  protected readonly badge = computed(() => {
    const access = this.access();
    if (access.type === 'direct' || access.type === 'grafana') return null;
    return access.type === 'teleport'
      ? { icon: ShieldCheck, title: `Teleport tunnel: ${access.database} as ${access.dbUser}` }
      : { icon: Cable, title: `Tunnel command: ${access.command}` };
  });
}
