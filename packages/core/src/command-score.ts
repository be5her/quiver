/**
 * Fuzzy match score for the command palette: 1 for an exact match, 0 for no match, and in between
 * by how the search characters land in the text (word starts and the beginning score highest).
 * A port of the scoring in cmdk (MIT), so the palette ranks entries as it always has.
 */

const SCORE_CONTINUE_MATCH = 1;
const SCORE_SPACE_WORD_JUMP = 0.9;
const SCORE_NON_SPACE_WORD_JUMP = 0.8;
const SCORE_CHARACTER_JUMP = 0.17;
const SCORE_TRANSPOSITION = 0.1;
const PENALTY_SKIPPED = 0.999;
const PENALTY_CASE_MISMATCH = 0.9999;
const PENALTY_NOT_COMPLETE = 0.99;

const IS_GAP = /[\\/_+.#"@[({&]/;
const COUNT_GAPS = /[\\/_+.#"@[({&]/g;
const IS_SPACE = /[\s-]/;
const COUNT_SPACE = /[\s-]/g;

function score(text: string, search: string, lowerText: string, lowerSearch: string, textIndex: number, searchIndex: number, memo: Record<string, number>): number {
  if (searchIndex === search.length) return textIndex === text.length ? SCORE_CONTINUE_MATCH : PENALTY_NOT_COMPLETE;
  const key = `${textIndex},${searchIndex}`;
  if (memo[key] !== undefined) return memo[key];

  const char = lowerSearch.charAt(searchIndex);
  let index = lowerText.indexOf(char, textIndex);
  let best = 0;
  while (index >= 0) {
    let current = score(text, search, lowerText, lowerSearch, index + 1, searchIndex + 1, memo);
    if (current > best) {
      if (index === textIndex) {
        current *= SCORE_CONTINUE_MATCH;
      } else if (IS_GAP.test(text.charAt(index - 1))) {
        current *= SCORE_NON_SPACE_WORD_JUMP;
        const gaps = text.slice(textIndex, index - 1).match(COUNT_GAPS);
        if (gaps && textIndex > 0) current *= PENALTY_SKIPPED ** gaps.length;
      } else if (IS_SPACE.test(text.charAt(index - 1))) {
        current *= SCORE_SPACE_WORD_JUMP;
        const spaces = text.slice(textIndex, index - 1).match(COUNT_SPACE);
        if (spaces && textIndex > 0) current *= PENALTY_SKIPPED ** spaces.length;
      } else {
        current *= SCORE_CHARACTER_JUMP;
        if (textIndex > 0) current *= PENALTY_SKIPPED ** (index - textIndex);
      }
      if (text.charAt(index) !== search.charAt(searchIndex)) current *= PENALTY_CASE_MISMATCH;
    }
    if (
      (current < SCORE_TRANSPOSITION && lowerText.charAt(index - 1) === lowerSearch.charAt(searchIndex + 1)) ||
      (lowerSearch.charAt(searchIndex + 1) === lowerSearch.charAt(searchIndex) && lowerText.charAt(index - 1) !== lowerSearch.charAt(searchIndex))
    ) {
      const transposed = score(text, search, lowerText, lowerSearch, index + 1, searchIndex + 2, memo);
      if (transposed * SCORE_TRANSPOSITION > current) current = transposed * SCORE_TRANSPOSITION;
    }
    if (current > best) best = current;
    index = lowerText.indexOf(char, index + 1);
  }
  memo[key] = best;
  return best;
}

const normalize = (value: string): string => value.toLowerCase().replace(COUNT_SPACE, ' ');

/** How well `search` matches `text` (with optional extra keywords), from 0 (no match) to 1. */
export function commandScore(text: string, search: string, keywords?: string[]): number {
  const full = keywords && keywords.length > 0 ? `${text} ${keywords.join(' ')}` : text;
  return score(full, search, normalize(full), normalize(search), 0, 0, {});
}
