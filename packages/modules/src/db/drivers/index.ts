import type { DbConnection } from '@quiver/core';
import { MySqlDriver } from './mysql';
import { RedisDriver } from './redis';
import { SqliteDriver } from './sqlite';
import type { Driver } from './types';

export type { Driver, RedisDriverApi, RunOptions, TableRowsOptions } from './types';
export { normalizeValue } from './types';

/** One place to add a new database kind: implement `Driver`, add a case here, extend `DbKindSchema`. */
export function createDriver(connection: DbConnection, password: string, workspacePath: string): Driver {
  switch (connection.kind) {
    case 'mysql':
      return new MySqlDriver(connection, password);
    case 'sqlite':
      return new SqliteDriver(connection, workspacePath);
    case 'redis':
      return new RedisDriver(connection, password);
    default: {
      const kind: never = connection.kind;
      throw new Error(`Unsupported database kind ${String(kind)}`);
    }
  }
}
