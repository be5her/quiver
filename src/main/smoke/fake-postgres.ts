import { createServer, type Socket } from 'node:net';

/**
 * Just enough of PostgreSQL's wire protocol for the database picker and a table's details: a password check, then
 * `SELECT version()` and the list from pg_database as plain queries, and the catalog queries behind db.schema.table as
 * prepared ones, about one table, whichever is asked for. `missing` databases answer 3D000 (does not exist), `denied`
 * ones 42501. Columns carry the type a real server gives them: `array_agg` of a `name` column is `name[]` unless cast,
 * which pg leaves as the text `{a,b}`.
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

  const int16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeInt16BE(n);
    return b;
  };
  const TEXT = 25;
  const BOOL = 16;
  const NAME = 19;
  const CHAR = 18;
  const NAME_ARRAY = 1003;
  const TEXT_ARRAY = 1009;

  /** A result set without the ReadyForQuery, which a prepared statement only gets at its Sync. */
  const resultSet = (columns: [name: string, oid: number][], values: (string | null)[][]) => {
    const fields = columns.map(([name, oid]) => Buffer.concat([Buffer.from(`${name}\0`, 'utf8'), int32(0), int16(0), int32(oid), int16(-1), int32(-1), int16(0)]));
    const description = message('T', Buffer.concat([int16(columns.length), ...fields]));
    const data = values.map((row) => {
      const cells = row.map((v) => {
        if (v === null) return int32(-1);
        const bytes = Buffer.from(v, 'utf8');
        return Buffer.concat([int32(bytes.length), bytes]);
      });
      return message('D', Buffer.concat([int16(row.length), ...cells]));
    });
    return Buffer.concat([description, ...data, message('C', Buffer.from(`SELECT ${values.length}\0`, 'utf8'))]);
  };
  const rows = (column: string, values: string[]) =>
    Buffer.concat([
      resultSet(
        [[column, TEXT]],
        values.map((v) => [v]),
      ),
      ready,
    ]);

  /** The catalog's answers for a table with a composite key, an index, a foreign key and a table pointing at it. */
  const catalog = (sql: string) => {
    // Each aggregate has its own type, so casting only one of a query's two does not pass for casting both.
    const arrays = [...sql.matchAll(/array_agg\(a\.attname(::text)?/g)].map((m) => (m[1] ? TEXT_ARRAY : NAME_ARRAY));
    if (/FROM pg_attribute a LEFT JOIN pg_attrdef/.test(sql)) {
      const columns: [string, number][] = [['attname', NAME], ['format_type', TEXT], ['attnotnull', BOOL], ['pg_get_expr', TEXT], ['attidentity', CHAR], ['attgenerated', CHAR]];
      return resultSet(columns, [
        ['tenant_id', 'integer', 't', null, '', ''],
        ['id', 'integer', 't', null, '', ''],
        ['customer_id', 'integer', 'f', null, '', ''],
      ]);
    }
    if (/FROM pg_index ix/.test(sql)) {
      const columns: [string, number][] = [['relname', NAME], ['indisunique', BOOL], ['indisprimary', BOOL], ['array_agg', arrays[0]]];
      return resultSet(columns, [
        ['orders_pkey', 't', 't', '{tenant_id,id}'],
        ['orders_customer_idx', 'f', 'f', '{customer_id}'],
      ]);
    }
    if (/FROM pg_constraint con/.test(sql)) {
      const columns: [string, number][] = [['conname', NAME], ['nspname', NAME], ['relname', NAME], ['nspname', NAME], ['relname', NAME], ['array_agg', arrays[0]], ['array_agg', arrays[1]], ['?column?', BOOL]];
      return resultSet(columns, [
        ['orders_customer_fk', 'public', 'orders', 'public', 'customers', '{customer_id}', '{id}', 't'],
        ['items_order_fk', 'public', 'items', 'public', 'orders', '{tenant_id,order_id}', '{tenant_id,id}', 'f'],
      ]);
    }
    return null;
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let started = false;
    let database = '';
    let prepared = '';

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
        return void socket.write(Buffer.concat([failure('42601', `The fake does not know: ${sql}`), ready]));
      }
      // A prepared statement: Parse, Bind, Describe, Execute, Sync. The row description goes out with the rows.
      if (type === 'P') {
        const nameEnd = body.indexOf(0);
        prepared = body.subarray(nameEnd + 1, body.indexOf(0, nameEnd + 1)).toString('utf8');
        return void socket.write(message('1', Buffer.alloc(0)));
      }
      if (type === 'B') return void socket.write(message('2', Buffer.alloc(0)));
      if (type === 'E') return void socket.write(catalog(prepared) ?? failure('42601', `The fake does not know: ${prepared}`));
      if (type === 'S') return void socket.write(ready);
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
