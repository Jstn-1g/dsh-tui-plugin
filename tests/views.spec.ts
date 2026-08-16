/**
 * Pure view renderers: text wrapping, block rows, sidebar, conversation
 * paging, and the composer caret.
 */

import { describe, expect, it } from 'vitest'
import {
  wrapText,
  renderBlock,
  renderSidebar,
  renderConversation,
  renderComposer,
  renderGoal,
  renderJobs,
  renderSkills,
  renderSubagents,
  truncate,
  hintRow,
  welcomeRows,
} from '../src/tui/views.ts'
import { blockVersion } from '../src/tui/fold.ts'
import type { FrameRow } from '../src/tui/screen.ts'
import type { SessionSummary } from '../src/tui/summary.ts'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'

/** Render a FrameRow (string or styled cells) back to plain text. */
function rowText(row: FrameRow): string {
  return typeof row === 'string' ? row : row.map(cell => cell.char).join('')
}

describe('wrapText', () => {
  it('wraps on word boundaries', () => {
    expect(wrapText('one two three', 8)).toEqual(['one two', 'three'])
  })

  it('hard-splits a single long word', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('returns a blank row for empty input', () => {
    expect(wrapText('', 10)).toEqual([''])
  })

  it('returns no rows for a non-positive width', () => {
    expect(wrapText('abc', 0)).toEqual([])
  })

  it('wraps and hard-splits by cell width for wide characters', () => {
    expect(wrapText('中文abc', 4)).toEqual(['中文', 'abc'])
    expect(wrapText('中文abc', 3)).toEqual(['中', '文a', 'bc']) // fits 3 cells per line
    // A single wide character wider than the budget still renders once.
    expect(wrapText('中', 1)).toEqual(['中'])
  })
})

describe('renderBlock', () => {
  it('renders user blocks with a prompt marker', () => {
    expect(renderBlock({ kind: 'user', text: 'hello' }, 40).map(rowText)).toEqual(['❯ hello'])
  })

  it('renders assistant blocks with a streaming marker', () => {
    expect(renderBlock({ kind: 'assistant', text: 'hi', streaming: true }, 40).map(rowText)).toEqual(['hi▍'])
    expect(renderBlock({ kind: 'assistant', text: 'hi', streaming: false }, 40).map(rowText)).toEqual(['hi'])
    // The streaming cursor rides the last row only.
    expect(renderBlock({ kind: 'assistant', text: 'a\nb', streaming: true }, 40).map(rowText)).toEqual(['a', 'b▍'])
  })

  it('versions tool blocks with and without a result', () => {
    expect(blockVersion({ kind: 'tool', callId: 'c' as never, name: 'bash', args: '{}', status: 'done' })).toBe(2)
    expect(blockVersion({ kind: 'tool', callId: 'c' as never, name: 'bash', args: '{}', status: 'done', result: 'ok' })).toBe(4)
  })

  it('renders markdown styling in assistant text', () => {
    const rows = renderBlock({ kind: 'assistant', text: 'see **bold** and `code`', streaming: false }, 40)
    expect(rows.map(rowText)).toEqual(['see bold and code'])
    const cells = typeof rows[0] === 'string' ? [] : rows[0]!
    expect(cells.slice(4, 8).every(cell => cell.style === 'bright')).toBe(true)
    expect(cells.slice(16, 20).every(cell => cell.style === 'cyan')).toBe(true)
    // A bold span at the very start skips the leading plain-text slice.
    const head = renderBlock({ kind: 'assistant', text: '**head** tail', streaming: false }, 40)
    expect(head.map(rowText)).toEqual(['head tail'])
    const headCells = typeof head[0] === 'string' ? [] : head[0]!
    expect(headCells.slice(0, 4).every(cell => cell.style === 'bright')).toBe(true)
  })

  it('renders markdown headers and fenced code in assistant text', () => {
    const rows = renderBlock({ kind: 'assistant', text: '## Title\n```\nconst x = 1\n```', streaming: false }, 40)
    expect(rows.map(rowText)).toEqual(['Title', '  const x = 1'])
    const header = typeof rows[0] === 'string' ? [] : rows[0]!
    expect(header.every(cell => cell.style === 'bright')).toBe(true)
  })

  it('renders markdown tables with aligned columns and dim borders', () => {
    const rows = renderBlock({
      kind: 'assistant',
      text: '| 目录 | 说明 |\n| --- | --- |\n| .agents/ | 工作流 |\n| packages/ | 核心包 |',
      streaming: false,
    }, 60)
    const text = rows.map(rowText).join('\n')
    expect(rows).toHaveLength(4)
    expect(text).toContain('目录')
    expect(text).toContain('│ .agents/ │ 工作流 │')
    expect(text).toContain('┼')
    // The header cells render bright.
    const header = typeof rows[0] === 'string' ? [] : rows[0]!
    expect(header.some(cell => cell.char === '目' && cell.style === 'bright')).toBe(true)
  })

  it('shrinks and truncates markdown tables wider than the pane', () => {
    const rows = renderBlock({
      kind: 'assistant',
      text: '| aaaaaaaaaa | b |\n| - | - |\n| 1234567890 | x |',
      streaming: false,
    }, 16)
    expect(rows.map(rowText).join('\n')).toContain('…')
    // Every rendered row stays within the pane width.
    for (const row of rows) expect(rowText(row).length).toBeLessThanOrEqual(16)
  })

  it('renders a lone pipe line as a paragraph and rejects a bad separator', () => {
    const lone = renderBlock({ kind: 'assistant', text: '| a | b |', streaming: false }, 40)
    expect(lone.map(rowText)).toEqual(['| a | b |'])
    const bad = renderBlock({ kind: 'assistant', text: '| a | b |\nnot a separator', streaming: false }, 40)
    expect(bad.map(rowText)).toEqual(['| a | b |', 'not a separator'])
  })

  it('pads short table rows and truncates long ones to the header count', () => {
    const rows = renderBlock({
      kind: 'assistant',
      text: '| a | b |\n| - | - |\n| only |\n| 1 | 2 | 3 |',
      streaming: false,
    }, 40)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('│ only │')
    expect(text).not.toContain('3 │') // the extra cell is dropped
  })

  it('keeps inline styles inside table header cells', () => {
    const rows = renderBlock({
      kind: 'assistant',
      text: '| `a` | b |\n| - | - |\n| 1 | 2 |',
      streaming: false,
    }, 40)
    const header = typeof rows[0] === 'string' ? [] : rows[0]!
    expect(header.some(cell => cell.char === 'a' && cell.style === 'cyan')).toBe(true)
  })

  it('renders markdown lists with hanging indents and checkboxes', () => {
    const rows = renderBlock({
      kind: 'assistant',
      text: '- one\n- two\n  - nested\n1. first\n- [x] done\n- [ ] todo',
      streaming: false,
    }, 40)
    expect(rows.map(rowText)).toEqual([
      '• one',
      '• two',
      '  ◦ nested',
      '1. first',
      '☑ done',
      '☐ todo',
    ])
  })

  it('hangs wrapped list continuations under the text start', () => {
    const rows = renderBlock({
      kind: 'assistant',
      text: `- ${'word '.repeat(20)}end`,
      streaming: false,
    }, 16)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.map(rowText)[0]).toContain('• word')
    for (const row of rows.slice(1)) expect(rowText(row)).toMatch(/^  /)
  })

  it('renders markdown blockquotes, rules, links, and strikethrough', () => {
    const rows = renderBlock({
      kind: 'assistant',
      text: '> quoted\n---\nsee [docs](https://d.sh) and ~~gone~~',
      streaming: false,
    }, 60)
    expect(rows.map(rowText)[0]).toBe('│ quoted')
    expect(rows.map(rowText)[1]).toMatch(/^─+$/)
    expect(rows.map(rowText)[2]).toBe('see docs (https://d.sh) and gone')
    const cells = typeof rows[2] === 'string' ? [] : rows[2]!
    expect(cells.some(cell => cell.char === '(' && cell.style === 'gray')).toBe(true)
    expect(cells.slice(-4).every(cell => cell.style === 'dim')).toBe(true)
  })

  it('renders tool blocks with a status glyph and one-line head', () => {
    expect(renderBlock({ kind: 'tool', callId: 'c' as never, name: 'bash', args: '{}', status: 'running' }, 40).map(rowText))
      .toEqual(['● bash({})'])
    expect(renderBlock({ kind: 'tool', callId: 'c' as never, name: 'bash', args: '{}', status: 'done', result: 'ok' }, 40).map(rowText))
      .toEqual(['✓ bash({})'])
    expect(renderBlock({ kind: 'tool', callId: 'c' as never, name: 'bash', args: '{}', status: 'done', error: { name: 'x', code: 'y' } }, 40).map(rowText))
      .toEqual(['✗ bash({})'])
  })

  it('expands a tool card to its full arguments and result', () => {
    const rows = renderBlock(
      { kind: 'tool', callId: 'c' as never, name: 'bash', args: '{"cmd":"ls"}', status: 'done', result: 'file.txt' },
      40,
      true,
    )
    expect(rows.map(rowText)).toEqual(['▾ bash(ls)', '  {"cmd":"ls"}', '← file.txt'])
  })

  it('summarizes shell commands instead of the raw JSON arguments', () => {
    expect(renderBlock({ kind: 'tool', callId: 'c' as never, name: 'pwsh', args: '{"command":"Get-ChildItem -Force"}', status: 'done' }, 60).map(rowText))
      .toEqual(['✓ pwsh(Get-ChildItem -Force)'])
    // Non-JSON arguments render verbatim.
    expect(renderBlock({ kind: 'tool', callId: 'c' as never, name: 'bash', args: 'plain args', status: 'done' }, 60).map(rowText))
      .toEqual(['✓ bash(plain args)'])
    // JSON without a readable scalar falls back to the raw arguments.
    expect(renderBlock({ kind: 'tool', callId: 'c' as never, name: 'fs', args: '{"recursive":true}', status: 'done' }, 60).map(rowText))
      .toEqual(['✓ fs({"recursive":true})'])
  })

  it('expands a tool card error', () => {
    const rows = renderBlock(
      { kind: 'tool', callId: 'c' as never, name: 'fs', args: '{}', status: 'done', error: { name: 'x', code: 'E1' } },
      40,
      true,
    )
    expect(rows.map(rowText)).toEqual(['▾ fs({})', '  {}', '✗ E1: x'])
  })

  it('expands a tool card with empty args', () => {
    const rows = renderBlock(
      { kind: 'tool', callId: 'c' as never, name: 'bash', args: '', status: 'done', result: 'ok' },
      40,
      true,
    )
    expect(rows.map(rowText)).toEqual(['▾ bash', '← ok'])
  })

  it('renders a tool block with empty args without trailing space', () => {
    expect(renderBlock({ kind: 'tool', callId: 'c' as never, name: 'bash', args: '', status: 'done' }, 40).map(rowText))
      .toEqual(['✓ bash'])
  })

  it('renders system blocks dimmed with a uniform marker', () => {
    expect(renderBlock({ kind: 'system', text: 'note' }, 40).map(rowText)).toEqual(['⌁ note'])
  })

  it('renders context units as marker chips', () => {
    const rows = renderBlock(
      { kind: 'context', text: '<system-reminder>workspace rules\nrule one\nrule two</system-reminder>' },
      60,
    )
    expect(rows).toHaveLength(1)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('⚙ workspace rules · 3 lines')
    expect(text).not.toContain('rule one')
  })

  it('renders file and skill context units with their own markers', () => {
    const file = renderBlock(
      { kind: 'context', text: '<system-reminder>Attached file: a.txt\nbody\n</system-reminder>' },
      60,
    )
    expect(file.map(rowText).join('\n')).toContain('📄 Attached file: a.txt · 2 lines')
    const skill = renderBlock(
      { kind: 'context', text: '<system-reminder><skill_content name="demo">\nBODY\n</system-reminder>' },
      60,
    )
    expect(skill.map(rowText).join('\n')).toContain('🔧 @demo · 2 lines')
  })

  it('labels injected units with meaningful previews', () => {
    const rules = renderBlock(
      { kind: 'context', text: '<system-reminder>The following workspace instructions may be relevant. Instructions from: AGENTS.md\nrule\n</system-reminder>' },
      80,
    )
    expect(rules.map(rowText).join('\n')).toContain('⚙ Instructions from: AGENTS.md · 2 lines')
    const catalog = renderBlock(
      { kind: 'context', text: '<system-reminder>A skill is a reusable set. <available_skills>x</available_skills></system-reminder>' },
      80,
    )
    expect(catalog.map(rowText).join('\n')).toContain('🧰 skill catalog')
    const policy = renderBlock(
      { kind: 'context', text: '<system-reminder>Current DSH file policy: workspace-write. Any available operation.</system-reminder>' },
      80,
    )
    expect(policy.map(rowText).join('\n')).toContain('🛡 DSH file policy: workspace-write')
    const runtime = renderBlock(
      { kind: 'context', text: '<system-reminder>Current runtime context. This snapshot supersedes.</system-reminder>' },
      80,
    )
    expect(runtime.map(rowText).join('\n')).toContain('⚙ runtime context')
  })

  it('renders nothing for an empty context block', () => {
    expect(renderBlock({ kind: 'context', text: '<system-reminder></system-reminder>' }, 40)).toEqual([])
  })

  it('renders unwrapped injected text as one unit', () => {
    const rows = renderBlock({ kind: 'context', text: 'plain injected text' }, 60)
    expect(rows.map(rowText).join('\n')).toContain('⚙ plain injected text · 1 lines')
  })

  it('renders todo items with status markers', () => {
    expect(renderBlock({
      kind: 'todo',
      items: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ],
    }, 40).map(rowText)).toEqual(['☑ a', '◐ b', '☐ c'])
  })
})

