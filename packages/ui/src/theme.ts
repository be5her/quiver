import { paletteCss, type GlobalConfig } from '@quiver/core';
import { useAppStore } from './stores/app';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function resolveTheme(pref: GlobalConfig['theme']): 'light' | 'dark' {
  if (pref === 'system') return media().matches ? 'dark' : 'light';
  return pref;
}

/** Applies the light/dark mode and the colour palette (the saved one unless given) to the document. */
export function applyTheme(pref: GlobalConfig['theme'], palette: string | undefined = useAppStore.getState().config?.palette): void {
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  applyPalette(palette);
  useAppStore.getState().setResolvedTheme(resolved);
}

function applyPalette(palette: string | undefined): void {
  let style = document.getElementById('quiver-palette');
  if (!style) {
    style = document.createElement('style');
    style.id = 'quiver-palette';
    document.head.appendChild(style);
  }
  style.dataset.palette = palette ?? '';
  const css = paletteCss(palette);
  if (style.textContent !== css) style.textContent = css;
}

/** Keep the resolved theme in sync with the OS while the preference is "system". */
export function watchSystemTheme(getPref: () => GlobalConfig['theme']): () => void {
  const mq = media();
  const listener = () => {
    if (getPref() === 'system') applyTheme('system');
  };
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}
