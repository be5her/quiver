import { describe, expect, it } from 'vitest';
import { relativeTime } from './time';

describe('relativeTime', () => {
  it('says how far and which way', () => {
    expect(relativeTime(-3 * 60e3)).toBe('3 minutes ago');
    expect(relativeTime(2 * 3600e3)).toBe('2 hours from now');
    expect(relativeTime(-1000)).toBe('1 second ago');
    expect(relativeTime(400 * 24 * 3600e3)).toBe('1 year from now');
  });

  it('calls anything under a second now', () => {
    expect(relativeTime(0)).toBe('now');
    expect(relativeTime(-999)).toBe('now');
  });
});
