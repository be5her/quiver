/**
 * Colour palettes from the Quiver brand package (themes/themes.json, schema quiver-theme/1).
 * Each palette has a light and a dark token set with the names styles.css defines; light-mode
 * accents are darkened from the brand accent to reach 4.5:1 on the light canvas.
 */

export const PALETTE_TOKENS = ['canvas', 'surface', 'elevated', 'fg', 'muted', 'edge', 'accent', 'accent-hover', 'accent-fg', 'danger', 'success', 'warning'] as const;
export type PaletteToken = (typeof PALETTE_TOKENS)[number];
export type PaletteTokens = Record<PaletteToken, string>;

export interface Palette {
  key: string;
  name: string;
  /** Raw brand colours, as used by the app icon. */
  brand: { accent: string; secondary: string; ink: string; paper: string; ground: string };
  light: PaletteTokens;
  dark: PaletteTokens;
}

export const PALETTES = [
  {
    key: 'amber-leather',
    name: 'Amber Leather',
    brand: {
      accent: '#e8a23a',
      secondary: '#b8652e',
      ink: '#1b1d23',
      paper: '#f5f3ee',
      ground: '#15171c',
    },
    light: {
      canvas: '#f5f3ee',
      surface: '#edece7',
      elevated: '#e4e2de',
      fg: '#1b1d23',
      muted: '#6b6760',
      edge: '#d6d5d2',
      accent: '#926610',
      'accent-hover': '#72500c',
      'accent-fg': '#ffffff',
      danger: '#dc2626',
      success: '#15803d',
      warning: '#b45309',
    },
    dark: {
      canvas: '#15171c',
      surface: '#1d1f23',
      elevated: '#27292d',
      fg: '#f5f3ee',
      muted: '#909090',
      edge: '#343639',
      accent: '#e8a23a',
      'accent-hover': '#ecb15a',
      'accent-fg': '#1b1d23',
      danger: '#f87171',
      success: '#4ade80',
      warning: '#fbbf24',
    },
  },
  {
    key: 'moss-lime',
    name: 'Moss & Lime',
    brand: {
      accent: '#9be05b',
      secondary: '#3c8c5f',
      ink: '#12261e',
      paper: '#eef3ea',
      ground: '#0f1f19',
    },
    light: {
      canvas: '#eef3ea',
      surface: '#e6ece3',
      elevated: '#dce3da',
      fg: '#12261e',
      muted: '#5c6b60',
      edge: '#cfd6cd',
      accent: '#457814',
      'accent-hover': '#33590f',
      'accent-fg': '#ffffff',
      danger: '#dc2626',
      success: '#15803d',
      warning: '#b45309',
    },
    dark: {
      canvas: '#0f1f19',
      surface: '#172620',
      elevated: '#203029',
      fg: '#e9f1e6',
      muted: '#87928a',
      edge: '#2e3c36',
      accent: '#9be05b',
      'accent-hover': '#ade679',
      'accent-fg': '#12261e',
      danger: '#f87171',
      success: '#4ade80',
      warning: '#fbbf24',
    },
  },
  {
    key: 'signal-blue',
    name: 'Signal Blue',
    brand: {
      accent: '#4f7df3',
      secondary: '#9cc3ff',
      ink: '#0f1b33',
      paper: '#edf1f8',
      ground: '#0b1630',
    },
    light: {
      canvas: '#edf1f8',
      surface: '#e5eaf1',
      elevated: '#dbe0e8',
      fg: '#0f1b33',
      muted: '#5a6478',
      edge: '#ced3dc',
      accent: '#2c61f3',
      'accent-hover': '#0e49ee',
      'accent-fg': '#ffffff',
      danger: '#dc2626',
      success: '#15803d',
      warning: '#b45309',
    },
    dark: {
      canvas: '#0b1630',
      surface: '#131e37',
      elevated: '#1d2740',
      fg: '#e9eef9',
      muted: '#858d9f',
      edge: '#2a344c',
      accent: '#4f7df3',
      'accent-hover': '#7096f5',
      'accent-fg': '#0f1b33',
      danger: '#f87171',
      success: '#4ade80',
      warning: '#fbbf24',
    },
  },
  {
    key: 'ember',
    name: 'Ember',
    brand: {
      accent: '#f06a4d',
      secondary: '#ffb39a',
      ink: '#241b1c',
      paper: '#f7f1ee',
      ground: '#1b1516',
    },
    light: {
      canvas: '#f7f1ee',
      surface: '#f0eae7',
      elevated: '#e6e0dd',
      fg: '#241b1c',
      muted: '#736460',
      edge: '#d9d3d1',
      accent: '#cf320f',
      'accent-hover': '#ae2a0d',
      'accent-fg': '#ffffff',
      danger: '#dc2626',
      success: '#15803d',
      warning: '#b45309',
    },
    dark: {
      canvas: '#1b1516',
      surface: '#231d1d',
      elevated: '#2c2627',
      fg: '#f5ece8',
      muted: '#938b8a',
      edge: '#3a3333',
      accent: '#f06a4d',
      'accent-hover': '#f3866e',
      'accent-fg': '#241b1c',
      danger: '#f87171',
      success: '#4ade80',
      warning: '#fbbf24',
    },
  },
  {
    key: 'slate-mint',
    name: 'Slate & Mint',
    brand: {
      accent: '#2dd4a8',
      secondary: '#178c6e',
      ink: '#171c22',
      paper: '#eef1f3',
      ground: '#14181d',
    },
    light: {
      canvas: '#eef1f3',
      surface: '#e6eaec',
      elevated: '#dde0e2',
      fg: '#171c22',
      muted: '#5b646c',
      edge: '#d0d3d6',
      accent: '#157961',
      'accent-hover': '#105b49',
      'accent-fg': '#ffffff',
      danger: '#dc2626',
      success: '#15803d',
      warning: '#b45309',
    },
    dark: {
      canvas: '#14181d',
      surface: '#1c2024',
      elevated: '#25292e',
      fg: '#edf1f3',
      muted: '#8b8f93',
      edge: '#32363b',
      accent: '#2dd4a8',
      'accent-hover': '#4bdab4',
      'accent-fg': '#171c22',
      danger: '#f87171',
      success: '#4ade80',
      warning: '#fbbf24',
    },
  },
  {
    key: 'graphite-red',
    name: 'Graphite & Red',
    brand: {
      accent: '#e8352b',
      secondary: '#8a8a8a',
      ink: '#111111',
      paper: '#fafafa',
      ground: '#111111',
    },
    light: {
      canvas: '#fafafa',
      surface: '#f2f2f2',
      elevated: '#e7e7e7',
      fg: '#111111',
      muted: '#666666',
      edge: '#d9d9d9',
      accent: '#dd2317',
      'accent-hover': '#bd1e14',
      'accent-fg': '#ffffff',
      danger: '#dc2626',
      success: '#15803d',
      warning: '#b45309',
    },
    dark: {
      canvas: '#111111',
      surface: '#191919',
      elevated: '#242424',
      fg: '#fafafa',
      muted: '#919191',
      edge: '#323232',
      accent: '#e83930',
      'accent-hover': '#ec5850',
      'accent-fg': '#111111',
      danger: '#f87171',
      success: '#4ade80',
      warning: '#fbbf24',
    },
  },
] as const satisfies readonly Palette[];

