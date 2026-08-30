#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const EXPECTED_TAG = 'dsh-v0.1.2-alpha.2'
const EXPECTED_COMMIT = '0a53fb55bea101816fa226bb964ae2bed71c343b'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function tsPath(path) {
  return path.replaceAll('\\', '/')
}

const sourceContracts = [
  {
    path: 'packages/interaction/commands/src/index.ts',
    fragments: [
      'async execute(',
      'images: readonly EncodedImageAttachment[]',
      'signal: AbortSignal',
    ],
  },
  {
    path: 'packages/interaction/user-questions/src/types.ts',
    fragments: [
      "'user-questions/request'(",
      'request: AskUserQuestionRequestEvent',
      'next: () => Promise<AskUserQuestionAnswer>',
    ],
  },
  {
    path: 'packages/interaction/user-questions/src/index.ts',
    fragments: [
      "this.ctx.waterfall('user-questions/request'",
      'if (request.signal?.aborted)',
      'throw abortedQuestion(error)',
    ],
  },
  {
    path: 'packages/core/tools/src/index.ts',
    fragments: ["mode: z.union(['native', 'ptc', 'both'] as const).default('native')"],
  },
  {
    path: 'packages/core/tools/src/ptc.ts',
    fragments: ["export const RUN_CODE_NAME = 'run_code'"],
  },
  {
    path: 'packages/code-runtime/code-runtime-worker-thread/package.json',
    fragments: ['"name": "@deepseek-ai/dsh-code-runtime-worker-thread"'],
  },
  {
    path: 'packages/bundle/headless/cordis.patch.yml',
    fragments: [
      'mode: !!js process.env.DSH_TOOLS_MODE',
      "name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
    ],
  },
  {
    path: 'packages/todo/tool-todo/src/types.ts',
    fragments: ['export interface TodoItem'],
  },
]

const typeEntries = {
  '@deepseek-ai/cordis': 'vendor/cordis/lib/types/index.d.ts',
  '@deepseek-ai/schemastery': 'vendor/schemastery/lib/types/index.d.ts',
  '@deepseek-ai/dsh-agent': 'packages/core/agent/lib/types/index.d.ts',
  '@deepseek-ai/dsh-agent-default-model': 'packages/core/agent-default-model/lib/types/index.d.ts',
  '@deepseek-ai/dsh-cmdline': 'packages/boot/cmdline/lib/types/index.d.ts',
  '@deepseek-ai/dsh-commands': 'packages/interaction/commands/lib/types/index.d.ts',
  '@deepseek-ai/dsh-goal': 'packages/goal/goal/lib/types/index.d.ts',
  '@deepseek-ai/dsh-invariants': 'packages/runtime-diagnostics/invariants/lib/types/index.d.ts',
  '@deepseek-ai/dsh-jobs': 'packages/jobs/jobs/lib/types/index.d.ts',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm/lib/types/index.d.ts',
  '@deepseek-ai/dsh-permission-presets': 'packages/interaction/permission-presets/lib/types/index.d.ts',
  '@deepseek-ai/dsh-plan-mode': 'packages/plan/plan-mode/lib/types/index.d.ts',
  '@deepseek-ai/dsh-session': 'packages/core/session/lib/types/index.d.ts',
  '@deepseek-ai/dsh-session-persistence': 'packages/session/session-persistence/lib/types/index.d.ts',
  '@deepseek-ai/dsh-session-title': 'packages/session/session-title/lib/types/index.d.ts',
  '@deepseek-ai/dsh-settings': 'packages/settings/settings/lib/types/index.d.ts',
  '@deepseek-ai/dsh-skill': 'packages/skill/skill/lib/types/index.d.ts',
  '@deepseek-ai/dsh-subagent': 'packages/subagent/subagent/lib/types/index.d.ts',
  '@deepseek-ai/dsh-tool-todo': 'packages/todo/tool-todo/lib/types/index.d.ts',
  '@deepseek-ai/dsh-user-approval': 'packages/interaction/user-approval/lib/types/index.d.ts',
  '@deepseek-ai/dsh-user-questions': 'packages/interaction/user-questions/lib/types/index.d.ts',
}

const declarationProjects = [
  ...new Set(Object.values(typeEntries).map(path => path.replace('/lib/types/index.d.ts', '/tsconfig.json'))),
  'packages/code-runtime/code-runtime-worker-thread/tsconfig.json',
]

function fail(message) {
  console.error(`alpha compatibility check: ${message}`)
  process.exit(1)
}

