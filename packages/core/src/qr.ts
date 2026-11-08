import { QuiverError } from './errors';

// A QR code encoder after ISO/IEC 18004:2015, with no dependency. One function per stage, in the order the standard
// describes them: choose the mode (7.4), the version (7.4.10, Table 7), encode the data (7.4.3 to 7.4.10), add the
// error correction codewords (7.5, Table 9) and interleave them (7.6), place the function patterns (6.3) and the data
// (7.7.3), choose the mask (7.8) and write the format and version information (7.9, 7.10). Kanji mode and mixed
// segments are left out: a text is one numeric, alphanumeric or byte (UTF-8) segment.

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';
export type QrMode = 'numeric' | 'alphanumeric' | 'byte';

export interface QrCode {
  /** One string per row, '1' dark and '0' light, without the quiet zone. */
  modules: string[];
  version: number;
  /** Modules per side: 17 + 4 × version. */
  size: number;
  errorCorrection: QrErrorCorrection;
  mode: QrMode;
  /** The mask pattern reference 0–7 the penalty rules picked. */
  mask: number;
}

export interface QrEncodeOptions {
  errorCorrection?: QrErrorCorrection;
  /** Force a mask pattern instead of the one with the lowest penalty (tests). */
  mask?: number;
}

export interface QrSvgOptions {
  /** The quiet zone, in modules (the standard asks for 4). */
  margin?: number;
  /** Pixels per module for the SVG's width and height. */
  moduleSize?: number;
}

/** The most a QR code holds: version 40 at level L in byte mode (Table 7). */
export const QR_MAX_BYTES = 2953;

const LEVELS: readonly QrErrorCorrection[] = ['L', 'M', 'Q', 'H'];

/** Table 9: error correction codewords per block, by level then version (index 0 unused). */
const ECC_CODEWORDS_PER_BLOCK: Record<QrErrorCorrection, readonly number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** Table 9: error correction blocks, by level then version (index 0 unused). */
const ECC_BLOCKS: Record<QrErrorCorrection, readonly number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** Table 12: the two bits of each level in the format information. */
const FORMAT_LEVEL_BITS: Record<QrErrorCorrection, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

/** Table 2: the mode indicators. */
const MODE_INDICATOR: Record<QrMode, number> = { numeric: 0b0001, alphanumeric: 0b0010, byte: 0b0100 };

/** Table 5: the 45 characters of alphanumeric mode, in value order. */
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// ---------- 7.4: data analysis and encoding ----------

/** 7.3: the densest single mode that holds every character of the text. */
export function qrMode(text: string): QrMode {
  if (/^[0-9]*$/.test(text)) return 'numeric';
  if ([...text].every((c) => ALPHANUMERIC.includes(c))) return 'alphanumeric';
  return 'byte';
}

/** Table 3: bits of the character count indicator, by mode and version range 1–9, 10–26, 27–40. */
function charCountBits(mode: QrMode, version: number): number {
  const range = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  return { numeric: [10, 12, 14], alphanumeric: [9, 11, 13], byte: [8, 16, 16] }[mode][range];
}

