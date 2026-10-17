const EXTENSIONS: [RegExp, string][] = [
  [/json/i, 'json'],
  [/svg/i, 'svg'],
  [/html/i, 'html'],
  [/xml/i, 'xml'],
  [/csv/i, 'csv'],
  [/javascript/i, 'js'],
  [/^text\/plain/i, 'txt'],
  [/png/i, 'png'],
  [/jpe?g/i, 'jpg'],
  [/gif/i, 'gif'],
  [/webp/i, 'webp'],
  [/pdf/i, 'pdf'],
  [/zip/i, 'zip'],
  [/gzip/i, 'gz'],
  [/octet-stream/i, 'bin'],
];

/** The extension a content type is usually saved with, or null when unknown. */
export function extensionFor(contentType: string | null): string | null {
  if (!contentType) return null;
  const type = contentType.split(';')[0].trim();
  return EXTENSIONS.find(([re]) => re.test(type))?.[1] ?? null;
}

/**
 * A file name to suggest when saving a response: the last segment of the URL path when it has one,
 * given the content type's extension if it has none, else "response" with that extension.
 */
export function responseFileName(url: string, contentType: string | null): string {
  const ext = extensionFor(contentType);
  let base = '';
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    base = decodeURIComponent(segment).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  } catch {
    base = '';
  }
  if (!base) return `response.${ext ?? 'txt'}`;
  return /\.[A-Za-z0-9]{1,8}$/.test(base) || !ext ? base : `${base}.${ext}`;
}
