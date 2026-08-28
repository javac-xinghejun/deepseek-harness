/** Dev/prod sidecar launch-source resolution. */

import { describe, expect, it } from 'vitest'
import { resolveSidecarCommand, serverExecutableName } from '../src/main/resolve-sidecar-command.ts'

describe('resolveSidecarCommand', () => {
  it('dev flag selects the source-launched desktop composition through pnpm', () => {
    const resolved = resolveSidecarCommand({ DSH_DESKTOP_DEV: '1' }, { resourcesDir: '/unused' })
    expect(resolved.command).toBe('pnpm')
    expect(resolved.args.slice(0, 4)).toEqual(['dsh', 'web', '--profile', 'desktop'])
    expect(resolved.args).toContain('--no-open')
  })

  it('prod selects the platform-named packaged executable with web-surface flags only', () => {
    const resolved = resolveSidecarCommand({}, { resourcesDir: '/opt/resources' })
    const name = serverExecutableName()
    expect(resolved.command).toBe(`/opt/resources/sidecar/${name}`)
    // The generated packaged entry mounts the composed config itself and has
    // no launcher flag family; SidecarManager appends --port.
    expect(resolved.args).toEqual(['--no-open'])
    expect(name.startsWith('dsh-desktop-server-')).toBe(true)
    if (process.platform === 'win32') expect(name.endsWith('.exe')).toBe(true)
    else expect(name.endsWith('.exe')).toBe(false)
  })

  it('both faces keep the browser handoff disabled', () => {
    // Composition parity (R4): whichever face runs, a desktop shell must
    // never hand off to the system browser; SidecarManager owns the port.
    const dev = resolveSidecarCommand({ DSH_DESKTOP_DEV: '1' }, { resourcesDir: '' })
    const prod = resolveSidecarCommand({}, { resourcesDir: '' })
    expect(dev.args).toContain('--no-open')
    expect(prod.args).toContain('--no-open')
  })
})
