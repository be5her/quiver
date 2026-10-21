import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl } from './external-url';

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
    for (const url of ['', 'github.com', '/relative/path', 'C:\Windows\notepad.exe', '\\host\share']) {
      expect(isSafeExternalUrl(url)).toBe(false);
    }
  });
});
