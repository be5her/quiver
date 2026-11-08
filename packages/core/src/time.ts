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

/** The same in a few characters, for narrow lists: "now", "45s", "3m", "2h", "5d", "4mo", "1y". Future times read as now. */
export function shortRelativeTime(diffMs: number): string {
  const abs = -diffMs;
  if (abs < 1e3) return 'now';
  for (const [name, size] of UNITS) {
    if (abs >= size) return `${Math.floor(abs / size)}${SHORT_UNITS[name]}`;
  }
  return 'now';
}

const SHORT_UNITS: Record<string, string> = { year: 'y', month: 'mo', day: 'd', hour: 'h', minute: 'm', second: 's' };
