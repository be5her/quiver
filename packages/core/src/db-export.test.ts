import { describe, expect, it } from 'vitest';
import { formatRows, rowsToInsert, rowsToMarkdown } from './db-export';

const columns = [{ name: 'id' }, { name: 'name' }];
const rows = [
  [1, 'Ada'],
  [2, 'a | b\nc'],
  [3, null],
];

describe('export formats', () => {
  it('writes Markdown with escaped pipes and line breaks', () => {
    expect(rowsToMarkdown(columns, rows)).toBe('| id | name |\n| --- | --- |\n| 1 | Ada |\n| 2 | a \\| b c |\n| 3 | NULL |');
  });
  it('writes one INSERT per row', () => {
    expect(rowsToInsert('postgres', 'users', 'public', columns, rows)).toBe(
      `INSERT INTO "public"."users" ("id", "name") VALUES (1, 'Ada');\nINSERT INTO "public"."users" ("id", "name") VALUES (2, 'a | b\nc');\nINSERT INTO "public"."users" ("id", "name") VALUES (3, NULL);`,
    );
  });
  it('writes CSV and JSON', () => {
    expect(formatRows({ format: 'csv', columns, rows })).toBe('id,name\n1,Ada\n2,"a | b\nc"\n3,');
    expect(JSON.parse(formatRows({ format: 'json', columns, rows }))).toEqual([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'a | b\nc' },
      { id: 3, name: null },
    ]);
  });
});
