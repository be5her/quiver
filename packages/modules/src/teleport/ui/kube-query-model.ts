import { kubeActionInfo, kubeActionTarget, kubeOperationInfo, type KubeAction, type KubeActionId, type KubeHistoryEntry, type KubeOperation, type KubeQuery } from '@quiver/core';

/** What the form holds, keyed by field: text as typed, ticked flags, a tail count. */
export type KubeValues = Record<string, string | number | boolean | undefined>;

/** Form values to a query: empty fields and unticked flags are left out, numbers are parsed. */
export function toQuery(operation: KubeOperation, values: KubeValues): KubeQuery {
  const info = kubeOperationInfo(operation);
  const params: Record<string, unknown> = {};
  for (const field of info?.fields ?? []) {
    const v = values[field.key];
    if (v === undefined || v === '' || v === false) continue;
    if (field.kind === 'tail') params[field.key] = typeof v === 'number' ? v : /^\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : v;
    else if (typeof v === 'string') params[field.key] = v.trim();
    else params[field.key] = v;
  }
  return { operation, params } as KubeQuery;
}

/** Number fields of actions: typed as text, sent as integers when they are one. */
const ACTION_NUMBERS = new Set(['replicas', 'revision', 'grace']);

/** Form values to an action, the same way: empty fields are left out, counts are parsed. */
export function toAction(action: KubeActionId, values: KubeValues): KubeAction {
  const info = kubeActionInfo(action);
  const params: Record<string, unknown> = {};
  for (const field of info?.fields ?? []) {
    const v = values[field.key];
    if (v === undefined || v === '' || v === false) continue;
    if (ACTION_NUMBERS.has(field.kind)) params[field.key] = typeof v === 'number' ? v : /^\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : v;
    else if (typeof v === 'string') params[field.key] = v.trim();
    else params[field.key] = v;
  }
  return { action, params } as KubeAction;
}

/** An action in a few words, e.g. `deployments/api · payments · 3 replicas`. */
export function summarizeAction(a: KubeAction): string {
  const t = kubeActionTarget(a);
  const p = a.params as Record<string, unknown>;
  const parts = [
    `${t.kind}/${t.name}`,
    t.namespace,
    p['replicas'] !== undefined ? `${p['replicas']} replica${p['replicas'] === 1 ? '' : 's'}` : undefined,
    p['toRevision'] !== undefined ? `to revision ${p['toRevision']}` : undefined,
    p['image'] !== undefined ? `${p['container']}=${p['image']}` : undefined,
    p['jobName'],
  ];
  return parts.filter((x) => x !== undefined && x !== '').join(' · ');
}

/** A history entry's title and parameters, whichever catalogue it came from. */
export function describeEntry(entry: KubeHistoryEntry): { title: string; summary: string } {
  if (entry.kind === 'action') return { title: kubeActionInfo(entry.action.action)?.title ?? entry.action.action, summary: summarizeAction(entry.action) };
  return { title: kubeOperationInfo(entry.query.operation)?.title ?? entry.query.operation, summary: summarizeQuery(entry.query) };
}

/** A history entry's parameters in a few words, e.g. `pods · payments · app=api`. */
export function summarizeQuery(q: KubeQuery): string {
  const p = q.params as Record<string, unknown>;
  const parts = [
    p['verb'],
    p['resource'],
    p['name'] ?? p['pod'] ?? p['deployment'],
    p['allNamespaces'] ? 'all namespaces' : p['namespace'],
    p['container'],
    p['selector'],
    p['tail'] !== undefined ? `tail ${p['tail']}` : undefined,
    p['since'] ? `since ${p['since']}` : undefined,
    p['output'],
  ];
  return parts.filter((x) => x !== undefined && x !== '').join(' · ');
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export interface LinePart {
  text: string;
  match: boolean;
}

/** A line split around every occurrence of `term` (lower case), for highlighting search matches. */
export function splitMatches(line: string, term: string): LinePart[] {
  if (!term) return [{ text: line, match: false }];
  const lower = line.toLowerCase();
  const parts: LinePart[] = [];
  let at = 0;
  for (let i = lower.indexOf(term); i >= 0; i = lower.indexOf(term, at)) {
    parts.push({ text: line.slice(at, i), match: false }, { text: line.slice(i, i + term.length), match: true });
    at = i + term.length;
  }
  parts.push({ text: line.slice(at), match: false });
  return parts;
}
