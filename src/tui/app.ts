/**
 * The terminal UI application: owns all interactive state, wires host services
 * (sessions, agents, commands, approvals, questions, jobs, subagents, goals,
 * plan mode, settings, skills, models), subscribes to session events, and
 * dispatches keys against the active view or popup.
 *
 * The app is deliberately testable: it takes an injected {@link TuiIo} and a
 * Cordis context, exposes {@link feed} for scripted input, and renders through
 * the injected screen so tests capture frames without a real TTY.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CallId } from '@deepseek-ai/dsh-llm'
import { readdir, readFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
// Type-only edges: resolve the ctx services this app drives (`agentDefaultModel`,
// `commands`, `planMode`, `userQuestions`, `approval`) and the approval event
// vocabulary, without value dependencies on their seams.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import { PERMISSION_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-permission-presets'
import type { JobId, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import type { GoalService, GoalView } from '@deepseek-ai/dsh-goal'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import type { TuiKey } from './keys.ts'
import { TuiKeyDecoder } from './keys.ts'
import type { TuiIo } from './screen.ts'
import { TuiScreen } from './screen.ts'
import type { Frame, FrameRow, Cell } from './screen.ts'
import type { CellStyle } from './screen.ts'
import { TranscriptFold, type TranscriptBlock } from './fold.ts'
import type { TranscriptRowCache } from './fold.ts'
import type { SessionSummary } from './summary.ts'
import { foldTitle, mergeSummaries, shortId, summarizeLive } from './summary.ts'
import type { TuiPopup } from './popups.ts'
import { clampCursor, modePopup, modelPopup, renderApprovalPopup, renderCommandPalette, renderConfirmPopup, renderListPopup, renderMentionPopup, renderQuestionPopup, visibleItems } from './popups.ts'
import type { MentionCandidate, ModelPickItem } from './popups.ts'
import {
  hintRow,
  renderComposer,
  renderConversation,
  renderGoal,
  renderJobs,
  renderSidebar,
  renderSkills,
  renderSubagents,
  welcomeRows,
} from './views.ts'
import { editorInvocation, launchEditorProcess, type EditorInvocation } from './editor.ts'
import { TUI_LOCALE_NS } from './locale-settings.ts'
import type { TuiLocaleName } from './i18n.ts'
import { localeName, setLocale, t } from './i18n.ts'
import {
  MAX_MENTION_FILES,
  MAX_MENTION_FILE_BYTES,
  MAX_MENTION_TOTAL_BYTES,
  fileReferenceBlock,
  mentionLabel,
  mentionWordAt,
  parseMentionTokens,
  referenceContextBlock,
} from './mention.ts'
import { charWidth } from './width.ts'
import { buildModelGroups, type ModelProviderGroup } from './model-catalog.ts'
import type { TuiStartupValues } from '../startup.ts'

/** A named main-pane view. */
export type TuiView =
  | 'conversation'
  | 'sessions'
  | 'jobs'
  | 'subagents'
  | 'goals'
  | 'settings'
  | 'skills'
  | 'help'

/** Per-session live state kept by the app. */
interface SessionState {
  session: Session | undefined
  agent?: Agent
  /** Incremental transcript fold; keeps streaming chunks O(1). */
  fold: TranscriptFold
  transcript: TranscriptBlock[]
  running: boolean
  /** Whether the resumed log ends with an open turn (an interrupted session). */
  resumedOpenTurn: boolean
  /** Provider-reported usage accumulated for this session (last sample per step replaces). */
  usage: TokenUsage
  /** The `turn:step` of the newest accumulated usage sample, for same-step replacement. */
  usageStep: string | undefined
  /** The usage sample the totals currently include for `usageStep` (for same-step replacement). */
  usageSample: TokenUsage | undefined
  /** Wall-clock ms when the current turn started; undefined while idle. */
  turnStartedAt: number | undefined
  /** Wall-clock ms when the last turn ended; undefined until one completes. */
  lastTurnEndedAt: number | undefined
}

/** Grace period after an input chunk before a lone ESC resolves as Escape. */
const ESCAPE_FLUSH_MS = 40

/** How long an idle Ctrl+C stays armed as a quit request. */
const EXIT_ARM_MS = 2000

/** Event-driven repaints coalesce to at most ~12 frames per second. */
const REPAINT_INTERVAL_MS = 83

/**
 * A session whose accumulated prompt-side usage (uncached input plus cache
 * traffic) reaches this many tokens is "heavy": resuming it without
 * compaction repeats a large prompt on every request, which misses provider
 * prompt caches and bills the full uncached input each time. The TUI prompts
 * for `/compact` at this threshold.
 */
const HEAVY_SESSION_TOKENS = 40_000

/** Zero usage accumulator (all buckets absent). */
const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 }

/**
 * Prompt-side weight of one session's accumulated usage: uncached input plus
 * cache reads and writes. This is what a resumed request re-sends, so it is
 * the number compaction shrinks.
 * @param usage - the accumulated usage.
 * @returns the prompt-side token weight.
 */
function sessionWeight(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * The usage a session event reports, if any: an `assistant/chunk` usage chunk
 * or a finalized `assistant/message` usage record.
 * @param event - the session event.
 * @returns the usage, or `undefined` when the event carries none.
 */
function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
    return event.data.chunk.usage
  }
  if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    return event.data.usage
  }
  return undefined
}

/** The `turn:step` identity of one session event, for same-step usage replacement. */
function eventStepOf(event: SessionEvent): string | undefined {
  const data = event.data as { turn?: number; step?: number } | undefined
  if (data?.turn === undefined || data?.step === undefined) return undefined
  return `${data.turn}:${data.step}`
}

/**
 * Whether a session's logged history ends inside an open turn (a `turn/start`
 * whose `turn/end` never landed) — the signature of an interrupted session.
 * @param session - the session whose log is inspected.
 * @returns whether the newest turn is still open.
 */
function hasOpenTurn(session: Session | undefined): boolean {
  if (session === undefined) return false
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event === undefined) continue
    if (event.type === 'turn/end') return false
    if (event.type === 'turn/start') return true
  }
  return false
}

/**
 * One status-line model label: the `provider/model` route plus the reasoning
 * effort when one is selected (e.g. `deepseek/deepseek-v4-flash · high`).
 * @param selection - the model selection, if any.
 * @returns the label, or `undefined` when no selection is available.
 */
function modelLabel(selection: { provider: string; model: string; reasoningEffort?: string } | undefined): string | undefined {
  if (selection === undefined) return undefined
  const base = `${selection.provider}/${selection.model}`
  return selection.reasoningEffort === undefined ? base : `${base} · ${selection.reasoningEffort}`
}