describe('renderSidebar', () => {
  const sessions: SessionSummary[] = [
    { id: 's1' as never, title: 'first', running: false, live: true },
    { id: 's2' as never, title: 'second', running: true, live: true },
  ]

  it('renders one row per session', () => {
    const rows = renderSidebar(sessions, 's1', 20)
    expect(rows.map(rowText)).toHaveLength(2)
    expect(rowText(rows[0]!)).toContain('first')
    expect(rowText(rows[1]!)).toContain('second')
  })

  it('returns no rows for a non-positive width', () => {
    expect(renderSidebar(sessions, undefined, 0)).toEqual([])
  })
})

describe('truncate', () => {
  it('leaves short labels intact', () => {
    expect(truncate('abc', 5)).toBe('abc')
  })

  it('cuts long labels with an ellipsis', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…')
    expect(truncate('中文字', 5)).toBe('中文…')
  })

  it('returns an empty string for a non-positive width', () => {
    expect(truncate('abc', 0)).toBe('')
    expect(truncate('abc', -1)).toBe('')
  })
})

describe('hintRow', () => {
  it('renders a dim hint padded to the width', () => {
    const row = hintRow('type a message', 20)
    expect(rowText(row)).toBe('type a message'.padEnd(20))
  })

  it('pads wide characters by cells', () => {
    const row = hintRow('中文', 6)
    expect(rowText(row)).toBe('中文  ')
  })

  it('truncates a hint longer than the width', () => {
    const row = hintRow('a very long hint that exceeds the pane width', 12)
    expect(rowText(row)).toHaveLength(12)
    expect(rowText(row)).toContain('…')
  })
})

