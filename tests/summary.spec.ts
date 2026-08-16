/**
 * Session summary model: title folding, live/cold rows, and merge order.
 */

import { describe, expect, it } from 'vitest'
import { foldTitle, shortId, summarizeLive, summarizeCold, mergeSummaries, type SessionSummary } from '../src/tui/summary.ts'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

describe('foldTitle', () => {
  it('returns the latest title event', () => {
    const events = [
      { type: 'session/title', data: { title: 'old' } },
      { type: 'session/title', data: { title: 'new' } },
    ] as unknown as SessionEvent[]
    expect(foldTitle(events)).toBe('new')
  })

  it('returns undefined without a title', () => {
    expect(foldTitle([{ type: 'turn/start', data: { turn: 1 } }] as unknown as SessionEvent[])).toBeUndefined()
  })

  it('returns undefined for an empty log', () => {
    expect(foldTitle([])).toBeUndefined()
  })
})

describe('summarizeLive', () => {
  it('uses the folded title or a friendly placeholder', () => {
    const withTitle = {
      id: 's1' as SessionId,
      header: { cwd: '/work' },
      events: [{ type: 'session/title', data: { title: 'T' } }],
    } as unknown as Session
    expect(summarizeLive(withTitle, false)).toMatchObject({ id: 's1', title: 'T', running: false, cwd: '/work', live: true })

    const noTitle = { id: 's2' as SessionId, header: {}, events: [] } as unknown as Session
    expect(summarizeLive(noTitle, true)).toMatchObject({ id: 's2', title: 'New session', running: true, live: true })
  })
})

describe('shortId', () => {
  it('keeps short ids intact under an ellipsis', () => {
    expect(shortId('cold-1' as SessionId)).toBe('…cold-1')
  })

  it('cuts long ids to their tail', () => {
    expect(shortId('session-0d2788db-8641-4a7e-8709-45b777a1c402' as SessionId)).toBe('…77a1c402')
  })
})

describe('summarizeCold', () => {
  it('uses the short id as title and reports not live', () => {
    expect(summarizeCold({ id: 's1' as SessionId, createdAt: 5 } as never)).toMatchObject({
      id: 's1', title: '…s1', running: false, live: false,
    })
    expect(summarizeCold({ id: 's1' as SessionId, createdAt: 5, cwd: '/x' } as never)).toMatchObject({ cwd: '/x' })
  })
})

describe('mergeSummaries', () => {
  it('puts live rows first and deduplicates cold headers', () => {
    const live: SessionSummary[] = [{ id: 's1' as SessionId, title: 's1', running: false, live: true }]
    const cold = [
      { id: 's1' as SessionId, createdAt: 1 },
      { id: 's2' as SessionId, createdAt: 2 },
      { id: 's3' as SessionId, createdAt: 3 },
    ] as never
    const merged = mergeSummaries(live, cold)
    expect(merged.map(row => row.id)).toEqual(['s1', 's3', 's2'])
  })
})
