/** Splits a text stream into lines as chunks arrive: LF or CRLF, a line kept back until it ends, empty lines skipped. */
export interface LineSplitter {
  push(chunk: string): string[];
  /** The last line, when the stream ended without a line break. */
  end(): string[];
}

export function createLineSplitter(): LineSplitter {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      return parts.map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
    },
    end() {
      const last = buffer.replace(/\r$/, '');
      buffer = '';
      return last.trim() ? [last] : [];
    },
  };
}
