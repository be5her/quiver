import { describe, expect, it } from 'vitest';
import {
  LOGS_CLOCK_SKEW_MS,
  LogsConnectionDraftSchema,
  LogsConnectionSchema,
  cleanGrafanaError,
  composeLogsQuery,
  describeLogsConnection,
  grafanaPartition,
  logLevelTone,
  logsConnectionAddress,
  logsConnectionReady,
  logsFieldName,
  logsFilterExpr,
  logsFollowRange,
  logsHitsStep,
  newLogsConnection,
  normalizeGrafanaUrl,
  normalizeVictoriaLogsUrl,
  parseHitsFrames,
  parseLogFrames,
  parseVictoriaLogsHits,
  parseVictoriaLogsLines,
  parseVictoriaLogsValues,
  resolveLogsTime,
  rfc3339ToNs,
  splitLogsQuery,
  victoriaLogsHeaders,
  type GrafanaFrame,
} from './logs';

describe('grafana address', () => {
  it('adds https, keeps a sub-path and drops trailing slashes, query and hash', () => {
    expect(normalizeGrafanaUrl(' grafana.example.com/ ')).toBe('https://grafana.example.com');
    expect(normalizeGrafanaUrl('http://127.0.0.1:3000/grafana/?orgId=1#x')).toBe('http://127.0.0.1:3000/grafana');
    expect(normalizeGrafanaUrl('https://vm-grafana.example.center/explore?left=1')).toBe('https://vm-grafana.example.center/explore');
    expect(normalizeGrafanaUrl('')).toBe('');
    expect(normalizeGrafanaUrl('ftp://x')).toBe('');
  });

  it('gives one session partition per origin', () => {
    expect(grafanaPartition('https://Grafana.Example.com/sub')).toBe('persist:quiver-grafana-https-grafana-example-com');
    expect(grafanaPartition('grafana.example.com')).toBe(grafanaPartition('https://grafana.example.com/other'));
    expect(grafanaPartition('http://127.0.0.1:3000')).toBe('persist:quiver-grafana-http-127-0-0-1-3000');
  });

  it('describes a connection by host and data source', () => {
    expect(describeLogsConnection({ grafanaUrl: 'https://g.example.com/x', datasourceName: 'VictoriaLogs-Staging' })).toBe('g.example.com · VictoriaLogs-Staging');
    expect(describeLogsConnection({ grafanaUrl: '', datasourceName: '' })).toBe('');
  });

  it('defaults a new connection and keeps drafts partial', () => {
    const conn = newLogsConnection({ name: 'Staging' });
    expect(conn).toMatchObject({ name: 'Staging', grafanaUrl: '', datasourceUid: '', datasourceType: 'victoriametrics-logs-datasource' });
    expect(LogsConnectionDraftSchema.parse({ datasourceUid: 'x' })).toEqual({ datasourceUid: 'x' });
  });
});

describe('LogsQL', () => {
  it('quotes field names that are not plain words', () => {
    expect(logsFieldName('app')).toBe('app');
    expect(logsFieldName('error.code')).toBe('error.code');
    expect(logsFieldName('k8s-pod')).toBe('"k8s-pod"');
    expect(logsFieldName('or')).toBe('"or"');
  });

  it('writes filters as exact matches, negated with !', () => {
    expect(logsFilterExpr({ field: 'app', value: 'oxo-wrapper-pos', exclude: false })).toBe('app:="oxo-wrapper-pos"');
    expect(logsFilterExpr({ field: 'level', value: 'Error', exclude: true })).toBe('!level:="Error"');
    expect(logsFilterExpr({ field: 'msg', value: 'say "hi" \\ bye', exclude: false })).toBe('msg:="say \\"hi\\" \\\\ bye"');
  });

  it('splits at the first top-level pipe, not inside quotes or subqueries', () => {
    expect(splitLogsQuery('error | stats count()')).toEqual({ filters: 'error', pipes: '| stats count()' });
    expect(splitLogsQuery('_msg:~"a|b" | limit 5')).toEqual({ filters: '_msg:~"a|b"', pipes: '| limit 5' });
    expect(splitLogsQuery('user:in(_time:5m error | fields user) | count()')).toEqual({ filters: 'user:in(_time:5m error | fields user)', pipes: '| count()' });
    expect(splitLogsQuery("x:'it\\'s|' y")).toEqual({ filters: "x:'it\\'s|' y", pipes: '' });
    expect(splitLogsQuery('  * ')).toEqual({ filters: '*', pipes: '' });
  });

  it('folds filters in front of the query and keeps an or from swallowing them', () => {
    const app = { field: 'app', value: 'api', exclude: false };
    const notDebug = { field: 'level', value: 'debug', exclude: true };
    expect(composeLogsQuery('', [])).toBe('*');
    expect(composeLogsQuery('*', [app])).toBe('app:="api"');
    expect(composeLogsQuery('error or warn', [])).toBe('error or warn');
    expect(composeLogsQuery('error or warn', [app, notDebug])).toBe('app:="api" !level:="debug" (error or warn)');
    expect(composeLogsQuery('* | stats by (level) count()', [app])).toBe('app:="api" | stats by (level) count()');
    expect(composeLogsQuery('timeout | sort by (_time)', [app], { pipes: false })).toBe('app:="api" (timeout)');
  });
});

