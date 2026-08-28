/**
 * DeepSeek Harness Desktop main-process entry: window lifecycle owned here,
 * agent runtime owned by the sidecar process. Cold start selects a free
 * loopback port, launches the desktop composition through the resolved
 * source (dev pnpm or pkg exe), and loads it once ready.
 * @module @deepseek-ai/dsh-desktop
 */

import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { app } from 'electron'
import { SidecarManager } from './sidecar-manager.ts'
import { createErrorWindow, createMainWindow, getMainWindow, reloadMainWindow } from './window-manager.ts'
import { defaultLayout, resolveSidecarCommand } from './resolve-sidecar-command.ts'
import { initUpdater } from './updater.ts'

/** The sidecar start carries the same composition in dev and prod faces. */
const SIDECAR_LAUNCH = resolveSidecarCommand(
  process.env,
  app.isPackaged ? { sidecarDir: join(process.resourcesPath, 'sidecar') } : defaultLayout(import.meta.url),
)

const manager = new SidecarManager()

/**
 * Application bootstrap: readiness gating, failure surfacing, updater and
 * crash-recovery attachment, then OS signal shutdown.
 */
function main(): void {
  void app.whenReady().then(async () => {
    const logsDir = join(app.getPath('userData'), 'logs')
    const handle = await manager.start({
      executablePath: SIDECAR_LAUNCH.command,
      args: [...SIDECAR_LAUNCH.args],
      logFilePath: join(logsDir, 'sidecar.log'),
    }).catch((error: unknown) => ({
      kind: 'failed' as const,
      diagnostic: error instanceof Error ? error.message : String(error),
    }))
    if (handle.kind !== 'ready') {
      // Render inside Chromium's own window: a shell that never opened one
      // would strand the diagnostic unseen.
      createErrorWindow(app, handle.diagnostic, logsDir)
      return
    }
    createMainWindow(app, `http://127.0.0.1:${String(handle.port)}/`, logsDir)
    attachLifecycle(logsDir)
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { void shutdown(signal === 'SIGTERM' ? 0 : 130) })
  }
  app.on('window-all-closed', () => { void shutdown(0) })
}

/**
 * Attach updater polling and sidecar-crash recovery after first readiness;
 * a supervised restart reloads the window onto the new port.
 * @param logsDir - shared log directory threaded through lifecycle surfaces.
 */
function attachLifecycle(logsDir: string): void {
  manager.onStateChange((state) => {
    if (state.kind === 'ready') reloadMainWindow(state.port)
  })
  initUpdater(autoUpdater, getMainWindow, logsDir)
}

/** Shutdown to quiescence (kill → await exit) before exiting the process. */
async function shutdown(code: number): Promise<void> {
  await manager.stop()
  app.exit(code)
}

main()
