/**
 * Package-owned invariant companion for `dsh-tui-plugin`.
 * @module dsh-tui-plugin/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-tui-plugin'

/** Cordis companion plugin name. */
export const name = 'tui-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the TUI is an interactive surface over the core
 * registries; every observable contract (rendered frames, key dispatch,
 * approval/question answer flows) is exercised by the driver and composition
 * suites rather than by a relation the tree itself must audit. It registers
 * nothing and holds no mutable relation to check inside the tree.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