describe('welcomeRows', () => {
  it('renders the centered welcome lines within the width', () => {
    const rows = welcomeRows(70)
    expect(rows.length).toBeGreaterThan(0)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('dshcli')
    expect(text).toContain('type a message to start a new session')
    for (const row of rows) expect(rowText(row).length).toBeLessThanOrEqual(70)
  })
})

describe('renderConversation', () => {
  it('pins to the newest rows and separates user turns with a blank row', () => {
    const blocks = [
      { kind: 'user' as const, text: 'a' },
      { kind: 'user' as const, text: 'b' },
      { kind: 'user' as const, text: 'c' },
    ]
    const rows = renderConversation(blocks, 10, 2, 0)
    expect(rows.map(rowText)).toEqual(['', '❯ c'])
  })

  it('separates the user turn from prior assistant material with a blank row', () => {
    const rows = renderConversation([
      { kind: 'assistant' as const, text: 'hi', streaming: false },
      { kind: 'user' as const, text: 'yo' },
    ], 10, 5, 0)
    expect(rows.map(rowText)).toEqual(['hi', '', '❯ yo'])
  })

  it('scrolls the offset back from the newest row and clamps at the top', () => {
    const blocks = [
      { kind: 'user' as const, text: 'a' },
      { kind: 'user' as const, text: 'b' },
      { kind: 'user' as const, text: 'c' },
      { kind: 'user' as const, text: 'd' },
    ]
    // One row back from the newest: the previous turn's text row.
    expect(renderConversation(blocks, 10, 2, 1).map(rowText)).toEqual(['❯ c', ''])
    // Overscroll clamps at the oldest row instead of rendering nothing.
    expect(renderConversation(blocks, 10, 2, 10).map(rowText)).toEqual(['❯ a', ''])
  })

  it('returns no rows for a non-positive size', () => {
    expect(renderConversation([], 0, 5, 0)).toEqual([])
    expect(renderConversation([], 5, 0, 0)).toEqual([])
  })
})

