import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl, safeExternalUrl, urlScheme } from './external-url';

describe('isSafeExternalUrl', () => {
  it('allows web pages and mail', () => {
    for (const url of ['https://github.com/be5her/quiver/pull/1', 'http://localhost:3000/x?y=1', 'HTTPS://EXAMPLE.COM', 'mailto:someone@example.com']) {
      expect(isSafeExternalUrl(url)).toBe(true);
    }
  });

  it('refuses schemes that open local programs or files', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'ms-settings:privacy',
      'smb://host/share/run.exe',
      'vscode://file/c:/x',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'search-ms:query=x',
    ]) {
      expect(isSafeExternalUrl(url)).toBe(false);
    }
  });

  it('refuses what is not an absolute URL', () => {
    for (const url of ['', 'github.com', '/relative/path', String.raw`C:\Windows\notepad.exe`, String.raw`\\host\share\run.exe`]) {
      expect(isSafeExternalUrl(url)).toBe(false);
    }
  });

  it('gives back the link as the parser read it, which is what the system gets', () => {
    // Spaces and control characters around the link and tabs or line breaks inside it pass the check; the system's
    // handler must not see the raw text.
    expect(safeExternalUrl(' \thttps://example.com/a b')).toBe('https://example.com/a%20b');
    expect(safeExternalUrl('ht\ntps://example.com')).toBe('https://example.com/');
    expect(safeExternalUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com');
    expect(safeExternalUrl('fi\tle:///C:/x.exe')).toBeNull();
  });

  it('names the scheme of a refused link without the rest of it', () => {
    expect(urlScheme('VSCODE://file/x?token=secret')).toBe('vscode:');
    expect(urlScheme('  ms-settings:privacy')).toBe('ms-settings:');
    expect(urlScheme('/relative/path')).toBeNull();
  });
});
