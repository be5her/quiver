import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { QR_MAX_BYTES, alignmentPositions, encodeQr, qrMode, renderQrSvg, type QrCode, type QrErrorCorrection } from './qr';

/** "HELLO WORLD" at 1-Q, the worked example of thonky.com's QR code tutorial (mask 6). */
const HELLO_WORLD_1Q = [
  '111111100001001111111',
  '100000101100101000001',
  '101110100101101011101',
  '101110101111101011101',
  '101110101101001011101',
  '100000100100101000001',
  '111111101010101111111',
  '000000001101100000000',
  '010111101100111011010',
  '101111010000111101110',
  '001010110001001100000',
  '101101000101100011000',
  '110111111110111011111',
  '000000001000100101000',
  '111111100110011001111',
  '100000101010010010111',
  '101110101101001000111',
  '101110101011100010100',
  '101110100100001000011',
  '100000101110011100110',
  '111111100101000000010',
];

/**
 * Draw the matrix with a quiet zone into an RGBA buffer, as a camera frame would show it, and read it back. jsqr 1.4
 * has version 23's alignment centres wrong (74 for 78), so a 23-L symbol does not read back; keep decoded texts off
 * version 23 (the alignment test below checks ours against Table E.1).
 */
function decode(code: QrCode, scale = 4): string | null {
  const margin = 4;
  const side = (code.size + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  code.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const at = (((y + margin) * scale + dy) * side + (x + margin) * scale + dx) * 4;
          pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
        }
      }
    }
  });
  return jsQR(pixels, side, side, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

/** Annex E, Table E.1: the alignment pattern centres of versions 2 to 40. */
const TABLE_E1: Record<number, number[]> = {
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
  18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90], 21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98], 23: [6, 30, 54, 78, 102],
  24: [6, 28, 54, 80, 106], 25: [6, 32, 58, 84, 110], 26: [6, 30, 58, 86, 114], 27: [6, 34, 62, 90, 118], 28: [6, 26, 50, 74, 98, 122],
  29: [6, 30, 54, 78, 102, 126], 30: [6, 26, 52, 78, 104, 130], 31: [6, 30, 56, 82, 108, 134], 32: [6, 34, 60, 86, 112, 138],
  33: [6, 30, 58, 86, 114, 142], 34: [6, 34, 62, 90, 118, 146], 35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154],
  37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162], 39: [6, 26, 54, 82, 110, 138, 166], 40: [6, 30, 58, 86, 114, 142, 170],
};

/** The 5×5 alignment pattern as rows. */
const ALIGNMENT = ['11111', '10001', '10101', '10001', '11111'];

/** The 7×7 finder pattern as rows. */
const FINDER = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];

function block(modules: string[], x: number, y: number, n: number): string[] {
  return modules.slice(y, y + n).map((row) => row.slice(x, x + n));
}

