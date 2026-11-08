import { Component, booleanAttribute, computed, inject, input, model, signal } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import { relativeTime, toErrorPayload, type ApiAuth, type ConcreteAuth, type OAuth2Auth, type RequestAuth } from '@quiver/core';
import { Button, Checkbox, HostBridge, Input, Label, Select, Toasts, VariableInput, invokeResource } from '@quiver/ui';
import { KeyRound, Trash2 } from 'lucide';

type Auth<T extends RequestAuth['type']> = Extract<RequestAuth, { type: T }>;

/** What `inherit` resolves to where the editor is used, and where that comes from. */
export interface InheritedAuthInfo {
  resolved: ConcreteAuth;
  /** The collection the auth comes from; null when nothing above sets one. */
  from: string | null;
  /** "collection" for a request, "parent collection" for a collection. */
  label: string;
}

/**
 * How the request authenticates: none, a bearer token, basic credentials or an API key, and, given
 * `inherit`, the auth of the collection above. Bind with `[formField]`.
 */
@Component({
  selector: 'q-auth-editor',
  imports: [Button, Checkbox, Input, Label, Select, VariableInput],
  templateUrl: './auth-editor.html',
  host: { class: 'flex flex-col gap-3 max-w-lg' },
})
export class AuthEditor implements FormValueControl<ApiAuth> {
  readonly value = model.required<ApiAuth>();
  /** Offers "Inherit from …" and says what it resolves to. Requests and collections pass it; realtime and MCP do not. */
  readonly inherit = input<InheritedAuthInfo | null>(null);
  /** Offers OAuth 2.0, which needs the API module's token commands: requests and collections, not realtime or MCP. */
  readonly oauth = input(false, { transform: booleanAttribute });

  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  protected readonly icons = { KeyRound, Trash2 };
  protected readonly secretSyntax = '{{clientSecret}}';
  protected readonly fetching = signal(false);
  protected readonly oauthAuth = computed(() => {
    const auth = this.value();
    return auth.type === 'oauth2' ? auth : null;
  });
  /** What is cached for this OAuth configuration; follows tokens got anywhere (a send, an agent, Get token). */
  protected readonly tokenStatus = invokeResource<{ hasToken: boolean; fresh: boolean; expiresAt: number | null; scope: string | null; refreshable: boolean }>(
    'api.oauth2.status',
    () => ({ auth: this.oauthAuth() }),
    { enabled: () => this.oauthAuth() !== null, refreshOn: ['oauth-tokens'] },
  );
  protected readonly statusText = computed(() => {
    const auth = this.oauthAuth();
    const status = this.tokenStatus.value();
    if (!auth) return '';
    if (this.tokenStatus.error()) return this.tokenStatus.error()!.message;
    if (!status?.hasToken) return auth.grant === 'client_credentials' ? 'No token yet. The first send gets one.' : 'Not signed in. Get token, or the first send, opens a sign-in window.';
    const scope = status.scope ? ` · scope ${status.scope}` : '';
    if (status.fresh) return `Token ${status.expiresAt ? `expires ${relativeTime(status.expiresAt - Date.now())}` : 'without an expiry'}${scope}`;
    return status.refreshable ? `Token expired; the next send refreshes it${scope}` : `Token expired; the next send gets a new one${scope}`;
  });
  protected readonly redirectUri = computed(() => `http://127.0.0.1:${this.oauthAuth()?.callbackPort ?? '<a free port>'}/callback`);

  protected readonly inheritedText = computed(() => {
    const info = this.inherit();
    if (!info?.from) return `Nothing above sets auth, so this sends none.`;
    const auth = info.resolved;
    const what =
      auth.type === 'bearer'
        ? 'A bearer token'
        : auth.type === 'basic'
          ? `Basic auth as ${auth.username || '(no user)'}`
          : auth.type === 'apikey'
            ? `The API key ${auth.key} in the ${auth.in}`
            : auth.type === 'oauth2'
              ? `OAuth 2.0 (${auth.grant === 'client_credentials' ? 'client credentials' : 'sign-in'})`
              : 'No auth';
    return `${what}, set on ${info.from}.`;
  });

  protected readonly tokenSyntax = '{{token}}';
  protected readonly variableSyntax = '{{name}}';

  /** Switching the type starts that type's fields from scratch. */
  protected setType(event: Event): void {
    const type = (event.target as HTMLSelectElement).value as ApiAuth['type'];
    switch (type) {
      case 'none':
      case 'inherit':
        return this.value.set({ type });
      case 'bearer':
        return this.value.set({ type, token: '' });
      case 'basic':
        return this.value.set({ type, username: '', password: '' });
      case 'apikey':
        return this.value.set({ type, key: 'X-API-Key', value: '', in: 'header' });
      case 'oauth2':
        return this.value.set({ type, grant: 'client_credentials', tokenUrl: '', clientId: '', clientSecret: '', scopes: '', clientAuth: 'basic', pkce: true });
    }
  }

  /** Change some fields of the current auth, keeping its type. */
  protected patch(patch: Partial<Auth<'bearer'> | Auth<'basic'> | Auth<'apikey'>>): void {
    this.value.update((auth) => ({ ...auth, ...patch }) as ApiAuth);
  }

  /** Change some OAuth 2.0 fields; an emptied optional one is left out, so the saved request stays tidy. */
  protected patchOAuth(patch: Partial<OAuth2Auth>): void {
    this.value.update((auth) => {
      if (auth.type !== 'oauth2') return auth;
      const next: OAuth2Auth = { ...auth, ...patch };
      for (const key of ['authUrl', 'audience', 'headerPrefix'] as const) if (next[key] !== undefined && !next[key]!.trim()) delete next[key];
      if (next.callbackPort === undefined) delete next.callbackPort;
      return next;
    });
  }

  protected setPort(event: Event): void {
    const text = this.text(event).trim();
    const port = Number(text);
    this.patchOAuth({ callbackPort: text && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined });
  }

  protected isChecked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  /** Gets a token now (a new one when one is cached), signing in when the grant needs it. */
  protected async getToken(): Promise<void> {
    const auth = this.oauthAuth();
    if (!auth || this.fetching()) return;
    this.fetching.set(true);
    try {
      const result = await this.host.invoke<{ source: string; scope: string | null }>('api.oauth2.token', { auth, force: this.tokenStatus.value()?.hasToken ?? false });
      this.toasts.notify(result.source === 'cache' ? 'The cached token is still good' : 'Got a token', 'success');
    } catch (err) {
      this.toasts.error(toErrorPayload(err).message);
    } finally {
      this.fetching.set(false);
      this.tokenStatus.reload();
    }
  }

  protected async clearToken(): Promise<void> {
    const auth = this.oauthAuth();
    if (!auth) return;
    try {
      await this.host.invoke('api.oauth2.clear', { auth });
      this.toasts.notify('Token forgotten', 'success');
    } catch (err) {
      this.toasts.error(toErrorPayload(err).message);
    }
    this.tokenStatus.reload();
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected placement(event: Event): 'header' | 'query' {
    return this.text(event) as 'header' | 'query';
  }
}
