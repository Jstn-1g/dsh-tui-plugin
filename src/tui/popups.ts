/**
 * Popup state and rendering for the terminal UI: approvals, user questions,
 * the slash-command palette, and the model picker. Popups are modal overlays
 * rendered above the conversation pane; each carries its own selection cursor
 * and a key contract the app dispatches.
 */

import type { FrameRow } from './screen.ts'
import { popupLines } from './views.ts'
import { t } from './i18n.ts'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ModelProviderGroup } from './model-catalog.ts'

/** A selectable popup over a list of options (command palette, model picker, questions). */
export interface ListPopup<T> {
  kind: 'list'
  title: string
  items: T[]
  /** Render one item to a display string (or `undefined` to skip it). */
  label: (item: T) => string
  cursor: number
  /** Filter text (command palette / model search). */
  filter: string
  /** Row height of the popup (items to show). */
  height: number
  /** Selection callback; absent lists fall back to the app's model selection. */
  onSelect?: (item: T) => void
  /** Cursor-move callback (lazy model-effort loading). */
  onMove?: (cursor: number) => void
}

/** An approval decision waiting on the user. */
export interface ApprovalPopup {
  kind: 'approval'
  request: ApprovalRequest
  /** Resolve with the user's outcome; `undefined` means the popup was dismissed. */
  resolve: (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void
}

/** A user question waiting on an answer. */
export interface QuestionPopup {
  kind: 'question'
  questions: AskUserQuestionItem[]
  cursor: number
  /** Resolve with the chosen option label per question. */
  resolve: (answers: { id: string; selected: string[] }[]) => void
}

/** A yes/no confirmation waiting on the user. */
export interface ConfirmPopup {
  kind: 'confirm'
  prompt: string
  /** Resolve with the user's decision; `undefined` means the popup was dismissed. */
  resolve: (yes: boolean | undefined) => void
}

/** The active modal, or none. */
export type TuiPopup =
  | ListPopup<unknown>
  | ApprovalPopup
  | QuestionPopup
  | ConfirmPopup

/**
 * The current cursor, clamped into the visible item range.
 * @param cursor - the requested cursor.
 * @param length - the item count.
 * @returns the clamped cursor.
 */
export function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0
  return Math.min(Math.max(0, cursor), Math.max(0, length - 1))
}

/**
 * Filtered items of a list popup, in full (the renderer pages them with a
 * cursor-following scroll window).
 * @param popup - the list popup.
 * @returns the filtered items.
 */
export function visibleItems<T>(popup: ListPopup<T>): T[] {
  const filter = popup.filter.trim().toLowerCase()
  return popup.items.filter(item => filter === '' || popup.label(item).toLowerCase().includes(filter))
}

/**
 * Render a list popup to frame rows, scrolled so the cursor stays visible
 * inside the popup's height window.
 * @param popup - the list popup.
 * @param width - the terminal width the popup spans.
 * @returns the rendered rows.
 */
export function renderListPopup(popup: ListPopup<unknown>, width: number): FrameRow[] {
  const items = visibleItems(popup)
  const start = scrollStart(popup.cursor, popup.height, items.length)
  const window = items.slice(start, start + popup.height)
  const body = window.map((item, index) => {
    const label = popup.label(item)
    return `${start + index === popup.cursor ? '› ' : '  '}${label}`
  })
  if (items.length === 0) body.push(t('commands.empty'))
  return popupLines(popup.title, body, width)
}

/**
 * Render an approval popup.
 * @param popup - the pending approval.
 * @param width - the terminal width the popup spans.
 * @returns the rendered rows.
 */
export function renderApprovalPopup(popup: ApprovalPopup, width: number): FrameRow[] {
  const { request } = popup
  const body = [
    `tool: ${request.toolName}`,
    ...request.reason === undefined ? [] : [`reason: ${request.reason}`],
    '',
    t('approval.hint'),
  ]
  return popupLines(t('approval.title'), body, width)
}

