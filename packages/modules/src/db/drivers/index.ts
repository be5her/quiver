import type { DbConnection, HostApi } from '@quiver/core';
import { GrafanaRedisDriver } from './grafana-redis';
import { MySqlDriver } from './mysql';
import { PostgresDriver } from './postgres';
import { RedisDriver } from './redis';
import { SqliteDriver } from './sqlite';
import type { Driver } from './types';

export type { Driver, RedisDriverApi, RunOptions, TableRowsOptions } from './types';
export { normalizeValue } from './types';
export { grafanaRedisDatasources } from './grafana-redis';

/** One place to add a new database kind: implement `Driver`, add a case here, extend `DbKindSchema`. */
export function createDriver(connection: DbConnection, password: string, workspacePath: string, host: HostApi): Driver {
  switch (connection.kind) {
    case 'mysql':
      return new MySqlDriver(connection, password);
    case 'postgres':
      return new PostgresDriver(connection, password);
    case 'sqlite':
      return new SqliteDriver(connection, workspacePath);
    case 'redis':
      return connection.access.type === 'grafana' ? new GrafanaRedisDriver(connection, host) : new RedisDriver(connection, password);
    default: {
      const kind: never = connection.kind;
      throw new Error(`Unsupported database kind ${String(kind)}`);
    }
  }
}
