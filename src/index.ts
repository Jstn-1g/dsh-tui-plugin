/**
 * dsh-tui-plugin — the interactive terminal surface. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * waits for the complete application to settle, then drives the terminal UI
 * from the same host services the Web surface serves through its proxy.
 *
 * @module dsh-tui-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { TuiApp } from './tui/app.ts'
import type { TuiIo } from './tui/screen.ts'
import { TUI_LOCALE_NS, TuiLocaleSettings } from './tui/locale-settings.ts'
import { localeName, t } from './tui/i18n.ts'
import type { TuiStartupValues } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the terminal surface can start. */
export const inject = ['tuiStartup', 'sessions', 'agents', 'agentDefaultModel']

/**
 * Hard-exit backstop after a user-requested quit. The launcher's bounded
 * shutdown completes naturally (`process.exitCode` only), so a process whose
 * stdio pipes keep the event loop alive (piped or embedded hosts) never
 * terminates. This grace doubles the launcher's own disposal bound
 * (`PROCESS_SHUTDOWN_TIMEOUT_MS`), so it never cuts a slow teardown short;
 * the timer is unref'd, so a console process whose loop drains at once still
 * exits immediately.
 */
const TUI_EXIT_GRACE_MS = 10_000

/** Plugin config: the flags resolved from this app's injected provider service. */
export interface Config {
  /** The resolved `dshcli` invocation values. */
  startup: TuiStartupValues
}

/** The process IO the TUI drives; tests substitute captures. */
export const internals: { io: TuiIo } = {
  io: {
    stdout: process.stdout,
    stdin: process.stdin,
  },
}

/** Wire raw stdin data into the app's key decoder. */
function wireInput(app: TuiApp, io: TuiIo): () => void {
  const onData = (chunk: string | Buffer): void => {
    app.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  }
  io.stdin.on('data', onData)
  return () => {
    io.stdin.off?.('data', onData)
  }
}

/**
 * Start the terminal surface and keep the process alive until the user quits.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated startup config.
 */
export function apply(ctx: Context, config: Config): void {
  // The terminal surface owns one settings namespace: its interface language,
  // defaulting to the `DSH_TUI_LANG` environment the i18n module already read.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(TUI_LOCALE_NS, TuiLocaleSettings, {
      base: { locale: localeName() },
    })
  })
  const exit = ctx.get('appExit')
  const app = new TuiApp(ctx, internals.io, config.startup, (sessionId) => {
    app.dispose()
    unwire()
    // After the terminal restores, hand the user the exact resume command
    // for the session they just left.
    if (sessionId !== undefined) {
      internals.io.stdout.write(`${t('exit.resumeHint', { id: sessionId })}\n`)
    }
    exit?.(0)
    const exitTimer = setTimeout(() => process.exit(0), TUI_EXIT_GRACE_MS)
    const timerWithUnref = exitTimer as unknown as { unref?: () => void }
    /* v8 ignore next -- Node's Timeout always carries unref; the optional call exists for non-Node timer fakes */
    timerWithUnref.unref?.()
  })
  const unwire = wireInput(app, internals.io)
  // The Loader settles asynchronously: wait for the complete application
  // before starting the TUI so scoped tools and prompt sections are composed.
  void (async () => {
    await ctx.get('loader')?.await()
    app.start()
  })().catch((error: unknown) => {
    app.dispose()
    unwire()
    ctx.logger.warn(`dsh-tui: startup failed: ${String(error)}`)
    exit?.(1)
  })
  // Teardown parity: disposing the tree restores the terminal even when the
  // user never pressed a quit key.
  ctx.effect(() => () => {
    app.dispose()
    unwire()
  }, 'dsh-tui: terminal surface teardown')
}
