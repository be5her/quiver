/** Short, URL-safe, collision-resistant id. Works in Node and browsers. */
export function newId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}
