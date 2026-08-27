/** Update-feed resolution: defaults, generic override, and fail-loud validation. */

import { describe, expect, it } from 'vitest'
import { readUpdaterConfig } from '../src/main/updater-config.ts'

describe('readUpdaterConfig', () => {
  it('defaults to the project GitHub Releases feed', () => {
    expect(readUpdaterConfig({})).toEqual({ provider: 'github', owner: 'deepseek-harness', repo: 'deepseek-harness' })
  })

  it('maps a generic static feed with its mandatory URL', () => {
    expect(readUpdaterConfig({ feedProvider: 'generic', feedUrl: 'https://example.com/updates/' }))
      .toEqual({ provider: 'generic', url: 'https://example.com/updates/' })
  })

  it('lets a github feed override owner/repo explicitly', () => {
    expect(readUpdaterConfig({ feedProvider: 'github', owner: 'acme', repo: 'mirror' }))
      .toEqual({ provider: 'github', owner: 'acme', repo: 'mirror' })
  })

  it('fails loud when a generic feed lacks its URL', () => {
    // Misconfiguration must never silently fall back to the default feed.
    expect(() => readUpdaterConfig({ feedProvider: 'generic' })).toThrow(/feedUrl/)
  })
})
