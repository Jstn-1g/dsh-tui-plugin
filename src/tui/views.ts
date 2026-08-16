/**
 * Pure view renderers: every function turns an app-state snapshot into frame
 * rows (or a wrapped cell grid) without touching services or I/O, so the
 * layout is unit-testable and the app stays a thin dispatcher.
 */

import type { FrameRow, Cell } from './screen.ts'
import { blockVersion } from './fold.ts'
import type { TranscriptBlock, TranscriptRowCache } from './fold.ts'
import type { CellStyle } from './screen.ts'
import type { SessionSummary } from './summary.ts'
import type { JobId, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { charWidth, fitCount, padWidth, stringWidth, truncateWidth } from './width.ts'
import { t } from './i18n.ts'

/**
 * Wrap text to a cell width, splitting on words; a single word longer than the
 * width is hard-split (wide characters count as two cells).
 * @param text - the text to wrap.
 * @param width - the maximum line width in cells.
 * @returns the wrapped lines.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return []
  const words = text.split(/\s+/).filter(word => word !== '')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (stringWidth(candidate) <= width) {
      line = candidate
      continue
    }
    if (line !== '') lines.push(line)
    line = word
    while (stringWidth(line) > width) {
      const chars = Array.from(line)
      const keep = fitCount(chars, width)
      if (keep === 0) {
        // A single wide character wider than the budget still renders (the
        // screen clips it); otherwise this loop would never terminate.
        /* v8 ignore next -- keep===0 implies chars is non-empty */
        lines.push(chars[0] ?? '')
        line = chars.slice(1).join('')
        continue
      }
      lines.push(chars.slice(0, keep).join(''))
      line = chars.slice(keep).join('')
    }
  }
  if (line !== '') lines.push(line)
  return lines.length === 0 ? [''] : lines
}

/** Build one styled row from a string and an optional style. */
function row(text: string, style?: CellStyle): FrameRow {
  return style === undefined
    ? text
    : Array.from(text).map(char => ({ char, style }))
}

/** Prefix a styled marker before plain text cells. */
function prefixCells(marker: string, markerStyle: CellStyle, text: string, textStyle: CellStyle): Cell[] {
  return [
    ...Array.from(marker).map(char => ({ char, style: markerStyle })),
    ...Array.from(text).map(char => ({ char, style: textStyle })),
  ]
}

/**
 * Truncate a label to a cell width, ending with an ellipsis when it overflows.
 * @param text - the label to truncate.
 * @param width - the maximum width in cells.
 * @returns the possibly-truncated label.
 */
export function truncate(text: string, width: number): string {
  return truncateWidth(text, width)
}

/**
 * One dim hint row for an empty pane.
 * @param text - the hint text.
 * @param width - the available width in cells.
 * @returns the rendered row.
 */
export function hintRow(text: string, width: number): FrameRow {
  return row(padWidth(truncateWidth(text, Math.max(0, width)), Math.max(0, width)), 'gray')
}

/**
 * The welcome pane for an empty start. Lines resolve per call so a runtime
 * language switch re-renders them (no module-load copy caching).
 * @param width - the available width in cells.
 * @returns the centered, dimmed rows.
 */
export function welcomeRows(width: number): FrameRow[] {
  const lines: readonly string[] = [
    t('welcome.title'),
    '',
    t('welcome.start'),
    t('welcome.keys'),
    t('welcome.keys2'),
  ]
  return lines.map((line) => {
    const pad = Math.max(0, Math.floor((width - stringWidth(line)) / 2))
    return row(`${' '.repeat(pad)}${line}`, 'gray')
  })
}

/**
 * Render a transcript block to rows within a width.
 * @param block - the transcript block to render.
 * @param width - the available width per row.
 * @param expanded - whether a tool card shows its full arguments and result.
 * @returns the rendered rows.
 */