export type PaletteKey = (typeof PALETTES)[number]['key'];

export const DEFAULT_PALETTE: PaletteKey = 'slate-mint';

/** The palette for a key, falling back to the default for unknown keys (a hand-edited config, a palette removed later). */
export function resolvePalette(key: string | undefined): Palette {
  return PALETTES.find((p) => p.key === key) ?? PALETTES.find((p) => p.key === DEFAULT_PALETTE)!;
}

/** CSS custom properties ('--accent' and friends) for a palette in one mode. */
export function paletteVariables(key: string | undefined, mode: 'light' | 'dark'): Record<string, string> {
  const tokens = resolvePalette(key)[mode];
  return Object.fromEntries(PALETTE_TOKENS.map((name) => [`--${name}`, tokens[name]]));
}

/**
 * A stylesheet setting a palette's tokens for both modes. The selectors outrank the `:root` and
 * `.dark` blocks of styles.css whatever the load order, and the mode still follows the `dark` class.
 */
export function paletteCss(key: string | undefined): string {
  const block = (selector: string, mode: 'light' | 'dark') => {
    const lines = Object.entries(paletteVariables(key, mode)).map(([name, value]) => `  ${name}: ${value};`);
    return `${selector} {\n${lines.join('\n')}\n}\n`;
  };
  return block('html:root', 'light') + block('html:root.dark', 'dark');
}
