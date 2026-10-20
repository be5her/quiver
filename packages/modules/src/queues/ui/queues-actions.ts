import { Service, inject, untracked } from '@angular/core';
import type { QueueDestination, QueueKind } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts, TreeState, type ContextMenuItem } from '@quiver/ui';
import { KIND_LABEL, QUEUE_KINDS, destinationWord, type QueueConnectionSummary } from './queues-format';

type ConnRef = Pick<QueueConnectionSummary, 'id' | 'name' | 'kind'>;

/** Opens the Queues tabs, and creates, tests and deletes connections and destinations; whatever destroys data asks first. */
@Service()
export class QueuesActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly tree = inject(TreeState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  private scope(): string {
    return untracked(this.app.scope);
  }

  /** Open (or focus) a connection's settings. */
  openConnectionTab(conn: Pick<ConnRef, 'id' | 'name'>): void {
    this.tabs.openTab(this.scope(), { type: 'queues.connection', title: conn.name, data: { id: conn.id } }, { singletonKey: `queues.connection:${conn.id}` });
  }

  /** Open (or focus) a topic or queue on a view: its messages, the producer, the live tail or the group lag. */
  openDestination(conn: Pick<ConnRef, 'id'>, destination: string, view?: string): void {
    const id = `${conn.id}:${destination}`;
    const tab = this.tabs.openTab(
      this.scope(),
      { type: 'queues.destination', title: destination, data: { id, connectionId: conn.id, destination, view, nonce: Date.now() } },
      { singletonKey: `queues.destination:${id}` },
    );
    // A tab that was already open keeps its data unless asked for another view.
    if (view) this.tabs.updateTab(this.scope(), tab.id, { data: { ...tab.data, view, nonce: Date.now() } });
  }

  async createConnection(kind?: QueueKind): Promise<void> {
    const answer = await this.dialogs.promptWithChoice({
      title: 'New queue connection',
      label: 'Name',
      placeholder: 'Orders Kafka',
      confirmLabel: 'Create',
      choice: {
        label: 'Broker',
        options: QUEUE_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
        defaultValue: kind ?? 'kafka',
        hint: (_text, choice) => (choice === 'memory' ? 'Lives in Quiver, nothing to set up' : null),
      },
    });
    if (!answer) return;
    const picked = QUEUE_KINDS.find((k) => k === answer.choice) ?? 'memory';
    try {
      const created = await this.host.invoke<QueueConnectionSummary>('queues.connection.save', { connection: { name: answer.value.trim() || KIND_LABEL[picked], kind: picked } });
      this.tree.expand(`queues/${created.id}`);
      this.openConnectionTab(created);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async testConnection(conn: ConnRef): Promise<void> {
    try {
      const r = await this.host.invoke<{ ok: boolean; message: string }>('queues.connection.test', { id: conn.id });
      this.toasts.notify(`${conn.name}: ${r.message}`, r.ok ? 'success' : 'error');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async deleteConnection(conn: ConnRef): Promise<boolean> {
    if (
      !(await this.dialogs.confirm({
        title: `Delete "${conn.name}"?`,
        message: 'The connection is removed from the project with its secrets on this machine, and its live tails stop. Nothing on the broker changes.',
        danger: true,
        confirmLabel: 'Delete',
      }))
    )
      return false;
    try {
      await this.host.invoke('queues.connection.delete', { id: conn.id });
      this.tabs.closeWhere(this.scope(), (t) => (t.type === 'queues.connection' && t.data?.['id'] === conn.id) || (t.type === 'queues.destination' && t.data?.['connectionId'] === conn.id));
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  /** Ask for a name (and partitions or FIFO where they apply), create the topic or queue and open it. */
  async createDestination(conn: ConnRef): Promise<void> {
    const word = destinationWord(conn.kind);
    const title = `New ${word} on ${conn.name}`;
    const placeholder = conn.kind === 'sqs' ? 'orders (orders.fifo for FIFO)' : 'orders';
    let name: string | null = null;
    let options: { partitions?: number; fifo?: boolean } = {};
    if (conn.kind === 'kafka' || conn.kind === 'memory') {
      const answer = await this.dialogs.promptWithChoice({
        title,
        label: 'Name',
        placeholder,
        confirmLabel: 'Create',
        choice: { label: 'Partitions', options: ['1', '3', '6', '12'].map((n) => ({ value: n, label: n })), defaultValue: '1' },
      });
      name = answer?.value ?? null;
      if (answer) options = { partitions: Number(answer.choice) };
    } else if (conn.kind === 'sqs') {
      const answer = await this.dialogs.promptWithChoice({
        title,
        label: 'Name',
        placeholder,
        confirmLabel: 'Create',
        choice: {
          label: 'Type',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'fifo', label: 'FIFO' },
          ],
          defaultValue: 'standard',
          hint: (text, choice) => (choice === 'fifo' && !text.trim().endsWith('.fifo') ? 'The name must end in .fifo' : null),
        },
      });
      name = answer?.value ?? null;
      if (answer) options = { fifo: answer.choice === 'fifo' };
    } else {
      name = await this.dialogs.prompt({ title, label: 'Name', placeholder, confirmLabel: 'Create' });
    }
    if (!name?.trim()) return;
    try {
      const created = await this.host.invoke<QueueDestination>('queues.destination.create', { connectionId: conn.id, destination: name.trim(), ...options });
      this.tree.expand(`queues/${conn.id}`);
      this.openDestination(conn, created.name);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async purge(conn: ConnRef, destination: string): Promise<boolean> {
    const word = destinationWord(conn.kind);
    const kafka = conn.kind === 'kafka';
    if (
      !(await this.dialogs.confirm({
        title: `Purge ${word} "${destination}"?`,
        message: `Every message in ${destination} on ${conn.name} is deleted.${kafka ? ' Offsets keep counting from where they were.' : ''} This cannot be undone.`,
        danger: true,
        confirmLabel: 'Purge',
      }))
    )
      return false;
    try {
      await this.host.invoke('queues.destination.purge', { connectionId: conn.id, destination });
      this.toasts.notify(`Purged ${destination}`, 'success');
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  async deleteDestination(conn: ConnRef, destination: string): Promise<boolean> {
    const word = destinationWord(conn.kind);
    if (
      !(await this.dialogs.confirm({
        title: `Delete ${word} "${destination}"?`,
        message: `The ${word} is deleted from ${conn.name} together with its messages. This cannot be undone.`,
        danger: true,
        confirmLabel: 'Delete',
      }))
    )
      return false;
    try {
      await this.host.invoke('queues.destination.delete', { connectionId: conn.id, destination });
      const id = `${conn.id}:${destination}`;
      this.tabs.closeWhere(this.scope(), (t) => t.type === 'queues.destination' && t.data?.['id'] === id);
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  /** The palette's "Open topic or queue": pick the connection, type the name; the hint lists what matches. */
  async pickDestination(): Promise<void> {
    try {
      const connections = await this.host.invoke<QueueConnectionSummary[]>('queues.connection.list', {});
      if (!connections.length) return this.createConnection();
      const names = new Map<string, string[]>();
      await Promise.all(
        connections.map(async (c) => {
          const list = await this.host.invoke<QueueDestination[]>('queues.destination.list', { connectionId: c.id }).catch(() => [] as QueueDestination[]);
          names.set(c.id, list.map((d) => d.name));
        }),
      );
      const matches = (text: string, connectionId: string) => (names.get(connectionId) ?? []).filter((n) => n.toLowerCase().includes(text.trim().toLowerCase()));
      const answer = await this.dialogs.promptWithChoice({
        title: 'Open topic or queue',
        label: 'Name',
        placeholder: 'orders',
        confirmLabel: 'Open',
        choice: {
          label: 'Connection',
          options: connections.map((c) => ({ value: c.id, label: c.name })),
          defaultValue: connections[0].id,
          hint: (text, choice) => {
            const found = matches(text, choice);
            if (!found.length) return names.get(choice)?.length ? 'No match' : 'Nothing listed yet';
            return found.slice(0, 4).join(', ') + (found.length > 4 ? ` +${found.length - 4}` : '');
          },
        },
      });
      if (!answer) return;
      const typed = answer.value.trim();
      const found = matches(typed, answer.choice);
      const exact = found.find((n) => n === typed);
      const name = exact ?? (found.length === 1 ? found[0] : typed);
      if (name) this.openDestination({ id: answer.choice }, name);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** The `…` and right-click menu of a connection. */
  connectionMenu(conn: QueueConnectionSummary): ContextMenuItem[] {
    const word = destinationWord(conn.kind);
    return [
      { label: `New ${word}…`, testId: 'queues-menu-new-destination', select: () => void this.createDestination(conn) },
      { label: 'Test connection', testId: 'queues-menu-test', select: () => void this.testConnection(conn) },
      { label: 'Edit connection', testId: 'queues-menu-edit', select: () => this.openConnectionTab(conn) },
      'separator',
      { label: 'Delete connection', testId: 'queues-menu-delete', danger: true, select: () => void this.deleteConnection(conn) },
    ];
  }

  /** The right-click menu of a topic or queue. */
  destinationMenu(conn: QueueConnectionSummary, destination: string): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      { label: 'Messages', select: () => this.openDestination(conn, destination, 'messages') },
      { label: 'Produce…', select: () => this.openDestination(conn, destination, 'produce') },
      { label: 'Live tail', select: () => this.openDestination(conn, destination, 'tail') },
    ];
    if (conn.kind === 'kafka') items.push({ label: 'Consumer groups', select: () => this.openDestination(conn, destination, 'groups') });
    items.push(
      'separator',
      { label: 'Purge…', testId: 'queues-menu-purge', danger: true, select: () => void this.purge(conn, destination) },
      { label: `Delete ${destinationWord(conn.kind)}…`, testId: 'queues-menu-delete-destination', danger: true, select: () => void this.deleteDestination(conn, destination) },
    );
    return items;
  }
}
