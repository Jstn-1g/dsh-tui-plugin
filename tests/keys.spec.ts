/**
 * Raw key decoding: printable chars, control keys, and the ANSI escape
 * sequences the TUI binds, including partial-sequence buffering.
 */

import { describe, expect, it } from 'vitest'
import { TuiKeyDecoder } from '../src/tui/keys.ts'

describe('TuiKeyDecoder', () => {
  it('decodes printable characters and space', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('hi')).toEqual([{ kind: 'char', char: 'h' }, { kind: 'char', char: 'i' }])
    expect(decoder.push(' ')).toEqual([{ kind: 'char', char: ' ' }])
  })

  it('decodes enter, backspace, and tab', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\r')).toEqual([{ kind: 'enter' }])
    expect(decoder.push('\n')).toEqual([{ kind: 'enter' }])
    expect(decoder.push('\x7f')).toEqual([{ kind: 'backspace' }])
    expect(decoder.push('\x08')).toEqual([{ kind: 'backspace' }])
    expect(decoder.push('\t')).toEqual([{ kind: 'tab' }])
  })

  it('decodes control characters to named keys', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x03')).toEqual([{ kind: 'ctrl', name: 'c' }])
    expect(decoder.push('\x11')).toEqual([{ kind: 'ctrl', name: 'q' }])
    expect(decoder.push('\x10')).toEqual([{ kind: 'ctrl', name: 'p' }])
    expect(decoder.push('\x0e')).toEqual([{ kind: 'ctrl', name: 'n' }])
    expect(decoder.push('\x14')).toEqual([{ kind: 'ctrl', name: 't' }])
    expect(decoder.push('\x05')).toEqual([{ kind: 'ctrl', name: 'e' }])
    expect(decoder.push('\x01')).toEqual([{ kind: 'ctrl', name: 'a' }])
    expect(decoder.push('\x0b')).toEqual([{ kind: 'ctrl', name: 'k' }])
    expect(decoder.push('\x0d')).toEqual([{ kind: 'enter' }])
  })

  it('decodes arrow and navigation escape sequences', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1b[A')).toEqual([{ kind: 'up' }])
    expect(decoder.push('\x1b[B')).toEqual([{ kind: 'down' }])
    expect(decoder.push('\x1b[C')).toEqual([{ kind: 'right' }])
    expect(decoder.push('\x1b[D')).toEqual([{ kind: 'left' }])
    expect(decoder.push('\x1b[H')).toEqual([{ kind: 'home' }])
    expect(decoder.push('\x1b[F')).toEqual([{ kind: 'end' }])
  })

  it('decodes tilde-coded keys (delete, pageup, pagedown)', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1b[3~')).toEqual([{ kind: 'delete' }])
    expect(decoder.push('\x1b[5~')).toEqual([{ kind: 'pageup' }])
    expect(decoder.push('\x1b[6~')).toEqual([{ kind: 'pagedown' }])
  })

  it('decodes Ctrl-modified arrows', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1b[1;5A')).toEqual([{ kind: 'ctrl', name: 'up' }])
    expect(decoder.push('\x1b[1;5B')).toEqual([{ kind: 'ctrl', name: 'down' }])
    // Unbound Ctrl-modified directions fall through to the plain key.
    expect(decoder.push('\x1b[1;5C')).toEqual([{ kind: 'right' }])
  })

  it('decodes SGR mouse wheel, press, drag, and release events', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1b[<64;1;1M')).toEqual([{ kind: 'wheelup' }])
    expect(decoder.push('\x1b[<65;1;1M')).toEqual([{ kind: 'wheeldown' }])
    expect(decoder.push('\x1b[<0;3;5M')).toEqual([{ kind: 'mouse', action: 'press', x: 3, y: 5 }])
    expect(decoder.push('\x1b[<32;8;5M')).toEqual([{ kind: 'mouse', action: 'drag', x: 8, y: 5 }])
    // SGR terminals report the release with the original button and `m`.
    expect(decoder.push('\x1b[<0;8;5m')).toEqual([{ kind: 'mouse', action: 'release', x: 8, y: 5 }])
    expect(decoder.push('\x1b[<3;8;5m')).toEqual([{ kind: 'mouse', action: 'release', x: 8, y: 5 }])
    expect(decoder.push('\x1b[<2;1;1M')).toEqual([]) // right click drops
  })

  it('decodes function keys through the O prefix', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1bOP')).toEqual([{ kind: 'f', number: 1 }])
    expect(decoder.push('\x1bOQ')).toEqual([{ kind: 'f', number: 2 }])
    expect(decoder.push('\x1bOR')).toEqual([{ kind: 'f', number: 3 }])
    expect(decoder.push('\x1bOS')).toEqual([{ kind: 'f', number: 4 }])
  })

  it('buffers partial escape sequences until the final byte arrives', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1b')).toEqual([])
    expect(decoder.hasPending()).toBe(true)
    expect(decoder.push('[')).toEqual([])
    expect(decoder.hasPending()).toBe(true)
    expect(decoder.push('A')).toEqual([{ kind: 'up' }])
    expect(decoder.hasPending()).toBe(false)
  })

  it('buffers a partial CSI numeric sequence', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1b[')).toEqual([])
    expect(decoder.push('3')).toEqual([])
    expect(decoder.push('~')).toEqual([{ kind: 'delete' }])
  })

  it('treats an unknown escape as an escape key and continues with the rest', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1bZ')).toEqual([{ kind: 'escape' }, { kind: 'char', char: 'Z' }])
  })

  it('treats a lone ESC followed by text as escape then chars', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1bx')).toEqual([{ kind: 'escape' }, { kind: 'char', char: 'x' }])
  })

  it('decodes alt-left and alt-right', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1bb')).toEqual([{ kind: 'ctrl', name: 'alt-left' }])
    expect(decoder.push('\x1bf')).toEqual([{ kind: 'ctrl', name: 'alt-right' }])
  })

  it('decodes an unmapped control character as a char', () => {
    const decoder = new TuiKeyDecoder()
    // \x00 (NUL) has no ctrlName entry, so it echoes as a plain char.
    expect(decoder.push('\x00')).toEqual([{ kind: 'char', char: '\x00' }])
  })

  it('treats an unknown numeric CSI sequence as escape plus the rest', () => {
    const decoder = new TuiKeyDecoder()
    // \x1b[1~ is not a bound tilde key; the ESC is emitted and the remaining
    // bytes re-decode as plain chars.
    expect(decoder.push('\x1b[1~')).toEqual([
      { kind: 'escape' },
      { kind: 'char', char: '[' },
      { kind: 'char', char: '1' },
      { kind: 'char', char: '~' },
    ])
  })

  it('buffers an incomplete O-prefixed sequence', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1bO')).toEqual([])
    expect(decoder.hasPending()).toBe(true)
    expect(decoder.push('P')).toEqual([{ kind: 'f', number: 1 }])
  })

  it('treats an unknown O-prefixed sequence as escape plus the rest', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1bOx')).toEqual([
      { kind: 'escape' },
      { kind: 'char', char: 'O' },
      { kind: 'char', char: 'x' },
    ])
  })

  it('decodes the shifted-tab sequence as tab', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('\x1b[Z')).toEqual([{ kind: 'tab' }])
  })

  it('flushEscape leaves mid-sequence prefixes pending', () => {
    const decoder = new TuiKeyDecoder()
    decoder.push('\x1b')
    decoder.push('[')
    expect(decoder.flushEscape()).toEqual([])
    expect(decoder.hasPending()).toBe(true)
  })

  it('decodes multiple keys from one chunk', () => {
    const decoder = new TuiKeyDecoder()
    expect(decoder.push('ab\r\x1b[B')).toEqual([
      { kind: 'char', char: 'a' },
      { kind: 'char', char: 'b' },
      { kind: 'enter' },
      { kind: 'down' },
    ])
  })
})