export function renderBlock(block: TranscriptBlock, width: number, expanded = false): FrameRow[] {
  switch (block.kind) {
    case 'user':
      return wrapText(block.text, width).map(text => prefixCells('❯ ', 'cyan', text, 'bright'))
    case 'assistant': {
      const rows = renderMarkdown(block.text, width)
      if (block.streaming && rows.length > 0) {
        // The streaming cursor rides the last row only.
        const last = rows[rows.length - 1]
        /* v8 ignore next -- rows.length > 0 guards the read */
        if (last !== undefined) {
          const cells: Cell[] = typeof last === 'string' ? Array.from(last).map(char => ({ char })) : last
          cells.push({ char: '▍', style: 'cyan' })
          rows[rows.length - 1] = cells
        }
      }
      return rows
    }
    case 'tool': {
      const glyph = expanded ? '▾' : block.status === 'running' ? '●' : block.error !== undefined ? '✗' : '✓'
      const status: CellStyle = block.status === 'running' ? 'cyan' : block.error !== undefined ? 'red' : 'green'
      // The card recedes: only the status glyph carries color, the rest is
      // gray, so the user's words and the assistant text stay the focus.
      const rawArgs = block.args.replace(/\s+/g, ' ').trim()
      const summary = toolArgsSummary(rawArgs) ?? rawArgs
      const head = summary === ''
        ? block.name
        : truncateWidth(`${block.name}(${summary})`, Math.max(1, width - 3))
      const lines: FrameRow[] = [prefixCells(`${glyph} `, status, head, 'gray')]
      if (expanded) {
        // Full arguments, then the result or error, wrapped beneath the head.
        if (block.args !== '') lines.push(...wrapText(block.args, width).map(text => row(`  ${text}`, 'gray')))
        if (block.result !== undefined && block.result !== '') {
          lines.push(...wrapText(`← ${block.result}`, width).map(text => row(text, 'gray')))
        }
        if (block.error !== undefined) {
          lines.push(row(`✗ ${block.error.code}: ${block.error.name}`, 'red'))
        }
      }
      return lines
    }
    case 'system':
      // System rows (commands, plan state, turn errors): dim with a uniform
      // `⌁` marker so they never read as assistant text.
      return wrapText(block.text, width).map(text => prefixCells('⌁ ', 'gray', text, 'gray'))
    case 'context': {
      // Injected material (workspace rules, attached files, skill bodies):
      // one dimmed, indented chip per injected unit — a marker, a preview
      // line, and a line count. renderConversation inserts a blank row
      // before the user turn, so injections never touch the user's words.
      return splitContextUnits(block.text).flatMap((unit) => {
        const lines = unit.split('\n').filter(line => line.trim() !== '').length
        const skillName = /<skill_content name="([^"]+)"/.exec(unit)?.[1]
        const from = /Instructions from:\s*([^\s<]+)/.exec(unit)?.[1]
        const isCatalog = unit.includes('<available_skills>')
        const policy = /^Current DSH file policy:\s*([^.]+)\.?/.exec(unit)?.[1]
        const fileAttach = unit.startsWith('Attached file:')
        /* v8 ignore next -- splitContextUnits only emits non-empty units, so a first line always exists */
        const firstLine = unit.split('\n').find(line => line.trim() !== '') ?? ''
        // A meaningful preview, not the boilerplate first line every
        // injection shares.
        const preview = fileAttach
          ? firstLine
          : skillName !== undefined
            ? `@${skillName}`
            : from !== undefined
              ? `Instructions from: ${from}`
              : isCatalog
                ? 'skill catalog'
                : policy !== undefined
                  ? `DSH file policy: ${policy}`
                  : unit.startsWith('Current runtime context')
                    ? 'runtime context'
                    : firstLine
        const marker = fileAttach ? '📄' : skillName !== undefined ? '🔧' : isCatalog ? '🧰' : policy !== undefined ? '🛡' : '⚙'
        const text = t('transcript.contextUnit', { marker, lines: String(lines), preview })
        return [row(truncateWidth(text, Math.max(1, width)), 'gray')]
      })
    }
    case 'todo':
      // Todo lists are progress furniture: uniform gray keeps them out of
      // the user/assistant focus.
      return block.items.map(item => row(
        `${item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '☐'} ${item.content}`,
        'gray',
      ))
  }
}

/**
 * A readable one-line summary for a tool card: the command/path/query the
 * call actually ran, instead of the raw JSON arguments blob. Falls back to
 * `undefined` so the caller keeps the raw arguments.
 * @param args - the tool-call arguments.
 * @returns the extracted summary string, or `undefined` when none applies.
 */
