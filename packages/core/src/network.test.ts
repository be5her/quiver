import { describe, expect, it } from 'vitest';
import { bypassesProxy, certificateFor, hostMatches, proxyFor } from './network';

describe('proxyFor', () => {
  const manual = { proxy: 'manual' as const, url: 'http://proxy.test:3128', noProxy: ['localhost', '.internal.test', '10.0.0.5:8080'] };

  it('uses the manual proxy except for hosts on the no-proxy list', () => {
    expect(proxyFor('https://api.example.com/x', manual)).toBe('http://proxy.test:3128');
    expect(proxyFor('http://localhost:3000/', manual)).toBeNull();
    expect(proxyFor('https://svc.internal.test/', manual)).toBeNull();
    expect(proxyFor('https://internal.test/', manual)).toBeNull();
    expect(proxyFor('http://10.0.0.5:8080/', manual)).toBeNull();
    expect(proxyFor('http://10.0.0.5:9090/', manual)).toBe('http://proxy.test:3128');
    expect(proxyFor('https://api.example.com/', { ...manual, url: ' ' })).toBeNull();
    expect(proxyFor('https://api.example.com/', { ...manual, proxy: 'none' })).toBeNull();
  });

  it('reads the environment for system, HTTPS_PROXY for secure URLs and NO_PROXY too', () => {
    const system = { proxy: 'system' as const, url: '', noProxy: [] };
    const env = { HTTPS_PROXY: 'http://secure.proxy:1', http_proxy: 'http://plain.proxy:2', NO_PROXY: 'skip.test, *' };
    expect(proxyFor('https://a.test/', system, { HTTPS_PROXY: 'http://secure.proxy:1', http_proxy: 'http://plain.proxy:2' })).toBe('http://secure.proxy:1');
    expect(proxyFor('ws://a.test/', system, { http_proxy: 'http://plain.proxy:2' })).toBe('http://plain.proxy:2');
    expect(proxyFor('https://a.test/', system, env)).toBeNull();
    expect(proxyFor('https://a.test/', system, {})).toBeNull();
  });

  it('matches IPv6 hosts and ports on the list', () => {
    expect(bypassesProxy(new URL('http://[::1]:8080/'), ['::1'])).toBe(true);
    expect(bypassesProxy(new URL('https://example.com/'), ['example.com:443'])).toBe(true);
    expect(bypassesProxy(new URL('https://notexample.com/'), ['example.com'])).toBe(false);
  });
});

describe('certificateFor', () => {
  const certs = [
    { id: 'wild', hostPattern: '*.example.com' },
    { id: 'exact', hostPattern: 'api.example.com' },
    { id: 'port', hostPattern: 'api.example.com:8443' },
  ];

  it('picks the most specific matching pattern', () => {
    expect(certificateFor('https://api.example.com/x', certs)?.id).toBe('exact');
    expect(certificateFor('https://api.example.com:8443/x', certs)?.id).toBe('port');
    expect(certificateFor('https://other.example.com/', certs)?.id).toBe('wild');
    expect(certificateFor('https://example.com/', certs)).toBeNull();
    expect(certificateFor('not a url', certs)).toBeNull();
  });

  it('compares ports with the scheme default', () => {
    expect(hostMatches('https://a.test/', 'a.test:443')).toBe(true);
    expect(hostMatches('http://a.test/', 'a.test:443')).toBe(false);
  });
});
