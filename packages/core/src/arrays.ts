/**
 * Move the item at `from` so that it ends up at index `to` of the result. Out-of-range indexes
 * are clamped; the input is not modified.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return [...items];
  const rest = items.filter((_, i) => i !== from);
  const at = Math.max(0, Math.min(to, rest.length));
  return [...rest.slice(0, at), items[from], ...rest.slice(at)];
}
