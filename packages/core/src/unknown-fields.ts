import type { z } from 'zod';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The schema under optional, nullable, default, lazy, transforms and the like: the one that says what the value looks like. */
function unwrap(schema: z.ZodType): z.ZodType {
  for (;;) {
    const def = schema.def as { type: string; innerType?: z.ZodType; in?: z.ZodType; getter?: () => z.ZodType };
    if (def.innerType) schema = def.innerType;
    else if (def.type === 'pipe' && def.in) schema = def.in;
    else if (def.type === 'lazy' && def.getter) schema = def.getter();
    else return schema;
  }
}

/**
 * `next` with the fields of `previous` that `schema` does not know put back, at every depth.
 *
 * A save parses what it is given through the item's schema, which drops fields it does not know: a request saved
 * by this version would lose what a newer Quiver wrote into the same committed file. Only fields of `previous` that
 * the schema has no key for come back, so a known field that `next` leaves out stays out, and nothing that was not
 * already in the file is added. Objects match by key, array items by their `id`, and a union only when one of its
 * options fits both values (a body that changed type keeps nothing of the old one). Strict objects get nothing back.
 */
export function keepUnknownFields<T>(schema: z.ZodType, previous: unknown, next: T): T {
  if (previous === undefined || previous === null || next === undefined || next === null) return next;
  const def = unwrap(schema).def as { type: string } & Record<string, unknown>;
  switch (def.type) {
    case 'object': {
      if (!isObject(previous) || !isObject(next)) return next;
      const shape = def['shape'] as Record<string, z.ZodType>;
      const out: Json = { ...next };
      for (const [key, value] of Object.entries(next)) {
        if (Object.hasOwn(shape, key) && Object.hasOwn(previous, key)) out[key] = keepUnknownFields(shape[key], previous[key], value);
      }
      // A loose or strict object decides about other keys itself.
      if (def['catchall'] === undefined) {
        for (const [key, value] of Object.entries(previous)) {
          if (!Object.hasOwn(shape, key) && !Object.hasOwn(next, key)) out[key] = value;
        }
      }
      return out as T;
    }
    case 'array': {
      if (!Array.isArray(previous) || !Array.isArray(next)) return next;
      const element = def['element'] as z.ZodType;
      const byId = new Map<string, unknown>();
      for (const item of previous) if (isObject(item) && typeof item['id'] === 'string') byId.set(item['id'], item);
      if (!byId.size) return next;
      return next.map((item: unknown) => (isObject(item) && typeof item['id'] === 'string' ? keepUnknownFields(element, byId.get(item['id']), item) : item)) as T;
    }
    case 'record': {
      if (!isObject(previous) || !isObject(next)) return next;
      const valueType = def['valueType'] as z.ZodType;
      const out: Json = { ...next };
      for (const [key, value] of Object.entries(next)) if (Object.hasOwn(previous, key)) out[key] = keepUnknownFields(valueType, previous[key], value);
      return out as T;
    }
    case 'union': {
      const option = (def['options'] as z.ZodType[]).find((o) => o.safeParse(next).success && o.safeParse(previous).success);
      return option ? keepUnknownFields(option, previous, next) : next;
    }
    default:
      return next;
  }
}
