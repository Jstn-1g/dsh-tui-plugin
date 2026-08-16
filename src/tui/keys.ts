/**
 * Raw terminal key decoder: consumes bytes from a raw-mode stdin stream and
 * emits key events. Escape sequences follow the common xterm/ANSI vocabulary;
 * anything unrecognized becomes a `char` key so the composer can still echo it.
 */

/** One decoded key press. */
export type TuiKey =
  | { kind: 'char'; char: string }
  | { kind: 'enter' }
  | { kind: 'backspace' }
  | { kind: 'tab' }
  | { kind: 'escape' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'home' }
  | { kind: 'end' }
  | { kind: 'pageup' }
  | { kind: 'pagedown' }
  | { kind: 'delete' }
  | { kind: 'wheelup' }
  | { kind: 'wheeldown' }
  | { kind: 'mouse'; action: 'press' | 'drag' | 'release'; x: number; y: number }
  | { kind: 'ctrl'; name: string }
  | { kind: 'f'; number: number }

/** Result of decoding one byte position: keys emitted plus bytes consumed. */
interface DecodeResult {
  keys: TuiKey[]
  consumed: number
  /** True when the leading ESC begins a sequence that needs more bytes. */
  incomplete: boolean
}

/** Map a control character to the key name we handle (the ones the app binds). */
function ctrlName(char: string): string | undefined {
  const code = char.charCodeAt(0)
  const names: Record<number, string> = {
    1: 'a',
    3: 'c',
    4: 'd',
    5: 'e',
    11: 'k',
    12: 'l',
    14: 'n',
    15: 'o',
    16: 'p',
    17: 'q',
    18: 'r',
    20: 't',
    21: 'u',
    24: 'x',
  }
  return names[code]
}

/**
 * Decode the byte sequence starting at `bytes[0]`. Returns the emitted keys
 * and how many bytes they consumed; a lone ESC that could start a longer
 * sequence reports `incomplete` so the caller can buffer and retry.
 * @param bytes - the remaining raw bytes of the current chunk.
 * @returns keys, consumed count, and the incomplete flag.
 */