/** A growing bit string, most significant bit first. */
class BitBuffer {
  readonly bits: number[] = [];

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** The data bits of one segment, without its mode indicator and count (7.4.3 to 7.4.5). */
function segmentBits(mode: QrMode, text: string, bytes: Uint8Array): { bits: BitBuffer; count: number } {
  const bits = new BitBuffer();
  if (mode === 'numeric') {
    // 7.4.3: groups of three digits in 10 bits; a last group of two in 7, of one in 4.
    for (let i = 0; i < text.length; i += 3) {
      const group = text.slice(i, i + 3);
      bits.append(Number(group), group.length * 3 + 1);
    }
    return { bits, count: text.length };
  }
  if (mode === 'alphanumeric') {
    // 7.4.4: pairs as 45 × first + second in 11 bits; a last single character in 6.
    for (let i = 0; i < text.length; i += 2) {
      const first = ALPHANUMERIC.indexOf(text[i]);
      if (i + 1 < text.length) bits.append(first * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
      else bits.append(first, 6);
    }
    return { bits, count: text.length };
  }
  // 7.4.5: each byte in 8 bits; the count is in bytes.
  for (const b of bytes) bits.append(b, 8);
  return { bits, count: bytes.length };
}

// ---------- Table 7 and 9: capacity ----------

/** 6.4.10: modules left for data and error correction once the function patterns and format/version areas are taken. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Table 7: data codewords of a version at a level. */
function dataCodewords(version: number, level: QrErrorCorrection): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[level][version] * ECC_BLOCKS[level][version];
}

/** The smallest version whose data capacity holds the segment, or null when even version 40 does not. */
function chooseVersion(mode: QrMode, dataBits: number, level: QrErrorCorrection): number | null {
  for (let version = 1; version <= 40; version++) {
    if (4 + charCountBits(mode, version) + dataBits <= dataCodewords(version, level) * 8) return version;
  }
  return null;
}

/** Table 7: the most characters (digits, alphanumeric characters or bytes) one segment of the mode holds at version 40. */
function maxCharacters(mode: QrMode, level: QrErrorCorrection): number {
  const bits = dataCodewords(40, level) * 8 - 4 - charCountBits(mode, 40);
  if (mode === 'numeric') return Math.floor(bits / 10) * 3 + (bits % 10 >= 7 ? 2 : bits % 10 >= 4 ? 1 : 0);
  if (mode === 'alphanumeric') return Math.floor(bits / 11) * 2 + (bits % 11 >= 6 ? 1 : 0);
  return Math.floor(bits / 8);
}

/** 7.4.9 and 7.4.10: mode, count and data, then the terminator, padding to a byte and the 0xEC 0x11 pad codewords. */
function dataCodewordBytes(mode: QrMode, segment: { bits: BitBuffer; count: number }, version: number, level: QrErrorCorrection): number[] {
  const capacity = dataCodewords(version, level) * 8;
  const bb = new BitBuffer();
  bb.append(MODE_INDICATOR[mode], 4);
  bb.append(segment.count, charCountBits(mode, version));
  bb.bits.push(...segment.bits.bits);
  bb.append(0, Math.min(4, capacity - bb.bits.length));
  bb.append(0, (8 - (bb.bits.length % 8)) % 8);
  for (let pad = 0xec; bb.bits.length < capacity; pad ^= 0xec ^ 0x11) bb.append(pad, 8);
  const bytes: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) bytes.push(bb.bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  return bytes;
}

// ---------- 7.5: Reed–Solomon error correction over GF(256) ----------

/** Multiplication in GF(2^8) modulo the field's polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D). */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** Annex A: the generator polynomial of a degree, (x − α^0)(x − α^1)…, highest coefficient (always 1) left out. */
function rsGenerator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** 7.5.2: the error correction codewords of one block, the remainder of the data divided by the generator. */
function rsRemainder(data: readonly number[], generator: readonly number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    generator.forEach((coef, i) => (result[i] ^= gfMultiply(coef, factor)));
  }
  return result;
}

