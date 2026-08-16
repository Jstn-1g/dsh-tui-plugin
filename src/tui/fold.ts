/**
 * Session-event fold for the terminal UI: converts a session's event log into
 * a list of display blocks (messages, tool cards, system rows, todo lists).
 * The fold is a pure function of `events` so replay and live streaming render
 * identically; the app refolds on every `session/event` append.
 */

import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { FrameRow } from './screen.ts'

/** One display block in the transcript. */
export type TranscriptBlock =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | {
    kind: 'tool'
    callId: CallId
    name: string
    args: string
    status: 'running' | 'done'
    result?: string
    error?: { name: string; code: string }
  }
  | { kind: 'system'; text: string }
  | { kind: 'context'; text: string }
  | { kind: 'todo'; items: TodoItem[] }

/**
 * A monotone version of one block's content, so a caller-owned row cache can
 * reuse wrapped rows while the block is unchanged (a streaming assistant
 * block grows its text every chunk and re-wraps only then).
 * @param block - the transcript block.
 * @returns the version value.
 */
export function blockVersion(block: TranscriptBlock): number {
  switch (block.kind) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'context':
      return block.text.length
    case 'tool':
      return block.args.length
        + (block.result?.length ?? 0)
        + (block.error?.name.length ?? 0)
        + (block.error?.code.length ?? 0)
    case 'todo':
      return block.items.reduce((sum, item) => sum + item.content.length, 0)
  }
}

/**
 * Caller-owned row cache for wrapped transcript blocks, keyed by the block
 * reference, terminal width, content version, and expansion state.
 */
export interface TranscriptRowCache {
  /**
   * The cached rows for one block, rebuilding when the key changed.
   * @param block - the transcript block.
   * @param width - the pane width the rows were wrapped for.
   * @param version - the block's current {@link blockVersion}.
   * @param expanded - whether the block renders expanded.
   * @param build - builds the rows on a miss.
   * @returns the cached-or-built rows.
   */
  rows(block: TranscriptBlock, width: number, version: number, expanded: boolean, build: () => FrameRow[]): FrameRow[]
}

/** The framing the harness wraps injected context in before the model sees it. */
const CONTEXT_PREFIX = '<system-reminder>'

/**
 * Split a message's content into the user's own text and the injected
 * instruction context. Context blocks (framed `<system-reminder>`) are shown
 * as a separate dimmed row so they never read as the user's words; a message
 * whose source is not `user` is injection by definition, whatever its
 * framing.
 * @param content - the message content blocks.
 * @param injected - whether the message's source marks it as injection.
 * @returns the user text and the concatenated context text.
 */
function splitContent(content: unknown, injected: boolean): { user: string; context: string } {
  const blocks = Array.isArray(content)
    ? content as readonly { type: string; text?: unknown; content?: unknown }[]
    : []
  let user = ''
  let context = ''
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      if (injected || block.text.startsWith(CONTEXT_PREFIX)) context += block.text
      else user += block.text
    } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      const nested = splitContent(block.content, injected)
      user += nested.user
      context += nested.context
    }
  }
  return { user, context }
}

/** Read the text blocks of a message's content, cast safely at the fold boundary. */
function messageText(content: unknown): string {
  const blocks = Array.isArray(content)
    ? content as readonly { type: string; text?: unknown; content?: unknown }[]
    : []
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      parts.push(messageText(block.content))
    }
  }
  return parts.join('')
}

/** Whether an assistant message is currently streaming (has open turn/step). */
function isStreaming(events: readonly SessionEvent[], end: number): boolean {
  let open = false
  for (let index = 0; index < end; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/**
 * Settle the tool call a result pairs to, when one is on record.
 * @param toolCalls - pending tool-call blocks by call id.
 * @param event - the result event to fold.
 */
function settleToolResult(
  toolCalls: ReadonlyMap<CallId, Extract<TranscriptBlock, { kind: 'tool' }>>,
  event: Extract<SessionEvent, { type: 'tool/result' }>,
): void {
  const block = toolCalls.get(event.data.message.source.callId)
  if (block !== undefined) {
    block.status = 'done'
    block.result = messageText(event.data.message.content)
    if (event.data.error !== undefined) block.error = event.data.error
  }
}

/**
 * Fold a session event log into display blocks.
 * @param events - the session log, in order.
 * @returns transcript blocks; an empty log yields an empty list.
 */
export function foldTranscript(events: readonly SessionEvent[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  const push = (block: TranscriptBlock): void => { blocks.push(block) }
  let assistant: Extract<TranscriptBlock, { kind: 'assistant' }> | undefined
  const toolCalls = new Map<CallId, Extract<TranscriptBlock, { kind: 'tool' }>>()

  const closeAssistant = (): void => {
    if (assistant === undefined) return
    assistant.streaming = false
    assistant = undefined
  }

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        closeAssistant()
        const sourceKind = (event.data.source as { kind?: unknown } | undefined)?.kind
        const injected = sourceKind !== undefined && sourceKind !== 'user'
        const split = splitContent(event.data.content, injected)
        if (split.user !== '') push({ kind: 'user', text: split.user })
        if (split.context !== '') push({ kind: 'context', text: split.context })
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          if (assistant === undefined) {
            assistant = { kind: 'assistant', text: '', streaming: true }
            push(assistant)
          }
          assistant.text += chunk.text
        }
        break
      }
      case 'assistant/message': {
        if (assistant === undefined) {
          assistant = { kind: 'assistant', text: '', streaming: false }
          push(assistant)
        }
        assistant.text = messageText(event.data.message.content)
        assistant.streaming = isStreaming(events, event.seq + 1)
        break
      }
      case 'tool/call': {
        closeAssistant()
        const block: Extract<TranscriptBlock, { kind: 'tool' }> = {
          kind: 'tool',
          callId: event.data.callId,
          name: event.data.name,
          args: event.data.arguments,
          status: 'running',
        }
        toolCalls.set(event.data.callId, block)
        push(block)
        break
      }
      case 'tool/result': {
        settleToolResult(toolCalls, event)
        break
      }
      case 'todo/write': {
        closeAssistant()
        push({ kind: 'todo', items: event.data.todos })
        break
      }
      case 'command/run': {
        closeAssistant()
        const args = 'args' in event.data && typeof event.data.args === 'string' && event.data.args.trim() !== ''
          ? ` ${(event.data as { args: string }).args.trim()}`
          : ''
        push({ kind: 'system', text: `/ ${event.data.name}${args}` })
        break
      }
      case 'command/done': {
        const text = event.data.text
        if (text !== undefined && text !== '') push({ kind: 'system', text })
        break
      }
      case 'plan/mode': {
        closeAssistant()
        push({ kind: 'system', text: event.data.active ? 'plan mode: on' : 'plan mode: off' })
        break
      }
      case 'turn/end': {
        closeAssistant()
        if (event.data.reason.kind === 'error') {
          push({ kind: 'system', text: `error: ${event.data.reason.error.code}: ${event.data.reason.error.message}` })
        }
        break
      }
      default:
        break
    }
  }
  return blocks
}