function job(overrides: Record<string, unknown> = {}): JobSnapshot {
  return {
    id: 'j1', kind: 'bash', label: 'job label', status: 'running', reported: false, startedAt: 0,
    ...overrides,
  } as unknown as JobSnapshot
}

describe('renderJobs', () => {
  it('renders one row per job with a cursor marker', () => {
    const rows = renderJobs([job(), job({ id: 'j2', status: 'failed' })], 40, 1, () => false)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('j1 · running · job label')
    expect(text).toContain('› j2 · failed · job label')
  })

  it('expands the selected job with detail lines', () => {
    const rows = renderJobs(
      [job({ finishedAt: 5, detail: 'done detail' }), job({ id: 'j2', kind: 'fs', status: 'done' })],
      60,
      0,
      () => true,
    )
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('kind: bash')
    expect(text).toContain('finished:')
    expect(text).toContain('detail: done detail')
    expect(text).toContain('reported: false')
    // A job without a finish time simply omits that line.
    expect(text).toContain('kind: fs')
    expect(text).toContain('reported: false')
    expect(text.split('\n').filter(line => line.includes('finished:')).length).toBe(1)
  })

  it('returns no rows for a non-positive width', () => {
    expect(renderJobs([job()], 0, 0, () => false)).toEqual([])
  })
})

