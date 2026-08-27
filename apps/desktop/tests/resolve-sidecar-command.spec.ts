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

  it('prod selects the platform-named packaged executable under resources/sidecar', () => {
    const resolved = resolveSidecarCommand({}, { resourcesDir: '/opt/resources' })
    const name = serverExecutableName()
    expect(resolved.command).toBe(`/opt/resources/sidecar/${name}`)
    expect(resolved.args.slice(0, 3)).toEqual(['--profile', 'desktop', '--no-open'])
    expect(name.startsWith('dsh-desktop-server-')).toBe(true)
    if (process.platform === 'win32') expect(name.endsWith('.exe')).toBe(true)
    else expect(name.endsWith('.exe')).toBe(false)
  })

  it('the dev face shares the exact prod profile combination', () => {
    // Composition parity is the R4 mitigation: both faces must mount
    // --profile desktop; only the runtime source differs.
    const dev = resolveSidecarCommand({ DSH_DESKTOP_DEV: '1' }, { resourcesDir: '' })
    const prod = resolveSidecarCommand({}, { resourcesDir: '' })
    expect(dev.args.join(' ')).toContain('--profile desktop')
    expect(prod.args.join(' ')).toContain('--profile desktop')
  })
})
