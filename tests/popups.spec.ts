/**
 * Popup models: clamping, list filtering, and the approval/question/list
 * renderers.
 */

import { describe, expect, it } from 'vitest'
import { clampCursor, visibleItems, renderListPopup, renderApprovalPopup, renderQuestionPopup, renderConfirmPopup, renderCommandPalette, renderMentionPopup, commandPopup, modePopup, modelPopup } from '../src/tui/popups.ts'
import type { ListPopup } from '../src/tui/popups.ts'
import type { FrameRow } from '../src/tui/screen.ts'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

/** Render one frame row (string or styled cells) back to plain text. */
function rowText(row: FrameRow): string {
  return typeof row === 'string' ? row : row.map(cell => cell.char).join('')
}

function listPopup(items: string[], filter: string, height: number): ListPopup<unknown> {
  return { kind: 'list', title: 't', items, label: item => `${item}`, cursor: 0, filter, height }
}

describe('clampCursor', () => {
  it('clamps into range', () => {
    expect(clampCursor(99, 3)).toBe(2)
    expect(clampCursor(-1, 3)).toBe(0)
    expect(clampCursor(1, 3)).toBe(1)
  })

  it('returns 0 for an empty list', () => {
    expect(clampCursor(3, 0)).toBe(0)
  })
})

describe('visibleItems', () => {
  it('filters list items (paging lives in the renderer)', () => {
    const popup = listPopup(['alpha', 'beta', 'gamma'], 'a', 2)
    expect(visibleItems(popup)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('filters to a single match', () => {
    const popup = listPopup(['alpha', 'beta', 'gamma'], 'ga', 2)
    expect(visibleItems(popup)).toEqual(['gamma'])
  })

  it('returns everything when the filter is empty', () => {
    expect(visibleItems(listPopup(['a', 'b', 'c'], '', 2))).toEqual(['a', 'b', 'c'])
  })
})

describe('renderListPopup', () => {
  it('renders a bordered popup with the cursor', () => {
    const rows = renderListPopup(listPopup(['a', 'b'], '', 5), 80)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map(rowText).join('\n')).toContain('t')
  })

  it('scrolls the window so the cursor stays visible', () => {
    const popup = listPopup(['a', 'b', 'c', 'd', 'e', 'f'], '', 3)
    popup.cursor = 5
    const text = renderListPopup(popup, 80).map(rowText).join('\n')
    expect(text).toContain('› f')
    expect(text).not.toContain('  a')
    expect(text).toContain('  d')
  })

  it('renders a no-matches row', () => {
    const rows = renderListPopup(listPopup(['a'], 'zzz', 5), 80)
    expect(rows.map(rowText).join('\n')).toContain('no matches')
  })

  it('spans the supplied width', () => {
    const rows = renderListPopup(listPopup(['a'], '', 5), 40)
    expect(rows[0]).toBeDefined()
    expect(rowText(rows[0] ?? '')).toBe('┌─ t' + ' '.repeat(36) + '─┐')
  })
})

describe('renderApprovalPopup', () => {
  it('renders the tool and reason', () => {
    const request = {
      agent: {} as never,
      toolName: 'bash',
      reason: 'needs a shell',
    } as unknown as ApprovalRequest
    const rows = renderApprovalPopup({ kind: 'approval', request, resolve: () => {} }, 80)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('bash')
    expect(text).toContain('needs a shell')
  })

  it('omits the reason when absent', () => {
    const request = { agent: {} as never, toolName: 'fs' } as unknown as ApprovalRequest
    const rows = renderApprovalPopup({ kind: 'approval', request, resolve: () => {} }, 80)
    expect(rows.map(rowText).join('\n')).not.toContain('reason:')
  })
})

describe('renderQuestionPopup', () => {
  const question: AskUserQuestionItem = {
    id: 'q1',
    question: 'pick one',
    options: [{ label: 'A', description: 'first' }, { label: 'B' }],
  }

  it('renders the question and options', () => {
    const rows = renderQuestionPopup({ kind: 'question', questions: [question], cursor: 0, resolve: () => {} }, 80)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('pick one')
    expect(text).toContain('A')
    expect(text).toContain('first')
  })

  it('renders the question detail when present', () => {
    const rows = renderQuestionPopup({
      kind: 'question',
      questions: [{ ...question, detail: 'extra context' }],
      cursor: 0,
      resolve: () => {},
    }, 80)
    expect(rows.map(rowText).join('\n')).toContain('extra context')
  })

  it('renders an empty state without questions', () => {
    const rows = renderQuestionPopup({ kind: 'question', questions: [], cursor: 0, resolve: () => {} }, 80)
    expect(rows.map(rowText).join('\n')).toContain('no questions')
  })
})

describe('renderConfirmPopup', () => {
  it('renders the prompt and the yes/no hint', () => {
    const rows = renderConfirmPopup({ kind: 'confirm', prompt: 'wipe it?', resolve: () => {} }, 80)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('wipe it?')
    expect(text).toContain('[y] yes')
  })
})

describe('renderMentionPopup', () => {
  it('renders candidates with the cursor and skill details', () => {
    const rows = renderMentionPopup([
      { label: '@dsh-prose-standard', detail: 'prose rules' },
      { label: '@package.json', detail: '' },
    ], 0, 80, 40)
    const text = rows.map(rowText).join('\n')
    expect(text).toContain('› @dsh-prose-standard — prose rules')
    expect(text).toContain('  @package.json')
  })

  it('renders the empty copy when nothing matches', () => {
    const text = renderMentionPopup([], 0, 80, 40).map(rowText).join('\n')
    expect(text).toContain('(no matches)')
  })

  it('scrolls the window so the cursor stays visible', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ label: `@file${index}`, detail: '' }))
    const text = renderMentionPopup(many, 11, 80, 6).map(rowText).join('\n')
    expect(text).toContain('› @file11')
    expect(text).not.toContain('@file0')
  })

  it('renders nothing when the window is shorter than the popup chrome', () => {
    expect(renderMentionPopup([], 0, 80, 2)).toEqual([])
    expect(renderMentionPopup([], 0, 80, 3)).toHaveLength(3)
  })
})

