/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-desktop-app`.
 * @module @deepseek-ai/dsh-desktop-app/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-desktop-app'

/** Cordis companion plugin name. */
export const name = 'desktop-app-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bundle contributes a patch layer over rows owned
 * by other packages and holds no event, service, or mutable data relation of
 * its own; behavioral assertions live in tests/desktop-app.spec.ts over the
 * composed tree.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
