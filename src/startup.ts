/**
 * The terminal app's command-line provider: it parses the `dshcli` flag family
 * (`--resume <session>`, `--model <provider/model>`, `--plan`) and its
 * `--help` text, then provides the immutable values as
 * {@link TUI_STARTUP_SERVICE}. Ordinary rows inject that service before reading
 * it from lazy config.
 * @module dsh-tui-plugin/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the TUI rows read from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** `--resume <session>`: open this session on boot (its id as logged). */
  resume?: SessionId
  /** `--model <provider/model>`: initial model selection for new sessions. */
  model?: string
  /** `--plan`: start every new session in plan mode. */
  plan: boolean
}

/** The terminal flag family, as commander parsed it. */
interface TuiOptions {
  resume?: string
  model?: string
  plan?: boolean
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dshcli')
    .description('Interactive terminal UI for the DeepSeek Harness.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <session>', 'open the given session on boot')
    .option('--model <provider/model>', 'initial model selection (provider/model) for new sessions')
    .option('--plan', 'start new sessions in plan mode')
    .addHelpText('after', `
Examples:
  dshcli                              open the terminal UI on a fresh session
  dshcli --resume session-3           resume an existing session
  dshcli --model deepseek/deepseek-v4 --plan
`)
}

/**
 * Parse and provide the terminal invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; a malformed
 * `--model` is a usage error, so on rejection (and on `--help`) nothing is
 * provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts<TuiOptions>()
    if (options.model !== undefined && !/^[^/]+\/[^/]+$/.test(options.model)) {
      program.error(`error: --model must be <provider>/<model>, got ${JSON.stringify(options.model)}`)
    }
    ctx.provide(TUI_STARTUP_SERVICE, {
      ...options.resume === undefined ? {} : { resume: options.resume as SessionId },
      ...options.model === undefined ? {} : { model: options.model },
      plan: options.plan === true,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