/** 7.6: split the data into the blocks of Table 9, add each block's error correction, and interleave them. */
function addEccAndInterleave(data: readonly number[], version: number, level: QrErrorCorrection): number[] {
  const numBlocks = ECC_BLOCKS[level][version];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[level][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const generator = rsGenerator(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const block = data.slice(k, k + shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1));
    k += block.length;
    const ecc = rsRemainder(block, generator);
    // Short blocks get a placeholder so every block has the same length; it is skipped when interleaving.
    if (i < numShortBlocks) block.push(0);
    blocks.push([...block, ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - eccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// ---------- 6.3: the symbol and its function patterns ----------

/** The matrix while it is drawn: dark modules and which ones belong to function patterns. */
interface Grid {
  size: number;
  dark: boolean[][];
  reserved: boolean[][];
}

function setFunction(grid: Grid, x: number, y: number, dark: boolean): void {
  grid.dark[y][x] = dark;
  grid.reserved[y][x] = true;
}

/** Annex E, Table E.1: the row and column centres of the alignment patterns of a version. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** 6.3.3: a 7×7 finder pattern centred on (cx, cy) with its light separator. */
function drawFinder(grid: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) continue;
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(grid, x, y, ring !== 2 && ring !== 4);
    }
  }
}

/** 6.3.6: a 5×5 alignment pattern centred on (cx, cy). */
function drawAlignment(grid: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) setFunction(grid, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
}

/** 6.3.5, 6.3.3 and 6.3.6: timing patterns, the three finders, the alignment patterns, and the format and version areas reserved. */
function drawFunctionPatterns(grid: Grid, version: number, level: QrErrorCorrection): void {
  for (let i = 0; i < grid.size; i++) {
    setFunction(grid, 6, i, i % 2 === 0);
    setFunction(grid, i, 6, i % 2 === 0);
  }
  drawFinder(grid, 3, 3);
  drawFinder(grid, grid.size - 4, 3);
  drawFinder(grid, 3, grid.size - 4);
  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      // The three corners that hold a finder pattern get no alignment pattern.
      const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0);
      if (!corner) drawAlignment(grid, align[i], align[j]);
    }
  }
  drawFormatBits(grid, level, 0);
  drawVersionBits(grid, version);
}

/** 7.9: the 15 format bits (level, mask, BCH(15,5) with generator 0x537, masked with 0x5412), twice, and the dark module. */
function drawFormatBits(grid: Grid, level: QrErrorCorrection, mask: number): void {
  const data = (FORMAT_LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const size = grid.size;
  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) setFunction(grid, 8, i, bit(i));
  setFunction(grid, 8, 7, bit(6));
  setFunction(grid, 8, 8, bit(7));
  setFunction(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(grid, 14 - i, 8, bit(i));
  // Beside the top-right and bottom-left finders.
  for (let i = 0; i < 8; i++) setFunction(grid, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(grid, 8, size - 15 + i, bit(i));
  // 7.9.1: the module above the bottom-left format bits is always dark.
  setFunction(grid, 8, size - 8, true);
}

/** 7.10: from version 7, the 18 version bits (BCH(18,6) with generator 0x1F25), in two 6×3 blocks. */
function drawVersionBits(grid: Grid, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = grid.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(grid, a, b, dark);
    setFunction(grid, b, a, dark);
  }
}

// ---------- 7.7.3: placing the codewords ----------

/** Two-module columns from the right, upwards then downwards, skipping the vertical timing column and function modules. */
function drawCodewords(grid: Grid, codewords: readonly number[]): void {
  const size = grid.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? size - 1 - vert : vert;
        if (grid.reserved[y][x] || i >= codewords.length * 8) continue;
        grid.dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
  // The remainder bits (Table 1) stay light.
}

// ---------- 7.8: masking ----------

/** Table 10: the eight mask conditions, with i the row and j the column. */
const MASKS: readonly ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

/** XOR a mask over the data modules; applying it twice undoes it. */
function applyMask(grid: Grid, mask: number): void {
  const condition = MASKS[mask];
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) if (!grid.reserved[y][x] && condition(y, x)) grid.dark[y][x] = !grid.dark[y][x];
  }
}

/** 7.8.3, Table 11: the penalty of a masked symbol (N1 = 3, N2 = 3, N3 = 40, N4 = 10). Lower is better. */
export function qrPenalty(dark: readonly (readonly boolean[])[]): number {
  const size = dark.length;
  const at = (x: number, y: number, vertical: boolean) => (vertical ? dark[x][y] : dark[y][x]);
  let penalty = 0;
  // Feature 1 (runs of five or more of one colour) and feature 3 (1:1:3:1:1 with four light modules on a side), rows then columns.
  const finderLike = [true, false, true, true, true, false, true];
  for (const vertical of [false, true]) {
    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x <= size; x++) {
        if (x < size && at(x, y, vertical) === at(x - 1, y, vertical)) run++;
        else {
          if (run >= 5) penalty += 3 + (run - 5);
          run = 1;
        }
      }
      for (let x = 0; x + 7 <= size; x++) {
        if (!finderLike.every((d, k) => at(x + k, y, vertical) === d)) continue;
        const lightBefore = x >= 4 && [1, 2, 3, 4].every((k) => !at(x - k, y, vertical));
        const lightAfter = x + 11 <= size && [7, 8, 9, 10].every((k) => !at(x + k, y, vertical));
        if (lightBefore) penalty += 40;
        if (lightAfter) penalty += 40;
      }
    }
  }
  // Feature 2: each 2×2 block of one colour.
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = dark[y][x];
      if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) penalty += 3;
    }
  }
  // Feature 4: 10 points for every full 5 % the dark share is away from 50 %.
  const darkCount = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  penalty += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10;
  return penalty;
}

