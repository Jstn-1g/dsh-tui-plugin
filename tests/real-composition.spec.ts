/**
 * Real-composition guard for the terminal surface. The shipped bundle patches
 * (dsh-base + dsh-tui) boot through the actual `boot`/Loader/Include path the
 * `dshcli` launcher uses, with a hermetic `DSH_HOME`. The tui-runner then
 * drives the real {@link TuiApp} against the REAL host services — settings,
 * sessions, agents, commands, jobs, skills — with no hand-built service mocks;
 * only the process streams are observed. The test cycles to the settings view
 * (a read-only pointer at the document path, no namespace drill-down), then
 * drives `/lang` through the palette picker and asserts the write lands in the
 * durable `$DSH_HOME/settings.yaml` document: editing happens in that file,
 * and the palette commands are the one programmatic write path. It also opens
 * the skills view and requires the workspace catalog the filesystem provider
 * resolves from the process cwd — the same root the Web surface lists.
 *
 * This is the composition contract the mocked `app.spec.ts` harness cannot
 * cover: which settings namespaces the terminal surface actually registers,
 * that the shipped rows settle, that a palette-driven write persists, and
 * that the skills view lists the real workspace catalog.
 */

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'
import { TUI_LOCALE_NS } from '../src/tui/locale-settings.ts'

/**
 * The bundle patch files exactly as the tui layer mounts them: the official
 * base patch first, then this package's patch. The base patch ships with the
 * official `@deepseek-ai/dsh` distribution; point `DSH_BASE_PATCH` at it (a
 * DeepSeek Harness checkout's `packages/bundle/base/cordis.patch.yml` also
 * works). The test fails loud when it is missing rather than silently booting
 * the wrong composition.
 */
const BASE_PATCH = process.env.DSH_BASE_PATCH ?? ''
const TUI_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/**
 * This package's own name, read from package.json: the patch rows reference
 * `dsh-tui-plugin/startup` and `dsh-tui-plugin` (its own exports), but
 * the package is not installed in its own node_modules, so the loader's
 * dynamic import cannot resolve it by name from inside `node_modules`.
 * Resolve those two specifiers to this package's sources instead.
 */
const PKG_NAME = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }
).name

/** Resolve this package's own patch rows to its sources; everything else unchanged. */
function importPatchTarget(specifier: string): string {
  if (specifier === PKG_NAME) return new URL('../src/index.ts', import.meta.url).href
  if (specifier.startsWith(`${PKG_NAME}/`)) {
    const entry = specifier.slice(PKG_NAME.length + 1)
    return new URL(`../src/${entry}.ts`, import.meta.url).href
  }
  return specifier
}

/** The namespace the palette's `/lang` command writes: the terminal surface owns it. */
const TUI_NS = TUI_LOCALE_NS

/** Parse one bundle patch file through the Loader's own entry schema. */
function loadBundlePatches(file: string): PatchOptions[] {
  const parsed = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError(`${file}: bundle patch must parse to a patch list`)
  return parsed as PatchOptions[]
}

let home: string | undefined
let ctx: Context | undefined
let frames: string[] = []
let stdoutSpy: MockInstance | undefined

/** Everything the terminal has painted so far (frames accumulate over renders). */
function painted(): string {
  return frames.join('')
}

/** Feed raw keystrokes through the real wired stdin, as a terminal would. */
function feed(keys: string): void {
  process.stdin.emit('data', keys)
}

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  stdoutSpy?.mockRestore()
  stdoutSpy = undefined
  frames = []
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
  vi.unstubAllEnvs()
})

/**
 * Boot the shipped composition: an empty profile root plus both bundle patch
 * layers, exactly like `dshcli` over the `tui` profile. The prepare hook
 * provides the launcher's cmdline services and routes workspace plugin
 * imports through the ambient test pipeline (the source plane, like every
 * other test import in this repository).
 */
async function bootComposition(): Promise<Context> {
  home = await mkdtemp(join(tmpdir(), 'dsh-tui-composition-'))
  vi.stubEnv('DSH_HOME', home)
  // The skills view lists the provider catalog; this standalone checkout has no
  // `.agents/skills` project root (the official repo does), so seed one skill
  // into the hermetic user root the provider also scans.
  const skillDir = join(home, 'skills', 'dsh-prose-standard')
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: dsh-prose-standard',
      'description: Standalone composition fixture skill',
      '---',
      '',
      'Fixture body.',
      '',
    ].join('\n'),
  )
  const rootConfig = join(home, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  frames = []
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    frames.push(String(chunk))
    return true
  })
  const booted = await boot(
    'dshcli',
    rootConfig,
    [...loadBundlePatches(BASE_PATCH), ...loadBundlePatches(TUI_PATCH)],
    (hostCtx) => {
      provideCmdline(hostCtx, { args: [], exit: () => {} })
      // Resolve workspace plugins through the ambient (vite-node) pipeline so
      // the composition runs from source, like every static test import.
      hostCtx.loader.internal = {
        version: 'v2',
        async import(specifier: string): Promise<unknown> {
          return import(importPatchTarget(specifier))
        },
      } as unknown as NonNullable<typeof hostCtx.loader.internal>
    },
  )
  ctx = booted
  return booted
}

