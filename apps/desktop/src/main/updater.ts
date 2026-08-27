/**
 * Update lifecycle glue over electron-updater: resolves the feed, polls on
 * an interval, and asks before applying. Untested by unit suites (the
 * electron-updater surface is a vendor contract); behavior lives behind the
 * pure {@link ./updater-config.ts} decision module.
 * @module @deepseek-ai/dsh-desktop/updater
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppUpdater } from 'electron-updater'
import type { BrowserWindow } from 'electron'
import { readUpdaterConfig, type UpdaterConfigInput } from './updater-config.ts'

/** Poll cadence; intentionally unconfigurable until a demand exists (YAGNI). */
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000

/** electron-updater channel feeding stable releases. */
const UPDATE_CHANNEL = 'latest'

/** Environment override holding a whole flat feed JSON (CI/testing seam). */
const FEED_ENV = 'DSH_UPDATE_FEED_JSON'

/** Config file name inside the shell's userData directory. */
const FEED_FILE = 'update-feed.json'

/**
 * Resolve the configured feed from the precedence chain env → file →
 * default. Any present-but-broken layer throws: partial configuration is
 * misconfiguration, not a fallback trigger.
 * @param userDataDir - the shell's userData directory.
 * @returns the validated update feed.
 */
function resolveUpdateFeed(userDataDir: string): ReturnType<typeof readUpdaterConfig> {
  const fromEnv = process.env[FEED_ENV]
  if (fromEnv !== undefined && fromEnv !== '') {
    return readUpdaterConfig(parseFeedJson(FEED_ENV, fromEnv))
  }
  try {
    const raw = readFileSync(join(userDataDir, FEED_FILE), 'utf8')
    return readUpdaterConfig(parseFeedJson(FEED_FILE, raw))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return readUpdaterConfig({})
}

/** Parse one flat feed document with its source named in failures. */
function parseFeedJson(source: string, raw: string): UpdaterConfigInput {
  try {
    return JSON.parse(raw) as UpdaterConfigInput
  } catch (error: unknown) {
    throw new Error(`dsh-desktop: ${source} holds invalid update-feed JSON: ${String(error)}`)
  }
}

/**
 * Bind electron-updater to the resolved feed and start periodic checks;
 * a downloaded update raises one modal-less dialog and restarts on confirm.
 * @param autoUpdater - the electron-updater singleton from the app's main.
 * @param window - the main window used to focus update prompts.
 * @param userDataDir - userData directory for feed-file resolution.
 */
export function initUpdater(
  autoUpdater: AppUpdater,
  window: () => BrowserWindow | null,
  userDataDir: string,
): void {
  const feed = resolveUpdateFeed(userDataDir)
  autoUpdater.channel = UPDATE_CHANNEL
  if (feed.provider === 'github') autoUpdater.setFeedURL({ provider: 'github', owner: feed.owner, repo: feed.repo })
  else autoUpdater.setFeedURL({ provider: 'generic', url: feed.url })

  let checking = false
  const check = async (): Promise<void> => {
    if (checking) return
    checking = true
    // A failed check skips this cycle silently; the next interval retries
    // and offline machines must not collect dialogs.
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // Intentionally quiet: probing a feed is best-effort by design.
    } finally {
      checking = false
    }
  }

  autoUpdater.on('update-downloaded', () => {
    void import('electron').then(({ dialog }) => {
      const target = window()
      if (target === null) return
      void dialog.showMessageBox(target, {
        type: 'info',
        message: 'A new version of DeepSeek Harness Desktop has been downloaded.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response !== 0) return
        autoUpdater.quitAndInstall()
      })
    })
  })

  void check()
  setInterval(() => { void check() }, UPDATE_CHECK_INTERVAL_MS).unref()
}