/** 7.8.2: try every mask (with its format bits drawn, since they count too) and keep the one with the lowest penalty. */
function chooseMask(grid: Grid, level: QrErrorCorrection): number {
  let best = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(grid, mask);
    drawFormatBits(grid, level, mask);
    const penalty = qrPenalty(grid.dark);
    if (penalty < bestPenalty) {
      best = mask;
      bestPenalty = penalty;
    }
    applyMask(grid, mask);
  }
  return best;
}

// ---------- The whole encoder ----------

/** Encode a text as a QR code at the smallest version that holds it at the level (M by default). */
export function encodeQr(text: string, options: QrEncodeOptions = {}): QrCode {
  const level = options.errorCorrection ?? 'M';
  if (!LEVELS.includes(level)) throw new QuiverError('INVALID_INPUT', `Unknown error correction level "${level}"; use L, M, Q or H`);
  const bytes = new TextEncoder().encode(text);
  if (!bytes.length) throw new QuiverError('INVALID_INPUT', 'Nothing to encode: the text is empty');
  if (bytes.length > QR_MAX_BYTES) throw new QuiverError('INVALID_INPUT', `The text is ${bytes.length} bytes; a QR code holds at most ${QR_MAX_BYTES} bytes (version 40, level L)`);
  const mode = qrMode(text);
  const segment = segmentBits(mode, text, bytes);
  const version = chooseVersion(mode, segment.bits.bits.length, level);
  if (version === null) {
    const unit = { numeric: 'digits', alphanumeric: 'characters', byte: 'bytes' }[mode];
    const length = mode === 'byte' ? bytes.length : text.length;
    throw new QuiverError(
      'INVALID_INPUT',
      `The text is ${length} ${unit} in ${mode} mode; at level ${level} a QR code holds at most ${maxCharacters(mode, level)} ${unit} in that mode. A lower level holds more, up to ${QR_MAX_BYTES} bytes at L`,
    );
  }
  const size = version * 4 + 17;
  const grid: Grid = { size, dark: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)), reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)) };
  drawFunctionPatterns(grid, version, level);
  drawCodewords(grid, addEccAndInterleave(dataCodewordBytes(mode, segment, version, level), version, level));
  const mask = options.mask ?? chooseMask(grid, level);
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new QuiverError('INVALID_INPUT', `Mask ${mask} is not 0 to 7`);
  applyMask(grid, mask);
  drawFormatBits(grid, level, mask);
  return { modules: grid.dark.map((row) => row.map((d) => (d ? '1' : '0')).join('')), version, size, errorCorrection: level, mode, mask };
}

/** The path of the dark modules, one unit square each, offset by the margin: one `M x,y h1v1h-1z` per module. */
export function qrSvgPath(modules: readonly string[], margin = 0): string {
  let d = '';
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '1') d += `M${x + margin},${y + margin}h1v1h-1z`;
  });
  return d;
}

/** An SVG of the code: one path for the dark modules in `currentColor`, the light ones left transparent. */
export function renderQrSvg(modules: readonly string[], options: QrSvgOptions = {}): string {
  const margin = options.margin ?? 4;
  const moduleSize = options.moduleSize ?? 8;
  const side = modules.length + margin * 2;
  const px = side * moduleSize;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><path fill="currentColor" d="${qrSvgPath(modules, margin)}"/></svg>`;
}