describe('time', () => {
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);

  it('reads now, spans, epoch seconds and ms, and ISO dates', () => {
    expect(resolveLogsTime('now', now)).toBe(now);
    expect(resolveLogsTime('', now)).toBe(now);
    expect(resolveLogsTime('now-15m', now)).toBe(now - 15 * 60_000);
    expect(resolveLogsTime('2h', now)).toBe(now - 2 * 3_600_000);
    expect(resolveLogsTime('7d', now)).toBe(now - 7 * 86_400_000);
    expect(resolveLogsTime('1791875593', now)).toBe(1_791_875_593_000);
    expect(resolveLogsTime('1791875593123', now)).toBe(1_791_875_593_123);
    expect(resolveLogsTime('2026-10-13T11:00:00Z', now)).toBe(now - 3_600_000);
    expect(() => resolveLogsTime('yesterday', now)).toThrow(/Cannot read "yesterday"/);
  });

  it('picks a histogram step for about 60 bars', () => {
    expect(logsHitsStep(0, 15 * 60_000)).toBe(30_000);
    expect(logsHitsStep(0, 3_600_000)).toBe(60_000);
    expect(logsHitsStep(0, 7 * 86_400_000)).toBe(10_800_000);
    expect(logsHitsStep(0, 365 * 86_400_000)).toBe(86_400_000);
  });

  it('follows from the newest entry to a little past now, even when that entry is ahead of this clock', () => {
    expect(logsFollowRange(null, String(now - 60_000), now)).toEqual({ from: String(now - 60_000), to: String(now + LOGS_CLOCK_SKEW_MS) });
    expect(logsFollowRange(`${now - 5_000}000250`, '0', now)).toEqual({ from: String(now - 5_000), to: String(now + LOGS_CLOCK_SKEW_MS) });
    // A writer whose clock runs 30 s ahead: the poll still ends after it starts.
    const ahead = now + 30_000;
    expect(logsFollowRange(`${ahead}000000`, '0', now)).toEqual({ from: String(ahead), to: String(ahead + LOGS_CLOCK_SKEW_MS) });
    expect(logsFollowRange(null, 'now-15m', now)).toEqual({ from: 'now-15m', to: String(now + LOGS_CLOCK_SKEW_MS) });
  });
});

describe('frames', () => {
  // The shape VictoriaLogs answers through Grafana's /api/ds/query.
  const logs: GrafanaFrame = {
    schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Line', type: 'string' }, { name: 'labels', type: 'other' }] },
    data: {
      values: [
        [1791875468000, 1791875469000, 1791875469000],
        ['started', 'failed to pay', '{"a":1}'],
        [
          { _stream_id: 's1', app: 'api', level: 'Information' },
          { _stream_id: 's1', app: 'api', level: 'Error', 'error.code': 'E42' },
          '{"_stream_id":"s2","app":"web","hits":5}',
        ],
      ],
      nanos: [[0, 250, 100], null, null],
    },
  };

  it('reads entries newest first with nanosecond order, level and fields', () => {
    const entries = parseLogFrames([logs]);
    expect(entries.map((e) => e.msg)).toEqual(['failed to pay', '{"a":1}', 'started']);
    expect(entries[0]).toMatchObject({ ns: '1791875469000000250', time: '2026-10-13T07:11:09.000Z', level: 'Error', fields: { app: 'api', level: 'Error', 'error.code': 'E42' } });
    expect(entries[1]).toMatchObject({ level: null, fields: { app: 'web', hits: '5' } });
    expect(entries[0]!.fields).not.toHaveProperty('_stream_id');
    expect(new Set(entries.map((e) => e.id)).size).toBe(3);
    expect(parseLogFrames([logs])[0]!.id).toBe(entries[0]!.id);
  });

  it('copes with empty and odd frames', () => {
    expect(parseLogFrames([])).toEqual([]);
    expect(parseLogFrames([{ schema: { fields: [] }, data: { values: [] } }])).toEqual([]);
  });

  it('adds up hits per bucket across frames', () => {
    const frame = (counts: number[]): GrafanaFrame => ({
      schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number' }] },
      data: { values: [[2000, 1000], counts] },
    });
    expect(parseHitsFrames([frame([3, 1]), frame([2, 0])])).toEqual({ buckets: [{ time: 1000, count: 1 }, { time: 2000, count: 5 }], total: 6 });
  });
});