/**
 * Render a user-question popup.
 * @param popup - the pending question.
 * @param width - the terminal width the popup spans.
 * @returns the rendered rows.
 */
export function renderQuestionPopup(popup: QuestionPopup, width: number): FrameRow[] {
  const question = popup.questions[0]
  const options = question?.options ?? []
  const cursor = Math.min(popup.cursor, Math.max(0, options.length - 1))
  const body = question === undefined
    ? [t('question.empty')]
    : [
      question.question,
      ...question.detail === undefined ? [] : [question.detail],
      ...options.map((option, index) =>
        `${index === cursor ? '› ' : '  '}${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`),
      '',
      t('question.hint'),
    ]
  return popupLines(t('question.title'), body, width)
}

/**
 * Render a yes/no confirmation popup.
 * @param popup - the pending confirmation.
 * @param width - the terminal width the popup spans.
 * @returns the rendered rows.
 */
export function renderConfirmPopup(popup: ConfirmPopup, width: number): FrameRow[] {
  return popupLines(t('confirm.title'), [popup.prompt, '', t('confirm.hint')], width)
}

/**
 * Build a command palette popup from the effective command descriptors
 * (navigation commands plus the host command catalog).
 * @param descriptors - the effective command catalog.
 * @param filter - the initial filter text.
 * @param height - the visible item count.
 * @returns the command list popup.
 */
export function commandPopup(
  descriptors: readonly { name: string; description?: string }[],
  filter: string,
  height: number,
): ListPopup<unknown> {
  return {
    kind: 'list',
    title: t('commands.title'),
    items: descriptors as unknown as unknown[],
    label: (item) => {
      const command = item as { name: string; description?: string }
      return `/${command.name} — ${command.description ?? ''}`
    },
    cursor: 0,
    filter,
    height,
  }
}

/** One model-picker item: the route plus its lazily loaded reasoning efforts. */
export interface ModelPickItem {
  provider: string
  model: string
  /** The route label without the effort suffix. */
  label: string
  /** Selectable reasoning efforts; absent until the route resolves. */
  efforts?: readonly { id: string; name: string }[]
  /** Index into `efforts` for the pending selection; -1 while unknown. */
  effortIndex: number
}

/**
 * Build a model picker popup from the provider groups; `←`/`→` cycle the
 * highlighted route's reasoning effort once it loads.
 * @param groups - the model catalog groups.
 * @param filter - the initial filter text.
 * @param height - the visible item count.
 * @returns the model list popup.
 */
export function modelPopup(groups: readonly ModelProviderGroup[], filter: string, height: number): ListPopup<unknown> {
  const items: ModelPickItem[] = groups.flatMap(group => group.models.map(model => ({
    provider: group.id,
    model: model.id,
    label: `${group.id}/${model.id}`,
    effortIndex: -1,
  })))
  return {
    kind: 'list',
    title: t('model.title'),
    items,
    label: (item) => {
      const pick = item as ModelPickItem
      const effort = pick.efforts?.[pick.effortIndex]?.name
      return effort === undefined ? pick.label : `${pick.label} · ${effort}`
    },
    cursor: 0,
    filter,
    height,
  }
}

/**
 * Build the permission-preset picker (`/mode`): one row per preset, the
 * current one marked, the cursor starting on it.
 * @param names - the preset names in order.
 * @param current - the preset the current session runs, if any.
 * @param height - the visible item count.
 * @returns the mode list popup.
 */
export function modePopup(names: readonly string[], current: string | undefined, height: number): ListPopup<unknown> {
  const items = names.map(name => ({ name, current: name === current }))
  return {
    kind: 'list',
    title: t('mode.title'),
    items,
    label: (item) => {
      const mode = item as { name: string; current: boolean }
      return `${mode.name}${mode.current ? ` ${t('mode.current')}` : ''}`
    },
    cursor: Math.max(0, items.findIndex(item => item.current)),
    filter: '',
    height,
  }
}

