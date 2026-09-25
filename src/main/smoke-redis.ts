import { createServer, type Server, type Socket } from 'node:net';

type Value = { type: 'string'; value: string } | { type: 'hash'; value: Map<string, string> } | { type: 'list'; value: string[] } | { type: 'set'; value: Set<string> } | { type: 'zset'; value: Map<string, number> };

/**
 * A tiny in-process RESP server that speaks enough Redis for the smoke test:
 * connection handshake, SCAN/TYPE/TTL, strings, hashes, lists, sets, sorted sets, DEL.
 * It exists so the Redis driver is exercised end to end without a Redis binary.
 */
export function startFakeRedis(): Promise<{ port: number; close(): Promise<void> }> {
  const data = new Map<string, Value>();
  const expires = new Map<string, number>();

  const seed = () => {
    data.set('user:1', { type: 'hash', value: new Map([['name', 'Ada'], ['role', 'admin']]) });
    data.set('user:2', { type: 'hash', value: new Map([['name', 'Linus'], ['role', 'dev']]) });
    data.set('session:abc', { type: 'string', value: '{"userId":1,"ok":true}' });
    expires.set('session:abc', Date.now() + 3600_000);
    data.set('queue', { type: 'list', value: ['job-1', 'job-2', 'job-3'] });
    data.set('tags', { type: 'set', value: new Set(['a', 'b']) });
    data.set('scores', { type: 'zset', value: new Map([['ada', 10], ['linus', 7]]) });
  };
  seed();

  const enc = {
    simple: (s: string) => `+${s}\r\n`,
    error: (s: string) => `-ERR ${s}\r\n`,
    int: (n: number) => `:${n}\r\n`,
    bulk: (s: string | null) => (s === null ? '$-1\r\n' : `$${Buffer.byteLength(s)}\r\n${s}\r\n`),
    array: (items: string[]) => `*${items.length}\r\n${items.join('')}`,
  };

  const ttlOf = (key: string): number => {
    const at = expires.get(key);
    if (at === undefined) return data.has(key) ? -1 : -2;
    return Math.max(0, Math.round((at - Date.now()) / 1000));
  };

  const handle = (argv: string[]): string => {
    const cmd = argv[0].toUpperCase();
    const key = argv[1];
    const entry = key ? data.get(key) : undefined;
    switch (cmd) {
      case 'INFO':
        return enc.bulk('# Server\r\nredis_version:7.2.0-fake\r\nloading:0\r\n');
      case 'PING':
        return enc.simple('PONG');
      case 'SELECT':
      case 'CLIENT':
        return enc.simple('OK');
      case 'AUTH':
        return argv[argv.length - 1] === 'hunter2' ? enc.simple('OK') : enc.error('WRONGPASS invalid username-password pair');
      case 'DBSIZE':
        return enc.int(data.size);
      case 'SCAN': {
        const patternIdx = argv.findIndex((a) => a.toUpperCase() === 'MATCH');
        const pattern = patternIdx >= 0 ? argv[patternIdx + 1] : '*';
        const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
        const keys = [...data.keys()].filter((k) => re.test(k));
        return enc.array([enc.bulk('0'), enc.array(keys.map((k) => enc.bulk(k)))]);
      }
      case 'TYPE':
        return enc.simple(entry?.type ?? 'none');
      case 'TTL':
        return enc.int(ttlOf(key));
      case 'EXISTS':
        return enc.int(data.has(key) ? 1 : 0);
      case 'OBJECT':
        return enc.bulk(argv[1]?.toUpperCase() === 'ENCODING' && data.has(argv[2]) ? 'embstr' : null);
      case 'MEMORY':
        return data.has(argv[2]) ? enc.int(64) : enc.bulk(null);
      case 'GET':
        return entry?.type === 'string' ? enc.bulk(entry.value) : enc.bulk(null);
      case 'STRLEN':
        return enc.int(entry?.type === 'string' ? entry.value.length : 0);
      case 'SET':
        data.set(key, { type: 'string', value: argv[2] });
        expires.delete(key);
        return enc.simple('OK');
      case 'DEL': {
        let n = 0;
        for (const k of argv.slice(1)) if (data.delete(k)) n++;
        return enc.int(n);
      }
      case 'HLEN':
        return enc.int(entry?.type === 'hash' ? entry.value.size : 0);
      case 'HGETALL':
        return entry?.type === 'hash' ? enc.array([...entry.value.entries()].flatMap(([f, v]) => [enc.bulk(f), enc.bulk(v)])) : enc.array([]);
      case 'HSET': {
        const hash = entry?.type === 'hash' ? entry : { type: 'hash' as const, value: new Map<string, string>() };
        let added = 0;
        for (let i = 2; i + 1 < argv.length; i += 2) {
          if (!hash.value.has(argv[i])) added++;
          hash.value.set(argv[i], argv[i + 1]);
        }
        data.set(key, hash);
        return enc.int(added);
      }
      case 'LLEN':
        return enc.int(entry?.type === 'list' ? entry.value.length : 0);
      case 'LRANGE': {
        if (entry?.type !== 'list') return enc.array([]);
        const start = Number(argv[2]);
        const stop = Number(argv[3]);
        const end = stop < 0 ? entry.value.length + stop : stop;
        return enc.array(entry.value.slice(start, end + 1).map((v) => enc.bulk(v)));
      }
      case 'SCARD':
        return enc.int(entry?.type === 'set' ? entry.value.size : 0);
      case 'SMEMBERS':
        return entry?.type === 'set' ? enc.array([...entry.value].map((v) => enc.bulk(v))) : enc.array([]);
      case 'ZCARD':
        return enc.int(entry?.type === 'zset' ? entry.value.size : 0);
      case 'ZRANGE': {
        if (entry?.type !== 'zset') return enc.array([]);
        const sorted = [...entry.value.entries()].sort((a, b) => a[1] - b[1]);
        const withScores = argv.some((a) => a.toUpperCase() === 'WITHSCORES');
        return enc.array(sorted.flatMap(([m, s]) => (withScores ? [enc.bulk(m), enc.bulk(String(s))] : [enc.bulk(m)])));
      }
      case 'FLUSHALL':
        data.clear();
        expires.clear();
        return enc.simple('OK');
      default:
        return enc.error(`unknown command '${cmd}'`);
    }
  };

  const sockets = new Set<Socket>();
  const onSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      for (;;) {
        const parsed = parseCommand(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.consumed);
        try {
          socket.write(handle(parsed.argv));
        } catch (err) {
          socket.write(enc.error((err as Error).message));
        }
      }
    });
    socket.on('error', () => {});
  };

  const server: Server = createServer(onSocket);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            // Drivers pooled by the host may still be attached; drop them so close() does not wait forever.
            for (const socket of sockets) socket.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Parse one RESP array of bulk strings from the start of `buf`. */
function parseCommand(buf: Buffer): { argv: string[]; consumed: number } | null {
  if (buf.length === 0) return null;
  if (buf[0] !== 0x2a /* * */) {
    // Inline command (not used by ioredis, but cheap to support).
    const nl = buf.indexOf('\r\n');
    if (nl < 0) return null;
    return { argv: buf.subarray(0, nl).toString().split(/\s+/).filter(Boolean), consumed: nl + 2 };
  }
  let pos = 0;
  const readLine = (): string | null => {
    const nl = buf.indexOf('\r\n', pos);
    if (nl < 0) return null;
    const line = buf.subarray(pos, nl).toString();
    pos = nl + 2;
    return line;
  };
  const header = readLine();
  if (header === null) return null;
  const count = Number(header.slice(1));
  const argv: string[] = [];
  for (let i = 0; i < count; i++) {
    const lenLine = readLine();
    if (lenLine === null) return null;
    const len = Number(lenLine.slice(1));
    if (buf.length < pos + len + 2) return null;
    argv.push(buf.subarray(pos, pos + len).toString());
    pos += len + 2;
  }
  return { argv, consumed: pos };
}
