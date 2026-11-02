import { createServer, type Socket } from 'node:net';

/**
 * Just enough of PostgreSQL's wire protocol for the database picker: a password check, then `SELECT version()` and the
 * list from pg_database, as plain queries. `missing` databases answer 3D000 (does not exist), `denied` ones 42501.
 */
export async function startFakePostgres(options: { password: string; databases: string[]; missing?: string[]; denied?: string[] }) {
  const seen: { connects: { database: string; user: string }[]; passwords: string[] } = { connects: [], passwords: [] };
  const sockets = new Set<Socket>();

  const message = (type: string, body: Buffer) => {
    const head = Buffer.alloc(5);
    head.write(type, 0, 'latin1');
    head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  };
  const int32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const failure = (code: string, text: string) => message('E', Buffer.from(`SFATAL\0C${code}\0M${text}\0\0`, 'utf8'));
  const ready = message('Z', Buffer.from('I'));

  const rows = (column: string, values: string[]) => {
    const field = Buffer.concat([Buffer.from(`${column}\0`, 'utf8'), int32(0), Buffer.from([0, 0]), int32(25), Buffer.from([0xff, 0xff]), int32(-1), Buffer.from([0, 0])]);
    const description = message('T', Buffer.concat([Buffer.from([0, 1]), field]));
    const data = values.map((v) => {
      const bytes = Buffer.from(v, 'utf8');
      return message('D', Buffer.concat([Buffer.from([0, 1]), int32(bytes.length), bytes]));
    });
    return Buffer.concat([description, ...data, message('C', Buffer.from(`SELECT ${values.length}\0`, 'utf8')), ready]);
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let started = false;
    let database = '';

    const startup = (body: Buffer) => {
      const code = body.readInt32BE(0);
      // SSLRequest: no TLS here; the client carries on in plain text or gives up.
      if (code === 80877103) return void socket.write('N');
      started = true;
      const parts = body.subarray(4).toString('utf8').split('\0');
      const params = new Map<string, string>();
      for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) params.set(parts[i], parts[i + 1]);
      database = params.get('database') ?? params.get('user') ?? '';
      seen.connects.push({ database, user: params.get('user') ?? '' });
      // AuthenticationCleartextPassword.
      socket.write(message('R', int32(3)));
    };

    const authenticated = () => {
      if (options.missing?.includes(database)) return void socket.end(failure('3D000', `database "${database}" does not exist`));
      if (options.denied?.includes(database)) return void socket.end(failure('42501', `permission denied for database "${database}"`));
      socket.write(Buffer.concat([message('R', int32(0)), ready]));
    };

    const handle = (type: string, body: Buffer) => {
      if (type === 'p') {
        const password = body.toString('utf8').replace(/\0$/, '');
        seen.passwords.push(password);
        if (password !== options.password) return void socket.end(failure('28P01', 'password authentication failed'));
        return authenticated();
      }
      if (type === 'Q') {
        const sql = body.toString('utf8');
        if (/pg_database/.test(sql)) return void socket.write(rows('datname', options.databases));
        if (/version\(\)/.test(sql)) return void socket.write(rows('version', ['PostgreSQL 16.0-fake']));
        return void socket.write(failure('42601', `The fake does not know: ${sql}`));
      }
      if (type === 'X') socket.end();
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk as Buffer]);
      for (;;) {
        if (!started) {
          if (buffer.length < 4) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          const body = buffer.subarray(4, length);
          buffer = buffer.subarray(length);
          startup(body);
        } else {
          if (buffer.length < 5) return;
          const length = buffer.readInt32BE(1);
          if (buffer.length < length + 1) return;
          const type = buffer.toString('latin1', 0, 1);
          const body = buffer.subarray(5, length + 1);
          buffer = buffer.subarray(length + 1);
          handle(type, body);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
