/**
 * Terminal screen: raw-mode lifecycle, alternate buffer, and full-frame ANSI
 * painting. The screen owns no application state — the app builds a {@link Frame}
 * and calls {@link TuiScreen.render}; the screen pads every row to the current
 * terminal width, applies per-cell styles, and restores the terminal on stop.
 */

/** Foreground styles the TUI uses; empty means default. */
export type CellStyle =
  | ''
  | 'dim'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'gray'
  | 'bright'
  | 'reverse'

/** One styled cell. */
export interface Cell {
  char: string
  style?: CellStyle
}

/** One row of the frame; a bare string renders unstyled. */
export type FrameRow = string | Cell[]

/** A complete frame: one row per terminal line, top to bottom. */
export interface Frame {
  rows: FrameRow[]
}

/** The process I/O the screen drives; injectable so tests capture output. */
export interface TuiIo {
  stdout: {
    write(chunk: string): unknown
    columns?: number
    rows?: number
    on(event: 'resize', listener: () => void): unknown
    off?(event: 'resize', listener: () => void): unknown
  }
  stdin: {
    setRawMode?(mode: boolean): unknown
    on(event: 'data', listener: (chunk: string | Buffer) => void): unknown
    off?(event: 'data', listener: (chunk: string | Buffer) => void): unknown
    pause(): unknown
    resume(): unknown
  }
}

/** ANSI escape for one style; empty style renders nothing. */
const STYLE_ESCAPES: Record<Exclude<CellStyle, ''>, string> = {
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bright: '\x1b[1m',
  reverse: '\x1b[7m',
}

import { fitCount, stringWidth } from './width.ts'

/** Render one row to ANSI text at the given cell width, padding short rows. */
function renderRow(row: FrameRow, width: number): string {
  const cells: Cell[] = typeof row === 'string'
    ? Array.from(row).map(char => ({ char }))
    : row
  const visible = cells.slice(0, fitCount(cells.map(cell => cell.char), width))
  const text = visible.map(cell => cell.char).join('')
  const styled = text !== '' ? styleCells(visible) : ''
  const pad = width - stringWidth(text)
  return `${styled}\x1b[0m${' '.repeat(Math.max(0, pad))}`
}

/** Apply per-cell styles to a cell list, merging runs. */
function styleCells(cells: readonly Cell[]): string {
  let out = ''
  let current: CellStyle = ''
  for (const cell of cells) {
    const style = cell.style ?? ''
    if (style !== current) {
      out += '\x1b[0m'
      if (style !== '') out += STYLE_ESCAPES[style]
      current = style
    }
    out += cell.char
  }
  if (current !== '') out += '\x1b[0m'
  return out
}

/**
 * Terminal screen owner. Call {@link start} once to enter raw mode and the
 * alternate buffer, {@link render} to repaint, and {@link stop} to restore the
 * terminal. Resize is handled by the app (it re-reads {@link size}).
 */
export class TuiScreen {
  private started = false

  /**
   * @param io - the process streams; production passes `process`-shaped IO.
   */
  constructor(private readonly io: TuiIo) {}

  /**
   * The current terminal size, falling back to 80×24 when unknown.
   * @returns the columns and rows of the terminal.
   */
  size(): { columns: number; rows: number } {
    return {
      columns: this.io.stdout.columns ?? 80,
      rows: this.io.stdout.rows ?? 24,
    }
  }

  /** Enter raw mode and the alternate screen buffer; idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.io.stdin.setRawMode?.(true)
    this.io.stdin.resume()
    // Alternate buffer, a hidden cursor, and SGR button-event mouse
    // reporting: wheel events and press/drag/release coordinates reach the
    // decoder, and the app paints and copies its own selection (Claude
    // Code-style) instead of relying on the terminal's native selection.
    this.io.stdout.write('\x1b[?1049h\x1b[2J\x1b[?25l\x1b[?1006h\x1b[?1002h')
  }

  /**
   * Paint one frame: home the cursor, write every row padded to the terminal
   * width, and clear any remaining tail lines.
   * @param frame - the rows to paint, top to bottom.
   */
  render(frame: Frame): void {
    const { columns, rows } = this.size()
    const lines = frame.rows.slice(0, rows)
    let out = '\x1b[H'
    for (let index = 0; index < rows; index += 1) {
      const row = lines[index]
      out += index === 0 ? '' : '\r\n'
      out += row === undefined ? ' '.repeat(columns) : renderRow(row, columns)
    }
    this.io.stdout.write(out)
  }

  /** Restore the terminal: show the cursor, leave the alternate buffer, exit raw mode. */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.io.stdout.write('\x1b[?25h\x1b[?1049l\x1b[?1006l\x1b[?1002l')
    this.io.stdin.setRawMode?.(false)
    this.io.stdin.pause()
  }
}