describe('encodeQr', () => {
  it('reproduces a published symbol module by module', () => {
    const code = encodeQr('HELLO WORLD', { errorCorrection: 'Q' });
    expect(code).toMatchObject({ version: 1, size: 21, mode: 'alphanumeric', errorCorrection: 'Q', mask: 6 });
    expect(code.modules).toEqual(HELLO_WORLD_1Q);
  });

  it('detects the mode', () => {
    expect(qrMode('0123456789')).toBe('numeric');
    expect(qrMode('HELLO WORLD $%*+-./:')).toBe('alphanumeric');
    expect(qrMode('Hello')).toBe('byte');
    expect(qrMode('héllo')).toBe('byte');
    expect(encodeQr('https://example.com').mode).toBe('byte');
  });

  it('picks the smallest version at the edges of version 1-L', () => {
    // Version 1-L holds 19 data codewords: 41 digits, 25 alphanumeric characters or 17 bytes.
    expect(encodeQr('1'.repeat(41), { errorCorrection: 'L' }).version).toBe(1);
    expect(encodeQr('1'.repeat(42), { errorCorrection: 'L' }).version).toBe(2);
    expect(encodeQr('A'.repeat(25), { errorCorrection: 'L' }).version).toBe(1);
    expect(encodeQr('A'.repeat(26), { errorCorrection: 'L' }).version).toBe(2);
    expect(encodeQr('a'.repeat(17), { errorCorrection: 'L' }).version).toBe(1);
    expect(encodeQr('a'.repeat(18), { errorCorrection: 'L' }).version).toBe(2);
  });

  it('honours every level: more correction needs a larger symbol', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const versions = (['L', 'M', 'Q', 'H'] as QrErrorCorrection[]).map((level) => encodeQr(text, { errorCorrection: level }).version);
    expect(versions).toEqual([3, 4, 4, 5]);
  });

  it('builds a consistent symbol for a long text at a high version', () => {
    const code = encodeQr('x'.repeat(2000), { errorCorrection: 'L' });
    expect(code.version).toBe(33);
    expect(code.size).toBe(17 + 4 * code.version);
    expect(code.modules).toHaveLength(code.size);
    expect(code.modules.every((row) => row.length === code.size && /^[01]+$/.test(row))).toBe(true);
    expect(block(code.modules, 0, 0, 7)).toEqual(FINDER);
    expect(block(code.modules, code.size - 7, 0, 7)).toEqual(FINDER);
    expect(block(code.modules, 0, code.size - 7, 7)).toEqual(FINDER);
    // Every alignment pattern of the symbol is in place: the centres of Table E.1, skipping the three finder corners.
    const centres = alignmentPositions(code.version);
    for (const cy of centres) {
      for (const cx of centres) {
        const corner = (cx === 6 && cy === 6) || (cx === 6 && cy === centres.at(-1)) || (cx === centres.at(-1) && cy === 6);
        if (!corner) expect(block(code.modules, cx - 2, cy - 2, 5), `alignment at ${cx},${cy}`).toEqual(ALIGNMENT);
      }
    }
    expect(decode(code, 2)).toBe('x'.repeat(2000));
  });

  it('places the alignment patterns of Table E.1 for every version', () => {
    expect(alignmentPositions(1)).toEqual([]);
    for (let version = 2; version <= 40; version++) expect(alignmentPositions(version), `version ${version}`).toEqual(TABLE_E1[version]);
  });

  it('holds 2953 bytes at 40-L and refuses more, or empty text', () => {
    expect(encodeQr('a'.repeat(QR_MAX_BYTES), { errorCorrection: 'L' }).version).toBe(40);
    expect(() => encodeQr('a'.repeat(QR_MAX_BYTES + 1), { errorCorrection: 'L' })).toThrow(/at most 2953 bytes/);
    // Too long for the level: the refusal names that level's limit in the text's mode (Table 7, version 40).
    expect(encodeQr('a'.repeat(1273), { errorCorrection: 'H' }).version).toBe(40);
    expect(() => encodeQr('a'.repeat(1274), { errorCorrection: 'H' })).toThrow(/at level H a QR code holds at most 1273 bytes/);
    expect(encodeQr('A'.repeat(1852), { errorCorrection: 'H' }).version).toBe(40);
    expect(() => encodeQr('A'.repeat(1853), { errorCorrection: 'H' })).toThrow(/1853 characters in alphanumeric mode; at level H a QR code holds at most 1852 characters/);
    expect(encodeQr('1'.repeat(2953), { errorCorrection: 'H' }).version).toBe(40);
    expect(() => encodeQr('A'.repeat(2421), { errorCorrection: 'Q' })).toThrow(/at most 2420 characters/);
    expect(() => encodeQr('a'.repeat(2332), { errorCorrection: 'M' })).toThrow(/at most 2331 bytes/);
    expect(() => encodeQr('')).toThrow(/empty/);
  });

  it('decodes as what was encoded', () => {
    expect(decode(encodeQr('0123456789012345'))).toBe('0123456789012345');
    expect(decode(encodeQr('HTTPS://EXAMPLE.COM/A-B'))).toBe('HTTPS://EXAMPLE.COM/A-B');
    expect(decode(encodeQr('héllo wörld ✓'))).toBe('héllo wörld ✓');
    const kilobyte = Array.from({ length: 1024 }, (_, i) => String.fromCharCode(32 + (i % 95))).join('');
    expect(decode(encodeQr(kilobyte), 2)).toBe(kilobyte);
    for (const level of ['L', 'M', 'Q', 'H'] as QrErrorCorrection[]) expect(decode(encodeQr(`level ${level}`, { errorCorrection: level }))).toBe(`level ${level}`);
  });

  it('decodes with every mask forced', () => {
    for (let mask = 0; mask < 8; mask++) expect(decode(encodeQr('https://quiver.test/qr', { mask }))).toBe('https://quiver.test/qr');
  });
});

describe('renderQrSvg', () => {
  it('draws one square per dark module in one path, sized by margin and module size', () => {
    const code = encodeQr('HELLO WORLD', { errorCorrection: 'Q' });
    const svg = renderQrSvg(code.modules, { margin: 2, moduleSize: 10 });
    const dark = code.modules.join('').split('').filter((m) => m === '1').length;
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg.match(/h1v1h-1z/g)).toHaveLength(dark);
    expect(svg).toContain('width="250" height="250" viewBox="0 0 25 25"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('fill="currentColor"');
    // The top-left module of the finder sits at the margin.
    expect(svg).toContain('d="M2,2h1v1h-1z');
  });
});