function toolArgsSummary(args: string): string | undefined {
  if (args === '') return undefined
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    for (const key of ['command', 'cmd', 'path', 'query', 'pattern']) {
      const value = parsed[key]
      if (typeof value === 'string' && value !== '') return value
    }
  } catch (_unparseableArgs) {
    // Non-JSON arguments render verbatim.
  }
  return undefined
}

/** One parsed markdown table. */
interface MarkdownTable {
  header: string[]
  rows: string[][]
  /** One past the last table line in the source. */
  end: number
}

/** Whether a line looks like a markdown table row (`| a | b |`). */
function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|')
}

/** Split one table row into trimmed cells. */
function splitTableCells(line: string): string[] {
  const trimmed = line.trim()
  /* v8 ignore start -- isTableRow guarantees the leading and trailing pipes */
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const final = inner.endsWith('|') ? inner.slice(0, -1) : inner
  /* v8 ignore stop */
  return final.split('|').map(cell => cell.trim())
}

/**
 * Parse a markdown table starting at `start`: a `|` header row followed by
 * a `-`/`:` separator row, then `|` data rows.
 * @param lines - the source lines.
 * @param start - the first candidate row.
 * @returns the table, or `undefined` when the pair is not a table.
 */
function parseTable(lines: readonly string[], start: number): MarkdownTable | undefined {
  const headerLine = lines[start]
  const separator = lines[start + 1]
  if (headerLine === undefined || separator === undefined) return undefined
  /* v8 ignore next -- renderMarkdown only calls parseTable on table-looking rows */
  if (!isTableRow(headerLine)) return undefined
  if (!/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(separator)) return undefined
  const header = splitTableCells(headerLine)
  const rows: string[][] = []
  let end = start + 2
  /* v8 ignore start -- the loop bound keeps the indexed line defined */
  while (end < lines.length && isTableRow(lines[end] ?? '')) {
    rows.push(splitTableCells(lines[end] ?? '').slice(0, header.length))
    /* v8 ignore stop */
    end += 1
  }
  return { header, rows, end }
}

/**
 * Shrink column widths to fit `available` cells, largest column first and
 * never below three cells (an ellipsis still fits).
 * @param widths - the natural column widths.
 * @param available - the total cell budget.
 * @returns the fitted widths.
 */
function fitTableWidths(widths: readonly number[], available: number): number[] {
  const out = [...widths]
  let total = out.reduce((sum, w) => sum + w, 0)
  while (total > available) {
    const max = Math.max(...out)
    const index = out.indexOf(max)
    /* v8 ignore start -- all columns at three cells always fit the guaranteed budget */
    if ((out[index] ?? 0) <= 3) break
    out[index] = (out[index] ?? 0) - 1
    /* v8 ignore stop */
    total -= 1
  }
  return out
}

/**
 * Fit styled cells into a cell budget, truncating with a dim ellipsis.
 * @param cells - the styled cells.
 * @param budget - the cell width in characters.
 * @returns the fitted cells, padded to the budget.
 */
function fitStyledCells(cells: readonly Cell[], budget: number): Cell[] {
  const out: Cell[] = []
  let used = 0
  for (const cell of cells) {
    const charWidth = stringWidth(cell.char)
    if (used + charWidth > budget) {
      /* v8 ignore next -- cell budgets are always positive */
      if (budget > 0) out.push({ char: '…', style: 'gray' })
      break
    }
    out.push(cell)
    used += charWidth
  }
  while (used < budget) {
    out.push({ char: ' ' })
    used += 1
  }
  return out
}