describe('renderSubagents', () => {
  it('renders child and terminated entries', () => {
    const entries = [
      { kind: 'child', id: 's1', activity: 'running', mode: 'one-shot', label: 'work' },
      { kind: 'report', id: 'r1', reason: 'completed' },
    ] as unknown as SubagentListEntry[]
    const rows = renderSubagents(entries, 40, 1)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('s1 · running · one-shot · work')
    expect(text).toContain('› r1 · terminated · completed')
  })

  it('returns no rows for a non-positive width', () => {
    expect(renderSubagents([], 0, 0)).toEqual([])
  })
})

function goalView(overrides: Partial<GoalView> = {}): GoalView {
  return {
    id: 'g1', revision: 1, objective: 'finish', phase: 'active', maxGoalRounds: 10,
    roundsStarted: 0, createdAt: 0, updatedAt: 0, activation: 'armed',
    ...overrides,
  } as GoalView
}

describe('renderGoal', () => {
  it('renders the phase, objective, budget, and activation', () => {
    const rows = renderGoal(goalView(), 80)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('active: finish')
    expect(text).toContain('rounds 0/10 · armed')
  })

  it('renders a blocking reason', () => {
    const rows = renderGoal(goalView({ phase: 'blocked', blockedReason: { code: 'stuck', message: 'no key' } }), 80)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('blocked: stuck — no key')
  })

  it('renders an empty state without a goal', () => {
    expect(renderGoal(undefined, 80).map(rowText)).toEqual(['(no goal)'])
  })

  it('returns no rows for a non-positive width', () => {
    expect(renderGoal(goalView(), 0)).toEqual([])
  })
})