/** Compact token counts: `1.2k` for thousands, else the plain integer. */
function compactTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k` : String(count)
}

/**
 * One status-line token summary: uncached input, output, and cache traffic,
 * e.g. `↑1.2k ↓3.4k 缓存5.6k`. Absent when nothing has been reported yet.
 * @param usage - the accumulated usage.
 * @returns the label, or `undefined` when no usage has landed.
 */
function usageTokensLabel(usage: TokenUsage): string | undefined {
  if (usage.inputTokens === 0 && usage.outputTokens === 0
    && (usage.cacheReadTokens ?? 0) === 0 && (usage.cacheWriteTokens ?? 0) === 0) {
    return undefined
  }
  const parts = [`↑${compactTokens(usage.inputTokens)}`, `↓${compactTokens(usage.outputTokens)}`]
  const cache = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  if (cache > 0) parts.push(`${t('status.cache')}${compactTokens(cache)}`)
  return parts.join(' ')
}

/**
 * Fold one usage sample into the running totals, replacing the previous
 * same-step sample (a usage chunk and the finalized message report the same
 * step; only the last one counts).
 * @param totals - the accumulated totals.
 * @param previousStep - the `turn:step` of the newest accumulated sample.
 * @param previousSample - the sample the totals currently include for `previousStep`.
 * @param step - this sample's `turn:step`.
 * @param usage - the new usage sample.
 * @returns the updated totals and sample identity.
 */
function foldUsage(
  totals: TokenUsage,
  previousStep: string | undefined,
  previousSample: TokenUsage | undefined,
  step: string | undefined,
  usage: TokenUsage,
): { usage: TokenUsage; sample: TokenUsage; step: string | undefined } {
  if (step !== undefined && step === previousStep && previousSample !== undefined) {
    return {
      usage: {
        inputTokens: totals.inputTokens - previousSample.inputTokens + usage.inputTokens,
        outputTokens: totals.outputTokens - (previousSample.outputTokens ?? 0) + (usage.outputTokens ?? 0),
        cacheReadTokens: (totals.cacheReadTokens ?? 0) - (previousSample.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: (totals.cacheWriteTokens ?? 0) - (previousSample.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      },
      sample: usage,
      step,
    }
  }
  return {
    usage: {
      inputTokens: totals.inputTokens + usage.inputTokens,
      outputTokens: totals.outputTokens + (usage.outputTokens ?? 0),
      cacheReadTokens: (totals.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: (totals.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    },
    sample: usage,
    step,
  }
}

/** Render styled segments into cells, truncating at a cell width. */
function segmentCells(parts: readonly { text: string; style: CellStyle }[], width: number): Cell[] {
  const cells: Cell[] = []
  let used = 0
  for (const part of parts) {
    for (const char of Array.from(part.text)) {
      const cell = charWidth(char)
      if (used + cell > width) return cells
      used += cell
      cells.push({ char, style: part.style })
    }
  }
  return cells
}

/**
 * TUI-local commands offered in the command palette. The palette is derived
 * from the composer draft, so these are ordinary command names the app
 * resolves before delegating to the host command registry.
 */
/**
 * TUI-local commands offered in the command palette, ordered by frequency
 * then danger: the quick actions people reach for most often first, view
 * jumps next, and `/exit` last (the renderer sinks it behind a separator).
 * The palette is derived from the composer draft, so these are ordinary
 * command names the app resolves before delegating to the host registry.
 */
const NAV_COMMANDS: readonly {
  name: string
  /** i18n copy key: the palette translates the description per render. */
  descriptionKey: string
  /** Palette section: view jumps versus actions. */
  group: 'views' | 'actions'
  local: true
  view?: TuiView
  action?: 'new' | 'exit' | 'model' | 'mode' | 'lang'
}[] = [
  { name: 'model', descriptionKey: 'nav.model', group: 'actions', local: true, action: 'model' },
  { name: 'mode', descriptionKey: 'nav.mode', group: 'actions', local: true, action: 'mode' },
  { name: 'lang', descriptionKey: 'nav.lang', group: 'actions', local: true, action: 'lang' },
  { name: 'new', descriptionKey: 'nav.new', group: 'actions', local: true, action: 'new' },
  { name: 'sessions', descriptionKey: 'nav.sessions', group: 'views', local: true, view: 'sessions' },
  { name: 'jobs', descriptionKey: 'nav.jobs', group: 'views', local: true, view: 'jobs' },
  { name: 'subagents', descriptionKey: 'nav.subagents', group: 'views', local: true, view: 'subagents' },
  { name: 'skills', descriptionKey: 'nav.skills', group: 'views', local: true, view: 'skills' },
  { name: 'help', descriptionKey: 'nav.help', group: 'views', local: true, view: 'help' },
  { name: 'exit', descriptionKey: 'nav.exit', group: 'actions', local: true, action: 'exit' },
]

/**
 * Shipped host commands shown before a session exists: the live registry is
 * agent-scoped, so the no-session palette falls back to this known list.
 * `/permission` is deliberately absent — `/mode` replaces it on this surface.
 */
const KNOWN_HOST_COMMANDS: readonly { name: string; descriptionKey: string }[] = [
  { name: 'compact', descriptionKey: 'host.compact' },
  { name: 'goal', descriptionKey: 'host.goal' },
  { name: 'plan', descriptionKey: 'host.plan' },
  { name: 'feedback', descriptionKey: 'host.feedback' },
]

const VIEW_KEYS: readonly (readonly [string, TuiView])[] = [
  ['1', 'conversation'],
  ['2', 'sessions'],
  ['3', 'jobs'],
  ['4', 'subagents'],
  ['5', 'goals'],
  ['6', 'settings'],
  ['7', 'skills'],
  ['8', 'help'],
]

/** The production editor launcher (the constructor default); tests substitute it. */
/* v8 ignore next 3 -- the real process spawn runs only in the shipped runner; unit tests inject a fake launcher */
function launchEditorDefault(invocation: EditorInvocation): void {
  launchEditorProcess(invocation.cmd, invocation.args)
}

/** The production mention directory listing; tests substitute a fake. */
/* v8 ignore next 4 -- the real directory read runs only in the shipped runner; unit tests inject fakes */
async function listMentionDirDefault(path: string): Promise<string[]> {
  const entries = await readdir(resolvePath(path), { withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => entry.name)
}

/** The production mention file read; tests substitute a fake. */
/* v8 ignore next 2 -- the real file read runs only in the shipped runner; unit tests inject fakes */
async function readMentionFileDefault(path: string): Promise<string> {
  return readFile(resolvePath(path), 'utf8')
}

/**
 * The terminal UI application.
 */
export class TuiApp {
  private readonly decoder = new TuiKeyDecoder()
  private readonly screen: TuiScreen
  private readonly sessions = new Map<SessionId, SessionState>()
  private current: SessionId | undefined
  private draft = ''
  private caret = 0
  private view: TuiView = 'conversation'
  private scroll = 0
  /**
   * Mouse-drawn transcript selection in 1-based screen coordinates; the
   * release copies the span to the system clipboard (OSC 52) and the
   * highlight stays until the next key or press.
   */
  private selection: { start: { row: number; col: number }; end: { row: number; col: number } } | undefined
  /** The rows of the last painted frame, read back when a selection copies. */
  private lastRows: FrameRow[] = []
  /** Ctrl+C quit arming: the first idle press only arms, the second quits. */
  private exitArmed = false
  private exitArmTimer: ReturnType<typeof setTimeout> | undefined
  /** Loaded titles of cold (persisted, unattached) sessions for the sidebar. */
  private readonly coldTitles = new Map<SessionId, string>()
  /**
   * Wrapped transcript rows per block, keyed by width, content version, and
   * expansion — long conversations only re-wrap the blocks that changed.
   */
  private readonly blockRows = new WeakMap<TranscriptBlock, Map<number, { rows: FrameRow[]; version: number; expanded: boolean }>>()
  private readonly rowCache: TranscriptRowCache = {
    rows: (block, width, version, expanded, build) => {
      const byWidth = this.blockRows.get(block) ?? new Map<number, { rows: FrameRow[]; version: number; expanded: boolean }>()
      const cached = byWidth.get(width)
      if (cached !== undefined && cached.version === version && cached.expanded === expanded) return cached.rows
      const rows = build()
      byWidth.set(width, { rows, version, expanded })
      this.blockRows.set(block, byWidth)
      return rows
    },
  }
  private sessionCursor = 0
  private sessionFilter = ''
  private popup: TuiPopup | undefined
  private model: string | undefined
  private plan = false
  private permission: string | undefined
  private readonly expandedTools = new Set<CallId>()
  private goal: GoalView | undefined
  private running = false
  private jobs: JobSnapshot[] = []
  private subagents: SubagentListEntry[] = []
  private skills: SkillSummary[] = []
  private modelGroups: ModelProviderGroup[] = []
  private jobCursor = 0
  private subagentCursor = 0
  private skillCursor = 0
  /** Scroll offsets keeping each list's cursor visible inside its window. */
  private sessionScroll = 0
  private jobScroll = 0
  private subagentScroll = 0
  private skillScroll = 0
  /** Help-pane scroll offset (its sections can exceed the pane). */
  private helpScroll = 0
  private readonly expandedJobs = new Set<JobId>()
  /**
   * The settings view is a read-only pointer at the settings document the
   * user edits themselves: the document path plus an edit hint, no
   * namespaces and no drill-down.
   */
  private settingsPath: string | undefined
  /**
   * The single current notice, painted as plain text on the bottom row of the
   * active view; a newer notice replaces the older one.
   */
  private notice: string | undefined
  private disposeJobsChanged: (() => void) | undefined
  private disposed = false
  private readonly selections = new WeakMap<Agent, ModelSelectionRef>()
  private readonly resizeListener = (): void => { this.repaint() }
  private escapeTimer: ReturnType<typeof setTimeout> | undefined
  private repaintTimer: ReturnType<typeof setTimeout> | undefined
  // Composer-centered command palette: the draft is the source of truth, and
  // the palette is derived from it (open only while the draft is a bare
  // `/command` word that the user has not dismissed with Esc).
  private paletteDismissed = false
  private paletteCursor = 0
  // Composer-centered `@` mention popup, derived from the word under the
  // caret: skills first, then files, with the same dismissal contract as the
  // palette. Directory listings cache per directory part for the popup's life.
  private mentionDismissed = false
  private mentionCursor = 0
  private readonly mentionDirs = new Map<string, string[]>()
  private mentionDirLoading: string | undefined
  /** Whether the skill catalog has been listed once for the popup. */
  private skillsListed = false
  private history: string[] = []
  private historyIndex = -1
  private historyDraft = ''

  /**
   * @param ctx - the settled host context.
   * @param io - the process streams the screen drives.
   * @param startup - resolved `dshcli` flags.
   * @param onQuit - called when the user requests quit with the active session id; the runner maps it to process exit.
   * @param launchEditor - launches the settings document in the user's editor; tests substitute a fake.
   * @param listMentionDir - lists the files of one directory for the `@` popup; tests substitute a fake.
   * @param readMentionFile - reads one referenced file; tests substitute a fake.
   */
  constructor(
    private readonly ctx: Context,
    private readonly io: TuiIo,
    private readonly startup: TuiStartupValues,
    private readonly onQuit: (sessionId: string | undefined) => void = () => {},
    private readonly launchEditor: (invocation: EditorInvocation) => void = launchEditorDefault,
    private readonly listMentionDir: (path: string) => Promise<string[]> = listMentionDirDefault,
    private readonly readMentionFile: (path: string) => Promise<string> = readMentionFileDefault,
  ) {
    this.screen = new TuiScreen(io)
  }

  /** Start the app: enter raw mode, list sessions, subscribe to events, paint. */
  start(): void {
    this.screen.start()
    this.io.stdout.on('resize', this.resizeListener)
    this.ctx.on('session/created', (session) => { this.upsertSession(session) })
    this.ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) })
    this.ctx.on('session/disposed', (session) => { this.removeSession(session) })
    this.ctx.on('agent/status', ({ agent, status }) => {
      const state = this.sessions.get(agent.id)
      if (state !== undefined) {
        state.running = status === 'running'
        this.refreshRunning()
        this.scheduleRepaint()
      }
    })
    void this.refreshSessions()
    this.refreshModel() // show the default model even before any session exists
    this.refreshPermission()
    this.refreshLocale() // apply the stored interface language
    this.installApprovalAnswerer()
    this.installQuestionProvider()
    // Keep the jobs pane live without repainting anything else.
    this.disposeJobsChanged = this.ctx.get('jobs')?.onJobsChanged(() => { this.refreshJobs() })
  }

  /** Stop the app and restore the terminal. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer)
    this.clearExitArmTimer()
    if (this.repaintTimer !== undefined) clearTimeout(this.repaintTimer)
    this.disposeJobsChanged?.()
    this.io.stdout.off?.('resize', this.resizeListener)
    this.screen.stop()
  }

  /**
   * Feed raw input bytes; decode keys and dispatch them.
   * @param chunk - raw input bytes.
   */
  feed(chunk: string): void {
    for (const key of this.decoder.push(chunk)) this.dispatch(key)
    if (this.decoder.hasPending()) this.armEscapeFlush()
  }

  /** Resolve a lone ESC after a grace period, keeping multi-byte sequences intact. */
  private armEscapeFlush(): void {
    if (this.escapeTimer !== undefined) return
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined
      if (!this.decoder.hasPending()) return
      for (const key of this.decoder.flushEscape()) this.dispatch(key)
    }, ESCAPE_FLUSH_MS)
  }

  /** Repaint the current frame immediately. */
  repaint(): void {
    if (this.disposed) return
    this.screen.render(this.frame())
  }

  /**
   * Coalesce an event-driven repaint to at most one per interval, so streaming
   * bursts cost a bounded number of full-frame writes. Idle apps have no timer.
   */
  private scheduleRepaint(): void {
    if (this.disposed) return
    if (this.repaintTimer !== undefined) return
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = undefined
      /* v8 ignore next -- dispose() clears the pending timer, so the callback never runs disposed */
      if (this.disposed) return
      this.screen.render(this.frame())
    }, REPAINT_INTERVAL_MS)
  }

  // ---- session lifecycle ----------------------------------------------------

  private upsertSession(session: Session): void {
    const state = this.ensureState(session.id)
    state.session = session
    state.fold = new TranscriptFold()
    state.usage = { ...ZERO_USAGE }
    state.usageStep = undefined
    state.usageSample = undefined
    for (const event of session.events) {
      state.fold.apply(event)
      const usage = usageOf(event)
      if (usage !== undefined) {
        const folded = foldUsage(state.usage, state.usageStep, state.usageSample, eventStepOf(event), usage)
        state.usage = folded.usage
        state.usageStep = folded.step
        state.usageSample = folded.sample
      }
    }
    state.transcript = state.fold.blocks
    void this.refreshSessions()
    this.repaint()
  }

  private removeSession(session: Session): void {
    this.sessions.delete(session.id)
    if (this.current === session.id) {
      this.current = this.orderFirst()
      this.refreshRunning()
      this.repaint()
    }
    void this.refreshSessions()
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const state = this.sessions.get(session.id)
    if (state === undefined) return
    state.session = session
    state.fold.apply(event) // O(1): streaming chunks never rescan the log
    state.transcript = state.fold.blocks
    if (event.type === 'turn/start') {
      state.running = true
      state.turnStartedAt = Date.now()
      this.refreshRunning()
    } else if (event.type === 'turn/end') {
      state.running = false
      state.turnStartedAt = undefined
      state.lastTurnEndedAt = Date.now()
      this.refreshRunning()
    }
    const usage = usageOf(event)
    if (usage !== undefined) {
      const folded = foldUsage(state.usage, state.usageStep, state.usageSample, eventStepOf(event), usage)
      state.usage = folded.usage
      state.usageStep = folded.step
      state.usageSample = folded.sample
    }
    if (session.id === this.current) this.scheduleRepaint()
  }

  private refreshRunning(): void {
    const state = this.current === undefined ? undefined : this.sessions.get(this.current)
    this.running = state?.running ?? false
  }

  /** Ensure the given session is tracked; returns its state. */
  private ensureState(id: SessionId): SessionState {
    let state = this.sessions.get(id)
    if (state === undefined) {
      const fold = new TranscriptFold()
      state = {
        session: undefined,
        fold,
        transcript: fold.blocks,
        running: false,
        resumedOpenTurn: false,
        usage: { ...ZERO_USAGE },
        usageStep: undefined,
        usageSample: undefined,
        turnStartedAt: undefined,
        lastTurnEndedAt: undefined,
      }
      this.sessions.set(id, state)
    }
    return state
  }

  private ensureCurrent(id: SessionId): void {
    if (this.current === id) return
    this.current = id
    this.scroll = 0
    this.refreshRunning()
    this.refreshModel()
    this.refreshPlan()
    this.refreshGoal()
    this.refreshJobs()
    this.refreshPermission()
    void this.refreshSubagents()
  }

  /** The first tracked session id, or undefined. */
  private orderFirst(): SessionId | undefined {
    return this.sessions.keys().next().value
  }

  /** List live + persisted sessions and track them; only `--resume` selects one. */
  async refreshSessions(): Promise<void> {
    const live = this.ctx.sessions.list().map((session) => {
      const state = this.sessions.get(session.id)
      return summarizeLive(session, state?.running ?? false)
    })
    const persistence = this.ctx.get('sessionPersistence')
    const cold = persistence === undefined ? [] : await persistence.list()
    const merged = mergeSummaries(live, cold)
    for (const row of merged) {
      const state = this.ensureState(row.id)
      if (state.session === undefined) {
        const live = this.ctx.sessions.get(row.id)
        if (live !== undefined) {
          state.session = live
          state.fold = new TranscriptFold()
          for (const event of live.events) state.fold.apply(event)
          state.transcript = state.fold.blocks
        } else if (persistence !== undefined && !this.coldTitles.has(row.id)) {
          // Cold sessions: load the log once and fold its title, so the
          // sidebar lists names, not bare ids. Unreadable logs keep the id.
          this.coldTitles.set(row.id, shortId(row.id))
          void persistence.load(row.id).then(
            (loaded) => {
              this.coldTitles.set(row.id, foldTitle(loaded.events) ?? shortId(row.id))
              this.repaint()
            },
            (_unreadable: unknown) => {
              // The provisional shortId stays for logs that no longer load.
            },
          )
        }
      }
    }
    // The app starts empty: only an explicit `--resume` opens a session.
    if (this.current === undefined && this.startup.resume !== undefined) {
      this.ensureCurrent(this.startup.resume)
    }
    this.repaint()
  }

  // ---- agent creation -------------------------------------------------------

  /**
   * Ensure an agent exists for the current session (create or resume).
   * @returns the live agent, or `undefined` when no session is current or creation failed.
   */
  async currentAgent(): Promise<Agent | undefined> {
    if (this.current === undefined) return undefined
    const state = this.ensureState(this.current)
    if (state.agent !== undefined) {
      this.syncAgentRunning(state)
      return state.agent
    }
    const live = this.ctx.agents.get(this.current)
    if (live !== undefined) {
      state.agent = live
      this.syncAgentRunning(state)
      return live
    }
    const persistence = this.ctx.get('sessionPersistence')
    const headers = persistence === undefined ? [] : await persistence.list()
    const stored = headers.find(header => header.id === this.current)
    try {
      if (stored !== undefined) {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: this.current,
          agentOptions: this.agentOptions(),
          setup: (agentCtx) => { this.installSelection(agentCtx) },
        })
        state.agent = handle.agent
        // A resumed agent is constructed idle and emits no `agent/status`
        // transition, so the running flag would otherwise stick to the
        // interrupted turn's `turn/start`. Sync from the live agent directly.
        this.attachResumedSession(state, handle.agent.session)
        this.syncAgentRunning(state)
        state.resumedOpenTurn = hasOpenTurn(state.session)
        if (state.resumedOpenTurn) {
          this.pushNotice(t('status.resumedOpenTurn'))
        }
        // A heavy resumed session repeats a large prompt on every request,
        // missing provider caches; offer compaction before the user continues.
        this.offerCompactionIfHeavy(state)
        return handle.agent
      }
      const handle = await this.ctx.agents.create({
        sessionId: this.current,
        agentOptions: this.agentOptions(),
        meta: { cwd: process.cwd() },
        setup: (agentCtx) => { this.installSelection(agentCtx) },
      })
      state.agent = handle.agent
      this.syncAgentRunning(state)
      return handle.agent
    } catch (error) {
      this.ctx.logger.warn(`dsh-tui: could not open session ${String(this.current)}: ${String(error)}`)
      return undefined
    }
  }

  /** Mirror the live agent's `status` into the session state's running flag. */
  private syncAgentRunning(state: SessionState): void {
    const agent = state.agent
    state.running = agent?.status === 'running'
    state.turnStartedAt = agent?.status === 'running' ? (state.turnStartedAt ?? Date.now()) : undefined
    this.refreshRunning()
    this.repaint()
  }

  /**
   * Attach a resumed agent's session to the tracked state and fold its full
   * history (transcript and token usage). A resume reuses a persisted session
   * that may predate this app instance, so no `session/created` event fires
   * for it here — the state must fold the log directly.
   * @param state - the session's live state.
   * @param session - the resumed agent's session.
   */
  private attachResumedSession(state: SessionState, session: Session): void {
    if (state.session === session) return
    state.session = session
    state.fold = new TranscriptFold()
    state.usage = { ...ZERO_USAGE }
    state.usageStep = undefined
    state.usageSample = undefined
    for (const event of session.events) {
      state.fold.apply(event)
      const usage = usageOf(event)
      if (usage !== undefined) {
        const folded = foldUsage(state.usage, state.usageStep, state.usageSample, eventStepOf(event), usage)
        state.usage = folded.usage
        state.usageStep = folded.step
        state.usageSample = folded.sample
      }
    }
    state.transcript = state.fold.blocks
    this.repaint()
  }

  /**
   * When a resumed session's prompt-side usage reaches the heavy threshold,
   * ask the user whether to compact it before continuing. A confirm popup
   * defers to the ordinary key dispatch: `y` runs `/compact` through the
   * command registry, `n`/`Esc` dismisses and the session continues as-is.
   * @param state - the resumed session's live state.
   */
  private offerCompactionIfHeavy(state: SessionState): void {
    const weight = sessionWeight(state.usage)
    if (weight < HEAVY_SESSION_TOKENS) return
    this.popup = {
      kind: 'confirm',
      prompt: t('compact.offerHeavy', {
        tokens: compactTokens(weight),
      }),
      resolve: (yes) => {
        this.popup = undefined
        if (yes === true) void this.compactCurrent()
        this.repaint()
      },
    }
    this.repaint()
  }

  /** Run `/compact` on the current session through the command registry. */
  private async compactCurrent(): Promise<void> {
    const agent = await this.currentAgent()
    const commands = this.ctx.get('commands')
    if (agent === undefined || commands === undefined) {
      this.pushNotice(t('compact.unavailable'))
      return
    }
    const controller = new AbortController()
    try {
      const execution = await commands.execute(agent, '/compact', controller.signal)
      if (execution === undefined) {
        this.pushNotice(t('compact.unavailable'))
        return
      }
      const outcome = execution.result
      this.pushNotice(outcome.kind === 'success'
        ? t('compact.done', { text: outcome.text ?? '' })
        : t('compact.failed', { text: outcome.text }))
    } catch (error: unknown) {
      this.pushNotice(t('compact.failed', { text: String(error) }))
    }
  }

  /** The current default model selection. */
  private agentOptions(): { provider?: string; model?: string } {
    const selection = this.ctx.agentDefaultModel.currentSelection()
    return { provider: selection.provider, model: selection.model }
  }

  /** Install a live per-session model selection ref in the agent's scope. */
  private installSelection(agentCtx: Context): void {
    const agent = agentCtx.agent
    if (agent === undefined) return
    const ref: ModelSelectionRef = { current: undefined, assembled: undefined }
    installModelSelection(agentCtx, ref)
    this.selections.set(agent, ref)
  }

  // ---- interaction: approvals and questions ----------------------------------

  /** Answer `approval/request` waterfall requests through a popup. */
  private installApprovalAnswerer(): void {
    this.ctx.on('approval/request', (request, _next) => {
      return new Promise<'allowed-once' | 'rejected' | 'cancelled'>((resolve) => {
        if (request.signal?.aborted === true) {
          resolve('cancelled')
          return
        }
        this.popup = {
          kind: 'approval',
          request,
          resolve: (outcome) => {
            this.popup = undefined
            resolve(outcome)
            this.repaint()
          },
        }
        this.repaint()
      })
    })
  }

  /** Answer user questions through a popup. */
  private installQuestionProvider(): void {
    const userQuestions = this.ctx.get('userQuestions')
    if (userQuestions === undefined) return
    userQuestions.registerProvider({
      ask: request => new Promise((resolve) => {
        if (request.signal?.aborted === true) {
          resolve({ answers: [] })
          return
        }
        this.popup = {
          kind: 'question',
          questions: request.questions,
          cursor: 0,
          resolve: (answers) => {
            this.popup = undefined
            resolve({ answers })
            this.repaint()
          },
        }
        this.repaint()
      }),
    })
  }

  // ---- commands, models, plan, goals, jobs, subagents, settings, skills -----

  /**
   * Set the current notice: one plain-text line at the bottom of the active
   * view, replaced by the next notice. Presentation-only: nothing here
   * reaches the session log or the model.
   * @param text - the notice text.
   */
  private pushNotice(text: string): void {
    this.notice = text
    this.scheduleRepaint()
  }

  /**
   * Execute one slash-command line, or send it as a user message with its
   * `@`-references resolved: skill references attach the canonical skill
   * body, file references attach the file content, both as injected
   * `<system-reminder>` context on the same user message.
   * @param line - the composer line to dispatch.
   */
  async send(line: string): Promise<void> {
    // The first message starts a new session (mainstream single-pane model).
    if (this.current === undefined) await this.newSessionWithAgent()
    const agent = await this.currentAgent()
    if (agent === undefined) return
    if (line.startsWith('/')) {
      const commands = this.ctx.get('commands')
      if (commands === undefined) return
      const controller = new AbortController()
      try {
        const execution = await commands.execute(agent, line, controller.signal)
        if (execution === undefined) this.pushNotice(t('command.unknown', { line }))
      } catch (error: unknown) {
        this.pushNotice(t('command.failed', { error: String(error) }))
      }
      return
    }
    const { context } = await this.resolveMentions(line)
    const content: { type: 'text'; text: string }[] = [{ type: 'text', text: line }]
    if (context !== undefined) content.push({ type: 'text', text: context })
    agent.followup(createUserMessage({
      content,
      source: { kind: 'user' },
    }))
  }

  /**
   * Resolve the `@`-references of one outgoing line: a token naming a known
   * user-invocable skill attaches that skill's rendered body, anything else
   * attaches the referenced file's content (workspace-relative, bounded).
   * Failures become notices and leave the reference text in place.
   * @param line - the outgoing line.
   * @returns the injected context block, or `undefined` when nothing resolved.
   */
  private async resolveMentions(line: string): Promise<{ context: string | undefined }> {
    const tokens = parseMentionTokens(line)
    if (tokens.length === 0) return { context: undefined }
    const skills = this.ctx.get('skills')
    const listed = skills === undefined ? [] : await skills.list({ cwd: process.cwd() })
    const sections: string[] = []
    let totalBytes = 0
    for (const token of tokens) {
      if (sections.length >= MAX_MENTION_FILES) {
        this.pushNotice(t('mention.tooMany', { max: String(MAX_MENTION_FILES) }))
        break
      }
      const summary = listed.find(skill => skill.name === token.value && skill.invocation.userInvocable)
      if (summary !== undefined && skills !== undefined) {
        try {
          const skill = await skills.get(summary.name, { cwd: process.cwd() })
          if (skill === undefined) {
            this.pushNotice(t('skill.loadFailed', { name: summary.name, error: 'not found' }))
            continue
          }
          sections.push(renderSkillContent(skill))
        } catch (error: unknown) {
          this.pushNotice(t('skill.loadFailed', { name: summary.name, error: String(error) }))
        }
        continue
      }
      try {
        const content = await this.readMentionFile(token.value)
        const bytes = Buffer.byteLength(content, 'utf8')
        if (bytes > MAX_MENTION_FILE_BYTES) {
          this.pushNotice(t('mention.fileTooLarge', { path: token.value }))
          continue
        }
        if (totalBytes + bytes > MAX_MENTION_TOTAL_BYTES) {
          this.pushNotice(t('mention.tooMuch', { path: token.value }))
          continue
        }
        totalBytes += bytes
        sections.push(fileReferenceBlock(token.value, content))
      } catch (_unreadableFile: unknown) {
        this.pushNotice(t('mention.fileNotFound', { path: token.value }))
      }
    }
    return { context: sections.length === 0 ? undefined : referenceContextBlock(sections) }
  }

  /** Cancel the current session's running turn. */
  cancel(): void {
    /* v8 ignore next -- a running turn implies a current session: refreshRunning clears the flag whenever the current session changes */
    const agent = this.current === undefined ? undefined : this.ctx.agents.get(this.current)
    agent?.cancel({ kind: 'user' })
  }

  /** Toggle the full details of the most recent tool card (Ctrl+O). */
  toggleLastTool(): void {
    const state = this.current === undefined ? undefined : this.sessions.get(this.current)
    const transcript = state?.transcript ?? []
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const block = transcript[index]
      if (block?.kind === 'tool') {
        if (this.expandedTools.has(block.callId)) this.expandedTools.delete(block.callId)
        else this.expandedTools.add(block.callId)
        break
      }
    }
    this.repaint()
  }

  /**
   * Handle one mouse event over the conversation frame: the wheel scrolls,
   * press anchors a selection, drag extends it, and release copies the span
   * to the system clipboard (OSC 52) — Claude Code's selection model.
   * @param key - the decoded mouse key.
   */
  private handleMouseKey(key: Extract<TuiKey, { kind: 'wheelup' | 'wheeldown' | 'mouse' }>): void {
    if (this.view !== 'conversation') return
    if (key.kind === 'wheelup') {
      this.scroll += 3
      return
    }
    if (key.kind === 'wheeldown') {
      this.scroll = Math.max(0, this.scroll - 3)
      return
    }
    if (key.action === 'press') {
      this.selection = { start: { row: key.y, col: key.x }, end: { row: key.y, col: key.x } }
      return
    }
    if (key.action === 'drag' && this.selection !== undefined) {
      this.selection = { start: this.selection.start, end: { row: key.y, col: key.x } }
      return
    }
    if (key.action === 'release' && this.selection !== undefined) this.copySelection()
  }

  /** The normalized selection bounds in 1-based screen coordinates, or nothing. */
  private selectionRange(): { rowStart: number; rowEnd: number; colStart: number; colEnd: number } | undefined {
    const selection = this.selection
    if (selection === undefined) return undefined
    return {
      rowStart: Math.min(selection.start.row, selection.end.row),
      rowEnd: Math.max(selection.start.row, selection.end.row),
      colStart: Math.min(selection.start.col, selection.end.col),
      colEnd: Math.max(selection.start.col, selection.end.col),
    }
  }

  /**
   * Copy the drawn span from the last painted frame into the system
   * clipboard via the OSC 52 escape every modern terminal honors.
   */
  private copySelection(): void {
    const selection = this.selectionRange()
    /* v8 ignore next -- copySelection runs only while a selection is pending */
    if (selection === undefined) return
    const lines: string[] = []
    for (let rowNo = selection.rowStart; rowNo <= selection.rowEnd; rowNo += 1) {
      const row = this.lastRows[rowNo - 1]
      if (row === undefined) break
      /* v8 ignore start -- the selection highlight pass converts every selected row to cells before the copy reads it back */
      const cells = typeof row === 'string'
        ? Array.from(row).map(char => ({ char }))
        : row
      /* v8 ignore stop */
      const from = rowNo === selection.rowStart ? selection.colStart - 1 : 0
      const to = rowNo === selection.rowEnd ? selection.colEnd - 1 : cells.length - 1
      lines.push(cells.slice(Math.max(0, from), Math.min(cells.length, to + 1)).map(cell => cell.char).join(''))
    }
    const text = lines.join('\n')
    if (text === '') return
    this.io.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`)
    // Visible feedback: the copy landed (or the terminal honors OSC 52).
    this.pushNotice(t('transcript.copied', { chars: String(text.length) }))
  }

  /**
   * Paint the selection highlight over one frame row: the selected cells
   * render in reverse video.
   * @param row - the frame row to highlight.
   * @param rowNo - the row's 1-based screen position.
   * @param selection - the normalized selection bounds.
   * @returns the highlighted row.
   */
  private highlightRow(
    row: FrameRow,
    rowNo: number,
    selection: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
  ): FrameRow {
    const cells: Cell[] = typeof row === 'string'
      ? Array.from(row).map(char => ({ char }))
      : row.map(cell => ({ ...cell }))
    cells.forEach((cell, index) => {
      const col = index + 1
      const selected = rowNo === selection.rowStart && rowNo === selection.rowEnd
        ? col >= selection.colStart && col <= selection.colEnd
        : rowNo === selection.rowStart
          ? col >= selection.colStart
          : rowNo === selection.rowEnd
            ? col <= selection.colEnd
            : true
      if (selected) cell.style = 'reverse'
    })
    return cells
  }

  /** Create a new blank session and switch to it. */
  newSession(): void {
    const session = this.ctx.sessions.create()
    this.upsertSession(session)
    this.ensureCurrent(session.id)
    void this.refreshSessions()
    this.repaint()
  }

  /** Create a new blank session and eagerly attach its agent. */
  async newSessionWithAgent(): Promise<void> {
    // Mint the id ourselves: agents.create() prepares the session through the
    // agent-loop factory, so a pre-created store session would collide.
    const id = brandSessionId(`session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    this.ensureState(id)
    this.current = id
    this.scroll = 0
    this.refreshRunning()
    await this.currentAgent()
    void this.refreshSessions()
    this.repaint()
  }

  /** Open an existing session from the sessions view (resume or attach). */
  private async selectSession(id: SessionId): Promise<void> {
    this.ensureState(id)
    this.ensureCurrent(id)
    await this.currentAgent()
    void this.refreshSessions()
    this.repaint()
  }

  /**
   * Rename the current session through the title service.
   * @param title - the new session title.
   */
  rename(title: string): void {
    if (this.current === undefined || title.trim() === '') return
    const agent = this.ctx.agents.get(this.current)
    if (agent !== undefined) {
      this.ctx.get('sessionTitle')?.rename(agent.session, title.trim())
    }
    void this.refreshSessions()
  }

  /** Refresh the header model label (route plus reasoning effort when set). */
  refreshModel(): void {
    const agent = this.current === undefined ? undefined : this.ctx.agents.get(this.current)
    if (agent !== undefined) {
      const selection = this.selections.get(agent)?.current ?? agent.session.requestHeader()?.config
      this.model = selection === undefined ? undefined : modelLabel(selection)
    } else {
      const selection = this.ctx.agentDefaultModel.currentSelection()
      this.model = modelLabel(selection)
    }
    this.repaint()
  }

  /** Refresh the plan-mode indicator. */
  refreshPlan(): void {
    const planMode = this.ctx.get('planMode')
    // ensureCurrent is the sole caller and sets current before invoking this.
    /* v8 ignore next -- current is always defined when refreshPlan runs */
    const agent = this.current === undefined ? undefined : this.ctx.agents.get(this.current)
    this.plan = agent === undefined || planMode === undefined ? false : planMode.get(agent).active
    this.repaint()
  }

  /** Refresh the permission-preset label for the current session. */
  refreshPermission(): void {
    const presets = this.ctx.get('permissionPresets')
    const state = this.current === undefined ? undefined : this.sessions.get(this.current)
    const session = state?.session
    this.permission = presets === undefined || session === undefined
      ? presets?.defaultPreset
      : presets.current(session.events)
    this.repaint()
  }

  /** Approval "always allow": switch to the danger preset, then allow. */
  private allowAlways(): void {
    const presets = this.ctx.get('permissionPresets')
    const state = this.current === undefined ? undefined : this.sessions.get(this.current)
    const session = state?.session
    if (presets === undefined || session === undefined) return
    const danger = presets.names.find(name => name === 'danger-full-access')
    if (danger !== undefined && presets.current(session.events) !== danger) presets.set(session, danger)
    this.refreshPermission()
  }

  /** Refresh the goal label. */
  refreshGoal(): void {
    const agent = this.current === undefined ? undefined : this.ctx.agents.get(this.current)
    const goals = this.ctx.get('goals')
    this.goal = agent === undefined || goals === undefined ? undefined : goals.get(agent)
    this.repaint()
  }

  /** Refresh the jobs list for the current session. */
  refreshJobs(): void {
    const jobs = this.ctx.get('jobs')
    const agent = this.current === undefined ? undefined : this.ctx.agents.get(this.current)
    this.jobs = jobs === undefined ? [] : jobs.list(agent)
    this.jobCursor = Math.min(this.jobCursor, Math.max(0, this.jobs.length - 1))
    this.repaint()
  }

  /** Refresh the subagent list for the current session. */
  async refreshSubagents(): Promise<void> {
    const subagents = this.ctx.get('subagents')
    const id = this.current
    this.subagents = subagents === undefined || id === undefined ? [] : await subagents.listChildren(id)
    this.subagentCursor = Math.min(this.subagentCursor, Math.max(0, this.subagents.length - 1))
    this.repaint()
  }

  /** Refresh the settings pane: the document path the user edits themselves. */
  refreshSettings(): void {
    const settings = this.ctx.get('settings')
    this.settingsPath = settings?.documentPath
    this.repaint()
  }

  /** Refresh the skills list for the current workspace. */
  async refreshSkills(): Promise<void> {
    const skills = this.ctx.get('skills')
    this.skills = skills === undefined ? [] : await skills.list({ cwd: process.cwd() })
    this.skillCursor = Math.min(this.skillCursor, Math.max(0, this.skills.length - 1))
    this.repaint()
  }

  /** Refresh the model catalog for the picker. */
  async refreshModelCatalog(): Promise<void> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) {
      this.modelGroups = []
      return
    }
    const providers = llm.listProviders()
    const modelsByProvider = new Map<string, { id: string; name: string }[]>()
    for (const provider of providers) {
      modelsByProvider.set(provider.id, await llm.listModels(provider.id))
    }
    this.modelGroups = buildModelGroups(providers, modelsByProvider)
  }

  // ---- key dispatch ---------------------------------------------------------

  /**
   * Dispatch one decoded key against the active popup or view.
   * @param key - the decoded key.
   */
  dispatch(key: TuiKey): void {
    if (key.kind === 'wheelup' || key.kind === 'wheeldown' || key.kind === 'mouse') {
      this.handleMouseKey(key)
      this.repaint()
      return
    }
    // Any other key ends a pending selection highlight and a pending quit arm.
    this.selection = undefined
    if (!(key.kind === 'ctrl' && key.name === 'c')) this.disarmExit()
    if (this.popup !== undefined) {
      this.dispatchPopup(key)
      return
    }
    if (this.view === 'conversation') {
      this.dispatchComposer(key)
      return
    }
    if (this.view === 'sessions') {
      this.dispatchSessions(key)
      return
    }
    if (this.view === 'jobs') {
      this.dispatchJobs(key)
      return
    }
    if (this.view === 'subagents') {
      this.dispatchSubagents(key)
      return
    }
    if (this.view === 'settings') {
      this.dispatchSettings(key)
      return
    }
    if (this.view === 'skills') {
      this.dispatchSkills(key)
      return
    }
    if (this.view === 'goals') {
      this.dispatchGoals(key)
      return
    }
    this.dispatchView(key)
  }

  /** Cursor keys and Enter inside the sessions view; other keys fall through. */
  private dispatchSessions(key: TuiKey): void {
    const sessions = this.sessionsSnapshot()
    if (key.kind === 'up') {
      this.sessionCursor = Math.max(0, this.sessionCursor - 1)
      this.sessionScroll = this.followCursor(this.sessionCursor, this.sessionScroll, this.listWindow())
    } else if (key.kind === 'down') {
      this.sessionCursor = Math.min(Math.max(0, sessions.length - 1), this.sessionCursor + 1)
      this.sessionScroll = this.followCursor(this.sessionCursor, this.sessionScroll, this.listWindow())
    } else if (key.kind === 'enter') {
      const session = sessions[this.sessionCursor]
      if (session !== undefined) {
        this.view = 'conversation'
        this.sessionCursor = 0
        this.sessionFilter = ''
        void this.selectSession(session.id)
      }
    } else if (key.kind === 'escape') {
      if (this.sessionFilter !== '') {
        this.sessionFilter = ''
        this.sessionCursor = 0
      } else {
        this.view = 'conversation'
      }
    } else if (key.kind === 'backspace') {
      if (this.sessionFilter !== '') {
        this.sessionFilter = this.sessionFilter.slice(0, -1)
        this.sessionCursor = 0
      }
    } else if (key.kind === 'char' && !/^[1-8/]$/.test(key.char)) {
      this.sessionFilter += key.char
      this.sessionCursor = 0
    } else {
      this.dispatchView(key)
      return
    }
    this.repaint()
  }

  /** Jobs view: cursor navigation, detail toggle, kill, and fall-through keys. */
  private dispatchJobs(key: TuiKey): void {
    if (key.kind === 'up') {
      this.jobCursor = Math.max(0, this.jobCursor - 1)
      this.jobScroll = this.followCursor(this.jobCursor, this.jobScroll, this.listWindow())
    } else if (key.kind === 'down') {
      this.jobCursor = Math.min(Math.max(0, this.jobs.length - 1), this.jobCursor + 1)
      this.jobScroll = this.followCursor(this.jobCursor, this.jobScroll, this.listWindow())
    } else if (key.kind === 'enter') {
      const job = this.jobs[this.jobCursor]
      if (job !== undefined) this.openJobActions(job)
    } else if (key.kind === 'escape') {
      this.view = 'conversation'
    } else {
      this.dispatchView(key)
      return
    }
    this.repaint()
  }

  /** Enter on a job opens its action picker; destructive actions confirm. */
  private openJobActions(job: JobSnapshot): void {
    const actions: ('details' | 'kill')[] = ['details', 'kill']
    this.popup = {
      kind: 'list',
      title: `${job.id} · ${job.label}`,
      items: actions,
      label: item => t(`jobs.action.${item as 'details' | 'kill'}`),
      cursor: 0,
      filter: '',
      height: actions.length,
      onSelect: (item) => {
        this.popup = undefined
        this.selectJobAction(job, item as 'details' | 'kill')
      },
    }
    this.repaint()
  }

  /** Apply one job action; the kill confirms before terminating. */
  private selectJobAction(job: JobSnapshot, action: 'details' | 'kill'): void {
    if (action === 'details') {
      if (this.expandedJobs.has(job.id)) this.expandedJobs.delete(job.id)
      else this.expandedJobs.add(job.id)
      this.repaint()
      return
    }
    void this.confirm(t('jobs.confirmKill', { id: job.id })).then((yes) => {
      if (yes !== true) return
      const jobs = this.ctx.get('jobs')
      const agent = this.current === undefined ? undefined : this.ctx.agents.get(this.current)
      const result = jobs?.kill(job.id, agent, 'tui')
      this.pushNotice(t('jobs.killed', { id: job.id, result: result ?? 'unavailable' }))
      this.refreshJobs()
    })
  }

  /** Subagents view: cursor navigation and opening a child's session. */
  private dispatchSubagents(key: TuiKey): void {
    if (key.kind === 'up') {
      this.subagentCursor = Math.max(0, this.subagentCursor - 1)
      this.subagentScroll = this.followCursor(this.subagentCursor, this.subagentScroll, this.listWindow())
    } else if (key.kind === 'down') {
      this.subagentCursor = Math.min(Math.max(0, this.subagents.length - 1), this.subagentCursor + 1)
      this.subagentScroll = this.followCursor(this.subagentCursor, this.subagentScroll, this.listWindow())
    } else if (key.kind === 'enter') {
      const entry = this.subagents[this.subagentCursor]
      if (entry?.kind === 'child') {
        this.view = 'conversation'
        void this.selectSession(entry.id)
        this.repaint()
        return
      }
    } else if (key.kind === 'escape') {
      this.view = 'conversation'
    } else {
      this.dispatchView(key)
      return
    }
    this.repaint()
  }

  /**
   * Settings view: a read-only pointer at the settings document the user
   * edits themselves — no namespace list, no drill-down, no write path.
   * Ctrl+E (any view) opens the document in the user's editor.
   */
  private dispatchSettings(key: TuiKey): void {
    if (key.kind === 'escape') {
      this.view = 'conversation'
      this.repaint()
      return
    }
    this.dispatchView(key)
  }

  /** Open the settings document in the user's editor (Ctrl+E, any view). */
  private openSettingsDocument(): void {
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      this.pushNotice(t('settings.editorUnavailable'))
      return
    }
    void settings.prepareDocument().then((path) => {
      if (path === undefined) {
        this.pushNotice(t('settings.editorUnavailable'))
        return
      }
      this.launchEditor(editorInvocation(process.env, process.platform, path))
      this.pushNotice(t('settings.editorOpened', { path }))
    }).catch((error: unknown) => {
      this.pushNotice(t('settings.editorFailed', { error: String(error) }))
    })
  }

  /** Skills view: cursor navigation and loading a skill into the conversation. */
  private dispatchSkills(key: TuiKey): void {
    if (key.kind === 'up') {
      this.skillCursor = Math.max(0, this.skillCursor - 1)
      this.skillScroll = this.followCursor(this.skillCursor, this.skillScroll, this.listWindow())
    } else if (key.kind === 'down') {
      this.skillCursor = Math.min(Math.max(0, this.skills.length - 1), this.skillCursor + 1)
      this.skillScroll = this.followCursor(this.skillCursor, this.skillScroll, this.listWindow())
    } else if (key.kind === 'enter') {
      const skill = this.skills[this.skillCursor]
      const skills = this.ctx.get('skills')
      if (skill !== undefined && skills !== undefined) void this.invokeSkill(skills, skill)
      return
    } else if (key.kind === 'escape') {
      this.view = 'conversation'
    } else {
      this.dispatchView(key)
      return
    }
    this.repaint()
  }

  /** Goals view: Enter opens the action picker; destructive actions confirm. */
  private dispatchGoals(key: TuiKey): void {
    if (key.kind === 'enter') {
      this.openGoalActions()
    } else if (key.kind === 'escape') {
      this.view = 'conversation'
    } else {
      this.dispatchView(key)
      return
    }
    this.repaint()
  }

  /** Enter on the goal opens its action picker (resume/pause/complete/clear). */
  private openGoalActions(): void {
    const view = this.goal
    if (view === undefined) return
    const actions: ('resume' | 'pause' | 'complete' | 'clear')[] = ['resume', 'pause', 'complete', 'clear']
    this.popup = {
      kind: 'list',
      title: `${view.phase}: ${view.objective}`,
      items: actions,
      label: item => t(`goal.action.${item as 'resume' | 'pause' | 'complete' | 'clear'}`),
      cursor: 0,
      filter: '',
      height: actions.length,
      onSelect: (item) => {
        this.popup = undefined
        this.selectGoalAction(item as 'resume' | 'pause' | 'complete' | 'clear')
      },
    }
    this.repaint()
  }

  /** Apply one goal action; complete and clear confirm first. */
  private selectGoalAction(action: 'resume' | 'pause' | 'complete' | 'clear'): void {
    if (action === 'resume') {
      this.resumeGoal()
      return
    }
    if (action === 'pause') {
      this.pauseGoal()
      return
    }
    if (action === 'complete') {
      void this.completeGoal()
      return
    }
    void this.clearGoal()
  }

  /**
   * The goal action target: the goals service, the current agent, and the
   * goal view together.
   * @returns the triple, or `undefined` when any piece is missing.
   */
  private goalActionTarget(): { goals: GoalService; agent: Agent; view: GoalView } | undefined {
    const goals = this.ctx.get('goals')
    const view = this.goal
    /* v8 ignore start -- only invoked from the action picker, which requires a live goal */
    const agent = this.current === undefined ? undefined : this.ctx.agents.get(this.current)
    if (goals === undefined || agent === undefined || view === undefined) return undefined
    /* v8 ignore stop */
    return { goals, agent, view }
  }

  /** Pause the active goal. */
  private pauseGoal(): void {
    const target = this.goalActionTarget()
    /* v8 ignore next -- the action picker requires a live goal, so the target resolves */
    if (target === undefined) return
    try {
      target.goals.pause(target.agent, target.view)
      this.pushNotice(t('goal.paused'))
    } catch (error: unknown) {
      this.pushNotice(t('goal.actionFailed', { error: String(error) }))
    }
    this.refreshGoal()
  }

  /** Complete the goal after confirmation. */
  private async completeGoal(): Promise<void> {
    const target = this.goalActionTarget()
    /* v8 ignore next -- the action picker requires a live goal, so the target resolves */
    if (target === undefined) return
    if (target.view.phase === 'complete') {
      this.pushNotice(t('goal.actionFailed', { error: 'goal is already complete' }))
      return
    }
    const yes = await this.confirm(t('confirm.completeGoal', { objective: target.view.objective }))
    if (yes !== true) return
    try {
      target.goals.complete(target.agent, target.view)
      this.pushNotice(t('goal.completed'))
    } catch (error: unknown) {
      this.pushNotice(t('goal.actionFailed', { error: String(error) }))
    }
    this.refreshGoal()
  }

  /** Clear the goal after confirmation. */
  private async clearGoal(): Promise<void> {
    const target = this.goalActionTarget()
    /* v8 ignore next -- the action picker requires a live goal, so the target resolves */
    if (target === undefined) return
    const yes = await this.confirm(t('confirm.clearGoal', { objective: target.view.objective }))
    if (yes !== true) return
    try {
      target.goals.clear(target.agent, target.view)
      this.pushNotice(t('goal.cleared'))
    } catch (error: unknown) {
      this.pushNotice(t('goal.actionFailed', { error: String(error) }))
    }
    this.refreshGoal()
  }

  /**
   * Ask a yes/no question through the modal popup.
   * @param prompt - the question to confirm.
   * @returns `true`/`false` from the user, or `undefined` when dismissed.
   */
  private confirm(prompt: string): Promise<boolean | undefined> {
    return new Promise((resolve) => {
      this.popup = {
        kind: 'confirm',
        prompt,
        resolve: (yes) => {
          this.popup = undefined
          resolve(yes)
          this.repaint()
        },
      }
      this.repaint()
    })
  }

  /**
   * Load one user-invocable skill and submit its instructions as a user turn,
   * exactly like a typed skill block; failures become a notice.
   * @param skills - the registry that owns the skill body.
   * @param summary - the skill to load.
   */
  private async invokeSkill(
    skills: { get(name: string, options: { cwd: string | undefined }): Promise<SkillDefinition | undefined> },
    summary: SkillSummary,
  ): Promise<void> {
    if (!summary.invocation.userInvocable) {
      this.pushNotice(t('skill.notUserInvocable', { name: summary.name }))
      return
    }
    try {
      const skill = await skills.get(summary.name, { cwd: process.cwd() })
      if (skill === undefined) {
        this.pushNotice(t('skill.loadFailed', { name: summary.name, error: 'not found' }))
        return
      }
      const text = `<skill name="${skill.name}">\n${skill.content}\n</skill>`
      this.view = 'conversation'
      void this.send(text)
      this.pushNotice(t('skill.invoked', { name: skill.name }))
    } catch (error: unknown) {
      this.pushNotice(t('skill.loadFailed', { name: summary.name, error: String(error) }))
    }
  }

  /**
   * Resume the current goal when it is paused or blocked; active and complete
   * goals report their phase instead.
   */
  private resumeGoal(): void {
    const target = this.goalActionTarget()
    /* v8 ignore next -- the action picker requires a live goal, so the target resolves */
    if (target === undefined) return
    if (target.view.phase === 'active' || target.view.phase === 'complete') {
      this.pushNotice(t('goal.resumeFailed', { error: `goal is ${target.view.phase}` }))
      return
    }
    try {
      target.goals.resume(target.agent, target.view)
      this.pushNotice(t('goal.resumed'))
    } catch (error: unknown) {
      this.pushNotice(t('goal.resumeFailed', { error: String(error) }))
    }
    this.refreshGoal()
  }

  private dispatchPopup(key: TuiKey): void {
    const popup = this.popup
    /* v8 ignore next 2 -- dispatch() only routes here while this.popup is set */
    if (popup === undefined) return
    if (popup.kind === 'approval') {
      if (key.kind === 'char' && (key.char === 'y' || key.char === 'Y')) popup.resolve('allowed-once')
      else if (key.kind === 'char' && (key.char === 'n' || key.char === 'N')) popup.resolve('rejected')
      else if (key.kind === 'char' && (key.char === 'a' || key.char === 'A')) {
        // Always allow: switch the session to the danger preset, then allow.
        this.allowAlways()
        popup.resolve('allowed-once')
      } else if (key.kind === 'escape') popup.resolve('cancelled')
      return
    }
    if (popup.kind === 'confirm') {
      if (key.kind === 'char' && (key.char === 'y' || key.char === 'Y')) popup.resolve(true)
      else if (key.kind === 'char' && (key.char === 'n' || key.char === 'N')) popup.resolve(false)
      else if (key.kind === 'escape') popup.resolve(undefined)
      return
    }
    if (popup.kind === 'question') {
      const question = popup.questions[0]
      const options = question?.options ?? []
      const optionCursor = Math.min(popup.cursor, Math.max(0, options.length - 1))
      if (key.kind === 'up') popup.cursor = Math.max(0, popup.cursor - 1)
      else if (key.kind === 'down') popup.cursor = Math.min(Math.max(0, options.length - 1), popup.cursor + 1)
      else if (key.kind === 'enter' && question !== undefined) {
        const option = options[optionCursor]
        popup.resolve(popup.questions.map(item => ({
          id: item.id,
          selected: item.id === question.id && option !== undefined ? [option.label] : [],
        })))
      } else if (key.kind === 'escape') {
        popup.resolve(popup.questions.map(item => ({ id: item.id, selected: [] })))
      }
      this.repaint()
      return
    }
    // List popup: the model picker and the mode picker (the command palette is
    // composer-derived, not a modal popup, and never reaches this branch).
    const visible = popup.items.filter(item => popup.filter === ''
      || popup.label(item).toLowerCase().includes(popup.filter.toLowerCase()))
    if (key.kind === 'up') {
      popup.cursor = Math.max(0, popup.cursor - 1)
      popup.onMove?.(popup.cursor)
    } else if (key.kind === 'down') {
      popup.cursor = Math.min(Math.max(0, visible.length - 1), popup.cursor + 1)
      popup.onMove?.(popup.cursor)
    } else if (key.kind === 'left' || key.kind === 'right') {
      // Cycle the highlighted model's reasoning effort (the model picker's
      // items carry the loaded effort list; other lists ignore the keys).
      const item = visible[popup.cursor] as
        | { efforts?: readonly { id: string; name: string }[]; effortIndex?: number }
        | undefined
      const efforts = item?.efforts
      if (item !== undefined && efforts !== undefined && efforts.length > 1) {
        /* v8 ignore next -- the effort index is always set once efforts load */
        const index = item.effortIndex ?? 0
        item.effortIndex = (index + (key.kind === 'left' ? -1 : 1) + efforts.length) % efforts.length
      }
    } else if (key.kind === 'char') popup.filter += key.char
    else if (key.kind === 'backspace') popup.filter = popup.filter.slice(0, -1)
    else if (key.kind === 'enter' && visible[popup.cursor] !== undefined) {
      const selected = visible[popup.cursor]
      if (popup.onSelect !== undefined) popup.onSelect(selected)
      /* v8 ignore start -- every list popup the app opens wires its own onSelect */
      else void this.selectModelItem(selected as string)
      /* v8 ignore stop */
    } else if (key.kind === 'escape') {
      this.popup = undefined
    }
    this.repaint()
  }

  // ---- composer-centered command palette -------------------------------------

  /**
   * The command word being composed, when the palette should be visible: the
   * draft starts with `/`, holds no whitespace, and the user has not dismissed
   * the palette for this draft.
   * @returns the text after the slash, or `undefined` while the palette is hidden.
   */
  private paletteWord(): string | undefined {
    if (this.paletteDismissed) return undefined
    if (!/^\/[^\s]*$/.test(this.draft)) return undefined
    return this.draft.slice(1)
  }

  /**
   * Every entry the palette offers, ordered by frequency then danger: view
   * jumps and quick actions lead, the host catalog follows, and `/exit`
   * sinks to the bottom (the renderer draws a rule above it when the full
   * list is shown).
   * @returns the ordered palette entries.
   */
  private paletteEntries(): readonly { name: string; description: string; group: 'views' | 'actions' | 'commands' }[] {
    const mapEntry = (entry: { name: string; descriptionKey: string; group: 'views' | 'actions' }): {
      name: string
      description: string
      group: 'views' | 'actions' | 'commands'
    } => ({
      name: entry.name,
      description: t(entry.descriptionKey),
      group: entry.group,
    })
    const local = NAV_COMMANDS.filter(entry => entry.name !== 'exit').map(mapEntry)
    const exit = NAV_COMMANDS.find(entry => entry.name === 'exit')
    // The live host registry is agent-scoped; before a session exists the
    // palette shows the shipped host commands instead, so the list never
    // changes shape between states. `/permission` is hidden — `/mode` is this
    // surface's preset switch. Host commands keep the shipped table's stable
    // order first (frequency), with any extra registry entries appended
    // alphabetically instead of the registry's own sort shuffling the list.
    const agent = this.current === undefined ? undefined : this.ctx.agents.get(this.current)
    const commands = this.ctx.get('commands')
    const knownOrder = new Map(KNOWN_HOST_COMMANDS.map((entry, index) => [entry.name, index] as const))
    const knownKeys = new Map(KNOWN_HOST_COMMANDS.map(entry => [entry.name, entry.descriptionKey] as const))
    const host = (agent === undefined || commands === undefined
      ? KNOWN_HOST_COMMANDS.map(entry => ({ name: entry.name, description: t(entry.descriptionKey) }))
      : commands.list(agent).filter(entry => entry.name !== 'permission'))
      .slice()
      .sort((left, right) => {
        const leftOrder = knownOrder.get(left.name)
        const rightOrder = knownOrder.get(right.name)
        if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder
        if (leftOrder !== undefined) return -1
        if (rightOrder !== undefined) return 1
        return left.name.localeCompare(right.name)
      })
      .map((entry) => {
        // Shipped host commands translate their description with the active
        // copy; unknown extras keep their plugin-owned text.
        const key = knownKeys.get(entry.name)
        return {
          name: entry.name,
          description: key === undefined ? entry.description : t(key),
          group: 'commands' as const,
        }
      })
    /* v8 ignore next -- exit is a shipped NAV_COMMANDS entry, so the lookup always resolves */
    return [...local, ...host, ...(exit === undefined ? [] : [mapEntry(exit)])]
  }

  /** Recompute palette and mention state after any draft mutation. */
  private afterDraftEdit(): void {
    // The palette reopens for a fresh `/` once the draft stops being a
    // command word (e.g. the slash was deleted); continuing to type inside a
    // dismissed command word keeps it dismissed.
    if (!/^\/[^\s]*$/.test(this.draft)) this.paletteDismissed = false
    this.paletteCursor = 0
    // The mention popup reopens once the caret leaves the dismissed `@`-word.
    if (mentionWordAt(this.draft, this.caret) === undefined) this.mentionDismissed = false
    this.mentionCursor = 0
    const word = this.mentionWord()
    if (word !== undefined) {
      this.loadMentionDir(this.mentionDirPart(word.filter))
      if (!this.skillsListed) {
        this.skillsListed = true
        void this.refreshSkills()
      }
    }
  }

  /**
   * The mention word being edited at the caret, when the popup should be
   * visible: a run of non-space characters containing the caret that starts
   * with `@`, not dismissed for this draft.
   * @returns the word bounds and filter, or `undefined` while hidden.
   */
  private mentionWord(): { start: number; end: number; filter: string } | undefined {
    if (this.mentionDismissed) return undefined
    return mentionWordAt(this.draft, this.caret)
  }

  /** The directory part of a mention filter (empty for top-level paths). */
  private mentionDirPart(filter: string): string {
    const slash = filter.lastIndexOf('/')
    return slash === -1 ? '' : filter.slice(0, slash)
  }

  /**
   * Load one directory's file names for the popup, cached per directory.
   * Unreadable directories yield no candidates; the reference still resolves
   * (or reports its failure) at send time.
   * @param dirPart - the workspace-relative directory.
   */
  private loadMentionDir(dirPart: string): void {
    if (this.mentionDirs.has(dirPart) || this.mentionDirLoading === dirPart) return
    this.mentionDirLoading = dirPart
    void this.listMentionDir(dirPart === '' ? '.' : dirPart).then((names) => {
      this.mentionDirs.set(dirPart, names)
      this.mentionDirLoading = undefined
      this.repaint()
    }, (_unreadableDir: unknown) => {
      this.mentionDirs.set(dirPart, [])
      this.mentionDirLoading = undefined
      this.repaint()
    })
  }

  /**
   * The popup's candidates for the current word: user-invocable skills by
   * name first, then files of the filter's directory part by prefix, both
   * relative to the workspace.
   * @param word - the mention word under the caret.
   * @returns the candidates in display order.
   */
  private mentionCandidates(word: { start: number; end: number; filter: string }): MentionCandidate[] {
    const filter = word.filter
    const skills = this.skills
      .filter(skill => skill.invocation.userInvocable && skill.name.startsWith(filter))
      .map(skill => ({ label: mentionLabel(skill.name), detail: skill.description }))
    const dirPart = this.mentionDirPart(filter)
    const base = dirPart === '' ? '' : `${dirPart}/`
    const namePart = dirPart === '' ? filter : filter.slice(dirPart.length + 1)
    const files = (this.mentionDirs.get(dirPart) ?? [])
      .filter(name => name.startsWith(namePart))
      .map(name => ({ label: mentionLabel(`${base}${name}`), detail: '' }))
      .sort((left, right) => left.label.localeCompare(right.label))
    return [...skills, ...files]
  }

  /** Push one submitted line onto the composer history (no consecutive duplicates). */
  private historyPush(line: string): void {
    const trimmed = line.trim()
    if (this.history[0] === trimmed) return
    this.history.unshift(trimmed)
    if (this.history.length > 100) this.history.pop()
    this.historyIndex = -1
  }

  /** Walk one step back through the composer history, parking the draft. */
  private historyBack(): void {
    if (this.history.length === 0) return
    if (this.historyIndex === -1) this.historyDraft = this.draft
    this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1)
    // historyIndex is clamped into the recorded range, so the entry resolves.
    /* v8 ignore next 2 -- the clamp above keeps the index inside the recorded history */
    this.draft = this.history[this.historyIndex] ?? ''
    this.caret = this.draft.length
  }

  /** Walk one step forward through the composer history, restoring the parked draft. */
  private historyForward(): void {
    if (this.historyIndex === -1) return
    this.historyIndex -= 1
    /* v8 ignore next 2 -- a non-negative index resolves within the recorded history */
    this.draft = this.historyIndex === -1 ? this.historyDraft : (this.history[this.historyIndex] ?? '')
    this.caret = this.draft.length
  }

  /**
   * Execute one command line from the palette or composer: TUI-local commands
   * resolve here; everything else runs through the host command registry.
   * @param line - the `/command` line to run.
   */
  private runCommandLine(line: string): void {
    const name = line.slice(1)
    const local = NAV_COMMANDS.find(entry => entry.name === name)
    if (local !== undefined) {
      if (local.action === 'exit') {
        this.requestExit()
        return
      }
      if (local.action === 'new') {
        void this.newSessionWithAgent()
        this.setView('conversation')
        return
      }
      if (local.action === 'model') {
        void this.openModelPicker()
        return
      }
      if (local.action === 'mode') {
        this.openModePicker()
        return
      }
      if (local.action === 'lang') {
        this.openLangPicker()
        return
      }
      const view = local.view
      /* v8 ignore next -- every non-action local command names a view */
      if (view !== undefined) this.setView(view)
      return
    }
    this.view = 'conversation'
    void this.send(line)
  }

  /**
   * Arm or fire the idle Ctrl+C quit: the first press only arms (a notice
   * says so), the second within the window quits — an accidental single
   * Ctrl+C on an empty input never kills the session.
   */
  private armExit(): void {
    if (this.exitArmed) {
      this.disarmExit()
      this.requestExit()
      return
    }
    this.exitArmed = true
    this.pushNotice(t('exit.confirmCtrlC'))
    this.clearExitArmTimer()
    this.exitArmTimer = setTimeout(() => { this.disarmExit() }, EXIT_ARM_MS)
  }

  /** Drop a pending quit arm (any other key or the arm window expiring). */
  private disarmExit(): void {
    this.exitArmed = false
    this.clearExitArmTimer()
  }

  private clearExitArmTimer(): void {
    if (this.exitArmTimer !== undefined) {
      clearTimeout(this.exitArmTimer)
      this.exitArmTimer = undefined
    }
  }

  /**
   * Quit after any running turn reaches idle, so an in-flight model call is
   * cancelled cleanly instead of tearing the tree out from under it.
   */
  private requestExit(): void {
    const sessionId = this.current
    if (this.running) {
      this.cancel()
      /* v8 ignore next -- a running turn implies a current session: refreshRunning clears the flag whenever the current session changes */
      const agent = sessionId === undefined ? undefined : this.ctx.agents.get(sessionId)
      /* v8 ignore next 2 -- a live session that reports turns always has a registered agent */
      if (agent !== undefined) {
        this.pushNotice(t('exit.cancel'))
        void agent.whenIdle().then(() => { this.onQuit(sessionId) })
        return
      }
    }
    this.onQuit(sessionId)
  }

  /**
   * Draft-editing keys: insertion, deletion, caret movement, and line cuts.
   * @param key - the decoded key.
   * @returns whether the key was consumed as an edit.
   */
  private editDraftKey(key: TuiKey): boolean {
    const chars = Array.from(this.draft)
    if (key.kind === 'char') {
      chars.splice(this.caret, 0, key.char)
      this.draft = chars.join('')
      this.caret += 1
      return true
    }
    if (key.kind === 'backspace' && this.caret > 0) {
      chars.splice(this.caret - 1, 1)
      this.draft = chars.join('')
      this.caret -= 1
      return true
    }
    if (key.kind === 'left') {
      this.caret = Math.max(0, this.caret - 1)
      return true
    }
    if (key.kind === 'right') {
      this.caret = Math.min(chars.length, this.caret + 1)
      return true
    }
    if (key.kind === 'home') {
      this.caret = 0
      return true
    }
    if (key.kind === 'end') {
      this.caret = chars.length
      return true
    }
    if (key.kind === 'ctrl' && key.name === 'a') {
      this.caret = 0
      return true
    }
    if (key.kind === 'ctrl' && key.name === 'u') {
      this.draft = this.draft.slice(this.caret)
      this.caret = 0
      return true
    }
    if (key.kind === 'ctrl' && key.name === 'k') {
      this.draft = this.draft.slice(0, this.caret)
      return true
    }
    return false
  }

  private dispatchComposer(key: TuiKey): void {
    const paletteWord = this.paletteWord()
    const mention = this.mentionWord()
    if (this.editDraftKey(key)) {
      this.afterDraftEdit()
    } else if (key.kind === 'up') {
      if (mention !== undefined) this.mentionCursor = Math.max(0, this.mentionCursor - 1)
      else if (paletteWord !== undefined) this.paletteCursor = Math.max(0, this.paletteCursor - 1)
      else this.historyBack()
    } else if (key.kind === 'down') {
      if (mention !== undefined) {
        const candidates = this.mentionCandidates(mention)
        this.mentionCursor = Math.min(Math.max(0, candidates.length - 1), this.mentionCursor + 1)
      } else if (paletteWord !== undefined) {
        const matches = this.paletteEntries().filter(entry => entry.name.startsWith(paletteWord))
        this.paletteCursor = Math.min(Math.max(0, matches.length - 1), this.paletteCursor + 1)
      } else this.historyForward()
    } else if (key.kind === 'tab') {
      if (mention !== undefined) {
        // Complete the `@`-word to the highlighted candidate, closing the popup.
        const candidates = this.mentionCandidates(mention)
        const selected = candidates[this.mentionCursor]
        if (selected !== undefined) {
          const chars = Array.from(this.draft)
          chars.splice(mention.start, mention.end - mention.start, ...Array.from(selected.label))
          this.draft = chars.join('')
          this.caret = mention.start + Array.from(selected.label).length
          this.mentionDismissed = true
          this.afterDraftEdit()
        }
      } else if (paletteWord !== undefined) {
        // Complete the command word to the selected entry, leaving the palette open.
        const matches = this.paletteEntries().filter(entry => entry.name.startsWith(paletteWord))
        const selected = matches[this.paletteCursor]
        if (selected !== undefined) {
          this.draft = `/${selected.name}`
          this.caret = this.draft.length
        }
      } else {
        this.cycleView()
      }
    } else if (key.kind === 'enter') {
      const line = this.draft.trim()
      this.draft = ''
      this.caret = 0
      this.paletteDismissed = false
      this.mentionDismissed = false
      if (line !== '') {
        if (paletteWord !== undefined && !line.includes(' ')) {
          // Palette-assisted execution: an exactly typed command name wins,
          // otherwise the highlighted match runs; nothing matches, the line
          // runs verbatim (and reports itself unknown). Matches derive from
          // the word captured before the draft cleared.
          const typed = line.slice(1)
          const entries = this.paletteEntries()
          const exact = entries.find(entry => entry.name === typed)
          const matches = entries.filter(entry => entry.name.startsWith(paletteWord))
          const selected = matches[this.paletteCursor]
          const target = exact !== undefined ? line
            : selected === undefined ? line : `/${selected.name}`
          this.runCommandLine(target)
        } else {
          this.historyPush(line)
          this.scroll = 0 // a sent message pins the viewport to the newest row
          void this.send(line)
        }
      } else {
        // An empty Enter toggles the most recent tool card (Ctrl+O too).
        this.toggleLastTool()
      }
      this.repaint()
      return
    } else if (key.kind === 'escape') {
      if (mention !== undefined) {
        // Dismiss the mention popup but keep the draft.
        this.mentionDismissed = true
      } else if (paletteWord !== undefined) {
        // Dismiss the palette but keep the draft: the input owns the text.
        this.paletteDismissed = true
      } else {
        this.draft = ''
        this.caret = 0
        // A cleared input reopens the palette and the popup on fresh gestures.
        this.paletteDismissed = false
        this.mentionDismissed = false
      }
    } else if (key.kind === 'ctrl' && key.name === 'c') {
      if (this.running) {
        this.cancel()
        this.disarmExit()
      } else if (this.draft !== '') {
        this.draft = ''
        this.caret = 0
        this.paletteDismissed = false
        this.mentionDismissed = false
      } else this.armExit()
    } else if (key.kind === 'ctrl' && key.name === 'n') {
      void this.newSessionWithAgent()
    } else if (key.kind === 'ctrl' && key.name === 'x') {
      void this.openModelPicker()
    } else if (key.kind === 'ctrl' && key.name === 'o') {
      this.toggleLastTool()
    } else if (key.kind === 'ctrl' && key.name === 'e') {
      this.openSettingsDocument()
    } else if (key.kind === 'ctrl' && key.name === 'p') {
      this.togglePlan()
    } else if (key.kind === 'ctrl' && key.name === 'q') {
      this.requestExit()
    } else if (key.kind === 'pageup' || (key.kind === 'ctrl' && key.name === 'up')) {
      // Older content: the scroll counts rows back from the newest.
      this.scroll += key.kind === 'pageup' ? 10 : 1
    } else if (key.kind === 'pagedown' || (key.kind === 'ctrl' && key.name === 'down')) {
      // Back toward the newest row; 0 pins the viewport to the latest.
      this.scroll = Math.max(0, this.scroll - (key.kind === 'pagedown' ? 10 : 1))
    }
    this.repaint()
  }

  private dispatchView(key: TuiKey): void {
    if (this.view === 'help') {
      // The help sections can exceed the pane: page through them.
      if (key.kind === 'pageup') this.helpScroll = Math.max(0, this.helpScroll - 10)
      else if (key.kind === 'pagedown') this.helpScroll += 10
    }
    if (key.kind === 'char' && key.char === '/') {
      // Typing `/` from any view lands in the composer; the palette derives
      // from the draft like everywhere else.
      this.view = 'conversation'
      this.dispatchComposer(key)
      return
    }
    if (key.kind === 'ctrl' && key.name === 'n') {
      void this.newSessionWithAgent()
      return
    }
    if (key.kind === 'ctrl' && key.name === 'q') {
      this.onQuit(this.current)
      return
    }
    if (key.kind === 'escape') {
      this.view = 'conversation'
      this.repaint()
      return
    }
    if (key.kind === 'tab' || (key.kind === 'ctrl' && key.name === 't')) {
      this.cycleView()
      return
    }
    if (key.kind === 'ctrl' && key.name === 'p') {
      this.togglePlan()
      return
    }
    if (key.kind === 'ctrl' && key.name === 'x') {
      void this.openModelPicker()
      return
    }
    if (key.kind === 'ctrl' && key.name === 'o') {
      this.toggleLastTool()
      return
    }
    if (key.kind === 'ctrl' && key.name === 'e') {
      this.openSettingsDocument()
      return
    }
    if (key.kind === 'char' && key.char === '1') this.setView('conversation')
    else if (key.kind === 'char' && key.char === '2') this.setView('sessions')
    else if (key.kind === 'char' && key.char === '3') this.setView('jobs')
    else if (key.kind === 'char' && key.char === '4') this.setView('subagents')
    else if (key.kind === 'char' && key.char === '5') this.setView('goals')
    else if (key.kind === 'char' && key.char === '6') this.setView('settings')
    else if (key.kind === 'char' && key.char === '7') this.setView('skills')
    else if (key.kind === 'char' && key.char === '8') this.setView('help')
  }

  /** Open the model picker. */
  async openModelPicker(): Promise<void> {
    await this.refreshModelCatalog()
    this.popup = modelPopup(this.modelGroups, '', this.listPopupHeight())
    const popup = this.popup
    popup.onSelect = (item) => { void this.selectModelItem(item as ModelPickItem) }
    popup.onMove = (cursor) => { void this.loadModelEfforts(cursor) }
    void this.loadModelEfforts(0)
    this.repaint()
  }

  /**
   * Load the highlighted model's reasoning efforts for `←`/`→` cycling. The
   * route resolves lazily once; routes without reasoning stay plain.
   * @param cursor - the popup cursor of the item to resolve.
   */
  private async loadModelEfforts(cursor: number): Promise<void> {
    const popup = this.popup
    /* v8 ignore next -- loadModelEfforts runs only while a list popup is open */
    if (popup?.kind !== 'list') return
    const item = visibleItems(popup)[cursor] as ModelPickItem | undefined
    if (item === undefined || item.efforts !== undefined) return
    const llm = this.ctx.get('llm')
    /* v8 ignore start -- picker items only exist when an llm service mounted them */
    if (llm === undefined) {
      item.efforts = []
      return
    }
    /* v8 ignore stop */
    try {
      const info = await llm.resolveModelInfo(item.provider, item.model)
      const efforts = info.reasoning?.efforts ?? []
      item.efforts = efforts.map(effort => ({ id: String(effort.id), name: effort.name }))
      const defaultId = info.reasoning?.defaultEffort
      item.effortIndex = defaultId === undefined || efforts.length === 0
        ? 0
        : Math.max(0, efforts.findIndex(effort => String(effort.id) === String(defaultId)))
    } catch (_unresolvable) {
      item.efforts = []
    }
    this.repaint()
  }

  /** Rows available between the header and the composer, minus popup chrome. */
  private overlayCapacity(): number {
    const { rows } = this.screen.size()
    return Math.max(1, rows - 2)
  }

  /** Visible item count for list popups so the box never exceeds the window. */
  private listPopupHeight(): number {
    return Math.max(1, this.overlayCapacity() - 3)
  }

  /** Rows a list view shows between the header and the composer. */
  private listWindow(): number {
    return Math.max(1, this.screen.size().rows - 4)
  }

  /** Scroll offset that keeps `cursor` inside a window of `window` rows. */
  private followCursor(cursor: number, scroll: number, window: number): number {
    if (cursor < scroll) return cursor
    if (cursor >= scroll + window) return cursor - window + 1
    return scroll
  }

  /**
   * Select a model (and its pending reasoning effort) and save it as the
   * default.
   * @param item - the picker item, or a `provider/model` string.
   */
  async selectModelItem(item: ModelPickItem | string): Promise<void> {
    const provider = typeof item === 'string' ? item.split('/')[0] : item.provider
    const model = typeof item === 'string' ? item.split('/')[1] : item.model
    if (provider === undefined || model === undefined) return
    const effort = typeof item === 'string' ? undefined : item.efforts?.[item.effortIndex]?.id
    const selection: ModelSelection = {
      provider,
      model,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    }
    const agent = await this.currentAgent()
    const ref = agent === undefined ? undefined : this.selections.get(agent)
    if (ref !== undefined) ref.current = selection
    await this.ctx.agentDefaultModel.saveSelection(selection)
    this.refreshModel()
    this.popup = undefined
    const label = typeof item === 'string' ? item : item.label
    this.pushNotice(t('model.selected', { model: label }))
  }

  /** Open the permission-preset picker (the `/mode` palette command). */
  openModePicker(): void {
    const presets = this.ctx.get('permissionPresets')
    if (presets === undefined) {
      this.pushNotice(t('mode.unavailable'))
      return
    }
    const state = this.current === undefined ? undefined : this.sessions.get(this.current)
    const session = state?.session
    // Before any session exists, the picker edits the default preset that
    // new sessions inherit.
    const current = session === undefined ? presets.defaultPreset : presets.current(session.events)
    const popup = modePopup(presets.names, current, this.listPopupHeight())
    this.popup = {
      ...popup,
      onSelect: (item) => {
        this.selectModeItem((item as { name: string }).name)
      },
    }
    this.repaint()
  }

  /**
   * Apply one permission preset: to the current session when one exists, or
   * to the stored default new sessions inherit.
   */
  selectModeItem(name: string): void {
    const presets = this.ctx.get('permissionPresets')
    if (presets === undefined) return
    const state = this.current === undefined ? undefined : this.sessions.get(this.current)
    const session = state?.session
    this.popup = undefined
    if (session !== undefined) {
      presets.set(session, name)
      this.refreshPermission()
      this.pushNotice(t('mode.selected', { preset: name }))
      return
    }
    const settings = this.ctx.get('settings')
    if (settings !== undefined) {
      void settings.update(PERMISSION_SETTINGS_NAMESPACE, { defaultPreset: name }).then(() => {
        this.refreshPermission()
        this.pushNotice(t('mode.defaultSelected', { preset: name }))
        this.repaint()
      }).catch((error: unknown) => {
        this.pushNotice(t('settings.updateFailed', { label: 'defaultPreset', error: String(error) }))
        this.repaint()
      })
    }
  }

  /** Open the language picker (the `/lang` palette command). */
  openLangPicker(): void {
    const locales: { locale: TuiLocaleName; name: string }[] = [
      { locale: 'en', name: 'English' },
      { locale: 'zh', name: '中文' },
    ]
    const current = this.currentLocale()
    this.popup = {
      kind: 'list',
      title: t('lang.title'),
      items: locales,
      label: item => (item as { name: string }).name,
      cursor: Math.max(0, locales.findIndex(entry => entry.locale === current)),
      filter: '',
      height: Math.min(locales.length, this.listPopupHeight()),
      onSelect: (item) => {
        this.selectLocale((item as { locale: TuiLocaleName }).locale)
      },
    }
    this.repaint()
  }

  /** Apply one interface language, persist it, and repaint with the new copy. */
  selectLocale(locale: TuiLocaleName): void {
    const settings = this.ctx.get('settings')
    const label = locale === 'zh' ? '中文' : 'English'
    this.popup = undefined
    // Apply the chosen language immediately; the stored value re-applies on
    // the next boot. A stale-language notice drops so nothing old survives.
    if (localeName() !== locale) {
      setLocale(locale)
      this.notice = undefined
    }
    if (settings !== undefined) void settings.update(TUI_LOCALE_NS, { locale }).catch((error: unknown) => {
      this.pushNotice(t('settings.updateFailed', { label: 'locale', error: String(error) }))
      this.repaint()
    })
    this.repaint()
    this.pushNotice(t('lang.selected', { name: label }))
    this.repaint()
  }

  /** The locale the `tui` settings namespace resolves, or the module default. */
  private currentLocale(): TuiLocaleName {
    const stored = this.ctx.get('settings')?.get(TUI_LOCALE_NS)
    const locale = typeof stored === 'object' && stored !== null
      ? (stored as { locale?: unknown }).locale
      : undefined
    return locale === 'zh' ? 'zh' : 'en'
  }

  /**
   * Re-apply the stored locale (boot and after settings writes). A change
   * also drops the notice pushed in the previous language, so no
   * stale-language text survives the switch.
   */
  private refreshLocale(): void {
    const next = this.currentLocale()
    if (localeName() === next) return
    setLocale(next)
    this.notice = undefined
  }

  /** Toggle plan mode for the current session. */
  togglePlan(): void {
    const planMode = this.ctx.get('planMode')
    const agent = this.current === undefined ? undefined : this.ctx.agents.get(this.current)
    if (agent === undefined || planMode === undefined) return
    planMode.set(agent, !planMode.get(agent).active)
    this.plan = planMode.get(agent).active
    this.repaint()
  }

  private setView(view: TuiView): void {
    this.view = view
    if (view === 'sessions') {
      this.sessionFilter = ''
      this.sessionCursor = this.current === undefined
        ? 0
        : Math.max(0, this.sessionsSnapshot().findIndex(row => row.id === this.current))
    }
    if (view === 'jobs') this.refreshJobs()
    if (view === 'subagents') void this.refreshSubagents()
    if (view === 'settings') this.refreshSettings()
    if (view === 'skills') void this.refreshSkills()
    if (view === 'goals') this.refreshGoal()
    this.repaint()
  }

  private cycleView(): void {
    const index = VIEW_KEYS.findIndex(entry => entry[1] === this.view)
    const next = VIEW_KEYS[(index + 1) % VIEW_KEYS.length]
    /* v8 ignore next 2 -- VIEW_KEYS is non-empty, so the wrap-around index always resolves */
    if (next !== undefined) this.setView(next[1])
  }

  // ---- rendering ------------------------------------------------------------

  /**
   * Build the full frame from the current state.
   * @returns the frame rows for the current terminal size.
   */
  frame(): Frame {
    const { columns, rows } = this.screen.size()
    const state = this.current === undefined ? undefined : this.sessions.get(this.current)
    const transcript = state?.transcript ?? []
    const composerHeight = 1
    const headerHeight = 1
    const statusHeight = 1
    const bodyHeight = Math.max(1, rows - composerHeight - headerHeight - statusHeight)

    const header = this.headerRow(columns)
    // The current notice owns the bottom row of the pane, so the view body
    // renders into one row less while a notice is live.
    const notice = this.notice
    const body = this.viewRows(this.view, transcript, columns, Math.max(1, bodyHeight - (notice === undefined ? 0 : 1)))
    const status = this.statusRow(columns)
    const composer = renderComposer(this.draft, this.caret, columns)

    const rowsOut: FrameRow[] = [header]
    for (let line = 0; line < bodyHeight; line += 1) {
      rowsOut.push(body[line] ?? ' '.repeat(columns))
    }
    if (notice !== undefined) rowsOut[rowsOut.length - 1] = hintRow(notice, columns)
    // Keep the composer pinned at the bottom even when the status line is empty.
    rowsOut.push(status.length > 0 ? status : ' '.repeat(columns))
    rowsOut.push(composer)

    // Popups, the composer-derived mention popup, and the command palette
    // dock above the composer, next to the input that invoked them, instead
    // of covering the top of the transcript. Every overlay is capped to the
    // window, so a short terminal never renders a popup taller than itself.
    const paletteWord = this.paletteWord()
    const mention = this.mentionWord()
    const capacity = Math.max(1, rows - composerHeight - headerHeight)
    let overlay: FrameRow[] | undefined
    if (this.popup !== undefined) {
      overlay = this.popupRows(columns)
    } else if (mention !== undefined) {
      const candidates = this.mentionCandidates(mention)
      this.mentionCursor = clampCursor(this.mentionCursor, candidates.length)
      overlay = renderMentionPopup(candidates, this.mentionCursor, columns, capacity)
    } else if (paletteWord !== undefined) {
      const entries = this.paletteEntries()
      const matches = entries.filter(entry => entry.name.startsWith(paletteWord))
      this.paletteCursor = clampCursor(this.paletteCursor, matches.length)
      overlay = renderCommandPalette(entries, paletteWord, this.paletteCursor, columns, capacity)
    }
    if (overlay !== undefined) {
      // Popups dock directly above the composer — the input that invoked
      // them — covering the status line while they are open.
      if (overlay.length > capacity) overlay = overlay.slice(0, capacity)
      const top = Math.max(headerHeight, rows - composerHeight - overlay.length)
      for (let index = 0; index < overlay.length && top + index < rows - composerHeight; index += 1) {
        const overlayRow = overlay[index]
        /* v8 ignore next 2 -- index < overlay.length guarantees the row exists */
        if (overlayRow !== undefined) rowsOut[top + index] = overlayRow
      }
      // A blank separator keeps the popup visually attached to the input area
      // instead of merging with the pane content above it.
      if (top - 1 >= headerHeight) rowsOut[top - 1] = ' '.repeat(columns)
    }
    // The mouse-drawn selection highlights its span over the final frame.
    const selection = this.selectionRange()
    if (selection !== undefined) {
      rowsOut.forEach((row, index) => {
        const rowNo = index + 1
        if (rowNo < selection.rowStart || rowNo > selection.rowEnd) return
        rowsOut[index] = this.highlightRow(row, rowNo, selection)
      })
    }
    this.lastRows = rowsOut
    return { rows: rowsOut }
  }

  /**
   * Current sidebar rows with titles folded from each live log.
   * @returns the sorted sidebar rows.
   */
  sessionsSnapshot(): SessionSummary[] {
    const rows: SessionSummary[] = []
    for (const [id, state] of this.sessions) {
      const session = state.session
      rows.push({
        id,
        /* v8 ignore next -- refreshSessions seeds a provisional label for every cold row */
        title: session === undefined
          ? this.coldTitles.get(id) ?? shortId(id)
          : foldTitle(session.events) ?? 'New session',
        running: state.running,
        ...session?.header.cwd === undefined ? {} : { cwd: session.header.cwd },
        live: session !== undefined,
        ...sessionWeight(state.usage) >= HEAVY_SESSION_TOKENS ? { heavy: true } : {},
      })
    }
    rows.sort((left, right) => left.id < right.id ? -1 : 1)
    return rows
  }

  private headerRow(width: number): FrameRow {
    const parts: { text: string; style: CellStyle }[] = [{ text: 'dshcli', style: 'bright' }]
    if (this.current !== undefined) {
      const state = this.sessions.get(this.current)
      const title = state?.session === undefined
        ? shortId(this.current)
        : foldTitle(state.session.events) ?? 'New session'
      parts.push({ text: ` · ${title}`, style: 'dim' })
    }
    return segmentCells(parts, width)
  }

  /** The status line: model+effort, tokens, permission preset, plan, goal, running. */
  private statusRow(width: number): FrameRow {
    const parts: { text: string; style: CellStyle }[] = []
    if (this.model !== undefined) parts.push({ text: this.model, style: 'cyan' })
    const state = this.current === undefined ? undefined : this.sessions.get(this.current)
    if (state !== undefined) {
      const usage = state.usage
      const elapsed = state.turnStartedAt === undefined ? undefined : Date.now() - state.turnStartedAt
      const tokens = usageTokensLabel(usage)
      if (tokens !== undefined) parts.push({ text: tokens, style: 'green' })
      if (elapsed !== undefined) {
        const seconds = elapsed / 1000
        const rate = usage.outputTokens === 0 || seconds <= 0
          ? undefined
          : `${Math.round(usage.outputTokens / seconds)}/s`
        parts.push({ text: `${seconds.toFixed(1)}s${rate === undefined ? '' : ` ${rate}`}`, style: 'green' })
      }
    }
    if (this.permission !== undefined) parts.push({ text: this.permission, style: 'yellow' })
    if (this.plan) parts.push({ text: 'plan', style: 'yellow' })
    if (this.goal !== undefined) parts.push({ text: `goal: ${this.goal.phase}: ${this.goal.objective}`, style: 'magenta' })
    if (this.running) parts.push({ text: '● running', style: 'red' })
    if (parts.length === 0) return []
    const joined: { text: string; style: CellStyle }[] = []
    parts.forEach((part, index) => {
      if (index > 0) joined.push({ text: ' · ', style: 'dim' })
      joined.push(part)
    })
    return segmentCells(joined, width)
  }

  /**
   * The help pane rows, derived per render from the real view keys and the
   * real palette entries — one source of truth, in the active language, one
   * item per line under labeled sections. Section headers render bright.
   * @returns the help lines with their header flag.
   */
  private helpRows(): readonly { text: string; header: boolean }[] {
    const palette = this.paletteEntries()
    const header = (text: string): { text: string; header: boolean } => ({ text, header: true })
    const line = (text: string): { text: string; header: boolean } => ({ text, header: false })
    return [
      line(t('help.title')),
      header(t('help.section.views')),
      ...VIEW_KEYS.map(([key, view]) => line(`  ${key} — ${view}`)),
      line(`  ${t('help.line.tab')}`),
      line(`  ${t('help.line.esc')}`),
      header(t('help.section.palette')),
      ...palette.map(entry => line(`  /${entry.name} — ${entry.description}`)),
      header(t('help.section.composer')),
      line(`  ${t('help.line.enter')}`),
      line(`  ${t('help.line.ctrlC')}`),
      line(`  ${t('help.line.edit')}`),
      line(`  ${t('help.line.history')}`),
      header(t('help.section.mention')),
      line(`  ${t('help.line.mention')}`),
      header(t('help.section.scroll')),
      line(`  ${t('help.line.scrollPg')}`),
      line(`  ${t('help.line.scrollRow')}`),
      line(`  ${t('help.line.wheel')}`),
      header(t('help.section.settings')),
      line(`  ${t('help.line.settingsEdit')}`),
      line(`  ${t('help.line.settingsBack')}`),
      header(t('help.section.viewKeys')),
      line(`  ${t('help.line.viewSessions')}`),
      line(`  ${t('help.line.viewJobs')}`),
      line(`  ${t('help.line.viewGoals')}`),
    ]
  }

  private viewRows(view: TuiView, transcript: readonly TranscriptBlock[], width: number, height: number): FrameRow[] {
    switch (view) {
      case 'conversation': {
        if (transcript.length === 0) {
          return this.current === undefined
            ? welcomeRows(width)
            : [hintRow(t('hint.newSession'), width)]
        }
        return renderConversation(
          transcript,
          width,
          height,
          this.scroll,
          block => block.kind === 'tool' && this.expandedTools.has(block.callId),
          this.rowCache,
        )
      }
      case 'sessions': {
        const all = this.sessionsSnapshot()
        const filter = this.sessionFilter.toLowerCase()
        const sessions = filter === ''
          ? all
          : all.filter(row => row.title.toLowerCase().includes(filter) || row.id.includes(filter))
        const cursor = sessions[this.sessionCursor]
        const window = Math.max(1, height - (this.sessionFilter !== '' ? 1 : 0))
        const visible = sessions.slice(this.sessionScroll, this.sessionScroll + window)
        const rows = renderSidebar(visible, cursor?.id, width)
        if (this.sessionFilter !== '') rows.unshift(hintRow(`${t('hint.search')} ${this.sessionFilter}`, width))
        return rows
      }
      case 'jobs': {
        if (this.jobs.length === 0) return [hintRow(t('jobs.empty'), width)]
        const window = Math.max(1, height)
        const visible = this.jobs.slice(this.jobScroll, this.jobScroll + window)
        return renderJobs(visible, width, this.jobCursor - this.jobScroll, id => this.expandedJobs.has(id))
      }
      case 'subagents': {
        if (this.subagents.length === 0) return [hintRow(t('subagents.empty'), width)]
        const window = Math.max(1, height)
        const visible = this.subagents.slice(this.subagentScroll, this.subagentScroll + window)
        return renderSubagents(visible, width, this.subagentCursor - this.subagentScroll)
      }
      case 'goals':
        return renderGoal(this.goal, width)
      case 'settings': {
        if (this.settingsPath === undefined) return [hintRow(t('settings.empty'), width)]
        return [
          hintRow(t('settings.file', { path: this.settingsPath }), width),
          hintRow(t('settings.editHint'), width),
        ]
      }
      case 'skills': {
        if (this.skills.length === 0) return [hintRow(t('skills.empty'), width)]
        const window = Math.max(1, height)
        const visible = this.skills.slice(this.skillScroll, this.skillScroll + window)
        return renderSkills(visible, width, this.skillCursor - this.skillScroll)
      }
      case 'help': {
        const all = this.helpRows()
        const window = Math.max(1, height)
        const visible = all.slice(this.helpScroll, this.helpScroll + window)
        return visible.map(item => item.header
          ? Array.from(item.text).map(char => ({ char, style: 'bright' as CellStyle }))
          : item.text)
      }
    }
  }

  private popupRows(width: number): FrameRow[] {
    const popup = this.popup
    /* v8 ignore next 2 -- frame() only invokes this while this.popup is set */
    if (popup === undefined) return []
    if (popup.kind === 'approval') return renderApprovalPopup(popup, width)
    if (popup.kind === 'question') return renderQuestionPopup(popup, width)
    if (popup.kind === 'confirm') return renderConfirmPopup(popup, width)
    return renderListPopup(popup, width)
  }
}
