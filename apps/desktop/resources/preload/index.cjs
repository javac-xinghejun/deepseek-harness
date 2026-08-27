// Sandboxed preload bridge: the only renderer-to-main surface of the shell.
// Sandbox rules require plain CommonJS (no imports, no ESM), so this file is
// authored as JavaScript and pinned to the api-names.ts contract by
// tests/bootstrap.spec.ts, which fails on any channel-string drift.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  /**
   * Open the shell log directory in the OS file manager.
   * @returns {Promise<string>} empty string on success, else the failure text.
   */
  openLogsDir: () => ipcRenderer.invoke('dsh-desktop:openLogsDir'),
})
