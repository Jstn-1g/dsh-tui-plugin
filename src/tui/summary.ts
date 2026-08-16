/**
 * Session list model for the TUI sidebar: merges live sessions from the store
 * with persisted headers, folding each session's logged title.
 */

import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session-persistence'

/** One sidebar row. */
export interface SessionSummary {
  id: SessionId
  /** Latest logged title; a friendly placeholder when the session has none. */
  title: string
  running: boolean
  cwd?: string
  /** Whether an agent is attached in this process. */
  live: boolean
  /** Whether the session's prompt-side usage reaches the heavy-compaction threshold. */
  heavy?: boolean
}

/**
 * Fold the latest `session/title` event from a log.
 * @param events - the session log in order.
 * @returns the latest title, or `undefined` when none is logged.
 */
export function foldTitle(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session/title') return event.data.title
  }
  return undefined
}

/**
 * A compact label for a session without a logged title: the id's tail.
 * @param id - the session id.
 * @returns the short label.
 */
export function shortId(id: SessionId): string {
  return `…${id.slice(-8)}`
}

/**
 * Build one live row from an attached session.
 * @param session - the attached session.
 * @param running - whether its agent is running.
 * @returns the sidebar row.
 */
export function summarizeLive(session: Session, running: boolean): SessionSummary {
  return {
    id: session.id,
    title: foldTitle(session.events) ?? 'New session',
    running,
    ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
    live: true,
  }
}

/**
 * Build one cold row from a persisted header.
 * @param header - the persisted session header.
 * @returns the sidebar row.
 */
export function summarizeCold(header: SessionHeader): SessionSummary {
  return {
    id: header.id,
    title: shortId(header.id),
    running: false,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    live: false,
  }
}

/**
 * Merge live rows and cold rows into the sidebar order: live first (by
 * creation), then cold by `createdAt` descending.
 * @param live - attached-session rows.
 * @param cold - persisted headers not already attached.
 * @returns the merged list.
 */
export function mergeSummaries(
  live: readonly SessionSummary[],
  cold: readonly SessionHeader[],
): SessionSummary[] {
  const attached = new Set(live.map(row => row.id))
  const coldRows = [...cold]
    .filter(header => !attached.has(header.id))
    .sort((left, right) => right.createdAt - left.createdAt)
    .map(summarizeCold)
  return [...live, ...coldRows]
}
