/** The shipped desktop composition: three real bundle layers stacked over boot's own patch engine. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { apply, inject, name } from '../src/index.ts'
import { apply as applyInvariant, inject as invariantInject, name as invariantName } from '../src/invariant.ts'

const BUNDLE_ROOTS = [
  'packages/bundle/base',
  'packages/bundle/web-app',
  'packages/bundle/desktop-app',
] as const

/** Load every shipped bundle layer in `dsh --profile desktop` order. */
function desktopLayers(): PatchOptions[][] {
  return BUNDLE_ROOTS.map(root => loadOverlayPatches('desktop-app.spec', `${root}/cordis.patch.yml`))
}

describe('desktop bundle composition', () => {
  it('resolves web-runtime with openBrowser disabled and the remaining keys untouched', () => {
    const entries = composeEntries(desktopLayers())
    const row = entries.find(entry => entry.id === 'web-runtime')
    expect(row).toEqual({
      id: 'web-runtime',
      name: '@deepseek-ai/dsh-web-app',
      inject: ['webStartup'],
      config: {
        openBrowser: false,
        printUrl: true,
        surfaceContext: true,
        trustedHosts: { __jsExpr: 'ctx.webStartup.trustedHosts' },
      },
    })
  })

  it('changes only the browser handoff relative to the web profile stack', () => {
    // Guard against the restatement silently normalizing keys the web bundle
    // owns: without the desktop layer the handoff stays the startup expression.
    // A missing web-app layer is a repo misconfiguration, not an empty stack.
    const webApp = desktopLayers()[1]
    if (webApp === undefined) throw new Error('web-app patch layer failed to load')
    const entries = composeEntries([webApp])
    const row = entries.find(entry => entry.id === 'web-runtime')
    expect(row?.config).toMatchObject({ openBrowser: { __jsExpr: 'ctx.webStartup.openBrowser' } })
  })
})

describe('desktop bundle plugin surface', () => {
  it('mounts as an ordinary loader-entry plugin with no activation behavior', () => {
    expect(name).toBe('desktop-app')
    expect(inject).toEqual([])
    expect(apply(new Context())).toBeUndefined()
  })

  it('registers an empty invariant companion over the invariants service', async () => {
    let installedPackage: string | undefined
    let installed: (() => unknown) | undefined
    const ctx = new Context()
    ctx.provide('invariants', {
      register(packageName: string, companion: () => unknown) {
        installedPackage = packageName
        installed = companion
        return () => installedPackage === undefined
      },
    // The companion only touches ctx.invariants.
    } as never)
    expect(invariantName).toBe('desktop-app-invariant')
    expect(invariantInject).toEqual(['invariants'])
    await applyInvariant(ctx)
    expect(installedPackage).toBe('@deepseek-ai/dsh-desktop-app')
    // The empty companion installs no relation of its own.
    expect(installed?.()).toBeUndefined()
  })
})
