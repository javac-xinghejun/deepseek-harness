/** One-shot smoke: drive the real packaged sidecar through the shell's own manager. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarManager } from '../apps/desktop/src/main/sidecar-manager.ts'

const root = process.argv[2]
if (root === undefined) throw new Error('usage: smoke-sidecar.ts <server-path>')
const logs = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
const manager = new SidecarManager()
const states = []
manager.onStateChange((state) => { states.push(state.kind) })

try {
  const handle = await manager.start({
    executablePath: root,
    args: ['--profile', 'desktop', '--no-open'],
    readyTimeoutMs: 20_000,
    probeIntervalMs: 400,
    logFilePath: join(logs, 'sidecar.log'),
  })
  if (handle.kind !== 'ready') {
    console.error('SMOKE FAIL: manager reported failure\n' + handle.diagnostic)
    process.exit(1)
  }
  console.log(`SMOKE ready on port ${String(handle.port)}; states=${states.join(',')}`)
  const response = await fetch(`http://127.0.0.1:${String(handle.port)}/`)
  const body = await response.text()
  if (response.status !== 200 || !body.includes('<div id="root">') && !body.includes('__DSH_BOOT__') && !body.includes('<!doctype html>')) {
    console.error(`SMOKE FAIL: GET / status=${String(response.status)} body starts ${body.slice(0, 80)}`)
    process.exit(1)
  }
  console.log(`SMOKE GET / -> ${String(response.status)}, html bytes=${String(body.length)}`)
  await manager.stop()
  console.log(`SMOKE stopped cleanly; final states=${states.join(',')}`)
  rmSync(logs, { recursive: true, force: true })
} catch (error) {
  console.error('SMOKE ERROR', error)
  await manager.stop()
  process.exit(1)
}
