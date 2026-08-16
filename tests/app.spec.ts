/**
 * TuiApp: session lifecycle, key dispatch, conversation streaming, popups
 * (approvals, questions, command palette, model picker), plan mode, jobs,
 * subagents, goals, settings, skills, and rendering. The app is driven through
 * a fake IO and real core registries; optional services are stubbed so each
 * behavior can be exercised in isolation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AgentOptions, AgentSetup, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { TuiApp } from '../src/tui/app.ts'
import { resetLocale, localeName } from '../src/tui/i18n.ts'
import { MAX_MENTION_FILE_BYTES } from '../src/tui/mention.ts'
import type { TuiIo, FrameRow } from '../src/tui/screen.ts'
import type { TuiStartupValues } from '../src/startup.ts'

/** A fake TuiIo capturing stdout and recording raw-mode/resume calls. */
function fakeIo(columns = 80, rows = 24): {
  io: TuiIo
  writes: string[]
  events: string[]
  resize(): void
} {
  const writes: string[] = []
  const events: string[] = []
  const listeners = new Set<() => void>()
  return {
    writes,
    events,
    resize: () => { for (const listener of listeners) listener() },
    io: {
      stdout: {
        write: (chunk: string) => { writes.push(chunk); return true },
        columns,
        rows,
        on: (_event: string, listener: () => void) => { listeners.add(listener); return listener },
        off: (_event: string, listener: () => void) => { listeners.delete(listener) },
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

/** Render a FrameRow back to plain text. */
function rowText(row: FrameRow): string {
  return typeof row === 'string' ? row : row.map(cell => cell.char).join('')
}

/** The whole frame as one string (for contains-style assertions). */
function frameText(app: TuiApp): string {
  return app.frame().rows.map(rowText).join('\n')
}

/** Let all pending microtasks/macrotasks settle (async agent creation, refreshes). */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Wait past the app's escape-flush grace period after feeding a lone ESC. */
async function flushEsc(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 60))
}

/** Scripted follow-up: append a user+assistant turn on every prompt. */
interface Script {
  afterPrompt?(session: Session, message: UserMessage): Promise<void> | void
  /** Resume hook; defaults to rejecting so the app falls through to create. */
  resume?(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
  /** Make the create factory reject, surfacing a creation failure. */
  failCreate?: boolean
  /** Run setup on a context without an agent (a misconfigured factory). */
  bareSetup?: boolean
}

/** Build a fake agent handle around a freshly created store session. */
async function makeHandle(
  ctx: Context,
  ownerCtx: Context,
  sessionId: SessionId,
  options: {
    agentOptions?: AgentOptions | undefined
    meta?: CreateAgentOptions['meta'] | undefined
    setup?: AgentSetup | undefined
    afterPrompt?: Script['afterPrompt'] | undefined
    bareSetup?: boolean | undefined
  },
): Promise<AgentHandle> {
  const session = ctx.sessions.create(sessionId, {
    ...options.meta === undefined ? {} : { meta: options.meta },
  })
  let idle = Promise.resolve()
  const agent = {} as Agent
  const agentCtx = ownerCtx.extend({ agent })
  Object.assign(agent, {
    id: session.id,
    options: options.agentOptions ?? {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: agentCtx,
    cancel: () => {},
    runMaintenance: () => Promise.reject(new Error('not used')),
    send: () => {},
    followup: (message: UserMessage) => {
      agent.inbox.append('next-turn', message)
      idle = Promise.resolve().then(() => options.afterPrompt?.(session, message))
    },
    steer: () => {},
    inject: () => {},
    whenIdle: () => idle,
  } satisfies Partial<Agent>)
  await options.setup?.(options.bareSetup === true ? ownerCtx.extend({}) : agentCtx)
  ctx.agents.register(agent)
  return { agent, dispose: () => Promise.resolve() }
}

/** Mount the real registries around a small scripted Agent factory. */
async function bench(
  script: Script = {},
  startup: TuiStartupValues = { plan: false },
  onQuit: () => void = () => {},
  launchEditor: (invocation: { cmd: string; args: readonly string[] }) => void = () => {},
  listMentionDir: (path: string) => Promise<string[]> = async () => [],
  readMentionFile: (path: string) => Promise<string> = async () => '',
): Promise<{ ctx: Context; app: TuiApp; io: ReturnType<typeof fakeIo> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  ctx.agents.setFactory({
    createAgent: (ownerCtx, options) => script.failCreate === true
      ? Promise.reject(new Error('factory failed'))
      : makeHandle(ctx, ownerCtx, options.sessionId, {
        agentOptions: options.agentOptions,
        meta: options.meta,
        setup: options.setup,
        afterPrompt: (session, message) => script.afterPrompt?.(session, message),
        bareSetup: script.bareSetup,
      }),
    resume: (ownerCtx, options) => script.resume?.(ownerCtx, options) ?? Promise.reject(new Error('not used')),
  })
  const io = fakeIo()
  const app = new TuiApp(ctx, io.io, startup, onQuit, launchEditor, listMentionDir, readMentionFile)
  return { ctx, app, io }
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  resetLocale()
})

describe('TuiApp', () => {
  it('starts into raw mode and renders an initial frame', async () => {
    const { ctx, app, io } = await bench()
    app.start()
    expect(io.events).toContain('raw:true')
    expect(io.writes.length).toBeGreaterThan(0)
    expect(io.writes[0]).toContain('\x1b[?1049h')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('creates a session and switches to it on Ctrl+N', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x03') // a stray ctrl char, then new session
    app.feed('\x0e') // Ctrl+N
    const sessions = ctx.sessions.list()
    expect(sessions.length).toBe(1)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('composes text in the composer and sends on Enter', async () => {
    const seen: UserMessage[] = []
    const { ctx, app } = await bench({
      afterPrompt: async (_session, message) => { seen.push(message) },
    })
    app.start()
    app.feed('\x0e') // Ctrl+N: create a session with an agent
    await flush()
    app.feed('hello world')
    app.feed('\r')
    await flush()
    expect(seen).toHaveLength(1)
    const message = seen[0]!
    const text = message.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
    expect(text).toBe('hello world')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('handles backspace, arrows, home, and end in the composer', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e') // Ctrl+N
    await flush()
    app.feed('abc')
    app.feed('\x7f') // backspace -> ab
    app.feed('\x1b[D') // left
    app.feed('X') // aXb
    app.feed('\x1b[H') // home
    app.feed('Z') // ZaXb
    app.feed('\x1b[F') // end
    app.feed('!') // ZaXb!
    app.feed('\r')
    await flush()
    const sessions = ctx.sessions.list()
    const agent = ctx.agents.get(sessions[0]!.id)
    expect(agent?.inbox.nextTurn[0]).toBeDefined()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('steps Ctrl+C through cancel, clear, and exit', async () => {
    // Running turn: Ctrl+C cancels it.
    let cancelled = 0
    const { ctx, app } = await bench({
      afterPrompt: (session) => {
        session.append('turn/start', { turn: 1 })
      },
    })
    app.start()
    app.feed('\x0e')
    await flush()
    const state = ctx.agents.list()[0]
    expect(state).toBeDefined()
    ;(state as unknown as { cancel: () => void }).cancel = () => { cancelled += 1 }
    app.feed('go') // send a prompt so the scripted turn opens
    app.feed('\r')
    await flush()
    expect(frameText(app)).toContain('running')
    app.feed('\x03')
    expect(cancelled).toBe(1)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('clears the draft with Ctrl+C instead of exiting', async () => {
    let quit = 0
    const { ctx, app } = await bench({}, { plan: false }, () => { quit += 1 })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('hello')
    app.feed('\x03') // draft non-empty and idle: clear, do not exit
    expect(quit).toBe(0)
    expect(frameText(app)).not.toContain('hello')
    app.feed('\x03') // draft empty and idle: arms the quit, does not exit
    expect(quit).toBe(0)
    app.feed('\x03') // the armed second press quits
    expect(quit).toBe(1)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('arms the idle Ctrl+C quit and disarms on any other key', async () => {
    let quit = 0
    const { ctx, app } = await bench({}, { plan: false }, () => { quit += 1 })
    app.start()
    app.feed('\x03') // idle, empty draft: arms only
    expect(quit).toBe(0)
    expect(frameText(app)).toContain('Press Ctrl+C again to quit')
    app.feed('x') // any other key disarms (and types into the draft)
    app.feed('\x03') // draft non-empty: clears, still no quit
    expect(quit).toBe(0)
    app.feed('\x03') // arms again
    expect(quit).toBe(0)
    app.feed('\x03') // the armed second press quits
    expect(quit).toBe(1)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('disarms the idle Ctrl+C quit after the window', async () => {
    vi.useFakeTimers()
    try {
      let quit = 0
      const { ctx, app } = await bench({}, { plan: false }, () => { quit += 1 })
      app.start()
      app.feed('\x03') // arms
      expect(quit).toBe(0)
      vi.advanceTimersByTime(2001) // the arm expires
      app.feed('\x03') // arms again instead of quitting
      expect(quit).toBe(0)
      app.dispose()
      disposers.push(() => ctx.fiber.dispose())
    } finally {
      vi.useRealTimers()
    }
  })

  it('refolds the transcript when session events append', async () => {
    const { ctx, app } = await bench({
      afterPrompt: (session) => {
        session.append('assistant/message', {
          turn: 1, step: 1,
          message: {
            id: 'a1' as never,
            role: 'assistant',
            content: [{ type: 'text', text: 'streamed answer' }],
            source: { kind: 'model', provider: 'p', model: 'm' },
          },
        }, { surfaceOp: 'append' })
      },
    })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('q')
    app.feed('\r')
    await flush()
    expect(frameText(app)).toContain('streamed answer')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('tracks running state across turn boundaries', async () => {
    const { ctx, app } = await bench({
      afterPrompt: (session) => {
        session.append('turn/start', { turn: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('\r')
    await flush()
    const session = ctx.sessions.list()[0]!
    session.append('turn/start', { turn: 2 })
    app.feed('\x03')
    expect(frameText(app)).toContain('running')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('opens the command palette on / from an empty composer', async () => {
    const executed: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [{ name: 'compact', description: 'c' }],
      execute: async (_agent: never, line: string) => {
        executed.push(line)
        return { commandId: 'x', result: { kind: 'success', text: 'ok' } }
      },
    } as never)
    app.start()
    app.feed('\x0e') // an agent must exist for the palette and the /command send
    await flush()
    app.feed('/')
    // The slash lands in the composer; the palette derives from it.
    expect(frameText(app)).toContain('❯ /')
    expect(frameText(app)).toContain('Commands')
    app.feed('comp') // the typed word stays visible in the composer
    expect(frameText(app)).toContain('❯ /comp')
    expect(frameText(app)).toContain('/compact — c')
    app.feed('\x1b[B') // down (no-op on single item)
    app.feed('\r') // execute selected -> runs /compact through send
    await flush()
    expect(executed).toEqual(['/compact'])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('sinks /exit behind a separator at the palette bottom', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('/') // no session: the palette still lists the shipped entries
    const lines = frameText(app).split('\n')
    const rule = (line: string) => /^│\s+─+\s*│$/.test(line)
    const separator = lines.findIndex(rule)
    const exit = lines.findIndex(line => line.includes('/exit — quit'))
    expect(separator).toBeGreaterThan(-1)
    expect(exit).toBeGreaterThan(separator)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('orders the palette by frequency then danger', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('/') // no session: shipped entries only
    const text = frameText(app)
    const index = (name: string) => text.indexOf(`/${name} —`)
    // Quick actions lead, view jumps follow, host commands next, /exit last.
    expect(index('model')).toBeLessThan(index('sessions'))
    expect(index('sessions')).toBeLessThan(index('compact'))
    expect(index('compact')).toBeLessThan(index('goal'))
    expect(index('goal')).toBeLessThan(index('exit'))
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('keeps the shipped host command order ahead of registry extras', async () => {
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [
        { name: 'zzz', description: 'last extra' },
        { name: 'goal', description: 'g' },
        { name: 'aaa', description: 'first extra' },
        { name: 'compact', description: 'c' },
      ],
      execute: async () => undefined,
    } as never)
    app.start()
    app.feed('\x0e') // a session makes the live registry the host source
    await flush()
    app.feed('/')
    const text = frameText(app)
    const index = (name: string) => text.indexOf(`/${name} —`)
    // Shipped commands keep their table order; extras append alphabetically.
    expect(index('compact')).toBeGreaterThan(-1)
    expect(index('compact')).toBeLessThan(index('goal'))
    expect(index('goal')).toBeLessThan(index('aaa'))
    expect(index('aaa')).toBeLessThan(index('zzz'))
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('opens the mention popup on @ with skills and files', async () => {
    const { ctx, app } = await bench(
      {},
      { plan: false },
      () => {},
      () => {},
      async () => ['package.json', 'README.md'],
    )
    ctx.provide('skills', {
      list: async () => [
        { name: 'locked', description: 'no', invocation: { modelInvocable: true, userInvocable: false }, source: 'runtime', provider: 'runtime' },
        { name: 'dsh-prose-standard', description: 'prose rules', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'runtime' },
      ],
    } as never)
    app.start()
    app.feed('@')
    await flush()
    const text = frameText(app)
    expect(text).toContain('Reference')
    expect(text).toContain('@dsh-prose-standard — prose rules')
    expect(text).toContain('@package.json')
    expect(text).not.toContain('@locked')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('completes the mention with Tab and then clears the draft with Esc', async () => {
    const { ctx, app } = await bench(
      {},
      { plan: false },
      () => {},
      () => {},
      async () => ['package.json'],
    )
    ctx.provide('skills', {
      list: async () => [
        { name: 'dsh-prose-standard', description: 'prose rules', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'runtime' },
      ],
    } as never)
    app.start()
    app.feed('@dsh')
    await flush()
    app.feed('\t') // complete to the highlighted skill, closing the popup
    expect(frameText(app)).toContain('❯ @dsh-prose-standard')
    expect(frameText(app)).not.toContain('Reference')
    app.feed('\x1b') // no popup open: the draft clears
    await flushEsc()
    expect(frameText(app)).not.toContain('@dsh-prose-standard')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('dismisses the mention popup with Esc while keeping the draft', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('@pack')
    await flush()
    expect(frameText(app)).toContain('Reference')
    app.feed('\x1b')
    await flushEsc()
    expect(frameText(app)).not.toContain('Reference')
    expect(frameText(app)).toContain('❯ @pack')
    app.feed('a') // typing inside the dismissed word keeps it dismissed
    expect(frameText(app)).not.toContain('Reference')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('filters files by subdirectory and quotes paths with spaces', async () => {
    const listed: string[] = []
    const { ctx, app } = await bench(
      {},
      { plan: false },
      () => {},
      () => {},
      async (path) => {
        listed.push(path)
        return path === 'src' ? ['main.ts', 'my notes.md'] : []
      },
    )
    app.start()
    app.feed('@src/')
    await flush()
    expect(listed).toContain('src')
    expect(frameText(app)).toContain('@src/main.ts')
    app.feed('my')
    app.feed('\t') // complete to the quoted path
    expect(frameText(app)).toContain('❯ @"src/my notes.md"')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('shows no file candidates when the directory is unreadable', async () => {
    const { ctx, app } = await bench(
      {},
      { plan: false },
      () => {},
      () => {},
      async () => { throw new Error('EACCES') },
    )
    app.start()
    app.feed('@')
    await flush()
    expect(frameText(app)).toContain('Reference')
    expect(frameText(app)).toContain('(no matches)')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('sends file references as attached context', async () => {
    const seen: UserMessage[] = []
    const { ctx, app } = await bench(
      { afterPrompt: async (_session, message) => { seen.push(message) } },
      { plan: false },
      () => {},
      () => {},
      async () => [],
      async () => 'file body',
    )
    app.start()
    app.feed('\x0e') // a session the message can follow
    await flush()
    app.feed('fix @src/app.ts\r')
    await flush()
    expect(seen).toHaveLength(1)
    const blocks = seen[0]!.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text)
    expect(blocks[0]).toBe('fix @src/app.ts')
    expect(blocks[1]).toContain('<system-reminder>')
    expect(blocks[1]).toContain('Attached file: src/app.ts')
    expect(blocks[1]).toContain('file body')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('sends skill references as the rendered skill body', async () => {
    const seen: UserMessage[] = []
    const { ctx, app } = await bench({ afterPrompt: async (_session, message) => { seen.push(message) } })
    ctx.provide('skills', {
      list: async () => [{ name: 'demo-skill', description: 'd', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'runtime' }],
      get: async (name: string) => ({
        name,
        description: 'd',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'runtime',
        provider: 'runtime',
        content: 'SKILL BODY',
      }),
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('use @demo-skill please\r')
    await flush()
    const blocks = seen[0]!.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text)
    expect(blocks[0]).toBe('use @demo-skill please')
    expect(blocks[1]).toContain('<skill_content name="demo-skill">')
    expect(blocks[1]).toContain('SKILL BODY')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports a skill reference that no longer loads', async () => {
    const seen: UserMessage[] = []
    const { ctx, app } = await bench({ afterPrompt: async (_session, message) => { seen.push(message) } })
    ctx.provide('skills', {
      list: async () => [{ name: 'gone-skill', description: 'd', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'runtime' }],
      get: async () => undefined,
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('use @gone-skill\r')
    await flush()
    expect(frameText(app)).toContain('Skill "gone-skill" failed to load: not found')
    const blocks = seen[0]!.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text)
    expect(blocks).toHaveLength(1) // nothing attached
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports a skill reference whose load throws', async () => {
    const seen: UserMessage[] = []
    const { ctx, app } = await bench({ afterPrompt: async (_session, message) => { seen.push(message) } })
    ctx.provide('skills', {
      list: async () => [{ name: 'gone-skill', description: 'd', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'runtime' }],
      get: async () => { throw new Error('boom') },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('use @gone-skill\r')
    await flush()
    expect(frameText(app)).toContain('Skill "gone-skill" failed to load: Error: boom')
    const blocks = seen[0]!.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text)
    expect(blocks).toHaveLength(1) // nothing attached
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('caps the total attached bytes across file references', async () => {
    const seen: UserMessage[] = []
    const { ctx, app } = await bench(
      { afterPrompt: async (_session, message) => { seen.push(message) } },
      { plan: false },
      () => {},
      () => {},
      async () => [],
      async () => 'x'.repeat(20 * 1024),
    )
    app.start()
    app.feed('\x0e')
    await flush()
    const refs = Array.from({ length: 5 }, (_, index) => `@f${index}.txt`).join(' ')
    app.feed(`${refs}\r`)
    await flush()
    expect(frameText(app)).toContain('Reference budget exceeded; skipped: f4.txt')
    const blocks = seen[0]!.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text)
    const attached = blocks[1]!.match(/Attached file:/g)
    expect(attached).toHaveLength(4)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('moves the mention cursor with the arrows', async () => {
    const { ctx, app } = await bench(
      {},
      { plan: false },
      () => {},
      () => {},
      async () => ['a.txt', 'b.txt'],
    )
    app.start()
    app.feed('@')
    await flush()
    app.feed('\x1b[B') // down
    expect(frameText(app)).toContain('› @b.txt')
    app.feed('\x1b[A') // up clamps at the top
    expect(frameText(app)).toContain('› @a.txt')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('ignores Tab when no mention candidate matches', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('@zzz')
    await flush()
    app.feed('\t') // no candidates: nothing completes, the popup stays open
    expect(frameText(app)).toContain('Reference')
    expect(frameText(app)).toContain('❯ @zzz')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports an unreadable file reference and keeps it in the text', async () => {
    const seen: UserMessage[] = []
    const { ctx, app } = await bench(
      { afterPrompt: async (_session, message) => { seen.push(message) } },
      { plan: false },
      () => {},
      () => {},
      async () => [],
      async () => { throw new Error('ENOENT') },
    )
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('see @missing.txt\r')
    await flush()
    expect(frameText(app)).toContain('File not found: missing.txt')
    const blocks = seen[0]!.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text)
    expect(blocks).toHaveLength(1) // nothing attached
    expect(blocks[0]).toBe('see @missing.txt')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports an oversized file reference and keeps it in the text', async () => {
    const seen: UserMessage[] = []
    const { ctx, app } = await bench(
      { afterPrompt: async (_session, message) => { seen.push(message) } },
      { plan: false },
      () => {},
      () => {},
      async () => [],
      async () => 'x'.repeat(MAX_MENTION_FILE_BYTES + 1),
    )
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('see @big.txt\r')
    await flush()
    expect(frameText(app)).toContain('File too large to attach: big.txt')
    const blocks = seen[0]!.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text)
    expect(blocks).toHaveLength(1) // nothing attached
    expect(blocks[0]).toBe('see @big.txt')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('caps the reference count and the total attached bytes', async () => {
    const seen: UserMessage[] = []
    const { ctx, app } = await bench(
      { afterPrompt: async (_session, message) => { seen.push(message) } },
      { plan: false },
      () => {},
      () => {},
      async () => [],
      async () => 'x'.repeat(10 * 1024),
    )
    app.start()
    app.feed('\x0e')
    await flush()
    const refs = Array.from({ length: 8 }, (_, index) => `@f${index}.txt`).join(' ')
    app.feed(`${refs}\r`)
    await flush()
    expect(frameText(app)).toContain('Too many references; only the first 5 attach')
    const blocks = seen[0]!.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text)
    expect(blocks[1]).toContain('<system-reminder>')
    const attached = blocks[1]!.match(/Attached file:/g)
    expect(attached).toHaveLength(5)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('closes the palette when the slash is deleted from the draft', async () => {
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [{ name: 'compact', description: 'c' }],
      execute: async () => ({ commandId: 'x', result: { kind: 'success' as const } }),
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('/')
    app.feed('comp')
    expect(frameText(app)).toContain('Commands')
    app.feed('\x7f') // backspace: '/com'
    expect(frameText(app)).toContain('❯ /com')
    app.feed('\x7f')
    app.feed('\x7f')
    app.feed('\x7f')
    app.feed('\x7f') // the slash is gone: the palette disappears with it
    expect(frameText(app)).not.toContain('Commands')
    expect(frameText(app)).not.toContain('❯ /')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('dismisses the palette with Esc while keeping the draft', async () => {
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [{ name: 'compact', description: 'c' }],
      execute: async () => ({ commandId: 'x', result: { kind: 'success' as const } }),
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('/')
    app.feed('comp')
    app.feed('\x1b') // dismiss: the palette hides, the draft survives
    await flushEsc()
    expect(frameText(app)).not.toContain('Commands')
    expect(frameText(app)).toContain('❯ /comp')
    app.feed('a') // typing inside the dismissed word keeps it dismissed
    expect(frameText(app)).not.toContain('Commands')
    // Deleting past the slash resets; a fresh slash reopens the palette.
    for (const _ of ['', '', '', '', '', '']) app.feed('\x7f')
    expect(frameText(app)).not.toContain('❯ /')
    app.feed('/')
    expect(frameText(app)).toContain('Commands')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('clears the draft with Esc when no palette is open', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('plain text')
    expect(frameText(app)).toContain('plain text')
    app.feed('\x1b')
    await flushEsc()
    expect(frameText(app)).not.toContain('plain text')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reopens the palette after Esc dismissed it and cleared the draft', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('/sess') // palette open
    app.feed('\x1b') // dismiss (draft survives)
    await flushEsc()
    app.feed('\x1b') // clear the draft
    await flushEsc()
    app.feed('/') // a fresh slash must reopen the palette
    expect(frameText(app)).toContain('Commands')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('completes the command word with Tab and runs it with Enter', async () => {
    const executed: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [{ name: 'compact', description: 'c' }],
      execute: async (_agent: never, line: string) => {
        executed.push(line)
        return { commandId: 'x', result: { kind: 'success' as const } }
      },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('/')
    app.feed('com')
    app.feed('\t') // complete to the selected match
    expect(frameText(app)).toContain('❯ /compact')
    expect(frameText(app)).toContain('Commands') // the palette stays open
    app.feed('\r')
    await flush()
    expect(executed).toEqual(['/compact'])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('runs an unmatched command word verbatim and reports it unknown', async () => {
    const executed: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [],
      execute: async (_agent: never, line: string) => {
        executed.push(line)
        return undefined
      },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('/')
    app.feed('zzz')
    app.feed('\t') // no match: Tab completes nothing, the draft stays
    expect(frameText(app)).toContain('❯ /zzz')
    app.feed('\r') // no match: the typed line runs verbatim
    await flush()
    expect(executed).toEqual(['/zzz'])
    expect(frameText(app)).toContain('Unknown command: /zzz')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('runs an exactly typed command even when the palette still matches', async () => {
    const executed: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [{ name: 'compact', description: 'c' }, { name: 'compact-all', description: 'ca' }],
      execute: async (_agent: never, line: string) => {
        executed.push(line)
        return { commandId: 'x', result: { kind: 'success' as const } }
      },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('/')
    app.feed('compact')
    app.feed('\r') // exact name wins over the highlighted prefix match
    await flush()
    expect(executed).toEqual(['/compact'])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('exits through /exit (the merged quit command)', async () => {
    let quit = 0
    const { ctx, app } = await bench({}, { plan: false }, () => { quit += 1 })
    app.start()
    app.feed('/')
    app.feed('exit')
    app.feed('\r')
    expect(quit).toBe(1)
    // `/quit` is gone: the palette offers no such entry, only the draft shows.
    app.feed('/')
    app.feed('quit')
    expect(frameText(app)).toContain('❯ /quit')
    expect(frameText(app)).not.toContain('/quit — quit')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('creates a new session through /new', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('/')
    app.feed('new')
    app.feed('\r')
    await flush()
    expect(ctx.sessions.list().length).toBe(1)
    expect(frameText(app)).toContain('New session — type a message below')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('waits for the running turn before /exit quits', async () => {
    let quit = 0
    const { ctx, app } = await bench({
      afterPrompt: (session) => {
        session.append('turn/start', { turn: 1 })
      },
    }, { plan: false }, () => { quit += 1 })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('go')
    app.feed('\r')
    await flush()
    app.feed('/')
    app.feed('exit')
    app.feed('\r') // running: cancels, then quits once idle
    expect(quit).toBe(0)
    await flush()
    expect(quit).toBe(1)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('walks the composer history with Up and Down', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('\x1b[A') // up with no history yet: a no-op
    app.feed('\x1b[B') // down with no history yet: a no-op
    app.feed('one')
    app.feed('\r')
    app.feed('two')
    app.feed('\r')
    app.feed('two') // a consecutive duplicate is not re-recorded
    app.feed('\r')
    await flush()
    app.feed('\x1b[A') // up -> 'two'
    expect(frameText(app)).toContain('❯ two')
    app.feed('\x1b[A') // up -> 'one'
    expect(frameText(app)).toContain('❯ one')
    app.feed('\x1b[A') // up again stays on the oldest entry
    expect(frameText(app)).toContain('❯ one')
    app.feed('\x1b[B') // down -> 'two'
    expect(frameText(app)).toContain('❯ two')
    app.feed('\x1b[B') // down -> parked empty draft
    expect(frameText(app)).toContain('❯  ')
    app.feed('\x1b[B') // down past the parked draft: a no-op
    expect(frameText(app)).toContain('❯  ')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('caps the composer history at one hundred entries', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    for (let index = 0; index < 101; index += 1) {
      app.feed(`m${index}`)
      app.feed('\r')
    }
    await flush()
    for (let presses = 0; presses < 200; presses += 1) app.feed('\x1b[A')
    // 200 Up presses clamp onto the oldest retained entry; the capped-out m0 is gone.
    expect(frameText(app)).toContain('❯ m1')
    expect(frameText(app)).not.toContain('❯ m0')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('constructs without an onQuit callback', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
    const io = fakeIo()
    const app = new TuiApp(ctx, io.io, { plan: false })
    app.start()
    app.feed('\x11') // Ctrl+Q quits through the default no-op callback
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('cuts the draft with Ctrl+A/Ctrl+U/Ctrl+K', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('abcdef')
    app.feed('\x01') // Ctrl+A: caret to start
    app.feed('\x0b') // Ctrl+K: cut to the end
    expect(frameText(app)).not.toContain('abcdef')
    app.feed('abcdef')
    app.feed('\x01')
    app.feed('\x1b[C') // right
    app.feed('\x1b[C')
    app.feed('\x1b[C') // caret after 'abc'
    app.feed('\x0b') // Ctrl+K
    expect(frameText(app)).toContain('❯ abc')
    app.feed('xyz')
    app.feed('\x15') // Ctrl+U: cut to the start
    expect(frameText(app)).not.toContain('xyz')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('answers an approval popup with y/n/esc', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    const agent = ctx.agents.list()[0]
    expect(agent).toBeDefined()
    const request = { agent, toolName: 'bash', signal: undefined }
    const promise = ctx.waterfall('approval/request', request as never, () => Promise.resolve('unavailable' as const))
    await Promise.resolve()
    app.feed('y')
    await expect(promise).resolves.toBe('allowed-once')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('answers a user question popup', async () => {
    const { ctx, app } = await bench()
    const globals = globalThis as unknown as { __tuiQuestionProvider?: { ask: (request: never) => Promise<unknown> } }
    ctx.provide('userQuestions', {
      registerProvider: (provider: { ask: (request: never) => Promise<unknown> }) => {
        globals.__tuiQuestionProvider = provider
      },
    } as never)
    app.start()
    const provider = globals.__tuiQuestionProvider
    expect(provider).toBeDefined()
    const answer = provider?.ask({
      questions: [{ id: 'q1', question: 'pick', options: [{ label: 'A' }, { label: 'B' }] }],
    } as never)
    app.feed('\x1b[B') // down to B
    app.feed('\r')
    const resolved = await answer
    expect(resolved).toEqual({ answers: [{ id: 'q1', selected: ['B'] }] })
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('switches views with Tab and number keys', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t') // leave composer -> sessions
    app.feed('8') // help (dispatchView number keys)
    expect(frameText(app)).toContain('Tab — cycle views')
    app.feed('1') // back to conversation
    app.feed('\x1b') // esc stays in conversation
    app.feed('\t') // sessions again
    app.feed('\t') // jobs
    expect(frameText(app)).not.toContain('Tab — cycle views')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('toggles plan mode when a planMode service is present', async () => {
    const { ctx, app } = await bench()
    const mode = { active: false }
    ctx.provide('planMode', {
      get: () => ({ active: mode.active }),
      set: (_agent: never, active: boolean) => {
        mode.active = active
        return 'committed' as const
      },
    } as never)
    app.start()
    app.feed('\x0e') // need an agent
    await flush()
    app.feed('\x10') // Ctrl+P
    expect(mode.active).toBe(true)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('refreshes jobs, subagents, settings, and skills views', async () => {
    const { ctx, app } = await bench()
    ctx.provide('jobs', {
      list: () => [{ id: 'j1', status: 'running', label: 'bash job' }],
      onJobsChanged: () => () => {},
    } as never)
    ctx.provide('subagents', { listChildren: async () => [{ kind: 'child', id: 's1', activity: 'running', mode: 'one-shot' }] } as never)
    ctx.provide('settings', { describe: () => [{ ns: 'shell' }], get: () => ({}), documentPath: 'C:/settings.yaml' } as never)
    ctx.provide('skills', { list: async () => [{ name: 'skill-a', description: 'a skill', invocation: { modelInvocable: true, userInvocable: true } }] } as never)
    app.start()
    app.feed('\x0e') // create a session so subagents have a parent id
    await flush()
    app.feed('\t') // leave composer -> sessions
    app.feed('7') // skills (dispatchView handles number keys)
    await flush()
    expect(frameText(app)).toContain('skill-a')
    app.feed('3') // jobs
    await flush()
    expect(frameText(app)).toContain('j1')
    app.feed('4') // subagents
    await flush()
    expect(frameText(app)).toContain('s1')
    app.feed('6') // settings
    await flush()
    expect(frameText(app)).toContain('settings file: C:/settings.yaml')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('scrolls the conversation with keys', async () => {
    const { ctx, app } = await bench({
      afterPrompt: (session) => {
        for (let index = 0; index < 30; index += 1) {
          session.append('todo/write', { todos: [{ content: `line ${index}`, status: 'pending' }] })
        }
      },
    })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('q')
    app.feed('\r')
    await flush()
    // Pinned to the newest rows at rest.
    expect(frameText(app)).toContain('line 29')
    expect(frameText(app)).not.toContain('line 8')
    app.feed('\x1b[1;5A') // Ctrl+Up: one row older
    expect(frameText(app)).not.toContain('line 29')
    expect(frameText(app)).toContain('line 8')
    app.feed('\x1b[1;5B') // Ctrl+Down: back to the newest
    expect(frameText(app)).toContain('line 29')
    app.feed('\x1b[<64;1;1M') // wheel up: three rows older
    expect(frameText(app)).not.toContain('line 29')
    app.feed('\x1b[<65;1;1M') // wheel down: back to the newest
    expect(frameText(app)).toContain('line 29')
    app.feed('\x1b[5~') // pageup: ten rows older
    expect(frameText(app)).not.toContain('line 29')
    expect(frameText(app)).toContain('line 0')
    app.feed('\x1b[6~') // pagedown: back to the newest
    expect(frameText(app)).toContain('line 29')
    app.feed('\x1bOP') // an unbound F-key falls through the composer chain
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('selects transcript text with the mouse and copies on release', async () => {
    const { ctx, app, io } = await bench({
      afterPrompt: (session) => {
        for (let index = 0; index < 30; index += 1) {
          session.append('todo/write', { todos: [{ content: `line ${index}`, status: 'pending' }] })
        }
      },
    })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('q')
    app.feed('\r')
    await flush()
    app.frame() // the copy reads back the last painted frame
    // Body row 1 (screen row 2) starts the viewport at '☐ line 9'.
    app.feed('\x1b[<0;2;2M') // press at row 2, col 2
    app.feed('\x1b[<32;9;2M') // drag to col 9 on the same row
    app.feed('\x1b[<3;9;2m') // release: copy the span
    const base64 = Buffer.from(' line 9', 'utf8').toString('base64')
    expect(io.writes.join('')).toContain(`\x1b]52;c;${base64}\x07`)
    // The highlight stays until the next key.
    const highlighted = app.frame().rows[1] ?? ''
    const highlightCells = typeof highlighted === 'string' ? [] : highlighted
    expect(highlightCells.some(cell => cell.style === 'reverse')).toBe(true)
    app.feed('x') // any key clears the highlight
    const cleared = app.frame().rows[1] ?? ''
    const clearedCells = typeof cleared === 'string' ? [] : cleared
    expect(clearedCells.some(cell => cell.style === 'reverse')).toBe(false)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('copies a multi-row mouse selection with per-row bounds', async () => {
    const { ctx, app, io } = await bench({
      afterPrompt: (session) => {
        for (let index = 0; index < 30; index += 1) {
          session.append('todo/write', { todos: [{ content: `line ${index}`, status: 'pending' }] })
        }
      },
    })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('q')
    app.feed('\r')
    await flush()
    app.frame()
    app.feed('\x1b[<0;2;2M') // press row 2, col 2
    app.feed('\x1b[<32;4;4M') // drag to row 4, col 4
    app.feed('\x1b[<3;4;4m') // release
    const base64 = Buffer.from(' line 9\n☐ line 10\n☐ li', 'utf8').toString('base64')
    expect(io.writes.join('')).toContain(`\x1b]52;c;${base64}\x07`)
    // A release without a pending selection is a no-op: no new OSC 52 write.
    app.feed('x') // a key clears the selection first
    const copiesBefore = (io.writes.join('').match(/\x1b\]52;c;/g) ?? []).length
    app.feed('\x1b[<3;9;2m')
    const copiesAfter = (io.writes.join('').match(/\x1b\]52;c;/g) ?? []).length
    expect(copiesAfter).toBe(copiesBefore)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('copies a selection over a blank padded row', async () => {
    const { ctx, app, io } = await bench()
    app.start()
    app.frame()
    // Row 10 of the welcome frame is a padded blank string row.
    app.feed('\x1b[<0;1;10M') // press row 10, col 1
    app.feed('\x1b[<32;4;10M') // drag to col 4
    app.feed('\x1b[<3;4;10m') // release
    const base64 = Buffer.from('    ', 'utf8').toString('base64')
    expect(io.writes.join('')).toContain(`\x1b]52;c;${base64}\x07`)
    const highlighted = app.frame().rows[9] ?? ''
    const cells = typeof highlighted === 'string' ? [] : highlighted
    expect(cells.some(cell => cell.style === 'reverse')).toBe(true)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('drops a mouse selection beyond the frame rows', async () => {
    const { ctx, app, io } = await bench()
    app.start()
    app.frame()
    app.feed('\x1b[<0;1;30M') // press below the 24-row frame
    app.feed('\x1b[<32;2;30M')
    app.feed('\x1b[<3;2;30m') // release copies nothing
    expect(io.writes.join('')).not.toContain('\x1b]52;c;')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('ignores mouse events outside the conversation view', async () => {
    const { ctx, app, io } = await bench()
    app.start()
    app.feed('\t') // sessions view
    app.feed('\x1b[<0;2;2M')
    app.feed('\x1b[<32;9;2M')
    app.feed('\x1b[<3;9;2m')
    app.feed('\x1b[<64;1;1M')
    expect(io.writes.join('')).not.toContain('\x1b]52;c;')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('sending pins the viewport back to the newest rows', async () => {
    const { ctx, app } = await bench({
      afterPrompt: (session) => {
        for (let index = 0; index < 30; index += 1) {
          session.append('todo/write', { todos: [{ content: `line ${index}`, status: 'pending' }] })
        }
      },
    })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('q')
    app.feed('\r')
    await flush()
    app.feed('\x1b[5~') // pageup: read history
    expect(frameText(app)).not.toContain('line 29')
    app.feed('again')
    app.feed('\r') // sending jumps back to the newest rows
    await flush()
    expect(frameText(app)).toContain('line 29')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('dispose restores the terminal exactly once', async () => {
    const { ctx, app, io } = await bench()
    app.start()
    app.dispose()
    expect(io.events).toContain('raw:false')
    expect(io.events).toContain('pause')
    const writes = io.writes.length
    app.dispose()
    expect(io.writes.length).toBe(writes)
    disposers.push(() => ctx.fiber.dispose())
  })

  it('renders without a current session', async () => {
    const { ctx, app } = await bench()
    app.start()
    const frame = app.frame()
    expect(frame.rows.length).toBeGreaterThan(0)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('repaints on terminal resize', async () => {
    const { ctx, app, io } = await bench()
    app.start()
    const before = io.writes.length
    io.resize()
    expect(io.writes.length).toBeGreaterThan(before)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('invokes the quit callback on Ctrl+Q', async () => {
    const { ctx } = await bench()
    let quit = 0
    const io = fakeIo()
    const quitApp = new TuiApp(ctx, io.io, { plan: false }, () => { quit += 1 })
    quitApp.start()
    quitApp.feed('\x11') // Ctrl+Q
    expect(quit).toBe(1)
    quitApp.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('removes a session from the store and falls back to another', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    app.feed('\x0e')
    await Promise.resolve()
    const sessions = ctx.sessions.list()
    for (const session of sessions) {
      ctx.emit('session/disposed', session)
    }
    app.feed('\x03')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('ignores feed after dispose', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.dispose()
    app.feed('x')
    disposers.push(() => ctx.fiber.dispose())
  })

  it('uses the default no-op quit callback when none is supplied', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x11') // Ctrl+Q hits the default onQuit (no-op)
    app.feed('\x03')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('updates the running flag from agent/status events', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e') // create a session with an agent
    await flush()
    const agent = ctx.agents.list()[0]
    if (agent === undefined) throw new Error('expected a created agent')
    ctx.emit('agent/status', { agent, status: 'running' })
    expect(frameText(app)).toContain('running')
    ctx.emit('agent/status', { agent, status: 'idle' })
    expect(frameText(app)).not.toContain('running')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('ignores agent/status for an untracked agent', async () => {
    const { ctx, app } = await bench()
    app.start()
    // A bare agent id the app never tracked: the status event is a no-op.
    const ghost = { id: 'ghost-session' } as unknown as Agent
    ctx.emit('agent/status', { agent: ghost, status: 'running' })
    app.feed('\x03')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('tracks a created session without auto-selecting it', async () => {
    const { ctx, app } = await bench()
    app.start()
    const session = ctx.sessions.create()
    ctx.emit('session/created', session)
    // The app stays empty (welcome pane) until the user acts.
    expect(frameText(app)).toContain('type a message to start a new session')
    app.feed('\t') // sessions view shows the tracked session
    expect(frameText(app)).toContain('New session')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('ignores session events for an untracked session', async () => {
    const { ctx, app } = await bench()
    app.start()
    // A bare session id the app never tracked: the event fold is a no-op.
    const ghost = { id: 'ghost-session' } as unknown as Session
    const event = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as unknown as import('@deepseek-ai/dsh-session').SessionEvent
    ctx.emit('session/event', ghost, event)
    app.feed('\x03')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('folds turn/end events into the running flag', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e') // create a tracked session
    await flush()
    const session = ctx.sessions.list()[0]
    if (session === undefined) throw new Error('expected a created session')
    ctx.emit('session/event', session, { type: 'turn/start', seq: 0, time: 1, data: { turn: 2 } } as never)
    expect(frameText(app)).toContain('running')
    ctx.emit('session/event', session, { type: 'turn/end', seq: 1, time: 2, data: { turn: 2, reason: { kind: 'completed' } } } as never)
    expect(frameText(app)).not.toContain('running')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('clears the running flag on resume even when the log ends inside a turn', async () => {
    // A session interrupted mid-turn persists a trailing turn/start with no
    // turn/end. Resuming constructs the agent idle without emitting an
    // agent/status transition, so the app must sync from the live agent
    // instead of trusting the event stream — otherwise the flag sticks.
    const { ctx, app } = await bench({
      resume: async (ownerCtx, options) => {
        const handle = await makeHandle(ctx, ownerCtx, options.resumeSessionId, {
          agentOptions: options.agentOptions,
          setup: options.setup,
        })
        // The interrupted turn: a start with no matching end, as loaded from
        // persistence (the app folds it into its session state live).
        handle.agent.session.append('turn/start', { turn: 4 })
        return handle
      },
    })
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'cold-2' as never, createdAt: 1, version: 0 }],
      load: async () => ({ meta: null, events: [] }),
    } as never)
    app.start()
    await flush()
    app.feed('\t') // sessions view
    app.feed('\r') // open the cold session (resume)
    await flush()
    const agent = await app.currentAgent()
    expect(agent).toBeDefined()
    expect(frameText(app)).not.toContain('running')
    expect(frameText(app)).toContain('interrupted')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('shows a resumed-open-turn notice only once per resume', async () => {
    const { ctx, app } = await bench({
      resume: async (ownerCtx, options) => {
        const handle = await makeHandle(ctx, ownerCtx, options.resumeSessionId, {
          agentOptions: options.agentOptions,
          setup: options.setup,
        })
        handle.agent.session.append('turn/start', { turn: 1 })
        return handle
      },
    })
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'cold-3' as never, createdAt: 1, version: 0 }],
      load: async () => ({ meta: null, events: [] }),
    } as never)
    app.start()
    await flush()
    app.feed('\t')
    app.feed('\r')
    await flush()
    // Opening again via currentAgent is idempotent: no second notice.
    await app.currentAgent()
    expect(frameText(app)).toContain('interrupted')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('offers compaction when a resumed session is heavy and compacts on y', async () => {
    const executed: string[] = []
    const { ctx, app } = await bench({
      resume: async (ownerCtx, options) => {
        const handle = await makeHandle(ctx, ownerCtx, options.resumeSessionId, {
          agentOptions: options.agentOptions,
          setup: options.setup,
        })
        // A heavy history: 50k prompt-side tokens from a past request.
        handle.agent.session.append('assistant/chunk', {
          turn: 1, step: 1,
          chunk: { type: 'usage', usage: { inputTokens: 50_000, outputTokens: 1000 } },
        } as never)
        return handle
      },
    })
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'cold-4' as never, createdAt: 1, version: 0 }],
      load: async () => ({ meta: null, events: [] }),
    } as never)
    ctx.provide('commands', {
      list: () => [],
      execute: async (_agent: never, line: string) => {
        executed.push(line)
        return { commandId: 'c1', result: { kind: 'success', text: 'Compacted 120 history items (~45k tokens).' } }
      },
    } as never)
    app.start()
    await flush()
    app.feed('\t')
    app.feed('\r') // resume the heavy session
    await flush()
    await app.currentAgent()
    // The compaction offer popup renders (its leading text survives truncation).
    expect(frameText(app)).toContain('Large context')
    app.feed('y') // confirm compaction
    await flush()
    expect(executed).toEqual(['/compact'])
    expect(frameText(app)).toContain('Compacted 120')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('dismissing the compaction offer keeps the session as-is', async () => {
    const executed: string[] = []
    const { ctx, app } = await bench({
      resume: async (ownerCtx, options) => {
        const handle = await makeHandle(ctx, ownerCtx, options.resumeSessionId, {
          agentOptions: options.agentOptions,
          setup: options.setup,
        })
        handle.agent.session.append('assistant/chunk', {
          turn: 1, step: 1,
          chunk: { type: 'usage', usage: { inputTokens: 50_000, outputTokens: 1000 } },
        } as never)
        return handle
      },
    })
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'cold-5' as never, createdAt: 1, version: 0 }],
      load: async () => ({ meta: null, events: [] }),
    } as never)
    ctx.provide('commands', {
      list: () => [],
      execute: async (_agent: never, line: string) => {
        executed.push(line)
        return { commandId: 'c1', result: { kind: 'success', text: 'ok' } }
      },
    } as never)
    app.start()
    await flush()
    app.feed('\t')
    app.feed('\r')
    await flush()
    await app.currentAgent()
    expect(frameText(app)).toContain('Large context')
    app.feed('n') // decline
    await flush()
    expect(executed).toEqual([])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('does not offer compaction for a light resumed session', async () => {
    const { ctx, app } = await bench({
      resume: async (ownerCtx, options) => {
        const handle = await makeHandle(ctx, ownerCtx, options.resumeSessionId, {
          agentOptions: options.agentOptions,
          setup: options.setup,
        })
        return handle
      },
    })
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'cold-6' as never, createdAt: 1, version: 0 }],
      load: async () => ({ meta: null, events: [] }),
    } as never)
    app.start()
    await flush()
    app.feed('\t')
    app.feed('\r')
    await flush()
    expect(frameText(app)).not.toContain('compact')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('refreshes a resumed session selection when a live session exists', async () => {
    const { ctx, app } = await bench()
    app.start()
    const first = ctx.sessions.create()
    ctx.emit('session/created', first)
    await flush()
    const second = ctx.sessions.create()
    ctx.emit('session/created', second)
    await flush()
    expect(frameText(app)).toContain('session')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('merges persisted sessions into the sessions view with their titles', async () => {
    const { ctx, app } = await bench()
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'cold-1' as never, createdAt: 1, version: 0 }],
      load: async (id: string) => ({
        meta: { id, createdAt: 1, version: 0 },
        events: [{ type: 'session/title', seq: 0, time: 1, data: { title: 'Fixing the build' } }],
      }),
    } as never)
    app.start()
    await flush()
    app.feed('\t') // sessions view
    await flush() // the async title load lands
    expect(frameText(app)).toContain('Fixing the build')
    expect(frameText(app)).not.toContain('cold-1')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('keeps the id label when a persisted log cannot load', async () => {
    const { ctx, app } = await bench()
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'cold-1' as never, createdAt: 1, version: 0 }],
      load: async () => { throw new Error('gone') },
    } as never)
    app.start()
    await flush()
    app.feed('\t')
    await flush()
    expect(frameText(app)).toContain('cold-1')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('keeps the current session when a non-current session event arrives', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e') // first session becomes current
    await flush()
    const other = ctx.sessions.create()
    ctx.emit('session/created', other)
    await flush()
    // A turn event on the non-current session must not switch rendering.
    ctx.emit('session/event', other, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as never)
    app.feed('\x03')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('re-emitting the current session id is a no-op', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    const session = ctx.sessions.list()[0]
    if (session === undefined) throw new Error('expected a created session')
    ctx.emit('session/created', session) // current already matches -> ensureCurrent returns early
    app.feed('\x03')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('returns no agent when no session is current', async () => {
    const { ctx, app } = await bench()
    app.start()
    expect(await app.currentAgent()).toBeUndefined()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reuses a live agent when a session is opened from the list', async () => {
    const { ctx, app } = await bench()
    const id = 'live-1' as never
    const handle = await ctx.agents.create({
      sessionId: id,
      agentOptions: { provider: 'p', model: 'm' },
      meta: { cwd: process.cwd() },
    })
    ctx.provide('sessionPersistence', {
      list: async () => [{ id, createdAt: 1, version: 0, cwd: process.cwd() }],
      load: async () => ({ meta: null, events: [] }),
    } as never)
    app.start()
    await flush()
    app.feed('\t') // sessions view
    app.feed('\r') // open the first row (the live session)
    await flush()
    const agent = await app.currentAgent()
    expect(agent).toBeDefined()
    expect(await app.currentAgent()).toBe(agent)
    void handle
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('switches to a freshly created session via newSession', async () => {
    const { ctx, app } = await bench()
    app.start()
    // create() announces session/created synchronously (upsertSession runs
    // inside it), so the explicit ensureCurrent then sees the same id.
    app.newSession()
    const sessions = ctx.sessions.list()
    expect(sessions.length).toBe(1)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('stays empty while the session refresh resolves', async () => {
    const { ctx, app } = await bench()
    ctx.provide('sessionPersistence', {
      list: async () => [],
      load: async () => ({ meta: null, events: [] }),
    } as never)
    app.start()
    // The app stays empty (welcome pane) until the user acts, even while the
    // async session refresh is still resolving.
    const session = ctx.sessions.create()
    expect(frameText(app)).toContain('type a message to start a new session')
    void session
    await flush()
    app.feed('\t') // sessions view shows the tracked session
    expect(frameText(app)).toContain('New session')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('resumes a persisted session opened from the list', async () => {
    const resumed: string[] = []
    const { ctx, app } = await bench({
      resume: async (ownerCtx, options) => {
        resumed.push(options.resumeSessionId)
        return makeHandle(ctx, ownerCtx, options.resumeSessionId, {
          agentOptions: options.agentOptions,
          setup: options.setup,
        })
      },
    })
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'cold-2' as never, createdAt: 1, version: 0 }],
      load: async () => ({ meta: null, events: [] }),
    } as never)
    app.start()
    await flush()
    app.feed('\t') // sessions view
    app.feed('\r') // open the first row (the cold session)
    await flush()
    const agent = await app.currentAgent()
    expect(agent).toBeDefined()
    expect(agent?.id).toBe('cold-2')
    expect(resumed).toEqual(['cold-2'])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('creates a fresh agent when the resume id is unknown to persistence', async () => {
    const { ctx, app } = await bench({}, { resume: 'resume-me' as never, plan: false })
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'cold-2' as never, createdAt: 1, version: 0 }],
      load: async () => ({ meta: null, events: [] }),
    } as never)
    app.start()
    await flush() // startup.resume wins over the merged cold row
    const agent = await app.currentAgent()
    expect(agent).toBeDefined()
    expect(agent?.id).toBe('resume-me')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('rejects an approval popup on n', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    const agent = ctx.agents.list()[0]
    expect(agent).toBeDefined()
    const request = { agent, toolName: 'bash', signal: undefined }
    const promise = ctx.waterfall('approval/request', request as never, () => Promise.resolve('unavailable' as const))
    await Promise.resolve()
    app.feed('n')
    await expect(promise).resolves.toBe('rejected')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('cancels an approval popup on esc', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    const agent = ctx.agents.list()[0]
    expect(agent).toBeDefined()
    const request = { agent, toolName: 'bash', signal: undefined }
    const promise = ctx.waterfall('approval/request', request as never, () => Promise.resolve('unavailable' as const))
    await Promise.resolve()
    app.feed('\x1b')
    await flushEsc() // a lone ESC resolves after the grace period
    await expect(promise).resolves.toBe('cancelled')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('answers an aborted approval request with cancelled', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    const agent = ctx.agents.list()[0]
    expect(agent).toBeDefined()
    const request = { agent, toolName: 'bash', signal: { aborted: true } }
    const promise = ctx.waterfall('approval/request', request as never, () => Promise.resolve('unavailable' as const))
    await expect(promise).resolves.toBe('cancelled')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('navigates a question popup with arrows and dismisses with escape', async () => {
    const { ctx, app } = await bench()
    const globals = globalThis as unknown as { __tuiQuestionProvider?: { ask: (request: never) => Promise<unknown> } }
    ctx.provide('userQuestions', {
      registerProvider: (provider: { ask: (request: never) => Promise<unknown> }) => {
        globals.__tuiQuestionProvider = provider
      },
    } as never)
    app.start()
    const provider = globals.__tuiQuestionProvider
    expect(provider).toBeDefined()
    const answer = provider?.ask({
      questions: [{ id: 'q1', question: 'pick', options: [{ label: 'A' }, { label: 'B' }] }],
    } as never)
    app.feed('\x1b[A') // up clamps at the top
    app.feed('\x1b[B') // down to B
    app.feed('a') // an unmatched key is ignored
    app.feed('\x1b') // escape dismisses with no selection
    await flushEsc() // a lone ESC resolves after the grace period
    const resolved = await answer
    expect(resolved).toEqual({ answers: [{ id: 'q1', selected: [] }] })
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('answers a question with no options', async () => {
    const { ctx, app } = await bench()
    const globals = globalThis as unknown as { __tuiQuestionProvider?: { ask: (request: never) => Promise<unknown> } }
    ctx.provide('userQuestions', {
      registerProvider: (provider: { ask: (request: never) => Promise<unknown> }) => {
        globals.__tuiQuestionProvider = provider
      },
    } as never)
    app.start()
    const provider = globals.__tuiQuestionProvider
    expect(provider).toBeDefined()
    const answer = provider?.ask({
      questions: [{ id: 'q1', question: 'anything' }], // no options field at all
    } as never)
    app.feed('\r')
    const resolved = await answer
    expect(resolved).toEqual({ answers: [{ id: 'q1', selected: [] }] })
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('answers an aborted question request with empty answers', async () => {
    const { ctx, app } = await bench()
    const globals = globalThis as unknown as { __tuiQuestionProvider?: { ask: (request: never) => Promise<unknown> } }
    ctx.provide('userQuestions', {
      registerProvider: (provider: { ask: (request: never) => Promise<unknown> }) => {
        globals.__tuiQuestionProvider = provider
      },
    } as never)
    app.start()
    const provider = globals.__tuiQuestionProvider
    expect(provider).toBeDefined()
    const answer = provider?.ask({
      questions: [{ id: 'q1', question: 'q' }],
      signal: { aborted: true },
    } as never)
    const resolved = await answer
    expect(resolved).toEqual({ answers: [] })
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('opens the model picker on Ctrl+X and selects a model', async () => {
    const { ctx, app } = await bench()
    let saved: unknown
    ctx.provide('llm', {
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => [{ id: 'm1', name: 'M1' }],
    } as never)
    ;(ctx.agentDefaultModel as unknown as { saveSelection: (selection: unknown) => Promise<void> }).saveSelection = async (selection) => {
      saved = selection
    }
    app.start()
    app.feed('\x0e') // an agent installs the per-session selection ref
    await flush()
    app.feed('\x18') // Ctrl+X opens the picker
    await flush() // refreshModelCatalog resolves the provider models
    expect(frameText(app)).toContain('Select model')
    app.feed('\x1b[B') // down (single item stays selected)
    app.feed('\r') // select p1/m1
    await flush()
    expect(saved).toEqual({ provider: 'p1', model: 'm1' })
    expect(frameText(app)).toContain('p1/m1')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('loads and cycles model reasoning efforts with the arrows', async () => {
    const { ctx, app } = await bench()
    let saved: unknown
    ctx.provide('llm', {
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => [{ id: 'm1', name: 'M1' }],
      resolveModelInfo: async () => ({
        provider: 'p1', id: 'm1', name: 'M1',
        reasoning: {
          efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
          defaultEffort: 'high',
        },
      }),
    } as never)
    ;(ctx.agentDefaultModel as unknown as { saveSelection: (selection: unknown) => Promise<void> }).saveSelection = async (selection) => {
      saved = selection
    }
    app.start()
    app.feed('\x0e') // an agent installs the per-session selection ref
    await flush()
    app.feed('/model\r')
    await flush() // the highlighted route's efforts resolve
    expect(frameText(app)).toContain('p1/m1 · High') // default effort highlighted
    app.feed('\x1b[C') // right: cycle to Max
    expect(frameText(app)).toContain('p1/m1 · Max')
    app.feed('\x1b[D') // left: back to High
    app.feed('\r') // select with the pending effort
    await flush()
    expect(saved).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('keeps a model plain when its route has no reasoning efforts', async () => {
    const { ctx, app } = await bench()
    let saved: unknown
    ctx.provide('llm', {
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => [{ id: 'm1', name: 'M1' }],
      resolveModelInfo: async () => ({ provider: 'p1', id: 'm1', name: 'M1' }),
    } as never)
    ;(ctx.agentDefaultModel as unknown as { saveSelection: (selection: unknown) => Promise<void> }).saveSelection = async (selection) => {
      saved = selection
    }
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('/model\r')
    await flush()
    expect(frameText(app)).toContain('p1/m1')
    app.feed('\x1b[C') // no efforts to cycle: the key is ignored
    app.feed('\r') // select without an effort
    await flush()
    expect(saved).toEqual({ provider: 'p1', model: 'm1' })
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('shows the selected reasoning effort in the status line', async () => {
    const { ctx, app } = await bench()
    let saved: unknown
    ctx.provide('llm', {
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => [{ id: 'm1', name: 'M1' }],
      resolveModelInfo: async () => ({
        provider: 'p1', id: 'm1', name: 'M1',
        reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
      }),
    } as never)
    ;(ctx.agentDefaultModel as unknown as { saveSelection: (selection: unknown) => Promise<void> }).saveSelection = async (selection) => {
      saved = selection
    }
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('/model\r')
    await flush()
    app.feed('\r') // select high
    await flush()
    expect(saved).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
    // The status line carries the effort suffix, not just the route.
    expect(frameText(app)).toContain('p1/m1 · high')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('shows accumulated token usage and cache traffic in the status line', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    const session = ctx.sessions.list()[0]
    if (session === undefined) throw new Error('expected a created session')
    ctx.emit('session/event', session, {
      type: 'assistant/chunk', seq: 0, time: 1,
      data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1500, outputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 50 } } },
    } as never)
    expect(frameText(app)).toContain('↑1.5k')
    expect(frameText(app)).toContain('↓200')
    expect(frameText(app)).toContain('cache')
    expect(frameText(app)).toContain('850') // 800 read + 50 write
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('replaces the same-step usage sample instead of double counting', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    const session = ctx.sessions.list()[0]
    if (session === undefined) throw new Error('expected a created session')
    // A usage chunk and the finalized message report the same turn/step; the
    // totals must reflect only the newest sample.
    ctx.emit('session/event', session, {
      type: 'assistant/chunk', seq: 0, time: 1,
      data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } } },
    } as never)
    ctx.emit('session/event', session, {
      type: 'assistant/message', seq: 1, time: 2,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 300, outputTokens: 40 } },
    } as never)
    expect(frameText(app)).toContain('↑300')
    expect(frameText(app)).toContain('↓40')
    expect(frameText(app)).not.toContain('↑400')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('shows the turn elapsed time and token rate while running', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    const session = ctx.sessions.list()[0]
    if (session === undefined) throw new Error('expected a created session')
    ctx.emit('session/event', session, { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as never)
    ctx.emit('session/event', session, {
      type: 'assistant/chunk', seq: 1, time: 2,
      data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 200 } } },
    } as never)
    // Let real time elapse so the elapsed seconds and rate render (a zero
    // elapsed turn suppresses the rate).
    await new Promise(resolve => setTimeout(resolve, 20))
    // 200 output tokens / >0s elapsed = a positive rate.
    expect(frameText(app)).toContain('running')
    expect(frameText(app)).toMatch(/\d+\.\d+s/)
    expect(frameText(app)).toMatch(/\d+\/s/)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('tolerates a failing model info resolution', async () => {
    const { ctx, app } = await bench()
    let saved: unknown
    ctx.provide('llm', {
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => [{ id: 'm1', name: 'M1' }],
      resolveModelInfo: async () => { throw new Error('unresolvable') },
    } as never)
    ;(ctx.agentDefaultModel as unknown as { saveSelection: (selection: unknown) => Promise<void> }).saveSelection = async (selection) => {
      saved = selection
    }
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('/model\r')
    await flush()
    app.feed('\r')
    await flush()
    expect(saved).toEqual({ provider: 'p1', model: 'm1' })
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('scrolls the help view with the page keys', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t') // sessions
    app.feed('8') // help (dispatchView number keys)
    expect(frameText(app)).toContain('Tab — cycle views')
    app.feed('\x1b[6~') // pagedown: deeper sections become visible
    const text = frameText(app)
    expect(text).toContain('/model — switch model')
    app.feed('\x1b[5~') // pageup back to the top
    expect(frameText(app)).toContain('Tab — cycle views')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('opens an empty model picker without an llm service', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x18') // Ctrl+X
    await flush()
    expect(frameText(app)).toContain('Select model')
    app.feed('\x1b') // esc closes the picker
    await flushEsc() // a lone ESC resolves after the grace period
    expect(frameText(app)).not.toContain('Select model')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('selectModelItem ignores a malformed item', async () => {
    const { ctx, app } = await bench()
    app.start()
    await app.selectModelItem('no-slash')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('opens the model picker through /model', async () => {
    const { ctx, app } = await bench()
    let saved: unknown
    ctx.provide('llm', {
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => [{ id: 'm1', name: 'M1' }],
    } as never)
    ;(ctx.agentDefaultModel as unknown as { saveSelection: (selection: unknown) => Promise<void> }).saveSelection = async (selection) => {
      saved = selection
    }
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('/model\r')
    await flush()
    expect(frameText(app)).toContain('Select model')
    app.feed('\r')
    await flush()
    expect(saved).toEqual({ provider: 'p1', model: 'm1' })
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('sends a slash command directly', async () => {
    const executed: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [],
      execute: async (_agent: never, line: string) => {
        executed.push(line)
        return { commandId: 'x', result: { kind: 'success', text: 'ok' } }
      },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    await app.send('/compact')
    expect(executed).toEqual(['/compact'])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('the first message creates a new session automatically', async () => {
    const seen: UserMessage[] = []
    const { ctx, app } = await bench({
      afterPrompt: async (_session, message) => { seen.push(message) },
    })
    app.start()
    expect(ctx.sessions.list().length).toBe(0)
    await app.send('hello') // no current session: one is created on the fly
    await flush()
    const sessions = ctx.sessions.list()
    expect(sessions.length).toBe(1)
    expect(seen).toHaveLength(1)
    const agent = ctx.agents.get(sessions[0]!.id)
    const message = agent?.inbox.nextTurn[0]
    const text = message?.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
    expect(text).toBe('hello')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('renames the current session through the title service', async () => {
    const renamed: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('sessionTitle', {
      rename: (_session: never, title: string) => { renamed.push(title) },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.rename('my title')
    expect(renamed).toEqual(['my title'])
    app.rename('   ') // blank titles are rejected
    expect(renamed).toEqual(['my title'])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('rename without a current session is a no-op', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.rename('x')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('refreshes plan and goal state for a current agent', async () => {
    const { ctx, app } = await bench()
    const mode = { active: false }
    ctx.provide('planMode', {
      get: () => ({ active: mode.active }),
      set: () => 'committed' as const,
    } as never)
    ctx.provide('goals', {
      get: () => ({
        id: 'g1', revision: 1, objective: 'finish', phase: 'active', maxGoalRounds: 10,
        roundsStarted: 0, createdAt: 0, updatedAt: 0, activation: 'armed',
      }),
    } as never)
    // The agent exists before the app starts, so the boot refresh selects the
    // session while the live agent is already registered.
    const handle = await ctx.agents.create({
      sessionId: 'pg-1' as never,
      agentOptions: { provider: 'p', model: 'm' },
      meta: { cwd: process.cwd() },
    })
    app.start()
    await flush()
    // Still the empty welcome: nothing is auto-selected.
    expect(frameText(app)).toContain('type a message to start a new session')
    app.feed('\t') // sessions view
    app.feed('\r') // open the live session
    await flush()
    expect(frameText(app)).toContain('goal: active: finish')
    app.feed('\t') // leave composer
    app.feed('5') // goals view shows the live goal
    expect(frameText(app)).toContain('active: finish')
    void handle
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('shows the goals view without a goal', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t') // leave composer
    app.feed('5') // goals view, nothing set yet
    expect(frameText(app)).toContain('(no goal)')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('arms and reuses the escape flush timer', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x1b') // arm the timer
    app.feed('\x1b') // pending again: the armed timer is reused
    await flushEsc() // fires: pending is a lone ESC, Escape is dispatched
    app.feed('\x18') // Ctrl+X still works after the flush
    await flush()
    expect(frameText(app)).toContain('Select model')
    app.feed('\x1b')
    await flushEsc()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('clears a stale escape timer once the sequence completes', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x1b') // arm the timer
    app.feed('A') // completes the buffer as escape + A
    await flushEsc() // the armed timer now finds nothing pending
    app.feed('\x18')
    await flush()
    expect(frameText(app)).toContain('Select model')
    app.feed('\x1b')
    await flushEsc()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('sending a slash command without a commands service is a no-op', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    await app.send('/compact') // no commands service provided
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('rename with no live agent skips the title service', async () => {
    const { ctx, app } = await bench()
    const renamed: string[] = []
    ctx.provide('sessionTitle', {
      rename: (_session: never, title: string) => { renamed.push(title) },
    } as never)
    app.start()
    ctx.sessions.create() // an agentless store session
    await flush()
    app.feed('\t') // sessions view
    app.feed('\r') // open it: no agent attaches (re-creating the id would collide)
    await flush()
    app.rename('t')
    expect(renamed).toEqual([])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('selectModelItem saves the default model without a session', async () => {
    const { ctx, app } = await bench()
    let saved: unknown
    ;(ctx.agentDefaultModel as unknown as { saveSelection: (selection: unknown) => Promise<void> }).saveSelection = async (selection) => {
      saved = selection
    }
    app.start()
    await app.selectModelItem('p1/m1')
    expect(saved).toEqual({ provider: 'p1', model: 'm1' })
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('answers an approval popup on uppercase Y and ignores other keys', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    const agent = ctx.agents.list()[0]
    expect(agent).toBeDefined()
    const request = { agent, toolName: 'bash', signal: undefined }
    const promise = ctx.waterfall('approval/request', request as never, () => Promise.resolve('unavailable' as const))
    await Promise.resolve()
    app.feed('x') // an unrelated key is ignored
    app.feed('Y') // uppercase accepted
    await expect(promise).resolves.toBe('allowed-once')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('returns to the conversation from another view on escape', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('hello') // composer draft
    app.feed('\t') // sessions view
    app.feed('\x1b') // escape
    await flushEsc()
    app.feed('!') // back in the composer: the draft grows
    expect(frameText(app)).toContain('hello!')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('quits from another view on Ctrl+Q', async () => {
    const { ctx } = await bench()
    let quit = 0
    const io = fakeIo()
    const quitApp = new TuiApp(ctx, io.io, { plan: false }, () => { quit += 1 })
    quitApp.start()
    quitApp.feed('\t') // sessions view
    quitApp.feed('\x11') // Ctrl+Q
    expect(quit).toBe(1)
    quitApp.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('cycles views with Ctrl+T from another view', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t') // sessions
    app.feed('\x14') // Ctrl+T cycles onward
    app.feed('\x1b') // back to conversation
    await flushEsc()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('toggles plan mode from another view', async () => {
    const { ctx, app } = await bench()
    const mode = { active: false }
    ctx.provide('planMode', {
      get: () => ({ active: mode.active }),
      set: (_agent: never, active: boolean) => {
        mode.active = active
        return 'committed' as const
      },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('\t') // sessions view
    app.feed('\x10') // Ctrl+P
    expect(mode.active).toBe(true)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('opens the model picker from another view', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t') // sessions view
    app.feed('\x18') // Ctrl+X
    await flush()
    expect(frameText(app)).toContain('Select model')
    app.feed('\x1b')
    await flushEsc()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('switches to the sessions view with 2 and ignores stray keys', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t') // sessions
    app.feed('2') // sessions again via the 2 key
    app.feed('1') // conversation
    app.feed('\t') // sessions again
    app.feed('a') // an unmatched key in a view is ignored
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('toggles plan mode without an agent or service is a no-op', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x10') // Ctrl+P with no session
    app.feed('\x0e') // create an agent
    await flush()
    app.feed('\x10') // Ctrl+P with an agent but no planMode service
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('renders subagent report entries', async () => {
    const { ctx, app } = await bench()
    ctx.provide('subagents', {
      listChildren: async () => [
        { kind: 'child', id: 's1', activity: 'running', mode: 'one-shot', label: 'bash job' },
        { kind: 'report', id: 'r1', reason: 'completed' },
      ],
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('\t')
    app.feed('4') // subagents view
    await flush()
    const text = frameText(app)
    expect(text).toContain('s1')
    expect(text).toContain('r1 · terminated · completed')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('renders settings and skills views without their services', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t') // leave composer
    app.feed('6') // settings (no settings service)
    app.feed('7') // skills (no skills service)
    await flush()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('surfaces a failed agent creation', async () => {
    const { ctx, app } = await bench({ failCreate: true }, { resume: 'fail-1' as never, plan: false })
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'cold-2' as never, createdAt: 1, version: 0 }],
      load: async () => ({ meta: null, events: [] }),
    } as never)
    app.start()
    await flush() // startup.resume wins; the create factory rejects below
    const agent = await app.currentAgent()
    expect(agent).toBeUndefined()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('tolerates a setup context without an agent', async () => {
    const { ctx, app } = await bench({ bareSetup: true }, { resume: 'bare-1' as never, plan: false })
    ctx.provide('sessionPersistence', {
      list: async () => [{ id: 'cold-2' as never, createdAt: 1, version: 0 }],
      load: async () => ({ meta: null, events: [] }),
    } as never)
    app.start()
    await flush() // startup.resume wins; the create path runs the bare setup
    const agent = await app.currentAgent()
    expect(agent).toBeDefined() // installSelection skipped, agent still created
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('navigates the command palette with up, backspace, and escape', async () => {
    const executed: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [
        { name: 'compact', description: 'compact the session' },
        { name: 'plan', description: 'plan mode' },
      ],
      execute: async (_agent: never, line: string) => {
        executed.push(line)
        return { commandId: 'x', result: { kind: 'success', text: 'ok' } }
      },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('/')
    app.feed('p') // filter narrows to /plan
    app.feed('\x1b[A') // up (cursor clamps at the top)
    app.feed('\x1b[D') // left is ignored by the list popup
    app.feed('\x7f') // backspace clears the filter
    app.feed('\x1b') // escape closes the palette
    await flushEsc() // a lone ESC resolves after the grace period
    expect(frameText(app)).not.toContain('Commands')
    expect(executed).toEqual([])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('opens the command palette and creates a session from another view', async () => {
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [],
      execute: async () => ({ commandId: 'x', result: { kind: 'success', text: 'ok' } }),
    } as never)
    app.start()
    app.feed('\t') // sessions view
    app.feed('/') // palette from a non-conversation view
    expect(frameText(app)).toContain('Commands')
    app.feed('\x1b') // close
    app.feed('\x0e') // Ctrl+N from a non-conversation view
    await flush()
    expect(ctx.sessions.list().length).toBe(1)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('moves the caret right in the composer', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('ab')
    app.feed('\x1b[C') // right
    app.feed('X')
    app.feed('\r')
    await flush()
    const sessions = ctx.sessions.list()
    const agent = ctx.agents.get(sessions[0]!.id)
    const message = agent?.inbox.nextTurn[0]
    const text = message?.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
    expect(text).toBe('abX')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('truncates the status bar to the terminal width', async () => {
    const { ctx } = await bench()
    ;(ctx.agentDefaultModel as unknown as { currentSelection: () => { provider: string; model: string } }).currentSelection = () => ({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-with-a-long-name',
    })
    const io = fakeIo(20, 10)
    const app = new TuiApp(ctx, io.io, { plan: false })
    app.start() // start() refreshes the model even with no session
    const text = frameText(app)
    expect(text).toContain('deepseek-official/') // status bar cut at the 20-col width
    expect(text).not.toContain('long-name')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('shows the default permission preset in the status bar', async () => {
    const { ctx, app } = await bench()
    ctx.provide('permissionPresets', {
      names: ['workspace-write', 'danger-full-access'],
      defaultPreset: 'workspace-write',
      current: () => 'workspace-write',
      set: () => {},
    } as never)
    app.start()
    expect(frameText(app)).toContain('workspace-write')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('applies a mode selection only while a session and presets exist', async () => {
    const set: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('permissionPresets', {
      names: ['workspace-write'],
      defaultPreset: 'workspace-write',
      current: () => 'workspace-write',
      set: (_session: never, name: string) => { set.push(name) },
    } as never)
    app.start()
    app.selectModeItem('workspace-write') // no session and no settings service: a no-op
    expect(set).toEqual([])
    app.feed('\x0e') // create a session
    await flush()
    app.selectModeItem('workspace-write')
    expect(set).toEqual(['workspace-write'])
    expect(frameText(app)).toContain('Permission mode: workspace-write')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('selectModeItem without a presets service is a no-op', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    app.selectModeItem('workspace-write')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('opens the settings document with Ctrl+E', async () => {
    const launches: { cmd: string; args: readonly string[] }[] = []
    const { ctx, app } = await bench({}, { plan: false }, () => {}, (invocation) => {
      launches.push(invocation)
    })
    ctx.provide('settings', {
      describe: () => [],
      get: () => ({}),
      documentPath: 'C:/home/settings.yaml',
      prepareDocument: async () => 'C:/home/settings.yaml',
    } as never)
    vi.stubEnv('EDITOR', 'code')
    app.start()
    app.feed('\x05') // Ctrl+E opens the settings document
    await flush()
    expect(launches).toEqual([{ cmd: 'code', args: [JSON.stringify('C:/home/settings.yaml')] }])
    expect(frameText(app)).toContain('Settings document opened in your editor: C:/home/settings.yaml')
    vi.unstubAllEnvs()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('opens the settings document with Ctrl+E from another view', async () => {
    const launches: { cmd: string; args: readonly string[] }[] = []
    const { ctx, app } = await bench({}, { plan: false }, () => {}, (invocation) => {
      launches.push(invocation)
    })
    ctx.provide('settings', {
      describe: () => [],
      get: () => ({}),
      documentPath: 'C:/home/settings.yaml',
      prepareDocument: async () => 'C:/home/settings.yaml',
    } as never)
    vi.stubEnv('EDITOR', 'vim')
    app.start()
    app.feed('\t') // sessions view
    app.feed('\x05') // Ctrl+E works from any view
    await flush()
    expect(launches).toEqual([{ cmd: 'vim', args: [JSON.stringify('C:/home/settings.yaml')] }])
    vi.unstubAllEnvs()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports when no settings document is available for the editor', async () => {
    const launches: { cmd: string; args: readonly string[] }[] = []
    const { ctx, app } = await bench({}, { plan: false }, () => {}, (invocation) => {
      launches.push(invocation)
    })
    ctx.provide('settings', {
      describe: () => [],
      get: () => ({}),
      documentPath: undefined,
      prepareDocument: async () => undefined,
    } as never)
    app.start()
    app.feed('\x05') // Ctrl+E
    await flush()
    expect(launches).toEqual([])
    expect(frameText(app)).toContain('No settings document is editable here.')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports the editor action when no settings service exists', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x05') // Ctrl+E: no settings service, the notice explains why
    expect(frameText(app)).toContain('No settings document is editable here.')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports when preparing the settings document fails', async () => {
    const { ctx, app } = await bench()
    ctx.provide('settings', {
      describe: () => [],
      get: () => ({}),
      documentPath: undefined,
      prepareDocument: async () => { throw new Error('boom') },
    } as never)
    app.start()
    app.feed('\x05') // Ctrl+E
    await flush()
    expect(frameText(app)).toContain('Opening the settings document failed: Error: boom')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('opens the permission picker through /mode and applies a preset', async () => {
    const set: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('permissionPresets', {
      names: ['workspace-write', 'danger-full-access'],
      defaultPreset: 'workspace-write',
      current: () => 'workspace-write',
      set: (_session: never, name: string) => { set.push(name) },
    } as never)
    app.start()
    app.feed('\x0e') // create a session
    await flush()
    app.feed('/mode\r')
    expect(frameText(app)).toContain('Permission mode')
    expect(frameText(app)).toContain('workspace-write (current)')
    app.feed('\x1b[B') // down to danger-full-access
    app.feed('\r')
    expect(set).toEqual(['danger-full-access'])
    expect(frameText(app)).toContain('Permission mode: danger-full-access')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('/mode before any session edits the default preset for new sessions', async () => {
    const updates: { ns: string; patch: object }[] = []
    const { ctx, app } = await bench()
    ctx.provide('settings', {
      describe: () => [],
      get: () => undefined,
      update: async (ns: string, patch: object) => { updates.push({ ns, patch }) },
    } as never)
    ctx.provide('permissionPresets', {
      names: ['workspace-write', 'danger-full-access'],
      defaultPreset: 'workspace-write',
      current: () => 'workspace-write',
      set: () => {},
    } as never)
    app.start()
    app.feed('/mode\r')
    expect(frameText(app)).toContain('Permission mode')
    expect(frameText(app)).toContain('workspace-write (current)')
    app.feed('\x1b[B\r') // down to danger-full-access, commit
    await flush()
    expect(updates).toEqual([{ ns: 'permission', patch: { defaultPreset: 'danger-full-access' } }])
    expect(frameText(app)).toContain('Permission mode for new sessions: danger-full-access')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports a failed default-preset write', async () => {
    const { ctx, app } = await bench()
    ctx.provide('settings', {
      describe: () => [],
      get: () => undefined,
      update: async () => { throw new Error('boom') },
    } as never)
    ctx.provide('permissionPresets', {
      names: ['workspace-write'],
      defaultPreset: 'workspace-write',
      current: () => 'workspace-write',
      set: () => {},
    } as never)
    app.start()
    app.feed('/mode\r')
    app.feed('\r') // select the current entry
    await flush()
    expect(frameText(app)).toContain('Setting defaultPreset update failed: Error: boom')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('/mode without a presets service reports unavailability', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e') // create a session
    await flush()
    app.feed('/mode\r')
    expect(frameText(app)).toContain('No permission presets are available.')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('expands and collapses the last tool card with Ctrl+O', async () => {
    const { ctx, app } = await bench({
      afterPrompt: (session) => {
        session.append('tool/call', {
          turn: 1, step: 1, callId: 'call-x' as never, name: 'bash', arguments: '{"cmd":"ls"}',
        })
        session.append('tool/result', {
          turn: 1, step: 1,
          message: createToolResultMessage({
            callId: 'call-x' as never,
            content: [{ type: 'text', text: 'file.txt' }],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
      },
    })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('q')
    app.feed('\r')
    await flush()
    expect(frameText(app)).toContain('✓ bash') // collapsed
    app.feed('\x0f') // Ctrl+O expands
    expect(frameText(app)).toContain('▾ bash')
    expect(frameText(app)).toContain('{"cmd":"ls"}')
    app.feed('\x0f') // Ctrl+O collapses again
    expect(frameText(app)).not.toContain('▾ bash')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('toggles the last tool card with an empty Enter', async () => {
    const { ctx, app } = await bench({
      afterPrompt: (session) => {
        session.append('tool/call', {
          turn: 1, step: 1, callId: 'call-x' as never, name: 'bash', arguments: '{"cmd":"ls"}',
        })
        session.append('tool/result', {
          turn: 1, step: 1,
          message: createToolResultMessage({
            callId: 'call-x' as never,
            content: [{ type: 'text', text: 'file.txt' }],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
      },
    })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('q')
    app.feed('\r')
    await flush()
    app.feed('\r') // empty Enter expands the card
    expect(frameText(app)).toContain('▾ bash')
    app.feed('\r') // and collapses it again
    expect(frameText(app)).toContain('✓ bash')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('Ctrl+O without a tool card is a no-op', async () => {
    const { ctx, app } = await bench({
      afterPrompt: (session) => {
        session.append('assistant/message', {
          turn: 1, step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'ok' }],
            source: { provider: 'p', model: 'm' },
          }),
        }, { surfaceOp: 'append' })
      },
    })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('q') // a user message, no tool blocks
    app.feed('\r')
    await flush()
    app.feed('\x0f') // Ctrl+O: no tool found
    app.feed('\t') // sessions view
    app.feed('\x0f') // Ctrl+O from another view
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('Ctrl+O with no session is a no-op', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0f') // Ctrl+O before any session exists
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('navigates to a view from the command palette', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e') // create a session so the sessions view has a row
    await flush()
    app.feed('/')
    app.feed('session') // filter narrows to /sessions
    app.feed('\r') // run the local navigation command
    expect(frameText(app)).toContain('New session') // sessions view lists the session
    app.feed('\x1b') // back to conversation
    await flushEsc()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('filters the sessions view by typed text', async () => {
    const { ctx, app } = await bench()
    app.start()
    for (const id of ['11111111', '22222222'] as never[]) {
      const handle = await ctx.agents.create({ sessionId: id, agentOptions: {}, meta: { cwd: process.cwd() } })
      handle.agent.session.append('session/title', {
        title: id === '11111111' ? 'alpha session' : 'beta session',
        messageSeqs: [],
        source: { kind: 'user' },
      })
    }
    await flush()
    app.feed('\t') // sessions view
    expect(frameText(app)).toContain('alpha session')
    app.feed('beta')
    expect(frameText(app)).toContain('search: beta')
    expect(frameText(app)).not.toContain('alpha session')
    expect(frameText(app)).toContain('beta session')
    app.feed('\x7f') // backspace removes a filter char
    expect(frameText(app)).toContain('search: bet')
    app.feed('\x1b') // escape clears the filter
    await flushEsc()
    expect(frameText(app)).not.toContain('search: bet')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('always-allow switches the permission preset and approves', async () => {
    const set: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('permissionPresets', {
      names: ['workspace-write', 'danger-full-access'],
      defaultPreset: 'workspace-write',
      current: () => 'workspace-write',
      set: (_session: never, name: string) => { set.push(name) },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    const agent = ctx.agents.list()[0]
    expect(agent).toBeDefined()
    const request = { agent, toolName: 'bash', signal: undefined }
    const promise = ctx.waterfall('approval/request', request as never, () => Promise.resolve('unavailable' as const))
    await Promise.resolve()
    app.feed('a') // always allow
    await expect(promise).resolves.toBe('allowed-once')
    expect(set).toEqual(['danger-full-access'])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('always-allow without a current session just approves', async () => {
    const set: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('permissionPresets', {
      names: ['workspace-write', 'danger-full-access'],
      defaultPreset: 'workspace-write',
      current: () => 'workspace-write',
      set: (_session: never, name: string) => { set.push(name) },
    } as never)
    app.start()
    // An agent exists, but the app has no current session selected.
    const handle = await ctx.agents.create({ sessionId: 'solo-1' as never, agentOptions: {}, meta: { cwd: process.cwd() } })
    const agent = ctx.agents.get('solo-1' as never)
    expect(agent).toBeDefined()
    const promise = ctx.waterfall(
      'approval/request',
      { agent, toolName: 'bash', signal: undefined } as never,
      () => Promise.resolve('unavailable' as const),
    )
    await Promise.resolve()
    app.feed('a')
    await expect(promise).resolves.toBe('allowed-once')
    expect(set).toEqual([])
    void handle
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('always-allow when already on danger does not reset', async () => {
    const set: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('permissionPresets', {
      names: ['workspace-write', 'danger-full-access'],
      defaultPreset: 'workspace-write',
      current: () => 'danger-full-access',
      set: (_session: never, name: string) => { set.push(name) },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    const agent = ctx.agents.list()[0]
    expect(agent).toBeDefined()
    const promise = ctx.waterfall('approval/request', { agent, toolName: 'bash', signal: undefined } as never, () => Promise.resolve('unavailable' as const))
    await Promise.resolve()
    app.feed('a')
    await expect(promise).resolves.toBe('allowed-once')
    expect(set).toEqual([])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('backspace with an empty session filter is a no-op', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t') // sessions view
    app.feed('\x7f') // backspace, nothing to remove
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('ignores stray keys in the jobs view', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t') // sessions
    app.feed('\t') // jobs
    app.feed('a') // unmatched key outside the sessions view
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('filters the model picker by typed text', async () => {
    const { ctx, app } = await bench()
    ctx.provide('llm', {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }],
      listModels: async (id: string) => id === 'deepseek'
        ? [{ id: 'v4', name: 'V4' }]
        : [{ id: 'gpt', name: 'GPT' }],
    } as never)
    app.start()
    app.feed('\x18') // Ctrl+X
    await flush()
    expect(frameText(app)).toContain('deepseek/v4')
    app.feed('\x1b[A') // up clamps at the top
    app.feed('\x1b[B') // down to the second row
    app.feed('\x1b[A') // and back up
    app.feed('gpt')
    expect(frameText(app)).toContain('openai/gpt')
    expect(frameText(app)).not.toContain('deepseek/v4')
    app.feed('zzz') // a filter with no matches
    app.feed('\r') // enter with nothing selectable falls through, picker stays
    expect(frameText(app)).toContain('Select model')
    app.feed('\x7f') // backspace narrows the filter back to all matches
    app.feed('\x7f')
    app.feed('\x7f')
    app.feed('\x1b')
    await flushEsc()
    expect(frameText(app)).not.toContain('Select model')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('coalesces streaming repaints to at most 12fps', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, app, io } = await bench({
        afterPrompt: (session) => {
          for (let i = 0; i < 50; i += 1) {
            session.append('assistant/chunk', {
              turn: 1, step: 1, chunk: { type: 'text-delta', index: i, text: 'x' },
            })
          }
        },
      })
      app.start()
      app.feed('\x0e') // create a session
      await vi.advanceTimersByTimeAsync(0)
      app.feed('q')
      app.feed('\r') // send -> 50 chunks arrive through the fold
      await vi.advanceTimersByTimeAsync(0)
      const afterBurst = io.writes.length
      // The burst coalesces into a single pending repaint: no writes yet.
      await vi.advanceTimersByTimeAsync(0)
      expect(io.writes.length).toBe(afterBurst)
      await vi.advanceTimersByTimeAsync(100) // the ~83ms flush fires once
      expect(io.writes.length).toBe(afterBurst + 1)
      app.dispose()
      disposers.push(() => ctx.fiber.dispose())
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-emits a populated session through upsertSession', async () => {
    const { ctx, app } = await bench({
      afterPrompt: (session) => {
        session.append('assistant/message', {
          turn: 1, step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'populated' }],
            source: { provider: 'p', model: 'm' },
          }),
        }, { surfaceOp: 'append' })
      },
    })
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('q')
    app.feed('\r')
    await flush()
    const session = ctx.sessions.list()[0]
    if (session === undefined) throw new Error('expected a session')
    ctx.emit('session/created', session) // upsert refolds the populated log
    expect(frameText(app)).toContain('populated')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('seeds the fold for a session that existed before start', async () => {
    const { ctx, app } = await bench()
    // The session exists in the store before the app starts, so refreshSessions
    // seeds its fold from the live log on boot.
    const handle = await ctx.agents.create({ sessionId: 'pre-1' as never, agentOptions: {}, meta: { cwd: process.cwd() } })
    handle.agent.session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'seeded' }],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    app.start()
    await flush()
    app.feed('\t') // sessions view
    app.feed('\r') // open the live session
    await flush()
    expect(frameText(app)).toContain('seeded')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('ignores event repaints after dispose', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e')
    await flush()
    const session = ctx.sessions.list()[0]
    if (session === undefined) throw new Error('expected a session')
    app.dispose()
    session.append('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' },
    })
    disposers.push(() => ctx.fiber.dispose())
  })

  it('truncates a wide header title by cells', async () => {    const { ctx } = await bench()
    const io = fakeIo(12, 6)
    const app = new TuiApp(ctx, io.io, { plan: false })
    app.start()
    const handle = await ctx.agents.create({ sessionId: 't1' as never, agentOptions: {}, meta: { cwd: process.cwd() } })
    handle.agent.session.append('session/title', {
      title: '中文标题很长',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    app.feed('\t') // sessions view
    app.feed('\r') // open the session
    await flush()
    const text = frameText(app)
    expect(text).toContain('dshcli · 中') // 12 cells fit "dshcli · " + 2 wide cells
    expect(text).not.toContain('很长')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('navigates the sessions view and reopens the current session', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\x0e') // create session A
    await flush()
    app.feed('\t') // sessions view (cursor lands on the current session)
    app.feed('\x1b[A') // up (clamps at the top)
    app.feed('\x1b[B') // down
    app.feed('\r') // reopen the current session (ensureCurrent no-ops)
    await flush()
    expect(frameText(app)).toContain('New session') // header shows the session title
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('handles an empty sessions view', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t') // sessions view (empty)
    app.feed('\r') // enter with nothing to open
    app.feed('\x1b') // esc back to conversation
    await flushEsc()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('sending when the agent cannot be created is a no-op', async () => {
    const { ctx, app } = await bench({ failCreate: true })
    app.start()
    await app.send('hello') // the auto-created session has no agent; send gives up
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('sorts the sessions view by id', async () => {
    const { ctx, app } = await bench()
    app.start()
    // Insert out of order so the sort comparator sees both directions; give
    // each session a logged title so the rows are distinguishable.
    const ids = ['22222222', '33333333', '11111111'] as never[]
    for (const id of ids) {
      const handle = await ctx.agents.create({ sessionId: id, agentOptions: {}, meta: { cwd: process.cwd() } })
      handle.agent.session.append('session/title', {
        title: `t-${id}`,
        messageSeqs: [],
        source: { kind: 'user' },
      })
    }
    await flush()
    app.feed('\t') // sessions view
    const text = frameText(app)
    const a = text.indexOf('t-11111111')
    const b = text.indexOf('t-22222222')
    const c = text.indexOf('t-33333333')
    expect(a).toBeGreaterThan(-1)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('scrolls the sessions list so the cursor stays visible', async () => {
    const { ctx, app } = await bench()
    app.start()
    const ids = Array.from({ length: 30 }, (_, i) => `s${String(i).padStart(8, '0')}`) as never[]
    for (const id of ids) {
      const handle = await ctx.agents.create({ sessionId: id, agentOptions: {}, meta: { cwd: process.cwd() } })
      handle.agent.session.append('session/title', {
        title: `session-${String(id)}`,
        messageSeqs: [],
        source: { kind: 'user' },
      })
    }
    await flush()
    app.feed('\t') // sessions view (cursor lands on the current session, s00000000)
    expect(frameText(app)).toContain('session-s00000000')
    for (let index = 0; index < 29; index += 1) app.feed('\x1b[B') // down to the last row
    const text = frameText(app)
    expect(text).toContain('session-s00000029')
    expect(text).not.toContain('session-s00000000') // scrolled out of the window
    app.feed('\x1b[A') // up: the window scrolls back
    expect(frameText(app)).toContain('session-s00000028')
    for (let index = 0; index < 28; index += 1) app.feed('\x1b[A') // back to the top
    expect(frameText(app)).toContain('session-s00000000')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('docks the command palette above the composer', async () => {
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [{ name: 'compact', description: 'c' }],
      execute: async () => ({ commandId: 'x', result: { kind: 'success' as const } }),
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('/')
    const rows = app.frame().rows
    const commandsRow = rows.findIndex(row => rowText(row).includes('Commands'))
    // The palette sits at the bottom of the body, not over the header.
    expect(commandsRow).toBeGreaterThan(1)
    expect(commandsRow).toBeLessThan(rows.length - 1)
    expect(rowText(rows[1] ?? '')).not.toContain('Commands')
    // The composer stays visible as the last row, and the palette's bottom
    // border sits directly above it (the status line is covered while open).
    expect(rowText(rows[rows.length - 1] ?? '')).toContain('❯')
    expect(rowText(rows[rows.length - 2] ?? '')).toContain('└')
    app.feed('\x1b')
    await flushEsc()
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('caps popups to the window and keeps the input as the last row on a short terminal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
    const globals = globalThis as unknown as { __tuiQuestionProvider?: { ask: (request: never) => Promise<unknown> } }
    ctx.provide('userQuestions', {
      registerProvider: (provider: { ask: (request: never) => Promise<unknown> }) => {
        globals.__tuiQuestionProvider = provider
      },
    } as never)
    const io = fakeIo(80, 8)
    const app = new TuiApp(ctx, io.io, { plan: false })
    app.start()
    app.feed('/') // the grouped palette is taller than the 6 available rows
    const rows = app.frame().rows
    expect(rows).toHaveLength(8)
    // The overlay fills every row between the header and the composer.
    expect(rowText(rows[1] ?? '')).toContain('┌')
    expect(rowText(rows[rows.length - 1] ?? '')).toContain('❯')
    // A question popup taller than the window is sliced to fit it.
    app.feed('\x1b')
    await flushEsc()
    void globals.__tuiQuestionProvider?.ask({
      questions: [{ id: 'q1', question: 'pick', options: Array.from({ length: 12 }, (_, i) => ({ label: `option-${i}` })) }],
    } as never)
    const popupRows = app.frame().rows
    expect(popupRows).toHaveLength(8)
    expect(rowText(popupRows[popupRows.length - 1] ?? '')).toContain('❯')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports unknown and failing commands as notices', async () => {
    const executed: string[] = []
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [],
      execute: async (_agent: never, line: string) => {
        executed.push(line)
        if (line === '/boom') throw new Error('kaboom')
        return undefined // unknown command
      },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    await app.send('/zzz')
    expect(frameText(app)).toContain('Unknown command: /zzz')
    await app.send('/boom')
    await flush()
    expect(executed).toEqual(['/zzz', '/boom'])
    const text = frameText(app)
    // The newest notice replaces the older one: only the failure survives.
    expect(text).toContain('Command failed: Error: kaboom')
    expect(text).not.toContain('Unknown command: /zzz')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('keeps only the newest notice', async () => {
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [],
      execute: async () => undefined,
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    await app.send('/n0')
    expect(frameText(app)).toContain('Unknown command: /n0')
    await app.send('/n1')
    const text = frameText(app)
    expect(text).not.toContain('Unknown command: /n0')
    expect(text).toContain('Unknown command: /n1')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('paints the notice at the bottom of the active view', async () => {
    const { ctx, app } = await bench()
    ctx.provide('commands', {
      list: () => [],
      execute: async () => undefined,
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    await app.send('/n0')
    expect(frameText(app)).toContain('Unknown command: /n0')
    app.feed('\t') // sessions
    app.feed('3') // jobs: the same notice owns the pane's bottom row
    const rows = app.frame().rows
    expect(rowText(rows[rows.length - 3] ?? '')).toContain('Unknown command: /n0')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('kills, expands, and navigates the jobs view through the action picker', async () => {
    const { ctx, app } = await bench()
    const killed: string[] = []
    ctx.provide('jobs', {
      list: () => [
        { id: 'j1', kind: 'bash', label: 'job one', status: 'running', reported: false, startedAt: 0 },
        { id: 'j2', kind: 'fs', label: 'job two', status: 'done', reported: true, startedAt: 0, finishedAt: 1 },
      ],
      kill: (id: string) => { killed.push(id); return 'requested' as const },
      onJobsChanged: () => () => {},
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('\t') // sessions
    app.feed('3') // jobs
    await flush()
    expect(frameText(app)).toContain('j1 · running · job one')
    app.feed('\x1b[B') // down to j2
    expect(frameText(app)).toContain('› j2 · done · job two')
    app.feed('\r') // Enter opens the action picker
    expect(frameText(app)).toContain('details')
    expect(frameText(app)).toContain('kill')
    app.feed('\r') // details: expand j2
    expect(frameText(app)).toContain('reported: true')
    app.feed('\r') // Enter again opens the picker; details collapses
    app.feed('\r')
    expect(frameText(app)).not.toContain('reported: true')
    app.feed('\x1b[A') // up to j1
    app.feed('\r') // picker on j1
    app.feed('\x1b[B') // down to kill
    app.feed('\r') // kill asks for confirmation
    expect(frameText(app)).toContain('Kill job j1?')
    app.feed('n') // declined: nothing killed
    await flush()
    expect(killed).toEqual([])
    app.feed('\r') // picker again
    app.feed('\x1b[B') // down to kill
    app.feed('\r') // confirm again
    app.feed('y')
    await flush()
    expect(killed).toEqual(['j1'])
    app.feed('\x1b') // back to conversation, where the notice renders
    await flushEsc()
    expect(frameText(app)).toContain('Job j1: requested')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('refreshes jobs when the registry reports a change', async () => {
    const { ctx, app } = await bench()
    let listener: (() => void) | undefined
    let label = 'first'
    ctx.provide('jobs', {
      list: () => [{ id: 'j1', kind: 'bash', label, status: 'running', reported: false, startedAt: 0 }],
      onJobsChanged: (next: () => void) => {
        listener = next
        return () => { listener = undefined }
      },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('\t')
    app.feed('3')
    await flush()
    expect(frameText(app)).toContain('j1 · running · first')
    label = 'second'
    listener?.()
    expect(frameText(app)).toContain('j1 · running · second')
    app.dispose()
    expect(listener).toBeUndefined() // dispose removed the subscription
    disposers.push(() => ctx.fiber.dispose())
  })

  it('opens a child session from the subagents view', async () => {
    const { ctx, app } = await bench()
    ctx.provide('subagents', {
      listChildren: async () => [
        { kind: 'child', id: 'child-1', activity: 'running', mode: 'one-shot' },
        { kind: 'report', id: 'r1', reason: 'completed' },
      ],
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('\t')
    app.feed('4')
    await flush()
    expect(frameText(app)).toContain('child-1 · running · one-shot')
    app.feed('\x1b[B') // down to the terminated entry
    app.feed('\r') // terminated entries are not openable
    expect(frameText(app)).toContain('r1 · terminated · completed')
    app.feed('\x1b[A')
    app.feed('\r') // open child-1
    await flush()
    expect(frameText(app)).toContain('New session — type a message below')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('shows the settings pane as a read-only pointer at the document', async () => {
    const { ctx, app } = await bench()
    ctx.provide('settings', {
      describe: () => [
        { ns: 'agent-default-model', schema: {}, value: {}, revision: 0, applies: 'live' },
        { ns: 'llm-deepseek', schema: {}, value: {}, revision: 0, applies: 'live' },
      ],
      get: () => ({}),
      documentPath: 'C:/home/settings.yaml',
      prepareDocument: async () => 'C:/home/settings.yaml',
    } as never)
    app.start()
    app.feed('\t')
    app.feed('6') // settings view
    await flush()
    const text = frameText(app)
    expect(text).toContain('settings file: C:/home/settings.yaml')
    expect(text).toContain('edit the file yourself')
    // No namespace drill-down: the registered namespaces never render.
    expect(text).not.toContain('agent-default-model')
    expect(text).not.toContain('llm-deepseek')
    app.feed('\x1b') // back to the conversation
    await flushEsc()
    expect(frameText(app)).not.toContain('settings file:')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('switches the interface language through /lang and persists it', async () => {
    const updates: { ns: string; patch: object }[] = []
    const { ctx, app } = await bench()
    ctx.provide('settings', {
      describe: () => [],
      get: () => undefined,
      update: async (ns: string, patch: object) => { updates.push({ ns, patch }) },
    } as never)
    app.start()
    // An English notice lands first; the language switch must clear it.
    app.feed('/mode\r')
    expect(frameText(app)).toContain('No permission presets are available.')
    app.feed('/lang\r')
    expect(frameText(app)).toContain('Language')
    expect(frameText(app)).toContain('English')
    expect(frameText(app)).toContain('中文')
    app.feed('\x1b[B') // down to 中文
    app.feed('\r')
    await flush()
    expect(updates).toEqual([{ ns: 'tui', patch: { locale: 'zh' } }])
    expect(frameText(app)).toContain('语言：中文')
    expect(localeName()).toBe('zh')
    // The pre-switch English notice is gone, and the palette's own command
    // descriptions follow the new language.
    expect(frameText(app)).not.toContain('No permission presets are available.')
    app.feed('/')
    expect(frameText(app)).toContain('切换语言')
    expect(frameText(app)).not.toContain('switch language')
    app.feed('\x1b') // dismiss the palette (draft survives)
    await flushEsc()
    app.feed('\x1b') // clear the draft
    await flushEsc()
    // Switch back to English: the picker starts on the current entry.
    app.feed('/lang\r')
    app.feed('\x1b[A') // up to English
    app.feed('\r')
    await flush()
    expect(updates[1]).toEqual({ ns: 'tui', patch: { locale: 'en' } })
    expect(localeName()).toBe('en')
    expect(frameText(app)).toContain('Language: English')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports a failed language write and applies the language anyway', async () => {
    const { ctx, app } = await bench()
    ctx.provide('settings', {
      describe: () => [],
      get: () => undefined,
      update: async () => { throw new Error('conflict') },
    } as never)
    app.start()
    app.feed('/lang\r')
    app.feed('\x1b[B') // down to 中文
    app.feed('\r')
    await flush()
    expect(localeName()).toBe('zh')
    // The failure notice renders in the freshly applied language.
    expect(frameText(app)).toContain('locale 更新失败：Error: conflict')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('applies the language through /lang even without a settings service', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('/lang\r')
    app.feed('\r') // select the current entry (English): a no-op switch
    expect(localeName()).toBe('en')
    expect(frameText(app)).toContain('Language: English')
    app.feed('/lang\r')
    app.feed('\x1b[B') // down to 中文
    app.feed('\r')
    expect(localeName()).toBe('zh')
    expect(frameText(app)).toContain('语言：中文')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('applies a stored tui locale at startup', async () => {
    const { ctx, app } = await bench()
    ctx.provide('settings', {
      describe: () => [],
      get: () => ({ locale: 'zh' }),
      update: async () => {},
    } as never)
    app.start()
    expect(frameText(app)).toContain('dshcli — DeepSeek Harness 终端界面')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })
  it('pauses, completes, and clears goals through the action picker with confirmation', async () => {
    const { ctx, app } = await bench()
    const calls: string[] = []
    const state = { phase: 'active' }
    const goal = () => ({
      id: 'g1', revision: 1, objective: 'finish', phase: state.phase, maxGoalRounds: 10,
      roundsStarted: 0, createdAt: 0, updatedAt: 0, activation: 'armed',
    })
    ctx.provide('goals', {
      get: () => goal(),
      pause: () => { calls.push('pause'); state.phase = 'paused' },
      resume: () => { calls.push('resume'); state.phase = 'active' },
      complete: () => { calls.push('complete'); state.phase = 'complete' },
      clear: () => { calls.push('clear'); state.phase = 'active' },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('\t')
    app.feed('5')
    app.feed('\r') // Enter opens the goal action picker
    expect(frameText(app)).toContain('resume')
    expect(frameText(app)).toContain('clear')
    app.feed('\x1b[B') // down to pause
    app.feed('\r')
    expect(calls).toEqual(['pause'])
    expect(frameText(app)).toContain('paused: finish')
    expect(frameText(app)).toContain('Goal paused')
    app.feed('\r') // picker again
    app.feed('\x1b[B')
    app.feed('\x1b[B') // down to complete
    app.feed('\r') // complete asks for confirmation
    expect(frameText(app)).toContain('Complete goal "finish"?')
    app.feed('z') // an unbound key during the confirm is ignored
    app.feed('N') // declined (uppercase)
    await flush()
    expect(calls).toEqual(['pause'])
    app.feed('\r')
    app.feed('\x1b[B')
    app.feed('\x1b[B')
    app.feed('\r')
    app.feed('Y') // confirmed (uppercase)
    await flush()
    expect(calls).toEqual(['pause', 'complete'])
    expect(frameText(app)).toContain('complete: finish')
    expect(frameText(app)).toContain('Goal completed')
    expect(frameText(app)).not.toContain('Goal paused')
    app.feed('\r') // picker again
    app.feed('\x1b[B')
    app.feed('\x1b[B')
    app.feed('\r') // already complete: no second confirmation
    expect(frameText(app)).not.toContain('Confirm')
    app.feed('\r') // picker again
    app.feed('\x1b[B')
    app.feed('\x1b[B')
    app.feed('\x1b[B') // down to clear
    app.feed('\r') // clearing asks for confirmation
    expect(frameText(app)).toContain('Clear goal "finish"?')
    app.feed('\x1b') // dismissed: nothing cleared
    await flushEsc()
    expect(calls).toEqual(['pause', 'complete'])
    app.feed('\r')
    app.feed('\x1b[B')
    app.feed('\x1b[B')
    app.feed('\x1b[B')
    app.feed('\r')
    app.feed('n') // declined again
    await flush()
    expect(calls).toEqual(['pause', 'complete'])
    app.feed('\r')
    app.feed('\x1b[B')
    app.feed('\x1b[B')
    app.feed('\x1b[B')
    app.feed('\r')
    app.feed('y') // confirmed
    await flush()
    expect(calls).toEqual(['pause', 'complete', 'clear'])
    expect(frameText(app)).toContain('Goal cleared')
    expect(frameText(app)).not.toContain('Goal completed')
    app.feed('\x1b') // back to conversation: the newest notice stays
    await flushEsc()
    const text = frameText(app)
    expect(text).toContain('Goal cleared')
    expect(text).not.toContain('Goal paused')
    expect(text).not.toContain('Goal completed')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('tolerates goal actions without a goal or session', async () => {
    const { ctx, app } = await bench()
    ctx.provide('goals', { get: () => undefined } as never)
    app.start()
    app.feed('\t')
    app.feed('5')
    app.feed('\r') // no goal: the action picker does not open
    expect(frameText(app)).toContain('(no goal)')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports goal action failures', async () => {
    const { ctx, app } = await bench()
    ctx.provide('goals', {
      get: () => ({
        id: 'g1', revision: 1, objective: 'finish', phase: 'paused', maxGoalRounds: 10,
        roundsStarted: 0, createdAt: 0, updatedAt: 0, activation: 'armed',
      }),
      pause: () => { throw new Error('nope') },
      complete: () => { throw new Error('nope') },
      clear: () => { throw new Error('nope') },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('\t')
    app.feed('5')
    app.feed('\r')
    app.feed('\x1b[B') // pause fails
    app.feed('\r')
    app.feed('\r')
    app.feed('\x1b[B')
    app.feed('\x1b[B') // complete fails after confirmation
    app.feed('\r')
    app.feed('y')
    app.feed('\r')
    app.feed('\x1b[B')
    app.feed('\x1b[B')
    app.feed('\x1b[B') // clear fails after confirmation
    app.feed('\r')
    app.feed('y')
    await flush()
    app.feed('\x1b')
    await flushEsc()
    expect(frameText(app)).toContain('Goal action failed: Error: nope')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('invokes a user-invocable skill into the conversation', async () => {
    const sent: string[] = []
    const { ctx, app } = await bench({
      afterPrompt: (_session, message) => {
        const block = message.content.find(entry => entry.type === 'text')
        if (block?.type === 'text') sent.push(block.text)
      },
    })
    ctx.provide('skills', {
      list: async () => [
        { name: 'alpha', description: 'a skill', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'runtime' },
      ],
      get: async (name: string) => ({
        name,
        content: `instructions for ${name}`,
        description: 'a skill',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'runtime',
        provider: 'runtime',
      }),
    } as never)
    app.start()
    app.feed('\t')
    app.feed('7')
    await flush()
    app.feed('\r') // invoke alpha
    await flush()
    const text = frameText(app)
    expect(text).toContain('Loaded skill "alpha"')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('<skill name="alpha">')
    expect(sent[0]).toContain('instructions for alpha')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('kills a job without a current session and reports unavailable results', async () => {
    const { ctx, app } = await bench()
    ctx.provide('jobs', {
      list: () => [{ id: 'j1', kind: 'bash', label: 'job one', status: 'running', reported: false, startedAt: 0 }],
      kill: () => undefined,
      onJobsChanged: () => () => {},
    } as never)
    app.start()
    app.feed('\t') // sessions (no session opened)
    app.feed('3') // jobs
    await flush()
    app.feed('\r') // action picker
    app.feed('\x1b[B') // down to kill
    app.feed('\r') // confirm
    app.feed('y')
    await flush()
    app.feed('\x1b')
    await flushEsc()
    expect(frameText(app)).toContain('Job j1: unavailable')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('tolerates empty and missing services across the list views', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t')
    app.feed('3') // jobs, no service
    await flush()
    expect(frameText(app)).toContain('(no jobs)')
    app.feed('\r') // enter on an empty list
    app.feed('k') // kill on an empty list
    app.feed('\x1b[A') // up on an empty list
    app.feed('\x1b[B') // down on an empty list
    app.feed('4') // subagents, no service
    await flush()
    expect(frameText(app)).toContain('(no subagents)')
    app.feed('\x1b') // escape back
    await flushEsc()
    app.feed('\t')
    app.feed('4')
    app.feed('\r') // enter on an empty subagent list
    app.feed('\x1b[A')
    app.feed('\x1b[B')
    app.feed('6') // settings, no service
    await flush()
    expect(frameText(app)).toContain('(no settings)')
    app.feed('\x1b[A') // up on an empty list
    app.feed('\x1b[B')
    app.feed('\r') // enter on an empty list
    app.feed('\x1b') // escape back
    await flushEsc()
    app.feed('\t')
    app.feed('6')
    app.feed('7') // skills, no service
    await flush()
    expect(frameText(app)).toContain('(no skills)')
    app.feed('\x1b[A')
    app.feed('\x1b[B')
    app.feed('\r') // enter on an empty list
    app.feed('8') // help view
    expect(frameText(app)).toContain('Tab — cycle views')
    app.feed('\x0e') // Ctrl+N works from any view
    await flush()
    expect(ctx.sessions.list().length).toBe(1)
    app.feed('\x1b') // dispatchView escape returns to the conversation
    await flushEsc()
    expect(frameText(app)).not.toContain('Tab — cycle views')
    app.feed('\t')
    app.feed('5') // goals without a service
    app.feed('1') // goals fall-through to dispatchView number keys
    expect(frameText(app)).not.toContain('(no goal)')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('shows an empty settings pane and falls through to view keys', async () => {
    const { ctx, app } = await bench()
    app.start()
    app.feed('\t')
    app.feed('6') // settings without a service
    await flush()
    expect(frameText(app)).toContain('(no settings)')
    expect(frameText(app)).not.toContain('settings file:')
    app.feed('1') // view-key fallthrough back to the conversation
    expect(frameText(app)).not.toContain('(no settings)')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('lists skills for the current workspace', async () => {
    const { ctx, app } = await bench()
    const listed: unknown[] = []
    ctx.provide('skills', {
      list: async (options: unknown) => {
        listed.push(options)
        return []
      },
    } as never)
    app.start()
    app.feed('\t')
    app.feed('7') // skills view
    await flush()
    // The workspace cwd selects the project skill roots the filesystem
    // provider scans; without it the catalog renders empty.
    expect(listed).toEqual([{ cwd: process.cwd() }])
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports skills that refuse user invocation or fail to load', async () => {
    const { ctx, app } = await bench()
    ctx.provide('skills', {
      list: async () => [
        { name: 'locked', description: 'no', invocation: { modelInvocable: true, userInvocable: false }, source: 'runtime', provider: 'runtime' },
        { name: 'broken', description: 'bad', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'runtime' },
        { name: 'missing', description: 'gone', invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime', provider: 'runtime' },
      ],
      get: async (name: string) => {
        if (name === 'broken') throw new Error('boom')
        return undefined
      },
    } as never)
    app.start()
    app.feed('\t')
    app.feed('7')
    await flush()
    app.feed('\r') // locked -> notice, stays in skills
    await flush()
    expect(frameText(app)).toContain('Skill "locked" is not user-invocable')
    app.feed('\x1b[B') // down to broken
    app.feed('\r') // get throws -> notice replaces the previous one
    await flush()
    expect(frameText(app)).toContain('Skill "broken" failed to load: Error: boom')
    expect(frameText(app)).not.toContain('Skill "locked"')
    app.feed('\x1b[B') // down to missing
    app.feed('\r') // get returns nothing -> notice
    await flush()
    expect(frameText(app)).toContain('Skill "missing" failed to load: not found')
    expect(frameText(app)).not.toContain('Skill "broken"')
    app.feed('\x1b') // back to conversation: the newest notice stays
    await flushEsc()
    expect(frameText(app)).toContain('Skill "missing" failed to load: not found')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('resumes a paused goal through the action picker and reports active goals', async () => {
    const { ctx, app } = await bench()
    const resumed: unknown[] = []
    const state = { phase: 'paused' }
    ctx.provide('goals', {
      get: () => ({
        id: 'g1', revision: 1, objective: 'finish', phase: state.phase, maxGoalRounds: 10,
        roundsStarted: 0, createdAt: 0, updatedAt: 0, activation: 'armed',
      }),
      resume: (_agent: never, ref: unknown) => { resumed.push(ref); state.phase = 'active' },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('\t')
    app.feed('5')
    expect(frameText(app)).toContain('paused: finish')
    app.feed('\r') // picker; resume is the first entry
    app.feed('\r')
    await flush()
    expect(resumed).toHaveLength(1)
    expect(frameText(app)).toContain('active: finish')
    expect(frameText(app)).toContain('Goal resumed')
    app.feed('\r') // active goals are not resumed again
    app.feed('\r')
    await flush()
    expect(resumed).toHaveLength(1)
    expect(frameText(app)).toContain('Goal resume failed: goal is active')
    expect(frameText(app)).not.toContain('Goal resumed')
    app.feed('\x1b') // the newest notice stays in the conversation
    await flushEsc()
    expect(frameText(app)).toContain('Goal resume failed: goal is active')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())
  })

  it('reports a goal resume failure and tolerates a missing service', async () => {
    const { ctx, app } = await bench()
    ctx.provide('goals', {
      get: () => ({
        id: 'g1', revision: 1, objective: 'finish', phase: 'paused', maxGoalRounds: 10,
        roundsStarted: 0, createdAt: 0, updatedAt: 0, activation: 'armed',
      }),
      resume: () => { throw new Error('nope') },
    } as never)
    app.start()
    app.feed('\x0e')
    await flush()
    app.feed('\t')
    app.feed('5')
    app.feed('\r') // picker
    app.feed('\r') // resume fails
    await flush()
    app.feed('\x1b')
    await flushEsc()
    expect(frameText(app)).toContain('Goal resume failed: Error: nope')
    app.dispose()
    disposers.push(() => ctx.fiber.dispose())

    // Without any goals service, Enter in the goals view is a no-op.
    const bare = await bench()
    const bareApp = bare.app
    bareApp.start()
    bareApp.feed('\t')
    bareApp.feed('5')
    bareApp.feed('\r')
    expect(frameText(bareApp)).toContain('(no goal)')
    bareApp.dispose()
    disposers.push(() => bare.ctx.fiber.dispose())
  })
})
