import type { McpContent, McpResourceContents } from '@quiver/core';
import { Badge, CodeEditor, formatBytes, type CodeLanguage } from '@quiver/ui';
import { useMemo } from 'react';

export function languageForMime(mime: string | undefined, text: string): CodeLanguage {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('json')) return 'json';
  if (m.includes('html')) return 'html';
  if (m.includes('xml')) return 'xml';
  if (m.includes('javascript')) return 'javascript';
  if (m.includes('sql')) return 'sql';
  if (m.includes('graphql')) return 'graphql';
  if (!m || m.startsWith('text/')) return /^\s*[[{]/.test(text) && isJson(text) ? 'json' : 'text';
  return 'text';
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Text shown read-only, pretty-printed when it is JSON. */
export function TextBlock({ text, mime }: { text: string; mime?: string }) {
  const { value, language } = useMemo(() => {
    const language = languageForMime(mime, text);
    if (language === 'json') {
      try {
        return { value: JSON.stringify(JSON.parse(text), null, 2), language };
      } catch {
        return { value: text, language: 'text' as const };
      }
    }
    return { value: text, language };
  }, [text, mime]);
  return <CodeEditor value={value} readOnly language={language} wrap={language !== 'json'} />;
}

export function ResourceContentsView({ contents }: { contents: McpResourceContents }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-2 text-[11px] text-muted flex-wrap">
        <span className="font-mono truncate">{contents.uri}</span>
        {contents.mimeType && <Badge>{contents.mimeType}</Badge>}
        {contents.blob !== undefined && <Badge>binary, {formatBytes(Math.floor((contents.blob.length * 3) / 4))}</Badge>}
      </div>
      {contents.text !== undefined && <TextBlock text={contents.text} mime={contents.mimeType} />}
      {contents.blob !== undefined && contents.mimeType?.startsWith('image/') && <img src={`data:${contents.mimeType};base64,${contents.blob}`} alt={contents.uri} className="max-h-64 max-w-full rounded border border-edge self-start" />}
      {contents.blob !== undefined && !contents.mimeType?.startsWith('image/') && <p className="text-xs text-muted">Binary contents are returned as base64 in `blob`.</p>}
    </div>
  );
}

export function ContentBlock({ content }: { content: McpContent }) {
  switch (content.type) {
    case 'text':
      return <TextBlock text={content.text} />;
    case 'image':
      return <img src={`data:${content.mimeType};base64,${content.data}`} alt="tool result" className="max-h-64 max-w-full rounded border border-edge self-start" />;
    case 'audio':
      return <audio controls src={`data:${content.mimeType};base64,${content.data}`} className="max-w-full" />;
    case 'resource':
      return <ResourceContentsView contents={content.resource} />;
    case 'resource_link':
      return (
        <div className="text-xs flex flex-col gap-0.5">
          <span className="font-medium">{content.name}</span>
          <span className="font-mono text-muted break-all">{content.uri}</span>
          {content.description && <span className="text-muted">{content.description}</span>}
          {content.mimeType && <Badge className="self-start">{content.mimeType}</Badge>}
        </div>
      );
    default:
      return <TextBlock text={JSON.stringify(content, null, 2)} mime="application/json" />;
  }
}

export function ContentBlocks({ content }: { content: McpContent[] }) {
  if (content.length === 0) return <p className="text-xs text-muted">No content.</p>;
  return (
    <div className="flex flex-col gap-2">
      {content.map((c, i) => (
        <div key={i} className="flex flex-col gap-1">
          {content.length > 1 && (
            <Badge className="self-start">
              {i + 1} · {c.type}
            </Badge>
          )}
          <ContentBlock content={c} />
        </div>
      ))}
    </div>
  );
}
