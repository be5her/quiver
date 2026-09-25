import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, PALETTES, PALETTE_TOKENS, paletteCss, paletteVariables, resolvePalette } from './palettes';

describe('palettes', () => {
  it('ships the six brand palettes with unique keys', () => {
    expect(PALETTES.map((p) => p.key)).toEqual(['amber-leather', 'moss-lime', 'signal-blue', 'ember', 'slate-mint', 'graphite-red']);
  });

  it('defines every token as a hex colour in both modes', () => {
    for (const palette of PALETTES) {
      for (const mode of ['light', 'dark'] as const) {
        expect(Object.keys(palette[mode]).sort()).toEqual([...PALETTE_TOKENS].sort());
        for (const value of Object.values(palette[mode])) expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('defaults to Slate & Mint', () => {
    expect(DEFAULT_PALETTE).toBe('slate-mint');
  });

  it('falls back to the default palette for unknown keys', () => {
    expect(resolvePalette('nope').key).toBe(DEFAULT_PALETTE);
    expect(resolvePalette(undefined).key).toBe(DEFAULT_PALETTE);
    expect(resolvePalette('ember').name).toBe('Ember');
  });

  it('maps tokens to CSS custom properties for the resolved mode', () => {
    const dark = paletteVariables('signal-blue', 'dark');
    expect(Object.keys(dark)).toHaveLength(PALETTE_TOKENS.length);
    expect(dark['--accent']).toBe(resolvePalette('signal-blue').dark.accent);
    expect(paletteVariables('signal-blue', 'light')['--canvas']).toBe(resolvePalette('signal-blue').light.canvas);
  });

  it('builds a stylesheet with a light block and a dark block that outrank styles.css', () => {
    const css = paletteCss('ember');
    const ember = resolvePalette('ember');
    expect(css).toContain(`html:root {\n  --canvas: ${ember.light.canvas};`);
    expect(css).toContain(`html:root.dark {\n  --canvas: ${ember.dark.canvas};`);
    expect(css.match(/--accent:/g)).toHaveLength(2);
  });
});
