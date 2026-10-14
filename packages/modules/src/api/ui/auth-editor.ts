import { Component, model } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import type { RequestAuth } from '@quiver/core';
import { Input, Label, Select, VariableInput } from '@quiver/ui';

type Auth<T extends RequestAuth['type']> = Extract<RequestAuth, { type: T }>;

/** How the request authenticates: none, a bearer token, basic credentials or an API key. Bind with `[formField]`. */
@Component({
  selector: 'q-auth-editor',
  imports: [Input, Label, Select, VariableInput],
  templateUrl: './auth-editor.html',
  host: { class: 'flex flex-col gap-3 max-w-lg' },
})
export class AuthEditor implements FormValueControl<RequestAuth> {
  readonly value = model.required<RequestAuth>();

  protected readonly tokenSyntax = '{{token}}';
  protected readonly variableSyntax = '{{name}}';

  /** Switching the type starts that type's fields from scratch. */
  protected setType(event: Event): void {
    const type = (event.target as HTMLSelectElement).value as RequestAuth['type'];
    switch (type) {
      case 'none':
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
    this.value.update((auth) => ({ ...auth, ...patch }) as RequestAuth);
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected placement(event: Event): 'header' | 'query' {
    return this.text(event) as 'header' | 'query';
  }
}
