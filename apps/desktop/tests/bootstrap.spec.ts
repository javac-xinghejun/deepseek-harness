/** Bootstrap contract: the preload bridge names and renderer security flags stay pinned. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAIN_PROCESS_API, SECURITY_FLAGS } from '../src/main/api-names.ts'

describe('desktop shell bootstrap', () => {
  it('exposes a single whitelist bridge channel', () => {
    expect(Object.keys(MAIN_PROCESS_API)).toEqual(['openLogsDir'])
  })

  it('pins the renderer isolation flags to their security baseline', () => {
    expect(SECURITY_FLAGS).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true })
  })

  it('keeps the sandboxed CJS preload on the exact api-names channels', () => {
    // The sandbox forbids importing TS contracts in the preload, so this
    // parse-level check is the anti-drift seam between index.cjs and
    // MAIN_PROCESS_API.
    const source = readFileSync(join(import.meta.dirname, '../resources/preload/index.cjs'), 'utf8')
    const channels = [...source.matchAll(/ipcRenderer\.invoke\('([^']+)'\)/gu)].map(match => match[1])
    expect(channels).toEqual([...Object.values(MAIN_PROCESS_API)])
  })
})
