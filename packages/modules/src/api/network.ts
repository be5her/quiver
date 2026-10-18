import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { rootCertificates } from 'node:tls';
import { QuiverError, certificateFor, defaultNetworkConfig, proxyFor, type ClientCertificate, type HostApi, type NetworkConfig, type WorkspaceApi } from '@quiver/core';
import { Agent, ProxyAgent, type Dispatcher } from 'undici';

/** Client certificates of a workspace, per machine: the files are on this machine, not in the project. */
export const CERTIFICATES_DOC = 'certificates';

/** The TLS material of one certificate, read from its files, or why it could not be. */
interface LoadedCertificate {
  id: string;
  hostPattern: string;
  key: string;
  tls?: { cert?: Buffer; key?: Buffer; pfx?: Buffer; passphrase?: string; ca?: Buffer };
  error?: string;
}

/** How the requests of one send reach the network: the proxy and the client certificate for each URL (redirects may change host). */
export interface NetworkContext {
  proxy(url: string): { uri: string; token?: string } | null;
  certificate(url: string): LoadedCertificate | null;
}

export function networkConfig(host: HostApi): NetworkConfig {
  return { ...defaultNetworkConfig(), ...(host.config.get().network ?? {}) };
}

export async function readCertificates(ws: WorkspaceApi): Promise<ClientCertificate[]> {
  return ws.store.readLocal<ClientCertificate[]>(CERTIFICATES_DOC, []);
}

/** A path as typed: relative ones resolve against the project folder. */
function resolvePath(ws: WorkspaceApi | undefined, given: string): string {
  return path.isAbsolute(given) || !ws ? given : path.resolve(ws.path, given);
}

async function loadCertificate(ws: WorkspaceApi | undefined, host: HostApi, c: ClientCertificate): Promise<LoadedCertificate> {
  const read = async (given: string, what: string) => {
    if (!given.trim()) return undefined;
    try {
      return await fs.readFile(resolvePath(ws, given.trim()));
    } catch (err) {
      throw new Error(`The ${what} ${given} for ${c.hostPattern} cannot be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
  };
  try {
    const tls = {
      cert: await read(c.certPath, 'certificate'),
      key: await read(c.keyPath, 'key'),
      pfx: await read(c.pfxPath, 'PKCS#12 file'),
      ca: await read(c.caPath, 'CA file'),
      passphrase: c.passphraseCipher ? host.secrets.decrypt(c.passphraseCipher) : undefined,
    };
    // The cache key: which files with what contents, without keeping a secret in it.
    const hash = createHash('sha256');
    for (const part of [tls.cert, tls.key, tls.pfx, tls.ca]) hash.update(part ?? '').update('\0');
    hash.update(c.passphraseCipher);
    const key = `${c.id}:${hash.digest('hex')}`;
    return { id: c.id, hostPattern: c.hostPattern, key, tls };
  } catch (err) {
    return { id: c.id, hostPattern: c.hostPattern, key: c.id, error: (err as Error).message };
  }
}

/** The proxy (global config) and the workspace's client certificates, read once for a send or a connection. */
export async function resolveNetwork(host: HostApi, ws?: WorkspaceApi): Promise<NetworkContext> {
  const config = networkConfig(host);
  const password = config.passwordCipher ? host.secrets.decrypt(config.passwordCipher) : '';
  const token = config.proxy === 'manual' && config.username ? `Basic ${Buffer.from(`${config.username}:${password}`).toString('base64')}` : undefined;
  const certificates = ws ? await Promise.all((await readCertificates(ws)).map((c) => loadCertificate(ws, host, c))) : [];
  return {
    proxy: (url) => {
      const uri = proxyFor(url, config, process.env);
      return uri ? { uri, ...(token ? { token } : {}) } : null;
    },
    certificate: (url) => certificateFor(url, certificates),
  };
}

const dispatchers = new Map<string, Dispatcher>();

/**
 * The undici dispatcher a request to `url` uses: through the proxy when one applies, presenting the
 * client certificate that matches, accepting invalid certificates when `insecure`. Undefined is
 * undici's own default. Dispatchers are kept and reused, keyed by what they were built with.
 */
export function dispatcherFor(url: string, insecure: boolean, network?: NetworkContext): Dispatcher | undefined {
  const proxy = network?.proxy(url) ?? null;
  const certificate = network?.certificate(url) ?? null;
  if (certificate?.error) throw new QuiverError('REQUEST_FAILED', certificate.error, { url });
  if (!proxy && !certificate && !insecure) return undefined;
  const key = JSON.stringify([proxy?.uri ?? null, proxy?.token ?? null, certificate?.key ?? null, insecure]);
  let dispatcher = dispatchers.get(key);
  if (!dispatcher) {
    const own = certificate?.tls ?? {};
    // A private CA joins the system roots rather than replacing them (Node's `ca` alone would): a host under the pattern with a public certificate still verifies.
    const tls = { ...own, ...(own.ca ? { ca: [...rootCertificates, own.ca.toString('utf8')] } : {}), rejectUnauthorized: !insecure };
    dispatcher = proxy ? new ProxyAgent({ uri: proxy.uri, ...(proxy.token ? { token: proxy.token } : {}), requestTls: tls }) : new Agent({ connect: tls });
    // A long session with many proxies or certificates edited over and over: start again rather than grow.
    if (dispatchers.size > 50) {
      for (const old of dispatchers.values()) void old.close().catch(() => undefined);
      dispatchers.clear();
    }
    dispatchers.set(key, dispatcher);
  }
  return dispatcher;
}
