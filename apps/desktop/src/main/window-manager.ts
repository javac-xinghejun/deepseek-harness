/**
 * Main-window lifecycle: one deterministic Chromium view pinned to the
 * sidecar's loopback URL, plus the sidecar-failure recovery page and the
 * open-logs IPC handler.
 * @module @deepseek-ai/dsh-desktop/window-manager
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { App, BrowserWindow } from 'electron'
import { BrowserWindow as RealBrowserWindow, ipcMain, shell } from 'electron'
import { MAIN_PROCESS_API, SECURITY_FLAGS } from './api-names.ts'

/** Bounds every new main window; fits a 768p laptop viewport. */
const MIN_WIDTH = 1024

/** Vertical floor matching {@link MIN_WIDTH}'s intent. */
const MIN_HEIGHT = 720

/** The one window this process owns; null before creation/after close. */
let mainWindow: BrowserWindow | undefined

/**
 * Create the (single) main window pointed at the serving sidecar.
 * @param app - the running application for owner binding.
 * @param url - the loopback URL the ready sidecar serves.
 * @param logsDir - directory the error page's "open logs" verb reveals.
 * @returns the created window; also retrievable through {@link getMainWindow}.
 */
export function createMainWindow(app: App, url: string, logsDir: string): BrowserWindow {
  const window = spawnWindow(app)
  // did-fail-load also reports subframe/embed failures, so only a
  // first-paint failure of the main frame swaps to the recovery page.
  let loadedOnce = false
  window.webContents.on('did-fail-load', (_event, code, description, _validatedUrl, isMainFrame) => {
    if (loadedOnce || !isMainFrame) return
    void window.loadURL(renderErrorDocument(String(code), description))
  })
  window.webContents.on('did-finish-load', () => { loadedOnce = true })
  registerOpenLogsHandler(logsDir)
  void window.loadURL(url)
  return window
}

/**
 * Show the self-contained recovery page inside a fresh window when the
 * sidecar never became reachable and there is nothing to load.
 * @param app - the running application for owner binding.
 * @param diagnostic - human-readable failure summary from the sidecar start.
 * @param logsDir - directory the "open logs" verb reveals.
 * @returns the created window.
 */
export function createErrorWindow(app: App, diagnostic: string, logsDir: string): BrowserWindow {
  const window = spawnWindow(app)
  registerOpenLogsHandler(logsDir)
  void window.loadURL(renderErrorDocument('', diagnostic))
  return window
}

/**
 * The live main window, for update prompts and crash-recovery reloads.
 * @returns the window or null while closed.
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow ?? null
}

/**
 * Point every existing surface back at a (possibly new) sidecar port after
 * a supervised crash restart.
 * @param port - the restarted sidecar's loopback port.
 */
export function reloadMainWindow(port: number): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  void mainWindow.loadURL(`http://127.0.0.1:${String(port)}/`)
}

/** Shared construction with the security baseline and single-instance guard. */
function spawnWindow(app: App): BrowserWindow {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    return mainWindow
  }
  const window = new RealBrowserWindow({
    width: MIN_WIDTH,
    height: MIN_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    webPreferences: {
      ...SECURITY_FLAGS,
      preload: fileURLToPath(new URL('../../src/preload/index.cjs', import.meta.url)),
    },
  })
  window.once('ready-to-show', () => { window.show() })
  window.on('closed', () => { mainWindow = undefined })
  mainWindow = window
  app.on('second-instance', () => {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  return window
}

/**
 * Fill the packaged static recovery document with one concrete failure.
 * Placeholders come straight from src/renderer/error.html.
 * @param code - Chromium error code rendering into the page meta line.
 * @param description - human-readable failure summary.
 * @returns a data: URL carrying the completed document.
 */
function renderErrorDocument(code: string, description: string): string {
  const path = fileURLToPath(new URL('../../src/renderer/error.html', import.meta.url))
  const body = readFileSync(path, 'utf8')
    .replace('DSH_DIAGNOSTIC_CODE', escapeHtml(code))
    .replace('DSH_DIAGNOSTIC_TEXT', escapeHtml(description))
  return `data:text/html;charset=utf-8,${encodeURIComponent(body)}`
}

/** Render one text fragment inert against the HTML document context. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Bind the single whitelisted renderer verb; rebinding replaces prior state,
 * keeping repeated window creations honest about their logs dir.
 * @param logsDir - absolute log directory passed to the OS opener.
 */
function registerOpenLogsHandler(logsDir: string): void {
  ipcMain.removeHandler(MAIN_PROCESS_API.openLogsDir)
  ipcMain.handle(MAIN_PROCESS_API.openLogsDir, async () => shell.openPath(logsDir))
}
