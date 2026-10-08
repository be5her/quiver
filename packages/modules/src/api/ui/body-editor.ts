import { Component, computed, input, model } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import type { ApiRequest, KeyValue, RequestBody } from '@quiver/core';
import { CodeEditor, KeyValueEditor, Select, type CodeLanguage } from '@quiver/ui';
import { GraphqlEditor, type GraphqlBody } from './graphql-editor';

const BODY_TYPES: { value: RequestBody['type']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'xml', label: 'XML' },
  { value: 'urlencoded', label: 'Form URL-encoded' },
  { value: 'form', label: 'Multipart form' },
  { value: 'graphql', label: 'GraphQL' },
];

type ContentBody = Extract<RequestBody, { content: string }>;
type FieldsBody = Extract<RequestBody, { fields: KeyValue[] }>;

/** The request body: its type, then raw content, form fields or a GraphQL query. Bind with `[formField]`. */
@Component({
  selector: 'q-body-editor',
  imports: [CodeEditor, GraphqlEditor, KeyValueEditor, Select],
  templateUrl: './body-editor.html',
  host: { class: 'flex flex-col h-full gap-2' },
})
export class BodyEditor implements FormValueControl<RequestBody> {
  readonly value = model.required<RequestBody>();
  readonly request = input.required<ApiRequest>();

  protected readonly types = BODY_TYPES;
  protected readonly content = computed<ContentBody | null>(() => {
    const body = this.value();
    return 'content' in body ? body : null;
  });
  protected readonly fields = computed<FieldsBody | null>(() => {
    const body = this.value();
    return 'fields' in body ? body : null;
  });
  protected readonly graphql = computed<GraphqlBody | null>(() => {
    const body = this.value();
    return body.type === 'graphql' ? body : null;
  });
  protected readonly language = computed<CodeLanguage>(() => {
    const type = this.value().type;
    return type === 'json' ? 'json' : type === 'xml' ? 'xml' : 'text';
  });
  protected readonly jsonPlaceholder = '{\n  "key": "value"\n}';

  /** Switching the type carries the text or the fields over where the new type has them. */
  protected setType(event: Event): void {
    const type = (event.target as HTMLSelectElement).value as RequestBody['type'];
    const body = this.value();
    if (type === body.type) return;
    const content = 'content' in body ? body.content : body.type === 'graphql' ? body.query : '';
    const fields: KeyValue[] = 'fields' in body ? body.fields : [];
    switch (type) {
      case 'none':
        return this.value.set({ type });
      case 'urlencoded':
      case 'form':
        return this.value.set({ type, fields });
      case 'graphql':
        return this.value.set({ type, query: content, variables: '' });
      default:
        return this.value.set({ type, content });
    }
  }

  protected setContent(body: ContentBody, content: string): void {
    this.value.set({ ...body, content });
  }

  protected setFields(body: FieldsBody, fields: KeyValue[]): void {
    this.value.set({ ...body, fields });
  }

  protected setGraphql(body: GraphqlBody): void {
    this.value.set(body);
  }
}