function skillSummary(name: string, userInvocable = true): SkillSummary {
  return {
    name,
    description: `${name} description`,
    invocation: { modelInvocable: true, userInvocable },
    source: 'runtime',
    provider: 'runtime',
  }
}

describe('renderSkills', () => {
  it('renders skill names with descriptions', () => {
    const rows = renderSkills([skillSummary('alpha'), skillSummary('beta')], 40, 1)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('alpha — alpha description')
    expect(text).toContain('› beta — beta description')
  })

  it('dim-styles non-user-invocable skills', () => {
    const rows = renderSkills([skillSummary('alpha'), skillSummary('locked', false)], 40, 0)
    const row = rows[1] as { char: string; style: string }[]
    expect(row.some(cell => cell.style === 'gray')).toBe(true)
  })

  it('returns no rows for a non-positive width', () => {
    expect(renderSkills([], 0, 0)).toEqual([])
  })
})

describe('renderComposer', () => {
  it('places the caret after the draft', () => {
    const row = renderComposer('ab', 2, 20)
    expect(rowText(row)).toContain('ab')
  })

  it('clamps a caret past the end', () => {
    const row = renderComposer('ab', 99, 20)
    expect(rowText(row)).toContain('ab')
  })

  it('handles an empty draft', () => {
    const row = renderComposer('', 0, 20)
    expect(rowText(row)).toContain('❯')
  })

  it('reverses the caret cell over a wide character', () => {
    const row = renderComposer('中文a', 1, 20)
    expect(rowText(row)).toBe('❯ 中文a')
    const cells = row as { char: string; style: string }[]
    // prefix ❯ + space, then the caret sits on 文
    expect(cells[3]).toMatchObject({ char: '文', style: 'reverse' })
  })

  it('scrolls a wide draft to its tail by cells', () => {
    // 4 CJK chars = 8 cells; the composer holds 6 cells total (4 after `❯ `).
    const row = renderComposer('中中中中', 4, 6)
    expect(rowText(row)).toBe('❯ 中中 ') // tail window + block cursor at the caret
    const cells = row as { char: string; style: string }[]
    expect(cells[cells.length - 1]).toMatchObject({ style: 'reverse' })
  })

  it('clips a wide char wider than the composer budget', () => {
    // avail = 1 cell; a single 中 needs 2, so only the block cursor shows.
    const row = renderComposer('中', 0, 3)
    expect(rowText(row)).toBe('❯  ')
    const cells = row as { char: string; style: string }[]
    expect(cells[cells.length - 1]).toMatchObject({ style: 'reverse' })
  })
})
