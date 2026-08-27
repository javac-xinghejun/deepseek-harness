/**
 * Shared main/preload contract constants: the single source the preload
 * bridge, the window manager IPC handlers, and their tests read so neither
 * side can drift its channel names or renderer security flags.
 * @module @deepseek-ai/dsh-desktop/api-names
 */

/**
 * The whitelist of IPC channels the preload bridge exposes to the renderer;
 * every renderer-facing method must appear here and nowhere else.
 */
export const MAIN_PROCESS_API = {
  /** Opens the shell's log directory in the OS file manager. */
  openLogsDir: 'dsh-desktop:openLogsDir',
} as const

/** The non-negotiable renderer isolation flags every BrowserWindow mounts. */
export const SECURITY_FLAGS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const
