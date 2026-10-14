import { describe, expect, it } from 'vitest';
import { commandScore } from './command-score';

describe('commandScore', () => {
  it('scores an exact match highest and no match as zero', () => {
    expect(commandScore('Settings', 'Settings')).toBe(1);
    expect(commandScore('Settings', 'xyz')).toBe(0);
  });

  it('ignores case, at a tiny cost', () => {
    const exact = commandScore('Settings', 'Set');
    const lower = commandScore('Settings', 'set');
    expect(lower).toBeGreaterThan(0);
    expect(lower).toBeLessThan(exact);
  });

  it('prefers matches at word starts over matches inside words', () => {
    expect(commandScore('Open folder as workspace', 'ofw')).toBeGreaterThan(commandScore('Toggle bottom panel', 'ofw'));
    expect(commandScore('New API request', 'req')).toBeGreaterThan(commandScore('Prerequisites', 'req'));
  });

  it('ranks a prefix above the same letters later on', () => {
    expect(commandScore('theme toggle', 'the')).toBeGreaterThan(commandScore('toggle the theme', 'the'));
  });

  it('matches the keywords as well as the text', () => {
    expect(commandScore('Toggle light / dark theme', 'appearance')).toBe(0);
    expect(commandScore('Toggle light / dark theme', 'appearance', ['appearance'])).toBeGreaterThan(0);
  });

  it('treats dashes and spaces alike', () => {
    expect(commandScore('close-all-tabs', 'close all')).toBeGreaterThan(0);
  });
});
