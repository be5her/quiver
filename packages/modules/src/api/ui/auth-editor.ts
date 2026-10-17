import { Component, computed, input, model } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import type { ApiAuth, RequestAuth } from '@quiver/core';
import { Input, Label, Select, VariableInput } from '@quiver/ui';

type Auth<T extends RequestAuth['type']> = Extract<RequestAuth, { type: T }>;

/** What `inherit` resolves to where the editor is used, and where that comes from. */
export interface InheritedAuthInfo {
  resolved: RequestAuth;
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
  imports: [Input, Label, Select, VariableInput],
  templateUrl: './auth-editor.html',
  host: { class: 'flex flex-col gap-3 max-w-lg' },
})
export class AuthEditor implements FormValueControl<ApiAuth> {
  readonly value = model.required<ApiAuth>();
  /** Offers "Inherit from …" and says what it resolves to. Requests and collections pass it; realtime and MCP do not. */
  readonly inherit = input<InheritedAuthInfo | null>(null);

  protected readonly inheritedText = computed(() => {
    const info = this.inherit();
    if (!info?.from) return `Nothing above sets auth, so this sends none.`;
    const auth = info.resolved;
    const what =
      auth.type === 'bearer' ? 'A bearer token' : auth.type === 'basic' ? `Basic auth as ${auth.username || '(no user)'}` : auth.type === 'apikey' ? `The API key ${auth.key} in the ${auth.in}` : 'No auth';
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
    }
  }

  /** Change some fields of the current auth, keeping its type. */
  protected patch(patch: Partial<Auth<'bearer'> | Auth<'basic'> | Auth<'apikey'>>): void {
    this.value.update((auth) => ({ ...auth, ...patch }) as ApiAuth);
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected placement(event: Event): 'header' | 'query' {
    return this.text(event) as 'header' | 'query';
  }
}
