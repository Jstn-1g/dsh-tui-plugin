/**
 * Terminal cell-width utilities: wide/zero-width classification, cell-width
 * measurement, fitting, truncation, and padding.
 */

import { describe, expect, it } from 'vitest'
import { codeWidth, charWidth, stringWidth, fitCount, truncateWidth, padWidth } from '../src/tui/width.ts'

describe('codeWidth / charWidth', () => {
  it('classifies ASCII as one cell', () => {
    expect(charWidth('a')).toBe(1)
    expect(codeWidth(0x41)).toBe(1)
  })

  it('classifies CJK and fullwidth characters as two cells', () => {
    expect(charWidth('中')).toBe(2) // 0x4e2d
    expect(charWidth('。')).toBe(2) // 0x3002 (CJK punctuation)
    expect(charWidth('Ａ')).toBe(2) // 0xff21 fullwidth
    expect(charWidth('한')).toBe(2) // 0xd55c Hangul
    expect(codeWidth(0x4e00)).toBe(2)
    expect(codeWidth(0x9fff)).toBe(2)
    expect(codeWidth(0x1f600)).toBe(1) // emoji outside the wide tables
  })

  it('classifies combining and zero-width characters as zero cells', () => {
    expect(charWidth('\u0301')).toBe(0) // combining acute
    expect(charWidth('\u200d')).toBe(0) // zero-width joiner
    expect(codeWidth(0xfe0f)).toBe(0) // variation selector
    expect(charWidth('')).toBe(0) // empty string has no leading code point
  })

  it('measures a string by summed cell widths', () => {
    expect(stringWidth('abc')).toBe(3)
    expect(stringWidth('中文abc')).toBe(7)
    expect(stringWidth('')).toBe(0)
  })
})

describe('fitCount', () => {
  it('counts leading characters that fit a cell budget', () => {
    expect(fitCount(['a', 'b', 'c'], 2)).toBe(2)
    expect(fitCount(['中', 'a'], 2)).toBe(1) // 中 fills the whole budget
    expect(fitCount(['a', '中'], 2)).toBe(1) // 中 would exceed the budget
    expect(fitCount(['a'], 0)).toBe(0)
  })
})

describe('truncateWidth', () => {
  it('keeps text that fits', () => {
    expect(truncateWidth('abc', 5)).toBe('abc')
    expect(truncateWidth('中文', 4)).toBe('中文')
  })

  it('cuts wide-aware with an ellipsis', () => {
    expect(truncateWidth('abcdef', 4)).toBe('abc…')
    expect(truncateWidth('中文字', 5)).toBe('中文…') // 2+2+1 cells
    expect(truncateWidth('abcdef', 0)).toBe('')
  })
})

describe('padWidth', () => {
  it('pads to a cell width without truncating', () => {
    expect(padWidth('ab', 5)).toBe('ab   ')
    expect(padWidth('中文', 6)).toBe('中文  ')
    expect(padWidth('longer', 3)).toBe('longer')
  })
})