/** Render one markdown table with aligned columns and dim borders. */
function renderTable(table: MarkdownTable, width: number): FrameRow[] {
  const columnCount = table.header.length
  /* v8 ignore next -- a parsed table always has at least one header cell */
  if (columnCount === 0) return []
  const all = [table.header, ...table.rows]
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(1, ...all.map(row => stringWidth(row[column] ?? ''))))
  const chrome = 3 * columnCount + 1
  const fitted = fitTableWidths(widths, Math.max(3 * columnCount, width - chrome))
  const rowCells = (cells: readonly string[], header: boolean): Cell[] => {
    const out: Cell[] = []
    cells.forEach((cell, index) => {
      /* v8 ignore next -- fitted keeps every header column */
      const colWidth = fitted[index] ?? 1
      out.push({ char: '│', style: 'gray' }, { char: ' ', style: 'gray' })
      const styled = renderInline(cell).map((cellChar): Cell => {
        const style = cellChar.style ?? ''
        return header
          ? { char: cellChar.char, style: style === '' ? 'bright' : style }
          : cellChar
      })
      out.push(...fitStyledCells(styled, colWidth))
    })
    out.push({ char: ' ', style: 'gray' }, { char: '│', style: 'gray' })
    return out
  }
  const rows: FrameRow[] = [rowCells(table.header, true)]
  const separator: Cell[] = []
  fitted.forEach((colWidth, index) => {
    separator.push(index === 0 ? { char: '│', style: 'gray' } : { char: '┼', style: 'gray' })
    separator.push(...Array.from({ length: colWidth + 2 }, (): Cell => ({ char: '─', style: 'gray' })))
  })
  separator.push({ char: '│', style: 'gray' })
  rows.push(separator)
  for (const row of table.rows) rows.push(rowCells(row, false))
  return rows
}

/**
 * Wrap text with a hanging indent: the first row carries `prefix`, wrapped
 * continuations align under the text start.
 * @param prefix - the leading marker (bullet, quote bar, number).
 * @param text - the item text.
 * @param width - the available pane width.
 * @returns the rendered rows.
 */
function hangCells(prefix: string, text: string, width: number): FrameRow[] {
  const indent = stringWidth(prefix)
  const lines = wrapText(text, Math.max(1, width - indent))
  return lines.map((line, index) => {
    const cells: Cell[] = index === 0
      ? Array.from(prefix).map(char => ({ char, style: 'gray' as CellStyle }))
      : Array.from(' '.repeat(indent)).map(char => ({ char }))
    cells.push(...renderInline(line))
    return cells
  })
}

/**
 * Render assistant markdown: tables aligned, lists with hanging indents,
 * headers/blockquotes/fences/hr styled, and inline `**bold**`, `` `code` ``,
 * `[text](url)`, and `~~strike~~` spans — the light formatting Claude Code
 * applies instead of dumping raw markdown.
 * @param text - the assistant text.
 * @param width - the available pane width.
 * @returns the rendered rows.
 */
function renderMarkdown(text: string, width: number): FrameRow[] {
  const rows: FrameRow[] = []
  const lines = text.split('\n')
  let inFence = false
  for (let index = 0; index < lines.length; index += 1) {
    /* v8 ignore next -- the loop bound keeps the line defined */
    const line = lines[index] ?? ''
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      rows.push(...wrapText(line, width).map(wrapped => row(`  ${wrapped}`, 'gray')))
      continue
    }
    const table = isTableRow(line) ? parseTable(lines, index) : undefined
    if (table !== undefined) {
      rows.push(...renderTable(table, width))
      index = table.end - 1
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      rows.push(row('─'.repeat(Math.max(1, width)), 'gray'))
      continue
    }
    const header = /^(#{1,6})\s+(.*)$/.exec(line)
    /* v8 ignore next -- the header group is required, so it always captures */
    if (header !== null && header[2] !== undefined) {
      rows.push(row(truncateWidth(header[2], Math.max(1, width)), 'bright'))
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null && quote[1] !== undefined) {
      rows.push(...hangCells('│ ', quote[1], width))
      continue
    }
    const checkbox = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (checkbox !== null && checkbox[3] !== undefined) {
      /* v8 ignore next -- the checkbox indent group is required, so it always captures */
      const level = Math.min(2, Math.floor((checkbox[1]?.length ?? 0) / 2))
      const checked = checkbox[2] === 'x' || checkbox[2] === 'X'
      rows.push(...hangCells(`${' '.repeat(level * 2)}${checked ? '☑ ' : '☐ '}`, checkbox[3], width))
      continue
    }
    const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (list !== null && list[3] !== undefined) {
      /* v8 ignore next -- the list indent group is required, so it always captures */
      const level = Math.min(2, Math.floor((list[1]?.length ?? 0) / 2))
      const marker = list[2]
      /* v8 ignore next -- the list group is required, so it always captures */
      const prefix = marker !== undefined && /^\d+\.$/.test(marker)
        ? `${marker} `
        : level > 0 ? '◦ ' : '• '
      rows.push(...hangCells(`${' '.repeat(level * 2)}${prefix}`, list[3], width))
      continue
    }
    rows.push(...wrapText(line, width).map(wrapped => renderInline(wrapped)))
  }
  return rows
}

