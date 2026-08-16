/**
 * Terminal screen: raw-mode lifecycle, alternate buffer, padded full-frame
 * painting, and terminal restore.
 */

import { describe, expect, it } from 'vitest'
import { TuiScreen, type TuiIo } from '../src/tui/screen.ts'

/** A fake TuiIo capturing every stdout write into a mutable holder. */
function fakeIo(columns = 20, rows = 5): { io: TuiIo; out: string; events: string[] } {
  const holder: { out: string } = { out: '' }
  const events: string[] = []
  return {
    get out(): string { return holder.out },
    set out(value: string) { holder.out = value },
    events,
    io: {
      stdout: {
        write: (chunk: string) => { holder.out += chunk; return true },
        columns,
        rows,
        on: (event: string, listener: () => void) => { events.push(event); return listener },
      },
      stdin: {
        setRawMode: (mode: boolean) => { events.push(`raw:${mode}`) },
        on: () => {},
        pause: () => { events.push('pause') },
        resume: () => { events.push('resume') },
      },
    },
  }
}

describe('TuiScreen', () => {
  it('reports the terminal size, falling back to 80x24', () => {
    const { io } = fakeIo(100, 30)
    expect(new TuiScreen(io).size()).toEqual({ columns: 100, rows: 30 })
    const minimal = fakeIo()
    delete minimal.io.stdout.columns
    delete minimal.io.stdout.rows
    expect(new TuiScreen(minimal.io).size()).toEqual({ columns: 80, rows: 24 })
  })

  it('enters raw mode and the alternate screen on start', () => {
    const fake = fakeIo()
    const screen = new TuiScreen(fake.io)
    screen.start()
    expect(fake.out).toContain('\x1b[?1049h')
    expect(fake.out).toContain('\x1b[?25l')
    // SGR button-event reporting feeds wheel and selection coordinates.
    expect(fake.out).toContain('\x1b[?1006h')
    expect(fake.out).toContain('\x1b[?1002h')
    expect(fake.events).toContain('raw:true')
    expect(fake.events).toContain('resume')
  })

  it('is idempotent across repeated starts', () => {
    const fake = fakeIo()
    const screen = new TuiScreen(fake.io)
    screen.start()
    const once = fake.out
    screen.start()
    expect(fake.out).toBe(once)
  })

  it('paints a padded frame home-anchored', () => {
    const fake = fakeIo(10, 3)
    const screen = new TuiScreen(fake.io)
    screen.render({ rows: ['ab', 'cd'] })
    // \x1b[H then line 1, \r\n, line 2, \r\n, then the blank row padded.
    expect(fake.out).toContain('\x1b[H')
    expect(fake.out).toContain('ab')
    expect(fake.out).toContain('cd')
    // every row is padded to the terminal width
    const lines = fake.out.replace(/\x1b\[H/, '').split('\r\n')
    expect(lines).toHaveLength(3)
  })

  it('applies per-cell styles and resets them', () => {
    const fake = fakeIo(10, 1)
    const screen = new TuiScreen(fake.io)
    screen.render({ rows: [[{ char: 'x', style: 'bright' }, { char: 'y' }]] })
    expect(fake.out).toContain('\x1b[1m')
    expect(fake.out).toContain('\x1b[0m')
  })

  it('renders an empty row padded without styling', () => {
    const fake = fakeIo(10, 2)
    const screen = new TuiScreen(fake.io)
    screen.render({ rows: ['', 'x'] })
    const lines = fake.out.replace(/\x1b\[H/, '').split('\r\n')
    expect(lines).toHaveLength(2)
    // the blank row still pads to the terminal width, with no color style
    expect(lines[0]!.endsWith(' '.repeat(10))).toBe(true)
    expect(lines[0]).not.toMatch(/\x1b\[3[0-9]m/)
  })

  it('clips wide rows by cells, not code points', () => {
    const fake = fakeIo(6, 1)
    const screen = new TuiScreen(fake.io)
    screen.render({ rows: ['中中中中'] }) // 8 cells, terminal holds 6
    const plain = fake.out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace('\x1b[H', '')
    expect(plain).toContain('中中中') // exactly 6 cells fit, no padding needed
    expect(plain).not.toContain('中中中中')
  })

  it('restores the terminal on stop and tolerates double stop', () => {
    const fake = fakeIo()
    const screen = new TuiScreen(fake.io)
    screen.start()
    screen.stop()
    expect(fake.out).toContain('\x1b[?25h')
    expect(fake.out).toContain('\x1b[?1049l')
    expect(fake.out).toContain('\x1b[?1006l')
    expect(fake.out).toContain('\x1b[?1002l')
    expect(fake.events).toContain('raw:false')
    expect(fake.events).toContain('pause')
    const after = fake.out
    screen.stop()
    expect(fake.out).toBe(after)
  })
})
