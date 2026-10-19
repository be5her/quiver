import { describe, expect, it } from 'vitest';
import { datasetError, datasetToResult, describeMetabaseConnection, metabasePartition, normalizeMetabaseUrl, type MetabaseDataset } from './metabase';

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