/** Style inline spans inside one wrapped line: `**bold**`, `` `code` ``, `[text](url)`, `~~strike~~`. */
function renderInline(text: string): Cell[] {
  const cells: Cell[] = []
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|~~([^~]+)~~/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index
    if (index > last) cells.push(...Array.from(text.slice(last, index)).map(char => ({ char })))
    if (match[1] !== undefined) {
      cells.push(...Array.from(match[1]).map((char): Cell => ({ char, style: 'bright' })))
    } else if (match[2] !== undefined) {
      cells.push(...Array.from(match[2]).map((char): Cell => ({ char, style: 'cyan' })))
    } else if (match[3] !== undefined && match[4] !== undefined) {
      cells.push(...Array.from(match[3]).map(char => ({ char })))
      cells.push({ char: ' ' }, { char: '(', style: 'gray' })
      cells.push(...Array.from(match[4]).map((char): Cell => ({ char, style: 'gray' })))
      cells.push({ char: ')', style: 'gray' })
    } else {
      /* v8 ignore start -- the strike alternative is the pattern's final one, so this branch always captures */
      cells.push(...Array.from(match[5] ?? '').map((char): Cell => ({ char, style: 'dim' })))
      /* v8 ignore stop */
    }
    last = index + match[0].length
  }
  if (last < text.length) cells.push(...Array.from(text.slice(last)).map(char => ({ char })))
  return cells
}

/** Split a folded context string into its injected units (one per `<system-reminder>` segment). */
function splitContextUnits(text: string): string[] {
  const units: string[] = []
  for (const match of text.matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)) {
    /* v8 ignore next -- a successful match always captures the wrapper body */
    const body = match[1]?.trim() ?? ''
    if (body !== '') units.push(body)
  }
  // Unwrapped content (older logs or plain injected text) stays one unit;
  // text made only of empty wrappers renders nothing.
  const unwrapped = text.replace(/<\/?system-reminder>/g, '').trim()
  if (units.length === 0 && unwrapped !== '') units.push(unwrapped)
  return units
}

/**
 * The sidebar: one row per session, the current session highlighted in
 * reverse video with a `›` marker, a running indicator, and a heavy-context
 * marker (◆) when the session's prompt-side usage reaches the compaction
 * threshold.
 * @param sessions - the session rows.
 * @param current - the selected session id.
 * @param width - the available sidebar width.
 * @returns the rendered rows.
 */
export function renderSidebar(sessions: readonly SessionSummary[], current: string | undefined, width: number): FrameRow[] {
  if (width <= 0) return []
  const rows: FrameRow[] = []
  for (const session of sessions) {
    const selected = session.id === current
    const style: CellStyle = selected ? 'reverse' : ''
    const title = truncate(session.title, Math.max(1, width - 6))
    const cells: Cell[] = [
      { char: selected ? '›' : ' ', style },
      { char: ' ', style },
      { char: session.running ? '●' : ' ', style: session.running ? 'green' : '' },
      { char: ' ', style },
      { char: session.heavy === true ? '◆' : ' ', style: session.heavy === true ? 'yellow' : '' },
      { char: ' ', style },
    ]
    for (const char of Array.from(title)) cells.push({ char, style })
    rows.push(cells)
  }
  return rows
}

/**
 * The conversation pane: fold blocks into rows, then page to the visible
 * window. A blank row separates every user turn from what came before it.
 * Wrapped rows come from the caller's {@link TranscriptRowCache} when one is
 * supplied, so long transcripts only re-wrap the blocks that changed.
 * @param blocks - the transcript blocks.
 * @param width - the available pane width.
 * @param height - the visible pane height.
 * @param offset - rows scrolled back from the newest row (0 pins the bottom).
 * @param expanded - whether a tool block renders its full details.
 * @param cache - optional wrapped-row cache keyed per block.
 * @returns the visible rows.
 */