describe('dsh-tui real composition (base + tui bundle patches through the Loader)', () => {
  it('renders the settings overview with the real namespaces and the document path, and a palette-driven /lang write persists to the settings document', async () => {
    const booted = await bootComposition()

    // The composition contract: the host-side namespaces registered by the
    // mounted plugins exist; the web-only client namespaces do not.
    const settings = booted.get('settings')
    expect(settings).toBeDefined()
    const described = settings!.describe().map(entry => String(entry.ns))
    expect(described).toContain('llm-deepseek')
    expect(described).toContain('agent-loop')
    expect(described).toContain('agent-default-model')
    expect(described).toContain('permission')
    expect(described).toContain('web-search-deepseek')
    expect(described).toContain(String(TUI_NS)) // the terminal surface's own locale namespace
    expect(described).not.toContain('ui-theme')

    // The runner paints the conversation frame on the real process stdout.
    await vi.waitFor(() => {
      expect(painted()).toContain('\x1b[?1049h')
    }, { timeout: 30_000 })

    // Cycle to the settings view (6): a read-only pointer at the settings
    // document the user edits themselves — no namespace drill-down.
    feed('\t\t\t\t\t')
    await vi.waitFor(() => {
      expect(painted()).toContain('settings file:')
    }, { timeout: 15_000 })
    // The pane never renders the namespace list the service still describes.
    expect(painted()).not.toContain('llm-deepseek')

    // The palette's /lang picker is the programmatic write path: selecting
    // 中文 persists into the durable document the user edits by hand.
    feed('\x1b') // back to the conversation
    await new Promise(resolve => setTimeout(resolve, 400))
    feed('/lang\r')
    await vi.waitFor(() => {
      expect(painted()).toContain('Language')
    }, { timeout: 15_000 })
    feed('\x1b[B\r') // down to 中文, Enter commits
    await vi.waitFor(() => {
      expect(readFileSync(join(home!, 'settings.yaml'), 'utf8')).toContain('tui:')
      expect(readFileSync(join(home!, 'settings.yaml'), 'utf8')).toContain('locale: zh')
    }, { timeout: 15_000 })
    await vi.waitFor(() => {
      expect((settings!.get(TUI_NS) as { locale?: string }).locale).toBe('zh')
    }, { timeout: 15_000 })
    await vi.waitFor(() => {
      expect(painted()).toContain('语言：中文')
    }, { timeout: 15_000 })

    // The skills view lists the workspace catalog the filesystem provider
    // resolves from the process cwd — the same root the Web surface lists.
    feed('\x1b') // back to the conversation
    await new Promise(resolve => setTimeout(resolve, 400))
    feed('\t\t\t\t\t\t') // cycle to the skills view (7)
    await vi.waitFor(() => {
      expect(painted()).toContain('dsh-prose-standard')
    }, { timeout: 15_000 })

    // The @ mention popup lists skills and real workspace files; Tab completes
    // the highlighted reference into the draft.
    feed('\x1b') // back to the conversation
    await new Promise(resolve => setTimeout(resolve, 400))
    feed('@')
    await vi.waitFor(() => {
      expect(painted()).toContain('引用') // the popup title, in the active language
      expect(painted()).toContain('@dsh-prose-standard') // skills lead the list
    }, { timeout: 15_000 })
    feed('package')
    await vi.waitFor(() => {
      expect(painted()).toContain('@package.json')
    }, { timeout: 15_000 })
    feed('\t') // complete to @package.json (verified by the send below)

    // Sending a message with a file reference attaches the file content as
    // injected context on the same user message (the transcript paints it);
    // the attachment resolves only if the completion inserted the full path.
    feed('\x1b') // clear the draft
    await new Promise(resolve => setTimeout(resolve, 400))
    feed('fix @package.json\r')
    await vi.waitFor(() => {
      expect(painted()).toContain('Attached file: package.json')
    }, { timeout: 15_000 })
  }, 180_000)
})
