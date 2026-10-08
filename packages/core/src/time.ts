const UNITS: [string, number][] = [
  ['year', 365 * 24 * 3600e3],
  ['month', 30 * 24 * 3600e3],
  ['day', 24 * 3600e3],
  ['hour', 3600e3],
  ['minute', 60e3],
  ['second', 1e3],
];

/** A time difference in words: "3 minutes ago" for a negative one, "2 hours from now" for a positive one. */
export function relativeTime(diffMs: number): string {
  const abs = Math.abs(diffMs);
  for (const [name, size] of UNITS) {
    if (abs >= size) {
      const n = Math.round(abs / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ${diffMs < 0 ? 'ago' : 'from now'}`;
    }
  }
  return 'now';
}
