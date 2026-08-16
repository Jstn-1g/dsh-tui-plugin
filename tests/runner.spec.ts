/**
 * The tui-runner plugin: waits for the Loader, starts the terminal surface,
 * wires stdin, and restores the terminal on quit and on tree teardown.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import SessionStore from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { apply, internals } from '../src/index.ts'
import type { TuiIo } from '../src/tui/screen.ts'

const originalInternals = { ...internals }

afterEach(() => {
  Object.assign(internals, originalInternals)
})

/** A fake TuiIo recording stdout writes and stdin registrations. */
function fakeIo(): {
  io: TuiIo
  writes: string[]
  events: string[]
  dataListeners: ((chunk: string) => void)[]
} {
  const writes: string[] = []
  const events: string[] = []
  const dataListeners: ((chunk: string) => void)[] = []
  return {
    writes,
    events,
    dataListeners,
    io: {
      stdout: {
        write: (chunk: string) => { writes.push(chunk); return true },
        columns: 80,
        rows: 24,
        on: (event: string, _listener: () => void) => { events.push(event); return _listener },
        off: (event: string, _listener: () => void) => { events.push(`off:${event}`) },
      },
      stdin: {
        setRawMode: (mode: boolean) => { events.push(`raw:${mode}`) },
        on: (_event: string, listener: (chunk: string) => void) => {
          if (_event === 'data') dataListeners.push(listener)
          return listener
        },
        off: (event: string) => { events.push(`off:${event}`) },
        pause: () => { events.push('pause') },
        resume: () => { events.push('resume') },
      },
    },
  }
}

/** Mount real registries around a scripted agent factory and run the plugin. */
async function boot(
  config: { startup?: { plan: boolean } } = {},
  settings?: unknown,
): Promise<{
  ctx: Context
  io: ReturnType<typeof fakeIo>
  exits: number[]
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
  if (settings !== undefined) ctx.provide('settings', settings as never)
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = {
        id: session.id,
        options: options.agentOptions ?? {},
        session,
        inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
        status: 'idle' as const,
        ctx: ownerCtx.extend({ agent: undefined as never }),
        cancel: () => {},
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (_message: UserMessage) => {},
        steer: () => {},
        inject: () => {},
        whenIdle: () => Promise.resolve(),
      } as unknown as Agent
      await options.setup?.(ownerCtx.extend({ agent }))
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('not used')),
  })
  const io = fakeIo()
  internals.io = io.io
  const exits: number[] = []
  ctx.provide('appExit', (code: number) => { exits.push(code) })
  apply(ctx, { startup: config.startup ?? { plan: false } })
  return { ctx, io, exits }
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

describe('tui-runner', () => {
  it('starts the terminal surface after the loader settles', async () => {
    const { ctx, io } = await boot()
    await Promise.resolve()
    await Promise.resolve()
    expect(io.events).toContain('raw:true')
    expect(io.writes.length).toBeGreaterThan(0)
    disposers.push(() => ctx.fiber.dispose())
  })

  it('routes stdin data into the app', async () => {
    const { ctx, io } = await boot()
    await Promise.resolve()
    io.dataListeners[0]?.('x')
    io.dataListeners[0]?.(Buffer.from('y') as unknown as string)
    disposers.push(() => ctx.fiber.dispose())
  })

  it('requests exit on quit, restores the terminal, and exits the process once the backstop grace elapses', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, io, exits } = await boot()
      await Promise.resolve()
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      try {
        // Ctrl+Q
        io.dataListeners[0]?.('\x11')
        expect(exits).toEqual([0])
        expect(io.events).toContain('raw:false')
        // The backstop fires only after the launcher's grace window: a held
        // event loop must not strand the process after a clean quit.
        expect(exitSpy).not.toHaveBeenCalled()
        vi.advanceTimersByTime(10_000)
        expect(exitSpy).toHaveBeenCalledWith(0)
      } finally {
        exitSpy.mockRestore()
      }
      disposers.push(() => ctx.fiber.dispose())
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores the terminal on tree teardown', async () => {
    const { ctx, io, exits } = await boot()
    await Promise.resolve()
    await ctx.fiber.dispose()
    expect(io.events).toContain('raw:false')
    expect(exits).toEqual([])
  })

  it('prints the resume command for the active session on quit', async () => {
    const { ctx, io, exits } = await boot()
    await Promise.resolve()
    io.dataListeners[0]?.('\x0e') // Ctrl+N: create and select a session
    await Promise.resolve()
    io.dataListeners[0]?.('\x11') // Ctrl+Q quits with the active session
    expect(exits).toEqual([0])
    expect(io.writes.join('')).toContain('dshcli --resume')
    disposers.push(() => ctx.fiber.dispose())
  })

  it('registers the tui locale settings namespace when a settings service exists', async () => {
    const registrations: { ns: string; base: unknown }[] = []
    const { ctx } = await boot({}, {
      register: (ns: unknown, _schema: unknown, options?: { base?: unknown }) => {
        registrations.push({ ns: String(ns), base: options?.base })
        return {
          get: () => ({ locale: 'en' }),
          watch: () => () => {},
          update: async () => {},
          replace: async () => {},
        }
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(registrations).toContainEqual({ ns: 'tui', base: { locale: 'en' } })
    disposers.push(() => ctx.fiber.dispose())
  })

  it('fails loud and requests a failing exit when startup throws', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider: 'p', model: 'm' })
    ctx.agents.setFactory({
      async createAgent(_ownerCtx: Context, _options: CreateAgentOptions): Promise<AgentHandle> {
        throw new Error('not used')
      },
      resume: () => Promise.reject(new Error('not used')),
    })
    const io = fakeIo()
    internals.io = io.io
    const exits: number[] = []
    ctx.provide('appExit', (code: number) => { exits.push(code) })
    // A loader whose settle rejects drives the runner's startup catch path.
    ctx.provide('loader', { await: async () => { throw new Error('boom') } } as never)
    apply(ctx, { startup: { plan: false } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(exits).toEqual([1])
    disposers.push(() => ctx.fiber.dispose())
    void io
  })
})