/**
 * Incremental transcript fold: applies one session event at a time in O(1)
 * amortized time, so streaming chunks never rescan the whole log. Applying an
 * event sequence produces the same blocks as {@link foldTranscript} on the
 * same log (live sessions append events in seq order, which is what the app
 * relies on; {@link foldTranscript} remains the authoritative pure fold).
 */
export class TranscriptFold {
  /** The folded display blocks, mutated in place as events arrive. */
  readonly blocks: TranscriptBlock[] = []
  private assistant: Extract<TranscriptBlock, { kind: 'assistant' }> | undefined
  private readonly toolCalls = new Map<CallId, Extract<TranscriptBlock, { kind: 'tool' }>>()
  private turnOpen = false

  private closeAssistant(): void {
    if (this.assistant === undefined) return
    this.assistant.streaming = false
    this.assistant = undefined
  }

  /**
   * Fold one event into the transcript.
   * @param event - the event to apply, in log order.
   */
  apply(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start':
        this.turnOpen = true
        break
      case 'turn/end':
        this.closeAssistant()
        this.turnOpen = false
        if (event.data.reason.kind === 'error') {
          this.blocks.push({
            kind: 'system',
            text: `error: ${event.data.reason.error.code}: ${event.data.reason.error.message}`,
          })
        }
        break
      case 'user/message': {
        this.closeAssistant()
        const sourceKind = (event.data.source as { kind?: unknown } | undefined)?.kind
        const injected = sourceKind !== undefined && sourceKind !== 'user'
        const split = splitContent(event.data.content, injected)
        if (split.user !== '') this.blocks.push({ kind: 'user', text: split.user })
        if (split.context !== '') this.blocks.push({ kind: 'context', text: split.context })
        break
      }
      case 'assistant/chunk': {
        if (event.data.chunk.type === 'text-delta') {
          if (this.assistant === undefined) {
            this.assistant = { kind: 'assistant', text: '', streaming: this.turnOpen }
            this.blocks.push(this.assistant)
          }
          this.assistant.text += event.data.chunk.text
        }
        break
      }
      case 'assistant/message': {
        if (this.assistant === undefined) {
          this.assistant = { kind: 'assistant', text: '', streaming: false }
          this.blocks.push(this.assistant)
        }
        this.assistant.text = messageText(event.data.message.content)
        this.assistant.streaming = this.turnOpen
        break
      }
      case 'tool/call': {
        this.closeAssistant()
        const block: Extract<TranscriptBlock, { kind: 'tool' }> = {
          kind: 'tool',
          callId: event.data.callId,
          name: event.data.name,
          args: event.data.arguments,
          status: 'running',
        }
        this.toolCalls.set(event.data.callId, block)
        this.blocks.push(block)
        break
      }
      case 'tool/result': {
        settleToolResult(this.toolCalls, event)
        break
      }
      case 'todo/write':
        this.closeAssistant()
        this.blocks.push({ kind: 'todo', items: event.data.todos })
        break
      case 'command/run': {
        this.closeAssistant()
        const args = 'args' in event.data && typeof event.data.args === 'string' && event.data.args.trim() !== ''
          ? ` ${(event.data as { args: string }).args.trim()}`
          : ''
        this.blocks.push({ kind: 'system', text: `/ ${event.data.name}${args}` })
        break
      }
      case 'command/done': {
        const text = event.data.text
        if (text !== undefined && text !== '') this.blocks.push({ kind: 'system', text })
        break
      }
      case 'plan/mode':
        this.closeAssistant()
        this.blocks.push({ kind: 'system', text: event.data.active ? 'plan mode: on' : 'plan mode: off' })
        break
      default:
        break
    }
  }
}
