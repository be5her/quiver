import { Service } from '@angular/core';

/**
 * Live tails whose tab is still open but not on screen: switching workspace takes a workspace's tabs off screen,
 * which destroys their components, so the tail hands its consumer over here and takes it back when the tab shows
 * again. Keys are `<scope>/<tab id>`. Not persisted: tails do not outlive Quiver either.
 */
@Service()
export class QueuesTails {
  private readonly held = new Map<string, string>();

  hold(key: string, consumerId: string): void {
    this.held.set(key, consumerId);
  }

  has(key: string): boolean {
    return this.held.has(key);
  }

  /** The consumer held for this tab, which is no longer held once taken. */
  take(key: string): string | undefined {
    const id = this.held.get(key);
    this.held.delete(key);
    return id;
  }
}
