/** Splits a text stream into lines as chunks arrive: LF or CRLF, a line kept back until it ends, empty lines skipped. */
export interface LineSplitter {
  /** The lines that ended with this chunk. Throws when a line grows past `maxLine` without ending: the stream is not lines. */
  push(chunk: string): string[];
  /** The last line, when the stream ended without a line break. */
  end(): string[];
}

/** How long a line (or an event) of a streamed body may be: a body that never breaks a line is not one to stream, and would be kept whole in memory. */
export const MAX_STREAM_LINE_BYTES = 1024 * 1024;

export function createLineSplitter(maxLine = MAX_STREAM_LINE_BYTES): LineSplitter {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      if (buffer.length > maxLine || parts.some((line) => line.length > maxLine)) {
        buffer = '';
        throw new Error(`A line of more than ${Math.round(maxLine / 1024 / 1024)} MB: the body is not lines, so the stream was closed`);
      }
      return parts.map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
    },
    end() {
      const last = buffer.replace(/\r$/, '');
      buffer = '';
      return last.trim() ? [last] : [];
    },
  };
}
