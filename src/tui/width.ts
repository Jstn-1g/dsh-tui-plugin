/**
 * Terminal cell-width utilities. East Asian wide and fullwidth characters
 * occupy two terminal cells and combining/format characters none, so every
 * wrap, truncate, and pad in the TUI measures cells, not code points. The
 * range tables cover the CJK/Hangul/fullwidth surfaces real conversations
 * produce; everything else is one cell.
 */

/** Code point ranges whose characters occupy two terminal cells. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals and symbols/punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK compatibility
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi syllables
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x20000, 0x2fffd], // CJK Extension B and later (supplementary)
  [0x30000, 0x3fffd],
]

/** Code point ranges that occupy zero cells (combining/format characters). */
const ZERO_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x200b, 0x200f], // zero-width space, joiner, and directional marks
  [0xfe00, 0xfe0f], // variation selectors
  [0xe0100, 0xe01ef], // variation selectors supplement
]

/** Whether `code` falls inside any inclusive range of a table. */
function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [start, end] of ranges) {
    if (code >= start && code <= end) return true
  }
  return false
}

/**
 * The terminal cell width of one code point.
 * @param code - the code point.
 * @returns 0, 1, or 2 cells.
 */
export function codeWidth(code: number): number {
  if (inRanges(code, ZERO_RANGES)) return 0
  if (inRanges(code, WIDE_RANGES)) return 2
  return 1
}

/**
 * The terminal cell width of one character (its leading code point).
 * @param char - a single character; an empty string measures zero cells.
 * @returns 0, 1, or 2 cells.
 */
export function charWidth(char: string): number {
  const code = char.codePointAt(0)
  return code === undefined ? 0 : codeWidth(code)
}

/**
 * The total terminal cell width of a string.
 * @param text - the text to measure.
 * @returns the width in cells.
 */
export function stringWidth(text: string): number {
  let width = 0
  for (const char of Array.from(text)) width += charWidth(char)
  return width
}

/**
 * The number of leading characters of `chars` that fit `width` cells.
 * @param chars - the characters to fit.
 * @param width - the cell budget.
 * @returns the count of characters that fit (possibly 0).
 */
export function fitCount(chars: readonly string[], width: number): number {
  let used = 0
  let count = 0
  for (const char of chars) {
    const cell = charWidth(char)
    if (used + cell > width) break
    used += cell
    count += 1
  }
  return count
}

/**
 * Truncate text to a cell width, ending with an ellipsis when it overflows.
 * @param text - the text to truncate.
 * @param width - the cell budget.
 * @returns the possibly-truncated text.
 */
export function truncateWidth(text: string, width: number): string {
  const chars = Array.from(text)
  if (stringWidth(text) <= width) return text
  if (width <= 0) return ''
  const keep = fitCount(chars, width - 1)
  return `${chars.slice(0, keep).join('')}…`
}

/**
 * Pad text with trailing spaces to exactly `width` cells (never truncates).
 * @param text - the text to pad.
 * @param width - the target cell width.
 * @returns the padded text.
 */
export function padWidth(text: string, width: number): string {
  return `${text}${' '.repeat(Math.max(0, width - stringWidth(text)))}`
}
