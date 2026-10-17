import { describe, expect, it } from 'vitest';
import { extensionFor, responseFileName } from './response-file';

describe('responseFileName', () => {
  it('uses the last path segment, adding the extension of the content type', () => {
    expect(responseFileName('https://x.test/api/users?page=2', 'application/json; charset=utf-8')).toBe('users.json');
    expect(responseFileName('https://x.test/files/report.pdf', 'application/pdf')).toBe('report.pdf');
    expect(responseFileName('https://x.test/img/logo', 'image/png')).toBe('logo.png');
  });

  it('falls back to response with an extension', () => {
    expect(responseFileName('https://x.test/', 'text/html')).toBe('response.html');
    expect(responseFileName('nonsense', null)).toBe('response.txt');
  });

  it('keeps a name without a known type and replaces characters a file name cannot hold', () => {
    expect(responseFileName('https://x.test/a%3Ab', null)).toBe('a_b');
  });
});

describe('extensionFor', () => {
  it('maps common types', () => {
    expect(extensionFor('image/svg+xml')).toBe('svg');
    expect(extensionFor('application/problem+json')).toBe('json');
    expect(extensionFor('application/x-thing')).toBeNull();
  });
});
