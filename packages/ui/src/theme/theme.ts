import { DOCUMENT, DestroyRef, Service, inject, untracked } from '@angular/core';
import { paletteCss, type GlobalConfig } from '@quiver/core';
import { AppState } from '../state/app-state';

type ThemePreference = GlobalConfig['theme'];

/**
 * Light or dark mode plus the colour palette. The mode is the `dark` class on the document; the
 * palette is a `<style id="quiver-palette">` whose selectors outrank styles.css, so the mode still
 * follows the class.
 */
@Service()
export class Theme {
  private readonly app = inject(AppState);
  private readonly document = inject(DOCUMENT);
  private readonly media = this.document.defaultView!.matchMedia('(prefers-color-scheme: dark)');

  resolve(preference: ThemePreference): 'light' | 'dark' {
    if (preference === 'system') return this.media.matches ? 'dark' : 'light';
    return preference;
  }

  /** Applies the mode and the palette (the saved one unless given) to the document. */
  apply(preference: ThemePreference, palette: string | undefined = untracked(this.app.config)?.palette): void {
    const resolved = this.resolve(preference);
    const root = this.document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    root.style.colorScheme = resolved;
    this.applyPalette(palette);
    this.app.resolvedTheme.set(resolved);
  }

  /** Keep the mode in step with the OS while the preference is "system", until `destroyRef` is destroyed. */
  followSystem(destroyRef: DestroyRef): void {
    const listener = () => {
      if ((untracked(this.app.config)?.theme ?? 'system') === 'system') this.apply('system');
    };
    this.media.addEventListener('change', listener);
    destroyRef.onDestroy(() => this.media.removeEventListener('change', listener));
  }

  private applyPalette(palette: string | undefined): void {
    let style = this.document.getElementById('quiver-palette');
    if (!style) {
      style = this.document.createElement('style');
      style.id = 'quiver-palette';
      this.document.head.appendChild(style);
    }
    style.dataset['palette'] = palette ?? '';
    const css = paletteCss(palette);
    if (style.textContent !== css) style.textContent = css;
  }
}