function git(harnessRoot, ...args) {
  const result = spawnSync('git', ['-C', harnessRoot, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) {
    fail(result.error?.message ?? result.stderr.trim() ?? `git ${args.join(' ')} failed`)
  }
  return result.stdout.trim()
}

const configuredRoot = process.env.DSH_HARNESS_ROOT
if (configuredRoot === undefined || configuredRoot.trim() === '') {
  fail('DSH_HARNESS_ROOT must point to an exact DeepSeek Harness source checkout')
}
if (!isAbsolute(configuredRoot)) fail('DSH_HARNESS_ROOT must be an absolute path')
const harnessRoot = resolve(configuredRoot)
if (!existsSync(join(harnessRoot, '.git'))) fail(`${harnessRoot} is not a Git checkout`)

const head = git(harnessRoot, 'rev-parse', 'HEAD')
const taggedCommit = git(harnessRoot, 'rev-parse', `${EXPECTED_TAG}^{commit}`)
if (head !== EXPECTED_COMMIT || taggedCommit !== EXPECTED_COMMIT) {
  fail(`expected ${EXPECTED_TAG} at ${EXPECTED_COMMIT}, received HEAD ${head}`)
}
if (git(harnessRoot, 'status', '--porcelain') !== '') {
  fail('the Harness checkout has local changes; refusing ambiguous compatibility evidence')
}

// Pin the contract to tracked source, never ignored/stale build output. The
// source compile below follows the exact checkout's own path facade.
for (const contract of sourceContracts) {
  git(harnessRoot, 'ls-files', '--error-unmatch', contract.path)
  const source = await readFile(join(harnessRoot, contract.path), 'utf8')
  for (const fragment of contract.fragments) {
    if (!source.includes(fragment)) {
      fail(`expected source contract ${JSON.stringify(fragment)} in ${contract.path}`)
    }
  }
}
git(harnessRoot, 'ls-files', '--error-unmatch', 'tsconfig.base.json')

const tuiPatch = await readFile(join(projectRoot, 'cordis.patch.yml'), 'utf8')
for (const fragment of [
  'mode: !!js process.env.DSH_TOOLS_MODE',
  "name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
]) {
  if (!tuiPatch.includes(fragment)) fail(`the TUI patch no longer carries ${JSON.stringify(fragment)}`)
}
const tuiPackage = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const workerPeer = tuiPackage.peerDependencies?.['@deepseek-ai/dsh-code-runtime-worker-thread']
if (workerPeer !== '0.1.2-alpha.2') {
  fail('the TUI package does not declare the exact alpha worker-thread runtime as compatible')
}

const typeRoot = join(harnessRoot, 'node_modules', '@types')
const tsc = join(harnessRoot, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(join(typeRoot, 'node'))) fail(`missing Harness Node declarations under ${typeRoot}`)
if (!existsSync(tsc)) fail(`missing Harness TypeScript compiler at ${tsc}`)

for (const project of declarationProjects) git(harnessRoot, 'ls-files', '--error-unmatch', project)

// Force only the plugin's exact package dependency closure to regenerate its
// declarations. `--emitDeclarationOnly` avoids the multi-gigabyte full-host
// runtime build while still preventing ignored lib/ output or tsbuildinfo from
// making this consumer check pass against another commit.
const rebuild = spawnSync(process.execPath, [
  tsc,
  '-b',
  ...declarationProjects,
  '--force',
  '--emitDeclarationOnly',
  '--pretty',
  'false',
], {
  cwd: harnessRoot,
  stdio: 'inherit',
  windowsHide: true,
})
if (rebuild.error !== undefined) fail(rebuild.error.message)
if (rebuild.status !== 0) fail('the exact Harness package declaration rebuild failed')

const paths = {}
for (const [specifier, relativePath] of Object.entries(typeEntries)) {
  const declaration = join(harnessRoot, relativePath)
  if (!existsSync(declaration)) {
    fail(`the exact Harness rebuild did not produce ${specifier}: ${declaration}`)
  }
  paths[specifier] = [tsPath(declaration)]
}

const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-tui-alpha-types-'))
const configPath = join(tempRoot, 'tsconfig.json')
const config = {
  compilerOptions: {
    target: 'ES2024',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    typeRoots: [tsPath(typeRoot)],
    types: ['node'],
    paths,
  },
  include: [tsPath(join(projectRoot, 'src', '**', '*.ts'))],
}

let compileError
let compileStatus = 0
try {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  const result = spawnSync(process.execPath, [tsc, '-p', configPath, '--pretty', 'false'], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
  })
  compileError = result.error
  compileStatus = result.status ?? 1
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}

if (compileError !== undefined) fail(compileError.message)
if (compileStatus !== 0) {
  process.exitCode = compileStatus
} else {
  console.log(`Exact-alpha tracked-source compatibility check passed: ${EXPECTED_TAG} (${EXPECTED_COMMIT})`)
}
