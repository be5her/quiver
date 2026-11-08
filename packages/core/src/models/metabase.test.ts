import { describe, expect, it } from 'vitest';
import { datasetError, datasetToResult, describeMetabaseConnection, mbqlFilter, mbqlTableQuery, metabasePartition, normalizeMetabaseUrl, type MetabaseDataset } from './metabase';

describe('metabase address', () => {
  it('adds https, keeps a sub-path and drops trailing slashes, query and hash', () => {
    expect(normalizeMetabaseUrl(' metabase.example.com/ ')).toBe('https://metabase.example.com');
    expect(normalizeMetabaseUrl('http://127.0.0.1:3000/metabase/?x=1#q')).toBe('http://127.0.0.1:3000/metabase');
    expect(normalizeMetabaseUrl('')).toBe('');
    expect(normalizeMetabaseUrl('ftp://x')).toBe('');
  });

  it('gives one session partition per origin', () => {
    expect(metabasePartition('https://Metabase.Example.com/sub')).toBe('persist:quiver-metabase-https-metabase-example-com');
    expect(metabasePartition('metabase.example.com')).toBe(metabasePartition('https://metabase.example.com/other'));
    expect(metabasePartition('http://127.0.0.1:3000')).toBe('persist:quiver-metabase-http-127-0-0-1-3000');
  });

  it('describes a connection by host and sign-in mode', () => {
    expect(describeMetabaseConnection({ url: 'https://mb.example.com/x', auth: 'browser' })).toBe('mb.example.com · browser sign-in');
    expect(describeMetabaseConnection({ url: 'https://mb.example.com', auth: 'apikey' })).toBe('mb.example.com · API key');
    expect(describeMetabaseConnection({ url: '', auth: 'apikey' })).toBe('API key');
  });
});

describe('metabase datasets', () => {
  it('reads the error of a failed dataset', () => {
    expect(datasetError({ status: 'failed', error: ' ERROR: relation "boom" does not exist ' })).toBe('ERROR: relation "boom" does not exist');
    expect(datasetError({ status: 'failed', error: { message: 'Permission denied' } })).toBe('Permission denied');
    expect(datasetError({ status: 'failed' })).toBe('Metabase could not run the query');
    expect(datasetError({ status: 'completed', data: { rows: [] } })).toBeNull();
  });

  it('turns rows into a result, naming columns by display name', () => {
    const dataset: MetabaseDataset = {
      status: 'completed',
      row_count: 2,
      running_time: 12,
      data: {
        cols: [{ name: 'id', display_name: 'ID', base_type: 'type/Integer' }, { name: 'customer' }, { display_name: '' }],
        rows: [
          [1, 'ada', null],
          [2, 'bob', null],
        ],
      },
    };
    const result = datasetToResult(dataset, 'SELECT * FROM orders');
    expect(result.kind).toBe('rows');
    expect(result.statement).toBe('SELECT * FROM orders');
    expect(result.columns).toEqual([
      { name: 'ID', type: 'type/Integer' },
      { name: 'customer', type: null },
      { name: '', type: null },
    ]);
    expect(result.rows).toEqual(dataset.data!.rows);
    expect(result.rowCount).toBe(2);
    expect(result.durationMs).toBe(12);
    expect(result.truncated).toBe(false);
  });

  it('flags rows Metabase cut and counts rows when row_count is missing', () => {
    const rows = Array.from({ length: 3 }, (_, i) => [i]);
    const result = datasetToResult({ data: { cols: [{ name: 'n' }], rows, rows_truncated: 2000 } }, 'q');
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(3);
    expect(datasetToResult({ data: { rows, rows_truncated: 0 } }, 'q').truncated).toBe(false);
    expect(datasetToResult({}, 'q')).toMatchObject({ columns: [], rows: [], rowCount: 0, truncated: false });
  });
});

describe('metabase table queries (MBQL)', () => {
  const base = { databaseId: 1, tableId: 11, limit: 100, page: 1, orderBy: null, filters: [] };

  it('builds one filter clause, with or without a value', () => {
    expect(mbqlFilter({ fieldId: 102, op: '=', value: 'Ada' })).toEqual(['=', ['field', 102, null], 'Ada']);
    expect(mbqlFilter({ fieldId: 103, op: '>', value: 10 })).toEqual(['>', ['field', 103, null], 10]);
    expect(mbqlFilter({ fieldId: 102, op: 'is-null' })).toEqual(['is-null', ['field', 102, null]]);
    expect(mbqlFilter({ fieldId: 102, op: 'not-empty', value: 'ignored' })).toEqual(['not-empty', ['field', 102, null]]);
  });

  it('asks the first page of a table without page or filter', () => {
    expect(mbqlTableQuery(base)).toEqual({ database: 1, type: 'query', query: { 'source-table': 11, limit: 100 } });
  });

  it('puts a single filter as is and ANDs several', () => {
    const one = mbqlTableQuery({ ...base, filters: [{ fieldId: 102, op: 'contains', value: 'a' }] });
    expect((one['query'] as Record<string, unknown>)['filter']).toEqual(['contains', ['field', 102, null], 'a']);
    const two = mbqlTableQuery({
      ...base,
      filters: [
        { fieldId: 103, op: '>', value: 10 },
        { fieldId: 102, op: 'not-null' },
      ],
    });
    expect((two['query'] as Record<string, unknown>)['filter']).toEqual(['and', ['>', ['field', 103, null], 10], ['not-null', ['field', 102, null]]]);
  });

  it('orders by one field', () => {
    const q = mbqlTableQuery({ ...base, orderBy: { fieldId: 103, direction: 'desc' } });
    expect((q['query'] as Record<string, unknown>)['order-by']).toEqual([['desc', ['field', 103, null]]]);
  });

  it('pages past the first page by limit rows', () => {
    expect((mbqlTableQuery({ ...base, limit: 2, page: 1 })['query'] as Record<string, unknown>)['page']).toBeUndefined();
    expect((mbqlTableQuery({ ...base, limit: 2, page: 3 })['query'] as Record<string, unknown>)['page']).toEqual({ page: 3, items: 2 });
  });
});