function decode(bytes: readonly string[]): DecodeResult {
  const first = bytes[0]
  /* v8 ignore next 2 -- push() decodes only non-empty windows, so decode never sees an empty byte list */
  if (first === undefined) return { keys: [], consumed: 0, incomplete: false }
  if (first !== '\x1b') {
    const code = first.charCodeAt(0)
    if (code === 13 || code === 10) return { keys: [{ kind: 'enter' }], consumed: 1, incomplete: false }
    if (code === 127 || code === 8) return { keys: [{ kind: 'backspace' }], consumed: 1, incomplete: false }
    if (code === 9) return { keys: [{ kind: 'tab' }], consumed: 1, incomplete: false }
    if (code < 32) {
      const name = ctrlName(first)
      if (name !== undefined) return { keys: [{ kind: 'ctrl', name }], consumed: 1, incomplete: false }
      return { keys: [{ kind: 'char', char: first }], consumed: 1, incomplete: false }
    }
    return { keys: [{ kind: 'char', char: first }], consumed: 1, incomplete: false }
  }
  // ESC-prefixed: an incomplete sequence needs its second byte.
  const second = bytes[1]
  if (second === undefined) return { keys: [], consumed: 0, incomplete: true }
  if (second === '[') {
    const rest = bytes.slice(2)
    const finalIndex = rest.findIndex(byte => /^[A-Za-z~]$/.test(byte))
    if (finalIndex === -1) return { keys: [], consumed: 0, incomplete: true }
    const final = rest[finalIndex]
    /* v8 ignore next 2 -- findIndex matched a defined element, so rest[finalIndex] is present */
    if (final === undefined) return { keys: [], consumed: 0, incomplete: true }
    const numeric = rest.slice(0, finalIndex).join('')
    if (final === 'Z') return { keys: [{ kind: 'tab' }], consumed: finalIndex + 3, incomplete: false }
    // SGR mouse reports (`\x1b[<button;x;yM/m`): wheel buttons bind, left
    // press/drag/release drive the transcript selection; other buttons drop.
    if (final === 'M' || final === 'm') {
      const match = /^<(\d+);(\d+);(\d+)$/.exec(numeric)
      const button = match?.[1]
      /* v8 ignore start -- a valid SGR report always carries both coordinates */
      const x = Number(match?.[2] ?? '0')
      const y = Number(match?.[3] ?? '0')
      /* v8 ignore stop */
      // In SGR mode terminals report the release with the ORIGINAL button
      // (usually 0) and a lowercase `m`, not a synthetic button 3.
      if (final === 'm') {
        return { keys: [{ kind: 'mouse', action: 'release', x, y }], consumed: finalIndex + 3, incomplete: false }
      }
      const key: TuiKey | undefined = button === '64' ? { kind: 'wheelup' }
        : button === '65' ? { kind: 'wheeldown' }
          : button === '0' ? { kind: 'mouse', action: 'press', x, y }
            : button === '32' ? { kind: 'mouse', action: 'drag', x, y }
              : undefined
      return { keys: key === undefined ? [] : [key], consumed: finalIndex + 3, incomplete: false }
    }
    // Ctrl-modified arrows (xterm `1;5` modifier) scroll the transcript.
    const ctrlArrow = numeric === '1;5' ? final === 'A' ? { kind: 'ctrl', name: 'up' } as TuiKey
      : final === 'B' ? { kind: 'ctrl', name: 'down' } as TuiKey
        : undefined
      : undefined
    if (ctrlArrow !== undefined) return { keys: [ctrlArrow], consumed: finalIndex + 3, incomplete: false }
    const key: TuiKey | undefined = final === 'A' ? { kind: 'up' }
      : final === 'B' ? { kind: 'down' }
        : final === 'C' ? { kind: 'right' }
          : final === 'D' ? { kind: 'left' }
            : final === 'H' ? { kind: 'home' }
              : final === 'F' ? { kind: 'end' }
                : final === '~' && numeric === '3' ? { kind: 'delete' }
                  : final === '~' && numeric === '5' ? { kind: 'pageup' }
                    : final === '~' && numeric === '6' ? { kind: 'pagedown' }
                      : undefined
    if (key !== undefined) return { keys: [key], consumed: finalIndex + 3, incomplete: false }
    return { keys: [{ kind: 'escape' }, ...decode(bytes.slice(1)).keys], consumed: 1 + decode(bytes.slice(1)).consumed, incomplete: false }
  }
  if (second === 'O') {
    const third = bytes[2]
    if (third === undefined) return { keys: [], consumed: 0, incomplete: true }
    const key: TuiKey | undefined = third === 'P' ? { kind: 'f', number: 1 }
      : third === 'Q' ? { kind: 'f', number: 2 }
        : third === 'R' ? { kind: 'f', number: 3 }
          : third === 'S' ? { kind: 'f', number: 4 }
            : undefined
    if (key !== undefined) return { keys: [key], consumed: 3, incomplete: false }
    return { keys: [{ kind: 'escape' }], consumed: 1, incomplete: false }
  }
  if (second === 'b') return { keys: [{ kind: 'ctrl', name: 'alt-left' }], consumed: 2, incomplete: false }
  if (second === 'f') return { keys: [{ kind: 'ctrl', name: 'alt-right' }], consumed: 2, incomplete: false }
  return { keys: [{ kind: 'escape' }], consumed: 1, incomplete: false }
}

/**
 * Incremental byte→key decoder. Feed raw chunks with {@link push}; completed
 * keys are returned, partial escape sequences are buffered until their final
 * byte arrives.
 */
export class TuiKeyDecoder {
  private pending: string[] = []

  /**
   * Feed one chunk of raw input and collect the keys it completed.
   * @param chunk - raw bytes as a string.
   * @returns decoded keys in order; incomplete escape prefixes are held.
   */
  push(chunk: string): TuiKey[] {
    const keys: TuiKey[] = []
    const bytes = [...this.pending, ...Array.from(chunk)]
    this.pending = []
    let index = 0
    while (index < bytes.length) {
      const result = decode(bytes.slice(index))
      if (result.incomplete) {
        this.pending = bytes.slice(index)
        break
      }
      keys.push(...result.keys)
      index += result.consumed
    }
    return keys
  }

  /**
   * Whether a partial escape sequence is currently buffered.
   * @returns true when an incomplete prefix awaits its final byte.
   */
  hasPending(): boolean {
    return this.pending.length > 0
  }

  /**
   * Force-resolve a lone buffered ESC into an Escape key. A bare Esc press
   * sends only `\x1b`, so the app arms a short timer after every chunk that
   * leaves a pending sequence and flushes here; multi-byte prefixes (`\x1b[`,
   * `\x1bO`) stay pending for their final byte.
   * @returns the keys to dispatch (exactly Escape for a lone ESC).
   */
  flushEscape(): TuiKey[] {
    if (this.pending.length === 1 && this.pending[0] === '\x1b') {
      this.pending = []
      return [{ kind: 'escape' }]
    }
    return []
  }
}
