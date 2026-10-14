import { DB_KIND_LABELS, type DbConnection, type DbKind } from './models/db';

export interface ParsedConnectionUrl {
  /** The fields the URL sets; the rest keep their defaults. */
  connection: Partial<DbConnection> & { kind: DbKind };
  /** The password, when the URL carries one; it goes to the secret store, never into the connection. */
  password: string | null;
}

const SCHEMES: Record<string, DbKind> = {
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  postgres: 'postgres',
  postgresql: 'postgres',
  pg: 'postgres',
  redis: 'redis',
  rediss: 'redis',
};

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function truthy(value: string | null): boolean {
  return value !== null && /^(1|true|yes|on|require|verify-ca|verify-full|prefer)$/i.test(value);
}

/**
 * A connection pasted as a URL: `mysql://user:pass@host:3306/db`, `postgres://…/db?sslmode=require`,
 * `redis://:pass@host:6379/2`, `rediss://` (TLS), `sqlite:path/to/file.db` or a bare `.db` path.
 * Null when the text is not one of those.
 */
export function parseConnectionUrl(text: string): ParsedConnectionUrl | null {
  const raw = text.trim();
  if (!raw) return null;
  const sqlite = /^(?:sqlite3?:(?:\/\/)?|file:(?:\/\/)?)(.+)$/i.exec(raw);
  if (sqlite) return { connection: { kind: 'sqlite', file: decode(sqlite[1]), name: `${DB_KIND_LABELS.sqlite} ${fileName(sqlite[1])}` }, password: null };
  if (/\.(db|sqlite|sqlite3|db3)$/i.test(raw) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return { connection: { kind: 'sqlite', file: raw, name: `${DB_KIND_LABELS.sqlite} ${fileName(raw)}` }, password: null };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
  const kind = scheme ? SCHEMES[scheme] : undefined;
  if (!kind) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = decode(url.hostname.replace(/^\[|\]$/g, '')) || '127.0.0.1';
  const port = url.port ? Number(url.port) : 0;
  const user = decode(url.username);
  const password = url.password ? decode(url.password) : null;
  const path = decode(url.pathname.replace(/^\/+/, ''));
  const params = url.searchParams;
  const ssl = scheme === 'rediss' || truthy(params.get('ssl')) || truthy(params.get('tls')) || truthy(params.get('sslmode'));
  const connection: ParsedConnectionUrl['connection'] = { kind, host, port, user, ssl, name: `${DB_KIND_LABELS[kind]} ${host}` };
  if (kind === 'redis') {
    const index = Number(path || params.get('db') || 0);
    connection.dbIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  } else {
    connection.database = path;
  }
  return { connection, password };
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
