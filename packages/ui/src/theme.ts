import type { GlobalConfig } from '@quiver/core';
import { useAppStore } from './stores/app';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function resolveTheme(pref: GlobalConfig['theme']): 'light' | 'dark' {
  if (pref === 'system') return media().matches ? 'dark' : 'light';
  return pref;
}

export function applyTheme(pref: GlobalConfig['theme']): void {
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  useAppStore.getState().setResolvedTheme(resolved);
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
