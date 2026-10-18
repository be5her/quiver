/** How requests reach the network: directly, through the proxy the environment names, or through one set here. */
export interface NetworkConfig {
  proxy: 'none' | 'system' | 'manual';
  /** The manual proxy, `http://host:port`. */
  url: string;
  /** Hosts reached directly: `localhost`, `.internal.example.com` (and its subdomains), `10.0.0.5:8080`, `*` for all. */
  noProxy: string[];
  /** Proxy authentication: the user name here, the password encrypted per machine. */
  username: string;
  passwordCipher: string;
}

export function defaultNetworkConfig(): NetworkConfig {
  return { proxy: 'none', url: '', noProxy: ['localhost', '127.0.0.1', '::1'], username: '', passwordCipher: '' };
}

/** The proxy environment variables, as `system` reads them (upper or lower case). */
export interface ProxyEnv {
  HTTPS_PROXY?: string;
  HTTP_PROXY?: string;
  NO_PROXY?: string;
  https_proxy?: string;
  http_proxy?: string;
  no_proxy?: string;
}

/** `host:port`, `[v6]:port` or a bare host (an IPv6 address has more than one colon), lower-cased. */
function splitHostPort(entry: string): { host: string; port: string | undefined } {
  const text = entry.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] };
  if ((text.match(/:/g) ?? []).length > 1) return { host: text, port: undefined };
  const m = /^(.*?)(?::(\d+))?$/.exec(text)!;
  return { host: m[1], port: m[2] };
}

/** Whether a host (with its port) is one of the `noProxy` entries. */
export function bypassesProxy(url: URL, noProxy: string[]): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
  return noProxy.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry === '*') return true;
    const { host: pattern, port: entryPort } = splitHostPort(entry);
    if (entryPort && entryPort !== port) return false;
    const bare = pattern.replace(/^\*?\./, '');
    return host === bare || host.endsWith(`.${bare}`);
  });
}

/**
 * The proxy a request to `target` goes through, or null for a direct connection: the manual one,
 * or for `system` the HTTPS_PROXY (for https and wss) or HTTP_PROXY variable, both minding the
 * no-proxy list.
 */
export function proxyFor(target: string, network: Pick<NetworkConfig, 'proxy' | 'url' | 'noProxy'>, env: ProxyEnv = {}): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (network.proxy === 'none') return null;
  if (network.proxy === 'manual') {
    const proxy = network.url.trim();
    return proxy && !bypassesProxy(url, network.noProxy) ? proxy : null;
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const proxy = (secure ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy) : (env.HTTP_PROXY ?? env.http_proxy))?.trim();
  if (!proxy) return null;
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').concat(network.noProxy);
  return bypassesProxy(url, noProxy) ? null : proxy;
}

/** A client certificate for the hosts matching `hostPattern`, from files on this machine. */
export interface ClientCertificate {
  id: string;
  /** `api.example.com`, `*.example.com` (subdomains), optionally with `:port`. */
  hostPattern: string;
  certPath: string;
  keyPath: string;
  /** A PKCS#12 bundle instead of the PEM certificate and key. */
  pfxPath: string;
  /** Encrypted per machine; empty when there is none. */
  passphraseCipher: string;
  /** Extra CA certificates to trust for these hosts (a private CA), added to the system roots rather than put in their place. */
  caPath: string;
}

/** Whether a URL's host (and port) matches a certificate's host pattern. */
export function hostMatches(target: string, pattern: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  const { host: hostPattern, port } = splitHostPort(pattern);
  if (!hostPattern) return false;
  const actualPort = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
  if (port && port !== actualPort) return false;
  const host = url.hostname.toLowerCase();
  if (hostPattern.startsWith('*.')) return host.endsWith(hostPattern.slice(1)) && host.length > hostPattern.length - 1;
  return host === hostPattern;
}

/** The certificate for a URL: the most specific matching pattern (an exact host before a wildcard, a port before none). */
export function certificateFor<C extends Pick<ClientCertificate, 'hostPattern'>>(target: string, certificates: C[]): C | null {
  const score = (c: C) => (c.hostPattern.includes(':') ? 2 : 0) + (c.hostPattern.trim().startsWith('*.') ? 0 : 1);
  return certificates.filter((c) => hostMatches(target, c.hostPattern)).sort((a, b) => score(b) - score(a))[0] ?? null;
}
