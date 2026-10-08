import { Component, computed, input, model } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import { clusterLabel, type DbAccess, type DbKind, type TeleportDatabase, type TeleportStatus } from '@quiver/core';
import { Input, Label, Select, invokeResource } from '@quiver/ui';

export type TeleportAccess = Extract<DbAccess, { type: 'teleport' }>;

/** Teleport cluster, database name and user, with suggestions from `tsh db ls` when logged in. */
@Component({
  selector: 'q-teleport-access-fields',
  imports: [Input, Label, Select],
  templateUrl: './teleport-access-fields.html',
  host: { class: 'block' },
})
export class TeleportAccessFields implements FormValueControl<TeleportAccess> {
  readonly value = model.required<TeleportAccess>();
  readonly kind = input.required<DbKind>();

  protected readonly clusterLabel = clusterLabel;
  private readonly status = invokeResource<TeleportStatus>('teleport.status', () => ({}), { workspaceId: null, refreshOnEvents: ['teleport.changed'] });
  protected readonly dbs = invokeResource<TeleportDatabase[]>('teleport.db.list', () => (this.value().proxy ? { proxy: this.value().proxy } : {}), {
    workspaceId: null,
    refreshOnEvents: ['teleport.changed'],
  });
  protected readonly clusters = computed(() => this.status.value()?.clusters ?? []);
  protected readonly knownProxy = computed(() => !this.value().proxy || this.clusters().some((c) => c.proxy === this.value().proxy));
  private readonly match = computed(() => this.dbs.value()?.find((d) => d.name === this.value().database));
  protected readonly users = computed(() => this.match()?.allowedUsers.filter((u) => u !== '*') ?? []);
  protected readonly note = computed(() => {
    const error = this.dbs.error();
    const match = this.match();
    if (error) return `Suggestions unavailable: ${error.message}`;
    if (match && match.protocol !== this.kind()) return `Teleport reports this database as ${match.protocol}; pick the matching type above.`;
    return 'Quiver starts tsh proxy db --tunnel on a free port and connects there. The tunnel is shared by every workspace.';
  });

  protected pickCluster(event: Event): void {
    this.value.update((access) => ({ ...access, proxy: (event.target as HTMLSelectElement).value }));
  }

  /** Picking a database that allows a single user fills the user in. */
  protected setDatabase(event: Event): void {
    const database = (event.target as HTMLInputElement).value;
    const picked = this.dbs.value()?.find((d) => d.name === database);
    const single = picked?.allowedUsers.filter((u) => u !== '*');
    this.value.update((access) => ({ ...access, database, dbUser: access.dbUser || (single?.length === 1 ? single[0] : '') }));
  }

  protected setUser(event: Event): void {
    this.value.update((access) => ({ ...access, dbUser: (event.target as HTMLInputElement).value }));
  }

  protected clusterState(state: string): string {
    return state === 'logged-in' || state === 'expiring' ? '' : ` · ${state}`;
  }
}
