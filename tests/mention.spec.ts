/**
 * Mention grammar: token parsing, the word under the caret, label quoting,
 * and the injected-context framing.
 */

import { describe, expect, it } from 'vitest'
import {
  fileReferenceBlock,
  mentionLabel,
  mentionWordAt,
  parseMentionTokens,
  referenceContextBlock,
} from '../src/tui/mention.ts'

describe('parseMentionTokens', () => {
  it('parses unquoted tokens anywhere in the line', () => {
    expect(parseMentionTokens('fix @src/app.ts and @README')).toEqual([
      { raw: '@src/app.ts', value: 'src/app.ts' },
      { raw: '@README', value: 'README' },
    ])
  })

  it('strips matching double and single quotes', () => {
    expect(parseMentionTokens('see @"my notes.md" and @\'a b\'')).toEqual([
      { raw: '@"my notes.md"', value: 'my notes.md' },
      { raw: "@'a b'", value: 'a b' },
    ])
  })

  it('ignores an unclosed quoted token', () => {
    expect(parseMentionTokens('@"unclosed')).toEqual([])
  })

  it('returns nothing for a line without mentions', () => {
    expect(parseMentionTokens('plain text and /commands')).toEqual([])
  })
})

describe('mentionWordAt', () => {
  it('returns the @-word bounds and filter at the caret', () => {
    expect(mentionWordAt('fix @pack', 8)).toEqual({ start: 4, end: 9, filter: 'pack' })
  })

  it('opens with an empty filter on a bare @', () => {
    expect(mentionWordAt('@', 1)).toEqual({ start: 0, end: 1, filter: '' })
  })

  it('tracks a caret in the middle of the word', () => {
    expect(mentionWordAt('@pa|ck'.replace('|', ''), 3)).toEqual({ start: 0, end: 5, filter: 'pack' })
  })

  it('returns undefined outside any @-word', () => {
    expect(mentionWordAt('hello', 3)).toBeUndefined()
    expect(mentionWordAt('see @x there', 10)).toBeUndefined()
  })

  it('unquotes the filter of a quoted word', () => {
    expect(mentionWordAt('@"my notes"', 11)).toEqual({ start: 0, end: 11, filter: 'my notes' })
    expect(mentionWordAt('@"my notes"', 8)).toEqual({ start: 0, end: 11, filter: 'my notes' })
  })

  it('keeps an unclosed quoted section inside the word while typing', () => {
    expect(mentionWordAt('@"my notes', 10)).toEqual({ start: 0, end: 10, filter: 'my notes' })
  })

  it('strips an opening quote while the closing one is still being typed', () => {
    expect(mentionWordAt('@"my', 4)).toEqual({ start: 0, end: 4, filter: 'my' })
  })
})

describe('mentionLabel', () => {
  it('keeps simple values bare', () => {
    expect(mentionLabel('src/app.ts')).toBe('@src/app.ts')
  })

  it('quotes values containing whitespace', () => {
    expect(mentionLabel('my notes.md')).toBe('@"my notes.md"')
  })
})

describe('context framing', () => {
  it('frames one attached file with the harness context convention', () => {
    expect(fileReferenceBlock('src/app.ts', 'export const x = 1')).toBe(
      '<system-reminder>Attached file: src/app.ts\nexport const x = 1\n</system-reminder>',
    )
  })

  it('frames each resolved section as its own context unit', () => {
    expect(referenceContextBlock(['first', 'second'])).toBe(
      '<system-reminder>first</system-reminder>\n<system-reminder>second</system-reminder>',
    )
  })
})
