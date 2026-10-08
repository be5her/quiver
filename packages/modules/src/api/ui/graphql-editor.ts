import { Component, computed, inject, input, model } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import type { ApiRequest, RequestBody } from '@quiver/core';
import { Button, CodeEditor, Label, Select, Toasts } from '@quiver/ui';
import { parse, print, type OperationDefinitionNode } from 'graphql';
import { BookOpen, RefreshCw, Sparkles } from 'lucide';
import { ApiActions } from './api-actions';
import { graphqlSchemaState } from './graphql-schema';

export type GraphqlBody = Extract<RequestBody, { type: 'graphql' }>;

function operationsOf(query: string): OperationDefinitionNode[] {
  try {
    return parse(query).definitions.filter((d): d is OperationDefinitionNode => d.kind === 'OperationDefinition');
  } catch {
    return [];
  }
}

/** The query (schema-aware once the schema is fetched), its variables, and the operation to run. Bind with `[formField]`. */
@Component({
  selector: 'q-graphql-editor',
  imports: [Button, CodeEditor, Label, Select],
  templateUrl: './graphql-editor.html',
  host: { class: 'flex flex-col h-full gap-1.5', 'data-testid': 'graphql-editor' },
})
export class GraphqlEditor implements FormValueControl<GraphqlBody> {
  private readonly toasts = inject(Toasts);
  protected readonly api = inject(ApiActions);

  readonly value = model.required<GraphqlBody>();
  readonly request = input.required<ApiRequest>();

  protected readonly icons = { BookOpen, RefreshCw, Sparkles };
  protected readonly schemaState = graphqlSchemaState(this.request);
  protected readonly queryPlaceholder = 'query {\n  \n}';
  protected readonly variablesPlaceholder = '{\n  "id": "1"\n}';
  /** The named operations of the query, one of which can be picked to run. */
  protected readonly named = computed(() =>
    operationsOf(this.value().query).flatMap((op) => (op.name?.value ? [{ name: op.name.value, operation: op.operation }] : [])),
  );
  protected readonly status = computed(() => {
    const doc = this.schemaState.doc();
    return doc ? `Schema: ${doc.typeCount} types, fetched ${new Date(doc.fetchedAt).toLocaleString()}` : 'No schema yet: fetch it for autocompletion and docs';
  });

  protected patch(patch: Partial<GraphqlBody>): void {
    this.value.update((body) => ({ ...body, ...patch }));
  }

  protected pickOperation(event: Event): void {
    this.patch({ operationName: (event.target as HTMLSelectElement).value || undefined });
  }

  /** Format the query, and the variables when they are valid JSON. */
  protected prettify(): void {
    const body = this.value();
    try {
      this.patch({ query: print(parse(body.query)) });
    } catch (err) {
      this.toasts.notify(`Cannot format: ${(err as Error).message}`, 'error');
    }
    if (body.variables.trim()) {
      try {
        this.patch({ query: print(parse(body.query)), variables: JSON.stringify(JSON.parse(body.variables), null, 2) });
      } catch {
        // leave the variables as typed
      }
    }
  }
}
