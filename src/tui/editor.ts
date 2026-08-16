/**
 * Opening the settings document in the user's editor. The invocation is
 * resolved from the environment (pure, unit-tested on every platform branch)
 * and launched detached so the editor outlives the TUI; tests substitute the
 * launcher instead of spawning real processes.
 * @module dsh-tui-plugin/editor
 */

import { spawn } from 'node:child_process'

/** One resolved editor launch: the command and its arguments. */
export interface EditorInvocation {
  /** The executable (or full shell command, resolved via `shell: true`). */
  cmd: string
  /** Arguments appended to the command; the document path comes last. */
  args: readonly string[]
}

/**
 * Resolve how to open `file` in the user's editor from the environment:
 * `$EDITOR`/`$VISUAL` win (they may carry arguments, launched through the
 * shell), then the platform's document opener.
 * @param env - the process environment snapshot.
 * @param platform - the host platform (`process.platform`).
 * @param file - the document path to open.
 * @returns the resolved invocation.
 */
export function editorInvocation(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
  file: string,
): EditorInvocation {
  const editor = env['EDITOR']?.trim() || env['VISUAL']?.trim()
  if (editor !== undefined && editor !== '') return { cmd: editor, args: [JSON.stringify(file)] }
  if (platform === 'win32') return { cmd: 'cmd', args: ['/d', '/c', 'start', '', JSON.stringify(file)] }
  if (platform === 'darwin') return { cmd: 'open', args: [file] }
  return { cmd: 'xdg-open', args: [file] }
}

/**
 * Launch a resolved editor invocation detached from the TUI process.
 * @param cmd - the command to run (through the shell).
 * @param args - its arguments.
 */
/* v8 ignore next 3 -- real process spawn; only the shipped runner launches editors, tests substitute the launcher */
export function launchEditorProcess(cmd: string, args: readonly string[]): void {
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore', shell: true }).unref()
}
