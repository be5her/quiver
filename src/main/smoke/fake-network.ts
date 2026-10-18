import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';

/** The test-only certificates in `certs/` (see its README), read from the repository. */
export const SMOKE_CERTS = path.join(process.cwd(), 'src', 'main', 'smoke', 'certs');

/**
 * An HTTPS echo that asks for a client certificate signed by the smoke CA (and refuses a request
 * without one), and a forward proxy (CONNECT) that records what went through it.
 */
export async function startFakeNetwork() {
  const read = (name: string) => fs.readFile(path.join(SMOKE_CERTS, name));
  const ca = await read('ca.crt');
  const mtls = createHttpsServer({ key: await read('server.key'), cert: await read('server.crt'), ca, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    req.resume();
    const socket = req.socket as TLSSocket;
    if (!socket.authorized) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'a client certificate signed by the smoke CA is required', reason: socket.authorizationError ?? null }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ client: socket.getPeerCertificate().subject?.CN ?? null, url: req.url }));
  });
  await new Promise<void>((r) => mtls.listen(0, '127.0.0.1', () => r()));
  const mtlsPort = (mtls.address() as { port: number }).port;

  const proxySeen: { method: string; target: string; auth: string | null }[] = [];
  const tunnels = new Set<Socket>();
  // undici's ProxyAgent tunnels every request, http too, so CONNECT is all this proxy answers.
  const proxy = createHttpServer((req, res) => {
    proxySeen.push({ method: req.method ?? '', target: req.url ?? '', auth: (req.headers['proxy-authorization'] as string | undefined) ?? null });
    req.resume();
    res.writeHead(405, { 'content-type': 'text/plain' }).end('CONNECT only');
  });
  proxy.on('connect', (req, client: Socket, head) => {
    proxySeen.push({ method: 'CONNECT', target: req.url ?? '', auth: (req.headers['proxy-authorization'] as string | undefined) ?? null });
    const [host, port] = (req.url ?? '').split(':');
    const server = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) server.write(head);
      server.pipe(client);
      client.pipe(server);
    });
    tunnels.add(client).add(server);
    const end = () => (client.destroy(), server.destroy());
    server.on('error', end);
    client.on('error', end);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  const proxyPort = (proxy.address() as { port: number }).port;

  return {
    mtlsPort,
    proxyPort,
    proxySeen,
    async close() {
      for (const socket of tunnels) socket.destroy();
      mtls.closeAllConnections();
      mtls.close();
      proxy.closeAllConnections();
      proxy.close();
    },
  };
}
