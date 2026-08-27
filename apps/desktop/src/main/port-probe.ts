/**
 * Loopback TCP readiness primitives for the sidecar lifecycle: a free-port
 * picker and one bounded connect probe. Pure node:net logic, no Electron.
 * @module @deepseek-ai/dsh-desktop/port-probe
 */

import { createConnection, createServer } from 'node:net'
import type { Socket } from 'node:net'

/**
 * Ask the OS for a currently-free loopback port (`listen(0)` semantics).
 *
 * The chosen port is free at selection time only; the sidecar's own bind is
 * the authoritative claim, and a probe failure against the picked port is
 * the caller's diagnostic surface for the (millisecond-wide) race window.
 * @returns the selected port number.
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port)
        else reject(new Error('dsh-desktop: pickFreePort did not observe its own listen address'))
      })
    })
  })
}

/**
 * Make exactly one bounded TCP connect attempt to `port` on loopback.
 * @param port - the port to connect to.
 * @param options - probe controls.
 * @param options.timeoutMs - the whole-attempt budget; an unresolved or
 * refused connect within it resolves false rather than throwing.
 * @returns whether a TCP connection was established within the budget.
 */
export function probeTcp(port: number, options: { timeoutMs: number }): Promise<boolean> {
  const socket: Socket = createConnection({ host: '127.0.0.1', port })
  socket.setTimeout(options.timeoutMs)
  return new Promise((resolve) => {
    let settled = false
    // Both terminal shapes — established or refused/timed out — resolve
    // through this single guard so late socket events stay inert.
    const finish = (established: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(established)
    }
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
    socket.once('timeout', () => { finish(false) })
  })
}
