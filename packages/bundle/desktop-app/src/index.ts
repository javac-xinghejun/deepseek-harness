/**
 * @deepseek-ai/dsh-desktop-app — the desktop-surface bundle entry.
 *
 * The composition lives in `cordis.patch.yml` (declared by the
 * `dsh.bundle.patch` manifest field and stacked after
 * {@link https://www.npmjs.com/package/@deepseek-ai/dsh-web-app | @deepseek-ai/dsh-web-app});
 * this module exists so the bundle mounts as an ordinary loader-entry plugin
 * and keeps the `./invariant` seam. Phase-two IPC-carrier rows mount here.
 * @module @deepseek-ai/dsh-desktop-app
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'desktop-app'

/** Services required before this plugin can mount; none today. */
export const inject = [] as const

/**
 * Install nothing: the bundle's effect is its stacked patch rows, and the
 * phase-two carrier rows will provide services of their own rather than read
 * any. The package therefore holds no activation-time behavior to run.
 * @param _ctx - unused while the installer stays empty.
 */
export function apply(_ctx: Context): void {}
