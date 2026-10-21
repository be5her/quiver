import { describe, expect, it } from 'vitest';
import { applySgr, color256, parseAnsi, plainText } from './ansi';

describe('parseAnsi', () => {
  it('keeps plain text as one unstyled span', () => {
    expect(parseAnsi('hello world').spans).toEqual([{ text: 'hello world', css: '' }]);
  });

  it('styles the text between colour codes and resets after 39 and 0', () => {
    const { spans, style } = parseAnsi('\x1b[32mready\x1b[39m on \x1b[1;31m3000\x1b[0m!');
    expect(spans).toEqual([
      { text: 'ready', css: 'color:var(--success)' },
      { text: ' on ', css: '' },
      { text: '3000', css: 'color:var(--danger);font-weight:600' },
      { text: '!', css: '' },
    ]);
    expect(style).toEqual({});
  });

  it('carries a style left open into the next line', () => {
    const first = parseAnsi('\x1b[33mwarn: a');
    expect(first.style).toEqual({ fg: 'var(--warning)' });
    expect(parseAnsi('b\x1b[m', first.style).spans).toEqual([{ text: 'b', css: 'color:var(--warning)' }]);
  });

  it('reads 256 colours and true colour, and ignores broken ones', () => {
    expect(parseAnsi('\x1b[38;5;196mx').spans[0].css).toBe('color:rgb(255,0,0)');
    expect(parseAnsi('\x1b[48;2;1;2;3mx').spans[0].css).toBe('background-color:rgb(1,2,3)');
    expect(parseAnsi('\x1b[38;2;300;0;0mx').spans[0].css).toBe('');
    expect(color256(232)).toBe('rgb(8,8,8)');
    expect(color256(256)).toBeUndefined();
  });

  it('drops other escapes: cursor moves, erase line, titles, bare control characters', () => {
    expect(plainText('\x1b[2K\x1b[1Gbuilt\x1b]0;title\x07 in \x1b[?25l1s\x07\x08')).toBe('built in 1s');
    expect(parseAnsi('a\tb').spans[0].text).toBe('a\tb');
  });

  it('drops escapes with intermediates and the one-character ones (tput sgr0, save and restore cursor)', () => {
    expect(plainText('\x1b[31mred\x1b(B\x1b[m plain')).toBe('red plain');
    expect(plainText('\x1b7saved\x1b8\x1b=\x1b>')).toBe('saved');
  });

  it('reads colon sub-parameters as one parameter', () => {
    expect(applySgr({}, '38:2::255:0:0')).toEqual({ fg: 'rgb(255,0,0)' });
    expect(applySgr({}, '38:2:1:2:3')).toEqual({ fg: 'rgb(1,2,3)' });
    expect(applySgr({}, '48:5:196')).toEqual({ bg: 'rgb(255,0,0)' });
    expect(applySgr({ fg: 'red', underline: true }, '4:0')).toEqual({ fg: 'red' });
    expect(applySgr({}, '4:3')).toEqual({ underline: true });
  });

  it('starts the line over at a carriage return, keeping the colour set before it', () => {
    expect(plainText('dl 10%\rdl 50%\rdl 100%')).toBe('dl 100%');
    expect(parseAnsi('\x1b[32m10%\r100%').spans).toEqual([{ text: '100%', css: 'color:var(--success)' }]);
    expect(plainText('done\r')).toBe('done');
  });

  it('swaps colours for inverse and turns bold and dim off with 22', () => {
    expect(applySgr({}, '7;31')).toEqual({ inverse: true, fg: 'var(--danger)' });
    expect(parseAnsi('\x1b[7;31mx').spans[0].css).toBe('color:var(--canvas);background-color:var(--danger)');
    expect(applySgr({ bold: true, dim: true, fg: 'red' }, '22')).toEqual({ fg: 'red' });
  });
});
