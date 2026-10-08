import { computed, effect, inject, signal, untracked, type Signal } from '@angular/core';
import type { ApiRequest, GraphqlSchemaDoc } from '@quiver/core';
import { HostBridge, Toasts } from '@quiver/ui';
import { buildSchema, type GraphQLSchema } from 'graphql';

/** Built schemas keyed by SDL text, shared by every editor and explorer showing the same endpoint. */
const built = new Map<string, GraphQLSchema | null>();

export function schemaFromDoc(doc: GraphqlSchemaDoc | null | undefined): GraphQLSchema | null {
  if (!doc) return null;
  if (!built.has(doc.sdl)) {
    try {
      built.set(doc.sdl, buildSchema(doc.sdl, { assumeValidSDL: true }));
    } catch {
      built.set(doc.sdl, null);
    }
  }
  return built.get(doc.sdl) ?? null;
}

export interface GraphqlSchemaState {
  readonly doc: Signal<GraphqlSchemaDoc | null>;
  readonly schema: Signal<GraphQLSchema | null>;
  readonly fetching: Signal<boolean>;
  /** Run the introspection query against the request's URL with its headers and auth. */
  fetch(): Promise<GraphqlSchemaDoc | null>;
}

/**
 * The cached schema of the request's endpoint, looked up again when the URL settles, plus a way to
 * introspect. Call in an injection context.
 */
export function graphqlSchemaState(request: () => ApiRequest): GraphqlSchemaState {
  const host = inject(HostBridge);
  const toasts = inject(Toasts);
  const doc = signal<GraphqlSchemaDoc | null>(null);
  const fetching = signal(false);
  // Only the endpoint matters for the lookup; headers and auth matter for fetching.
  const endpoint = computed(() => `${request().id} ${request().url}`);

  effect((onCleanup) => {
    endpoint();
    let cancelled = false;
    const timer = setTimeout(() => {
      host
        .invoke<GraphqlSchemaDoc | null>('api.graphql.schema', { request: untracked(request) })
        .then((d) => !cancelled && doc.set(d))
        .catch(() => !cancelled && doc.set(null));
    }, 400);
    onCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });
  });

  const fetch = async (): Promise<GraphqlSchemaDoc | null> => {
    fetching.set(true);
    try {
      const d = await host.invoke<GraphqlSchemaDoc>('api.graphql.introspect', { request: untracked(request) });
      doc.set(d);
      return d;
    } catch (err) {
      toasts.error(err);
      return null;
    } finally {
      fetching.set(false);
    }
  };

  return { doc: doc.asReadonly(), schema: computed(() => schemaFromDoc(doc())), fetching: fetching.asReadonly(), fetch };
}
