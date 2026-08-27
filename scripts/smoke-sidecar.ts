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
const logs = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
const logPath = join(logs, 'sidecar.log')

try {
  const port = await freePort()
  const child = spawn(server, ['--profile', 'desktop', '--no-open', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
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
  child.once('exit', (code, signal) => {
    if (code !== null && code !== 0) console.error(`sidecar exited early (exitCode=${String(code)}, signal=${String(signal)})`)
  })

  try {
    await probeUntil(port)
    const response = await fetch(`http://127.0.0.1:${String(port)}/`)
    if (response.status !== 200 || !/<\/html>/i.test(await response.text())) {
      throw new Error(`GET / was not a rendered page (status ${String(response.status)})`)
    }
    console.log(`SMOKE OK: ready on port ${String(port)}, GET / returned the web surface`)
  } finally {
    await reap(child)
  }
  rmSync(logs, { recursive: true, force: true })
} catch (error) {
  console.error(`SMOKE FAIL (log kept at ${logPath}):`, error instanceof Error ? error.message : error)
  process.exit(1)
}

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

async function reap(child: ReturnType<typeof spawn>): Promise<void> {
  const exited = new Promise<void>((resolvePromise) => {
    child.once('exit', () => resolvePromise())
  })
  try {
    child.kill()
  } catch {
    // An already-exited child raises here; the exit promise below stays valid.
  }
  const escalated = setTimeout(() => {
    try { child.kill('SIGKILL') } catch { /* lost the race to exit */ }
    void exited
  }, 5_000)
  escalated.unref()
  await exited
}
