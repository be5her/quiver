import { Component, computed, inject, input, model } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import { baseName, contentTypeFor, type ApiRequest, type FormField, type KeyValue, type RequestBody } from '@quiver/core';
import { Button, Checkbox, CodeEditor, Icon, IconButton, KeyValueEditor, Select, Toasts, formatBytes, invokeResource, type KeyValueExtraContext } from '@quiver/ui';
import { FolderOpen } from 'lucide';
import { ApiActions } from './api-actions';
import { GraphqlEditor, type GraphqlBody } from './graphql-editor';

const BODY_TYPES: { value: RequestBody['type']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'xml', label: 'XML' },
  { value: 'urlencoded', label: 'Form URL-encoded' },
  { value: 'form', label: 'Multipart form' },
  { value: 'binary', label: 'Binary file' },
  { value: 'graphql', label: 'GraphQL' },
];

type ContentBody = Extract<RequestBody, { content: string }>;
type UrlencodedBody = Extract<RequestBody, { type: 'urlencoded' }>;
type FormBody = Extract<RequestBody, { type: 'form' }>;
type BinaryBody = Extract<RequestBody, { type: 'binary' }>;

interface FileInfo {
  exists: boolean;
  size: number | null;
  relative: string | null;
  abs: string | null;
}

/**
 * The request body: its type, then raw content, form fields (multipart ones may be files), a file
 * sent as it is, or a GraphQL query. Bind with `[formField]`.
 */
@Component({
  selector: 'q-body-editor',
  imports: [Button, Checkbox, CodeEditor, GraphqlEditor, Icon, IconButton, KeyValueEditor, Select],
  templateUrl: './body-editor.html',
  host: { class: 'flex flex-col h-full gap-2' },
})
export class BodyEditor implements FormValueControl<RequestBody> {
  private readonly api = inject(ApiActions);
  private readonly toasts = inject(Toasts);

  readonly value = model.required<RequestBody>();
  readonly request = input.required<ApiRequest>();

  protected readonly types = BODY_TYPES;
  protected readonly icons = { FolderOpen };
  protected readonly formatBytes = formatBytes;
  protected readonly content = computed<ContentBody | null>(() => {
    const body = this.value();
    return 'content' in body ? body : null;
  });
  protected readonly urlencoded = computed<UrlencodedBody | null>(() => {
    const body = this.value();
    return body.type === 'urlencoded' ? body : null;
  });
  protected readonly form = computed<FormBody | null>(() => {
    const body = this.value();
    return body.type === 'form' ? body : null;
  });
  protected readonly binary = computed<BinaryBody | null>(() => {
    const body = this.value();
    return body.type === 'binary' ? body : null;
  });
  protected readonly graphql = computed<GraphqlBody | null>(() => {
    const body = this.value();
    return body.type === 'graphql' ? body : null;
  });
  protected readonly language = computed(() => {
    const type = this.value().type;
    return type === 'json' ? 'json' : type === 'xml' ? 'xml' : 'text';
  });
  protected readonly jsonPlaceholder = '{\n  "key": "value"\n}';
  /** The binary body's file: whether it exists and how big it is. */
  protected readonly binaryFile = invokeResource<FileInfo>('api.file.stat', () => ({ path: this.binary()?.path ?? '' }));
  protected readonly binaryTypePlaceholder = computed(() => contentTypeFor(this.binary()?.path ?? ''));

  /** Switching the type carries the text or the fields over where the new type has them. */
  protected setType(event: Event): void {
    const type = (event.target as HTMLSelectElement).value as RequestBody['type'];
    const body = this.value();
    if (type === body.type) return;
    const content = 'content' in body ? body.content : body.type === 'graphql' ? body.query : '';
    const fields: KeyValue[] = 'fields' in body ? body.fields.map(({ id, key, value, enabled }) => ({ id, key, value, enabled })) : [];
    switch (type) {
      case 'none':
        return this.value.set({ type });
      case 'urlencoded':
      case 'form':
        return this.value.set({ type, fields });
      case 'binary':
        return this.value.set({ type, path: '' });
      case 'graphql':
        return this.value.set({ type, query: content, variables: '' });
      default:
        return this.value.set({ type, content });
    }
  }

  protected setContent(body: ContentBody, content: string): void {
    this.value.set({ ...body, content });
  }

  protected setUrlencoded(body: UrlencodedBody, fields: KeyValue[]): void {
    this.value.set({ ...body, fields });
  }

  protected setForm(body: FormBody, fields: FormField[]): void {
    this.value.set({ ...body, fields });
  }

  /** The File checkbox of a multipart row: a file field keeps \`kind: 'file'\`, a text one drops it. */
  protected setKind(context: KeyValueExtraContext<FormField>, event: Event): void {
    const file = (event.target as HTMLInputElement).checked;
    context.update(file ? { kind: 'file' } : { kind: undefined, fileName: undefined, contentType: undefined });
  }

  protected async browseField(context: KeyValueExtraContext<FormField>): Promise<void> {
    try {
      const path = await this.api.pickRequestFile(`File for ${context.$implicit.key || 'the field'}`);
      if (path) context.update({ value: path, kind: 'file', ...(context.$implicit.key ? {} : { key: baseName(path).replace(/\.[^.]+$/, '') }) });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected setBinaryPath(body: BinaryBody, event: Event): void {
    this.value.set({ ...body, path: (event.target as HTMLInputElement).value });
  }

  protected setBinaryType(body: BinaryBody, event: Event): void {
    const contentType = (event.target as HTMLInputElement).value;
    const next: BinaryBody = { ...body, contentType };
    if (!contentType.trim()) delete next.contentType;
    this.value.set(next);
  }

  protected async browseBinary(body: BinaryBody): Promise<void> {
    try {
      const path = await this.api.pickRequestFile('File to send as the body');
      if (path) this.value.set({ ...body, path });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected setGraphql(body: GraphqlBody): void {
    this.value.set(body);
  }
}