export function renderConversation(
  blocks: readonly TranscriptBlock[],
  width: number,
  height: number,
  offset: number,
  expanded?: (block: TranscriptBlock) => boolean,
  cache?: TranscriptRowCache,
): FrameRow[] {
  if (width <= 0 || height <= 0) return []
  const all: FrameRow[] = []
  for (const block of blocks) {
    // The user's own words never touch injected or assistant material.
    if (block.kind === 'user' && all.length > 0) all.push('')
    const version = blockVersion(block)
    const isExpanded = expanded?.(block) ?? false
    const rows = cache === undefined
      ? renderBlock(block, width, isExpanded)
      : cache.rows(block, width, version, isExpanded, () => renderBlock(block, width, isExpanded))
    all.push(...rows)
  }
  // Overscroll clamps at the oldest row; a short transcript stays pinned.
  const pinned = Math.min(offset, Math.max(0, all.length - height))
  const end = all.length - pinned
  const start = Math.max(0, end - height)
  return all.slice(start, end)
}

/**
 * The composer line: a cyan prompt marker plus the draft, with the caret
 * shown in reverse video (a block cursor when the draft is empty). The draft
 * scrolls to its tail in cells, so wide characters and the caret stay aligned.
 * @param draft - the draft text.
 * @param caret - the caret position in the draft.
 * @param width - the available composer width in cells.
 * @param prefix - the prompt marker.
 * @returns the rendered composer row.
 */
export function renderComposer(draft: string, caret: number, width: number, prefix = '❯ '): FrameRow {
  const safe = Array.from(draft)
  const caretAt = Math.min(caret, safe.length)
  const before = safe.slice(0, caretAt)
  const after = safe.slice(caretAt)
  const all = [...before, ...after]
  const avail = Math.max(0, width - stringWidth(prefix))
  // When the draft overflows, show its tail (the caret rides the right edge);
  // otherwise show from the start.
  let start = 0
  if (stringWidth(draft) > avail) {
    // Longest suffix of the draft that fits `avail` cells (the caret rides
    // the right edge of the overflow window).
    let used = 0
    let count = 0
    for (const char of [...all].reverse()) {
      const cell = charWidth(char)
      if (used + cell > avail) break
      used += cell
      count += 1
    }
    start = all.length - count
  }
  const visible = all.slice(start)
  // The visible window fits `avail` cells by construction (the suffix walk
  // above or the whole draft when it fits), so every char renders.
  const cells: Cell[] = visible.map(char => ({ char, style: '' }))
  const caretPos = stringWidth(before.join('')) - stringWidth(all.slice(0, start).join(''))
  let acc = 0
  let caretCell: Cell | undefined
  for (const cell of cells) {
    const w = charWidth(cell.char)
    if (acc + w > caretPos) { caretCell = cell; break }
    acc += w
  }
  if (caretCell !== undefined) {
    caretCell.style = 'reverse'
  } else {
    cells.push({ char: ' ', style: 'reverse' })
  }
  const out: Cell[] = Array.from(prefix).map(char => ({ char, style: 'cyan' as CellStyle }))
  out.push(...cells)
  return out
}

/**
 * One line of a centered popup; `title` is bold, `body` dim. Widths are cells,
 * so CJK titles and body lines align inside the borders.
 * @param title - the popup title.
 * @param body - the popup body lines.
 * @param width - the available width in cells.
 * @returns the rendered popup rows.
 */
export function popupLines(title: string, body: readonly string[], width: number): FrameRow[] {
  const inner = Math.max(1, width - 4)
  const titleLine = padWidth(truncateWidth(title, inner), inner)
  const lines: FrameRow[] = [row(`┌─ ${titleLine} ─┐`, 'cyan')]
  for (const line of body.slice(0, 20)) {
    lines.push(row(`│ ${padWidth(truncateWidth(line, inner), inner)} │`, undefined))
  }
  lines.push(row(`└${'─'.repeat(inner + 4)}┘`, 'cyan'))
  return lines
}

