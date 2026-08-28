/** One-shot smoke: spawn the packaged sidecar, wait for loopback readiness, fetch `/`, then reap it. */

import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const server = process.argv[2]
if (server === undefined) throw new Error('usage: smoke-sidecar.ts <server-path>')

const PROBE_INTERVAL_MS = 400
const READY_BUDGET_MS = 20_000
const TERM_GRACE_MS = 5_000

const logs = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
const logPath = join(logs, 'sidecar.log')
let verdict = 'FAIL: did not complete'
let exitCode = 1

const port = await freePort()
const child = spawn(server, ['--no-open', '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
// Attach the exit listener before anything can race a fast death.
const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
  child.once('exit', (code, termSignal) => resolvePromise({ code, signal: termSignal }))
})
let logSize = 0
for (const stream of [child.stdout, child.stderr]) {
  stream?.setEncoding('utf8')
  stream?.on('data', (chunk: string) => {
    if (logSize < 8_000_000) {
      logSize += Buffer.byteLength(chunk)
      process.stdout.write(chunk)
    }
  })
}

try {
  await probeUntil(port)
  const response = await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(10_000) })
  const body = await response.text()
  if (response.status !== 200 || !/<\/html>/i.test(body)) {
    throw new Error(`GET / was not a rendered page (status ${String(response.status)})`)
  }
  verdict = `OK: ready on port ${String(port)}, GET / returned the web surface`
  exitCode = 0
} catch (error) {
  verdict = `FAIL: ${error instanceof Error ? error.message : String(error)} (log kept at ${logPath})`
  exitCode = 1
} finally {
  // Bounded teardown: TERM → grace → KILL; the ref'd sentinel keeps this loop
  // alive so the escalation always fires regardless of stream state.
  child.kill()
  const sentinel = setInterval(() => {}, 250)
  const escalation = setTimeout(() => { child.kill('SIGKILL') }, TERM_GRACE_MS)
  const outcome = await Promise.race([
    exited,
    new Promise<null>((resolvePromise) => { setTimeout(() => resolvePromise(null), TERM_GRACE_MS + 1_000).unref() }),
  ])
  clearInterval(sentinel)
  clearTimeout(escalation)
  if (outcome === null) {
    verdict += ' | teardown: child survived TERM+KILL'
    exitCode = 1
  }
  if (exitCode === 0) rmSync(logs, { recursive: true, force: true })
}

console.log(`SMOKE ${verdict}`)
process.exit(exitCode)

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const listener = createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      listener.close(() => {
        if (address !== null && typeof address === 'object') resolvePromise(address.port)
        else reject(new Error('did not observe own listen address'))
      })
    })
  })
}

function probeUntil(target: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + READY_BUDGET_MS
    const tick = (): void => {
      const socket = createConnection({ host: '127.0.0.1', port: target })
      socket.setTimeout(PROBE_INTERVAL_MS)
      socket.once('connect', () => {
        socket.destroy()
        resolvePromise()
      })
      const retry = (): void => {
        socket.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`readiness probe timed out on port ${String(target)}`))
          return
        }
        setTimeout(tick, PROBE_INTERVAL_MS)
      }
      socket.once('error', retry)
      socket.once('timeout', retry)
    }
    tick()
  })
}