describe('commandPopup', () => {
  it('labels commands with a slash prefix', () => {
    const descriptor = { name: 'compact', description: 'compact the session' } as CommandDescriptor
    const popup = commandPopup([descriptor], '', 5)
    expect(popup.label(descriptor)).toContain('/compact')
  })

  it('labels a command without a description', () => {
    const popup = commandPopup([{ name: 'bare' }], '', 5)
    expect(popup.label({ name: 'bare' })).toBe('/bare — ')
  })
})

describe('modelPopup', () => {
  it('flattens provider groups into provider/model items', () => {
    const popup = modelPopup([
      { id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] },
    ], '', 5)
    const item = popup.items[0] as { provider: string; model: string; label: string; effortIndex: number }
    expect(item).toMatchObject({ provider: 'p1', model: 'm1', label: 'p1/m1', effortIndex: -1 })
    expect(popup.label(popup.items[0])).toBe('p1/m1')
  })
})

describe('modePopup', () => {
  it('marks the current preset and starts the cursor on it', () => {
    const popup = modePopup(['read-only', 'workspace-write', 'danger-full-access'], 'workspace-write', 8)
    expect(popup.items).toHaveLength(3)
    expect(popup.label(popup.items[0])).toBe('read-only')
    expect(popup.label(popup.items[1])).toBe('workspace-write (current)')
    expect(popup.cursor).toBe(1)
  })

  it('starts the cursor at the top when no preset is current', () => {
    expect(modePopup(['read-only', 'workspace-write'], undefined, 8).cursor).toBe(0)
  })
})

describe('renderCommandPalette', () => {
  const entries = [
    { name: 'sessions', description: 'session list', group: 'views' as const },
    { name: 'model', description: 'switch model', group: 'actions' as const },
    { name: 'goal', description: 'set goal', group: 'commands' as const },
    { name: 'plan', description: 'plan mode', group: 'commands' as const },
  ]

  it('renders a flat list with the cursor on the selected entry', () => {
    const rows = renderCommandPalette(entries, '', 0, 80, 40).map(rowText).join('\n')
    expect(rows).toContain('› /sessions — session list')
    expect(rows).toContain('  /model — switch model')
    expect(rows).not.toContain('Views')
  })

  it('filters by prefix and marks the selected match', () => {
    const rows = renderCommandPalette(entries, 'p', 1, 80, 40).map(rowText).join('\n')
    expect(rows).not.toContain('/sessions')
    expect(rows).toContain('  /plan — plan mode')
    expect(renderCommandPalette(entries, 'p', 0, 80, 40).map(rowText).join('\n')).toContain('› /plan — plan mode')
  })

  it('scrolls the window so the cursor stays visible', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `cmd${i}`,
      description: `d${i}`,
      group: 'actions' as const,
    }))
    const text = renderCommandPalette(many, '', 11, 80, 6).map(rowText).join('\n')
    expect(text).toContain('› /cmd11')
    expect(text).not.toContain('/cmd0')
  })

  it('caps the box at the given height so it never exceeds a short window', () => {
    const rows = renderCommandPalette(entries, '', 0, 80, 5)
    expect(rows.length).toBeLessThanOrEqual(5)
    expect(rowText(rows[rows.length - 1] as never).startsWith('└')).toBe(true)
  })

  it('renders nothing when the window is shorter than the popup chrome', () => {
    expect(renderCommandPalette(entries, '', 0, 80, 2)).toEqual([])
    expect(renderCommandPalette(entries, '', 0, 80, 3)).toHaveLength(3)
  })

  it('renders the empty copy when nothing matches', () => {
    const rows = renderCommandPalette(entries, 'zzz', 0, 80, 20).map(rowText).join('\n')
    expect(rows).toContain('(no matches)')
  })

  it('sinks /exit behind a separator when the full list is shown', () => {
    const withExit = [...entries, { name: 'exit', description: 'quit', group: 'actions' as const }]
    const lines = renderCommandPalette(withExit, '', 0, 80, 40).map(rowText)
    const rule = (line: string) => /^│\s+─+\s*│$/.test(line)
    const separator = lines.findIndex(rule)
    const exit = lines.findIndex(line => line.includes('/exit — quit'))
    expect(separator).toBeGreaterThan(-1)
    expect(exit).toBeGreaterThan(separator)
  })

  it('omits the separator while a prefix filters the list', () => {
    const withExit = [...entries, { name: 'exit', description: 'quit', group: 'actions' as const }]
    const lines = renderCommandPalette(withExit, 'ex', 0, 80, 40).map(rowText)
    expect(lines.join('\n')).toContain('/exit — quit')
    expect(lines.some(line => /^│\s+─+\s*│$/.test(line))).toBe(false)
  })
})
