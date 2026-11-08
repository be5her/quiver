import { describe, expect, it } from 'vitest';
import { relativeTime, shortRelativeTime } from './time';

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

describe('shortRelativeTime', () => {
  it('fits a narrow list', () => {
    expect(shortRelativeTime(-500)).toBe('now');
    expect(shortRelativeTime(-45e3)).toBe('45s');
    expect(shortRelativeTime(-3 * 60e3 - 59e3)).toBe('3m');
    expect(shortRelativeTime(-2 * 3600e3)).toBe('2h');
    expect(shortRelativeTime(-5 * 24 * 3600e3)).toBe('5d');
    expect(shortRelativeTime(-400 * 24 * 3600e3)).toBe('1y');
  });

  it('reads a time a little ahead of the clock as now', () => {
    expect(shortRelativeTime(5_000)).toBe('now');
  });
});