/** One mention candidate: the insertable `@reference` plus an optional detail line. */
export interface MentionCandidate {
  /** The `@reference` text the composer inserts on acceptance (quoted when needed). */
  label: string
  /** Supporting copy (skill description); empty for file paths. */
  detail: string
}

/**
 * Render the composer-derived `@`-mention popup: one flat list of skills and
 * file paths, scrolled so the cursor stays visible inside a window capped at
 * `height` rows.
 * @param candidates - the candidates in display order.
 * @param cursor - the selected index.
 * @param width - the terminal width.
 * @param height - the maximum overlay height available.
 * @returns the bordered popup rows.
 */
export function renderMentionPopup(
  candidates: readonly MentionCandidate[],
  cursor: number,
  width: number,
  height: number,
): FrameRow[] {
  // Two chrome rows plus at least one candidate row; a shorter window renders nothing.
  if (height < 3) return []
  const body: { text: string; selected: boolean }[] = candidates.map((candidate, index) => ({
    text: candidate.detail === '' ? candidate.label : `${candidate.label} — ${candidate.detail}`,
    selected: index === cursor,
  }))
  if (candidates.length === 0) body.push({ text: t('mention.empty'), selected: false })
  const room = height - 2
  const start = scrollStart(cursor, room, body.length)
  const rows = body.slice(start, start + room).map(row =>
    row.selected ? `› ${row.text}` : `  ${row.text}`)
  return popupLines(t('mention.title'), rows, width)
}

/** One palette entry: its name, translated description, and section. */
export interface PaletteEntry {
  name: string
  description: string
  group: 'views' | 'actions' | 'commands'
}

/**
 * The scroll window start that keeps `cursor` visible inside `height` rows
 * of a `length`-row list, centered when possible.
 * @param cursor - the selected index.
 * @param height - the visible row count.
 * @param length - the total row count.
 * @returns the first visible index.
 */
export function scrollStart(cursor: number, height: number, length: number): number {
  if (length <= height) return 0
  const centered = cursor - Math.floor(height / 2)
  return Math.max(0, Math.min(centered, length - height))
}

/**
 * Render the composer-derived command palette: one flat, frequency-ordered
 * list filtered by prefix, scrolled so the cursor stays visible inside a
 * window capped at `height` rows. The risky `/exit` sits last; when the full
 * list is shown a dim rule separates it from the everyday commands (the
 * prefix filter shows a plain flat list instead).
 * @param entries - the palette entries in selection order.
 * @param filter - the prefix being typed after the slash.
 * @param cursor - the selected match index over the flattened filtered list.
 * @param width - the terminal width.
 * @param height - the maximum overlay height available.
 * @returns the bordered palette rows.
 */
export function renderCommandPalette(
  entries: readonly PaletteEntry[],
  filter: string,
  cursor: number,
  width: number,
  height: number,
): FrameRow[] {
  // Two chrome rows plus at least one entry row; a shorter window renders nothing.
  if (height < 3) return []
  const word = filter.toLowerCase()
  const matches = entries.filter(entry => word === '' || entry.name.toLowerCase().startsWith(word))
  const body: { text: string; selected: boolean }[] = []
  let cursorRow = 0
  matches.forEach((entry, matchIndex) => {
    if (entry.name === 'exit' && word === '') {
      // Two prefix cells plus the inner width: the rule fills the popup
      // without hitting truncation's ellipsis.
      body.push({ text: '─'.repeat(Math.max(1, width - 6)), selected: false })
    }
    if (matchIndex === cursor) cursorRow = body.length
    body.push({ text: `/${entry.name} — ${entry.description}`, selected: matchIndex === cursor })
  })
  if (matches.length === 0) body.push({ text: t('commands.empty'), selected: false })
  const room = height - 2
  const start = scrollStart(cursorRow, room, body.length)
  const rows = body.slice(start, start + room).map(row =>
    row.selected ? `› ${row.text}` : `  ${row.text}`)
  return popupLines(t('commands.title'), rows, width)
}
