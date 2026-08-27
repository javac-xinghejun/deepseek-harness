/**
 * Update-feed configuration resolution for the desktop updater: a pure
 * decision over the configured source so misconfiguration fails loud at
 * startup validation and no silent fallback hides a broken feed.
 * @module @deepseek-ai/dsh-desktop/updater-config
 */

/** Where update metadata and packages publish. */
export type UpdateFeed =
  | { provider: 'github'; owner: string; repo: string }
  | { provider: 'generic'; url: string }

/** Flat declarative form accepted from env JSON or the config file. */
export interface UpdaterConfigInput {
  /** Feed kind; defaults to the project's GitHub Releases channel. */
  feedProvider?: 'github' | 'generic'
  /** GitHub repository owner; required by the github provider override only. */
  owner?: string
  /** GitHub repository name; required by the github provider override only. */
  repo?: string
  /** Base URL for a generic static feed; required by the generic provider. */
  feedUrl?: string
}

/** The default feed every shipping artifact targets. */
export const DEFAULT_UPDATE_FEED: Extract<UpdateFeed, { provider: 'github' }> = {
  provider: 'github',
  owner: 'deepseek-harness',
  repo: 'deepseek-harness',
}

/**
 * Resolve one {@link UpdateFeed} from a flat input.
 *
 * A `generic` feed without `feedUrl` is misconfiguration and throws —
 * per the fail-loud rule, never a silent fall back to GitHub.
 * @param input - parsed flat configuration; `{}` selects the default.
 * @returns the validated feed.
 * @throws Error when the requested provider lacks its mandatory field.
 */
export function readUpdaterConfig(input: UpdaterConfigInput): UpdateFeed {
  if (input.feedProvider === 'generic') {
    if (input.feedUrl === undefined || input.feedUrl === '') {
      throw new Error('dsh-desktop: updater feedProvider "generic" requires feedUrl')
    }
    return { provider: 'generic', url: input.feedUrl }
  }
  if (input.feedProvider === 'github') {
    return {
      provider: 'github',
      owner: input.owner ?? DEFAULT_UPDATE_FEED.owner,
      repo: input.repo ?? DEFAULT_UPDATE_FEED.repo,
    }
  }
  return DEFAULT_UPDATE_FEED
}
