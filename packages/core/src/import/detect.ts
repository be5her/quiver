import { isRecord, parseStructured } from './common';

export type ImportFormat = 'openapi' | 'postman' | 'insomnia' | 'har';

export const IMPORT_FORMATS: { value: ImportFormat; label: string; extensions: string[] }[] = [
  { value: 'openapi', label: 'OpenAPI', extensions: ['yaml', 'yml', 'json'] },
  { value: 'postman', label: 'Postman', extensions: ['json'] },
  { value: 'insomnia', label: 'Insomnia', extensions: ['json', 'yaml', 'yml'] },
  { value: 'har', label: 'HAR', extensions: ['har', 'json'] },
];

/** Which importer reads this text, or null when none would. */
export function detectImportFormat(text: string): ImportFormat | null {
  let doc: unknown;
  try {
    doc = parseStructured(text, 'file');
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  if ('openapi' in doc || 'swagger' in doc) return 'openapi';
  if (isRecord(doc['log']) && Array.isArray(doc['log']['entries'])) return 'har';
  if (doc['_type'] === 'export' || (typeof doc['type'] === 'string' && doc['type'].startsWith('collection.insomnia.rest/'))) return 'insomnia';
  if ((isRecord(doc['info']) && Array.isArray(doc['item'])) || (Array.isArray(doc['values']) && '_postman_variable_scope' in doc) || isRecord(doc['collection'])) return 'postman';
  return null;
}
