/** Loopback port selection and one bounded TCP probe. */

import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { pickFreePort, probeTcp } from '../src/main/port-probe.ts'

describe('pickFreePort', () => {
  it('returns a plausible port number (listen 0 semantics)', async () => {
    const port = await pickFreePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65_535)
  })
})

describe('probeTcp', () => {
  it('resolves true once the port accepts a connection', async () => {
    const server = createServer().listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => { server.once('listening', resolve) })
    const port = (server.address() as AddressInfo).port
    try {
      await expect(probeTcp(port, { timeoutMs: 1_000 })).resolves.toBe(true)
    } finally {
      server.close()
    }
  })

  it('resolves false against a refused port without throwing', async () => {
    // Port 1 on loopback refuses connects; nothing listens there in tests.
    // The refuse and idle-timeout branches share one guarded terminal path,
    // so late socket events after resolution stay inert.
    await expect(probeTcp(1, { timeoutMs: 250 })).resolves.toBe(false)
  })
})