/** One cursor-marked list row: the selected entry gets a `›` marker and reverse video. */
function cursorRow(text: string, selected: boolean, width: number, style: CellStyle = ''): FrameRow {
  const cells: Cell[] = [
    { char: selected ? '›' : ' ', style: selected ? 'reverse' : '' },
    { char: ' ', style: selected ? 'reverse' : '' },
  ]
  for (const char of Array.from(truncate(text, Math.max(1, width - 2)))) {
    cells.push({ char, style: selected ? 'reverse' : style })
  }
  return cells
}

/**
 * The jobs pane: one row per job with its status, and dimmed detail lines
 * under the expanded job (kind, detail, timestamps, reporting state).
 * @param jobs - the job snapshots.
 * @param width - the available pane width.
 * @param cursor - the selected row index.
 * @param expanded - whether a job shows its detail lines.
 * @returns the rendered rows.
 */
export function renderJobs(
  jobs: readonly JobSnapshot[],
  width: number,
  cursor: number,
  expanded: (id: JobId) => boolean,
): FrameRow[] {
  if (width <= 0) return []
  const rows: FrameRow[] = []
  jobs.forEach((job, index) => {
    const selected = index === cursor
    const statusStyle: CellStyle = job.status === 'running' ? 'cyan' : job.status === 'failed' ? 'red' : 'green'
    rows.push(cursorRow(`${job.id} · ${job.status} · ${job.label}`, selected, width, statusStyle))
    if (expanded(job.id)) {
      const detail = [
        `kind: ${job.kind}`,
        `started: ${new Date(job.startedAt).toISOString()}`,
        ...job.finishedAt === undefined ? [] : [`finished: ${new Date(job.finishedAt).toISOString()}`],
        ...job.detail === undefined ? [] : [`detail: ${job.detail}`],
        `reported: ${String(job.reported)}`,
      ]
      for (const line of detail) rows.push(row(`  ${line}`, 'gray'))
    }
  })
  return rows
}

/**
 * The subagents pane: one row per child (openable) or terminated entry, the
 * selected row highlighted.
 * @param entries - the subagent list entries.
 * @param width - the available pane width.
 * @param cursor - the selected row index.
 * @returns the rendered rows.
 */
export function renderSubagents(entries: readonly SubagentListEntry[], width: number, cursor: number): FrameRow[] {
  if (width <= 0) return []
  const rows: FrameRow[] = []
  entries.forEach((entry, index) => {
    const selected = index === cursor
    if (entry.kind === 'child') {
      const label = entry.label === undefined ? '' : ` · ${entry.label}`
      rows.push(cursorRow(`${entry.id} · ${entry.activity} · ${entry.mode}${label}`, selected, width, 'green'))
    } else {
      rows.push(cursorRow(`${entry.id} · terminated · ${entry.reason}`, selected, width, 'gray'))
    }
  })
  return rows
}

/**
 * The goals pane: the durable goal with its phase, round budget, activation,
 * and any blocking reason.
 * @param goal - the current goal view.
 * @param width - the available pane width.
 * @returns the rendered rows.
 */
export function renderGoal(goal: GoalView | undefined, width: number): FrameRow[] {
  if (width <= 0) return []
  if (goal === undefined) return [row(t('goals.empty'), 'gray')]
  const rows: FrameRow[] = [cursorRow(`${goal.phase}: ${goal.objective}`, true, width, 'magenta')]
  rows.push(row(`  rounds ${goal.roundsStarted}/${goal.maxGoalRounds} · ${goal.activation} · updated ${new Date(goal.updatedAt).toISOString()}`, 'gray'))
  if (goal.blockedReason !== undefined) {
    rows.push(row(`  blocked: ${goal.blockedReason.code} — ${goal.blockedReason.message}`, 'red'))
  }
  return rows
}

/**
 * The skills pane: one row per skill with its description; skills the user
 * may not invoke render dimmed.
 * @param skills - the skill summaries.
 * @param width - the available pane width.
 * @param cursor - the selected row index.
 * @returns the rendered rows.
 */
export function renderSkills(skills: readonly SkillSummary[], width: number, cursor: number): FrameRow[] {
  if (width <= 0) return []
  const rows: FrameRow[] = []
  skills.forEach((skill, index) => {
    const selected = index === cursor
    rows.push(cursorRow(`${skill.name} — ${skill.description}`, selected, width, skill.invocation.userInvocable ? '' : 'gray'))
  })
  return rows
}
