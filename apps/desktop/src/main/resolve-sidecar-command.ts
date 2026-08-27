/**
 * Dev/prod launch-source resolution for the sidecar: one pure function both
 * the Electron main process and its tests call, so the desktop profile and
 * port contract cannot drift between development and packaged runs.
 * @module @deepseek-ai/dsh-desktop/resolve-sidecar-command
 */

import { platform, arch } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The dev flag turning the shell into source-launched development mode. */
const DEV_FLAG = 'DSH_DESKTOP_DEV'

/** Host layout facts needed to place the packaged sidecar executable. */
export interface DesktopLayout {
  /** Absolute directory holding `sidecar/dsh-desktop-server-*` resources. */
  resourcesDir: string
}

/** One resolved sidecar launch; `--port <N>` is appended by SidecarManager. */
export interface SidecarCommand {
  /** Executable path (prod) or PATH command (dev pnpm). */
  command: string
  /** Arguments preceding the manager-owned `--port`. */
  args: string[]
}

/**
 * Resolve how the sidecar launches in this environment.
 *
 * Dev (`DSH_DESKTOP_DEV=1`) runs the composition from workspace sources
 * through the dsh launcher; prod uses the pkg-built single-file server under
 * the app's resources directory. Both faces share the exact same
 * `--profile desktop` combination by construction.
 * @param env - the environment whose `${DEV_FLAG}` decides the mode.
 * @param layout - host layout for the packaged sidecar location.
 * @returns the sidecar command without its manager-owned port suffix.
 */
export function resolveSidecarCommand(env: NodeJS.ProcessEnv, layout: DesktopLayout): SidecarCommand {
  if (env[DEV_FLAG] === '1') {
    return {
      command: 'pnpm',
      // --no-open belongs to every face of this command: a desktop shell is
      // itself the browser; no composition may hand off to the system one.
      args: ['dsh', 'web', '--profile', 'desktop', '--no-open'],
    }
  }
  return {
    command: join(layout.resourcesDir, 'sidecar', serverExecutableName()),
    args: ['--profile', 'desktop', '--no-open'],
  }
}

/**
 * The pkg artifact name matching `scripts/build-exe-for-desktop.ts` output,
 * selected for the running host.
 * @returns the sidecar executable file name, `.exe`-suffixed on Windows.
 */
export function serverExecutableName(): string {
  const platformTokens: Partial<Record<ReturnType<typeof platform>, string>> = {
    win32: 'win',
    linux: 'linux',
    darwin: 'darwin',
  }
  const platformToken = platformTokens[platform()] ?? platform()
  return `dsh-desktop-server-${platformToken}-${arch()}${platform() === 'win32' ? '.exe' : ''}`
}

/**
 * Layout for an unpackaged run: the repository's own packaging output next
 * to `apps/`. A packaged application passes `{ resourcesDir:
 * process.resourcesPath }` directly instead.
 * @param entryUrl - import.meta.url of the calling built module (…/apps/desktop/lib/*).
 * @returns the development-side resources directory selection.
 */
export function defaultLayout(entryUrl: string): DesktopLayout {
  // Relative to the FILE url: lib/ → apps/desktop → apps → repository root.
  const repoRoot = fileURLToPath(new URL('../../../..', entryUrl))
  return { resourcesDir: join(repoRoot, 'dist-desktop') }
}