describe('levels and errors', () => {
  it('maps the usual spellings to a tone', () => {
    expect(['Error', 'ERR', 'fatal', 'Critical'].map(logLevelTone)).toEqual(['error', 'error', 'error', 'error']);
    expect(['warn', 'Warning'].map(logLevelTone)).toEqual(['warn', 'warn']);
    expect(['Information', 'INFO', 'notice'].map(logLevelTone)).toEqual(['info', 'info', 'info']);
    expect(['debug', 'Trace', 'Verbose'].map(logLevelTone)).toEqual(['debug', 'debug', 'debug']);
    expect([null, '', 'custom'].map(logLevelTone)).toEqual(['other', 'other', 'other']);
  });

  it('cleans the datasource prefix and the echoed query off Grafana errors', () => {
    expect(cleanGrafanaError('error from datasource: cannot parse `query` arg: compound token cannot start with ""; context: [app:(((]; query=app:(((\n')).toBe(
      'cannot parse `query` arg: compound token cannot start with ""; context: [app:(((]',
    );
  });
});

describe('direct VictoriaLogs connections', () => {
  it('reads a file without kind as a Grafana connection, and a direct one with its defaults', () => {
    const old = LogsConnectionSchema.parse({ id: 'a', name: 'Old', grafanaUrl: 'https://g.example.com', datasourceUid: 'vl', createdAt: 'x', updatedAt: 'x' });
    expect(old).toMatchObject({ kind: 'grafana', url: '', auth: 'none' });
    expect(old.tenant).toBeUndefined();
    expect(logsConnectionReady(old)).toBe(true);
    expect(logsConnectionAddress(old)).toBe('https://g.example.com');
    const direct = newLogsConnection({ kind: 'victorialogs', url: 'http://localhost:9428' });
    expect(logsConnectionReady(direct)).toBe(true);
    expect(logsConnectionAddress(direct)).toBe('http://localhost:9428');
    expect(logsConnectionReady(newLogsConnection({ kind: 'victorialogs' }))).toBe(false);
  });

  it('validates the tenant and lets a draft take it away', () => {
    expect(LogsConnectionDraftSchema.parse({ tenant: { accountId: 0, projectId: 3 } })).toEqual({ tenant: { accountId: 0, projectId: 3 } });
    expect(LogsConnectionDraftSchema.parse({ tenant: null })).toEqual({ tenant: null });
    expect(LogsConnectionDraftSchema.safeParse({ tenant: { accountId: -1, projectId: 0 } }).success).toBe(false);
    expect(LogsConnectionDraftSchema.safeParse({ tenant: { accountId: 1.5, projectId: 0 } }).success).toBe(false);
    expect(LogsConnectionDraftSchema.safeParse({ kind: 'loki' }).success).toBe(false);
  });

  it('defaults the address to http and keeps a sub-path', () => {
    expect(normalizeVictoriaLogsUrl('localhost:9428/')).toBe('http://localhost:9428');
    expect(normalizeVictoriaLogsUrl('https://logs.example.com/vl/?x=1')).toBe('https://logs.example.com/vl');
    expect(normalizeVictoriaLogsUrl('ftp://x')).toBe('');
    expect(normalizeGrafanaUrl('grafana.example.com')).toBe('https://grafana.example.com');
  });

  it('describes a direct connection by host and tenant', () => {
    expect(describeLogsConnection({ kind: 'victorialogs', url: 'http://127.0.0.1:9428', grafanaUrl: '', datasourceName: '' })).toBe('127.0.0.1:9428 · VictoriaLogs');
    expect(describeLogsConnection({ kind: 'victorialogs', url: 'http://vl:9428', tenant: { accountId: 2, projectId: 7 }, grafanaUrl: '', datasourceName: '' })).toBe('vl:9428 · VictoriaLogs · tenant 2:7');
  });

  it('sends the tenant headers and basic or bearer auth', () => {
    expect(victoriaLogsHeaders({ auth: 'none', tenant: { accountId: 1, projectId: 2 } }, 'ignored')).toEqual({ AccountID: '1', ProjectID: '2' });
    expect(victoriaLogsHeaders({ auth: 'basic', authUsername: 'ü', tenant: undefined }, 'p:w')).toEqual({ Authorization: `Basic ${Buffer.from('ü:p:w').toString('base64')}` });
    expect(victoriaLogsHeaders({ auth: 'bearer', tenant: undefined }, 'tok')).toEqual({ Authorization: 'Bearer tok' });
    expect(victoriaLogsHeaders({ auth: 'bearer', tenant: undefined }, '')).toEqual({});
  });

  it('reads RFC 3339 times to the nanosecond', () => {
    expect(rfc3339ToNs('2026-10-13T07:11:09.000000250Z')).toBe('1791875469000000250');
    expect(rfc3339ToNs('2026-10-13T07:11:09Z')).toBe('1791875469000000000');
    expect(rfc3339ToNs('2026-10-13T09:11:09.5+02:00')).toBe('1791875469500000000');
    expect(rfc3339ToNs('not a time')).toBe('0');
  });

  it('reads JSON lines as the same entries the Grafana frames give, newest first', () => {
    const lines = [
      { _time: '2026-10-13T07:11:08Z', _msg: 'started', _stream_id: 's1', _stream: '{app="api"}', app: 'api', level: 'Information' },
      { _time: '2026-10-13T07:11:09.000000250Z', _msg: 'failed to pay', _stream_id: 's1', app: 'api', level: 'Error', 'error.code': 'E42' },
      { _time: '2026-10-13T07:11:09.000000100Z', _msg: '{"a":1}', _stream_id: 's2', app: 'web', hits: 5 },
    ];
    const text = [JSON.stringify(lines[0]), JSON.stringify(lines[1]), '', 'not json', JSON.stringify(lines[2])].join('\n');
    const entries = parseVictoriaLogsLines(text);
    expect(entries.map((e) => e.msg)).toEqual(['failed to pay', '{"a":1}', 'started']);
    expect(entries[0]).toMatchObject({ ns: '1791875469000000250', time: '2026-10-13T07:11:09.000Z', level: 'Error', fields: { app: 'api', level: 'Error', 'error.code': 'E42' } });
    expect(entries[1]).toMatchObject({ level: null, fields: { app: 'web', hits: '5' } });
    expect(entries[2]!.fields).toMatchObject({ _stream: '{app="api"}' });
    for (const e of entries) for (const k of ['_stream_id', '_time', '_msg']) expect(e.fields).not.toHaveProperty(k);
    // The same entry through Grafana and directly is the same entry, id included.
    const viaGrafana = parseLogFrames([
      {
        schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Line', type: 'string' }, { name: 'labels', type: 'other' }] },
        data: { values: [[1791875469000], ['failed to pay'], [{ _stream_id: 's1', app: 'api', level: 'Error', 'error.code': 'E42' }]], nanos: [[250], null, null] },
      },
    ]);
    expect(viaGrafana[0]).toEqual(entries[0]);
  });

  it('reads pipe results as entries whose fields are the columns', () => {
    const [row] = parseVictoriaLogsLines(`${JSON.stringify({ app: 'api', hits: '3' })}\n`);
    expect(row).toMatchObject({ ns: '0', msg: '', level: null, fields: { app: 'api', hits: '3' } });
  });

  it('adds up hits series and reads field names and values', () => {
    const body = {
      hits: [
        { fields: { app: 'api' }, timestamps: ['2026-10-13T07:11:00Z', '2026-10-13T07:10:30Z'], values: [3, 1], total: 4 },
        { fields: { app: 'web' }, timestamps: ['2026-10-13T07:11:00Z'], values: [2], total: 2 },
      ],
    };
    const t = Date.parse('2026-10-13T07:11:00Z');
    expect(parseVictoriaLogsHits(body)).toEqual({ buckets: [{ time: t - 30_000, count: 1 }, { time: t, count: 5 }], total: 6 });
    expect(parseVictoriaLogsHits({})).toEqual({ buckets: [], total: 0 });
    expect(parseVictoriaLogsValues({ values: [{ value: 'level', hits: 5 }, { value: '', hits: '2' }, null] })).toEqual([
      { name: 'level', hits: 5 },
      { name: '', hits: 2 },
    ]);
    expect(parseVictoriaLogsValues('nope')).toEqual([]);
  });
});
