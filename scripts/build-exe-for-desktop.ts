/**
 * Build the DeepSeek Harness Desktop sidecar executables: one SEA single-file
 * server per release target, carrying the full `dsh --profile desktop`
 * composition. Staging mechanics live in `scripts/exe-packaging/shared.ts`;
 * the desktop-specific facts are the `apps/cli` deploy closure, the full
 * workspace closure backfill, the linked-vendor restore, and the
 * four-platform whitelist.
 *
 * Known limitation (2026-08-27 spike): the SEA snapshot serves bundled patch
 * assets and config composition (`--dump-default-config` passes), and the
 * staged closure boots completely under host Node — but dynamic bare-name
 * imports of plugin rows resolve against the real profile directory, whose
 * `profiles/node_modules` fallback symlinks cannot point into the snapshot.
 * A desktop packaged-bin entry composing cordis.yml directly from its own
 * snapshot anchors is the recorded phase-one follow-up; see the Agent Note.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DEFAULT_NODE_RANGE,
  PKG_SPEC,
  injectPkgConfig,
  packTarget,
  parseExeBuildCli,
  restoreWorkspaceClosure,
  prepareDeployStaging,
  printProducts,
  pnpmBin,
  runStep,
  stageNativePtyAddon,
} from './exe-packaging/shared.ts'

const root = resolve(import.meta.dirname, '..')

/** The deployment closure root: apps/cli owns the dsh launcher and web face. */
const DEPLOY_PACKAGE = '@deepseek-ai/dsh'
/**
 * The closed-runtime app entry the desktop shell spawns with --port <N>.
 * Deploying `@deepseek-ai/dsh` as the closure root puts its launcher at the
 * staging root, not under node_modules.
 */
const ENTRY_BIN = 'lib/bin.js'
/** Product name stem; SidecarManager resolves <stem>-<platform>-<arch>. */
const OUTPUT_BASENAME = 'dsh-desktop-server'
const OUT_DIR = 'dist-desktop'

/**
 * Whole-tree assets cover Cordis's runtime bare-package imports, which pkg's
 * static analysis cannot see, plus every bundle patch layer: without the
 * cordis patch glob here, the desktop bundle never enters the exe.
 */
const ASSET_GLOBS = [
  '**/cordis.patch.yml',
  'package.json',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.node',
  'node_modules/**/*.wasm',
]

/**
 * Desktop release targets. Windows is required by the phase-one DoD; macOS
 * ships arm64 only; linux covers both architectures.
 */
const TARGET_SPECS = [
  'node24-win-x64',
  'node24-linux-x64',
  'node24-linux-arm64',
  'node24-macos-arm64',
] as const

type TargetSpec = (typeof TARGET_SPECS)[number]

function isTargetSpec(value: string): value is TargetSpec {
  return (TARGET_SPECS as readonly string[]).includes(value)
}

/**
 * Validated CLI configuration; parsing flows through the shared exe-packaging
 * parser with this script's whitelist and usage text.
 */
class DesktopCli {
  private constructor(
    /** Build targets; defaults to the host platform entry only. */
    readonly targets: readonly TargetSpec[],
    /** Skip step 1 (`pnpm run build`); lib/ artifacts must already exist. */
    readonly skipBuild: boolean,
    /** Print every command and config patch instead of executing. */
    readonly dryRun: boolean,
  ) {}

  /**
   * Parse argv. Help exits 0; malformed flags exit 1; off-whitelist or
   * duplicate targets throw.
   * @param argv - the raw arguments (`process.argv.slice(2)`).
   * @returns the parsed, validated configuration.
   */
  static parse(argv: string[]): DesktopCli {
    const parsed = parseExeBuildCli(argv, {
      logPrefix: 'build-exe-for-desktop',
      usage: () => [
        'Usage: pnpm exec tsx scripts/build-exe-for-desktop.ts [flags]',
        '',
        `  --targets=<t1,t2,...>  pkg targets from: ${TARGET_SPECS.join(', ')}.`,
        '                         Default: this host architecture on linux only.',
        '  --skip-build           skip `pnpm run build` (lib/ artifacts must already exist).',
        '  --dry-run              print every command and config patch without executing.',
        '  --help                 print this help.',
        '',
        `Build route: ${PKG_SPEC} --sea.`,
        `Stages under ${OUT_DIR}/staging and writes executables to ${OUT_DIR}/.`,
      ].join('\n'),
      parseTarget: (spec) => {
        if (!isTargetSpec(spec)) {
          throw new Error(`build-exe-for-desktop: target ${JSON.stringify(spec)} is not one of ${TARGET_SPECS.join(', ')}.`)
        }
        return spec as TargetSpec
      },
      defaultTargets: () => [hostTarget()],
      key: target => target,
    })
    return new DesktopCli(parsed.targets, parsed.skipBuild, parsed.dryRun)
  }
}

/** Resolve the runnable host target; the script packs linux locally either way. */
function hostTarget(): TargetSpec {
  const hostKey = `${DEFAULT_NODE_RANGE}-${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch}`
  const match = (TARGET_SPECS as readonly string[]).find(spec => spec === hostKey)
  if (match === undefined) {
    throw new Error(`build-exe-for-desktop: unsupported host ${process.platform}-${process.arch}; pass --targets explicitly.`)
  }
  return match as TargetSpec
}

/** Fail loud unless all three shipped bundle patch layers exist to be staged. */
function verifyCompositionPatches(): void {
  const layers = [
    'packages/bundle/base/cordis.patch.yml',
    'packages/bundle/web-app/cordis.patch.yml',
    'packages/bundle/desktop-app/cordis.patch.yml',
  ]
  const missing = layers.filter(relative => !existsSync(join(root, relative)))
  if (missing.length > 0) {
    throw new Error(`build-exe-for-desktop: desktop composition patch layer(s) missing: ${missing.join(', ')}. Run pnpm install first.`)
  }
}

class DesktopSidecarBuild {
  /** Deploy staging lives inside the output directory so clean leaves it. */
  readonly staging = resolve(root, OUT_DIR, 'staging')
  private readonly outDir = resolve(root, OUT_DIR)

  constructor(private readonly cli: DesktopCli) {}

  /** Options routed into every shared staging call. */
  private get stepOptions(): { root: string; logPrefix: 'build-exe-for-desktop'; dryRun: boolean } {
    return { root, logPrefix: 'build-exe-for-desktop', dryRun: this.cli.dryRun }
  }

  /** Build all package artifacts unless `--skip-build` was passed. */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('build-exe-for-desktop: skipping pnpm run build (--skip-build)')
      return
    }
    await runStep(this.stepOptions, 'build', pnpmBin(), ['run', 'build'])
  }

  /** Clear and deploy the apps/cli closure into staging. */
  async deployStaging(): Promise<void> {
    await prepareDeployStaging({
      ...this.stepOptions,
      // The launcher app itself provides the hoist source for legacy deploy:
      // its direct dependencies are exactly what lands beside the deploy copy.
      deployPackage: DEPLOY_PACKAGE,
      stagingDir: this.staging,
      hoistSourceNodeModules: 'apps/cli/node_modules',
      // Linked vendored overrides never hoist into the deployed tree on
      // their own; every SEA consumer needs them beside plain node_modules.
      extraPackageSources: {
        '@deepseek-ai/cordis': 'vendor/cordis',
        '@deepseek-ai/cordis-plugin-group': 'vendor/group',
        '@deepseek-ai/cordis-plugin-hmr': 'vendor/hmr',
        '@deepseek-ai/cordis-plugin-include': 'vendor/include',
        '@deepseek-ai/cordis-plugin-loader': 'vendor/loader',
        '@deepseek-ai/cordis-plugin-logger-console': 'vendor/logger-console',
        '@deepseek-ai/cordis-plugin-timer': 'vendor/timer',
        '@deepseek-ai/cosmokit': 'vendor/cosmokit',
        '@deepseek-ai/schemastery': 'vendor/schemastery',
      },
    })
  }

  /** Backfill workspace packages legacy deploy omitted from the flat tree. */
  async restoreClosure(): Promise<void> {
    await restoreWorkspaceClosure({
      ...this.stepOptions,
      stagingDir: this.staging,
      anchorDir: 'apps/cli',
    })
  }

  /** Add the executable entry and asset globs (patch layers included). */
  async injectConfig(): Promise<void> {
    await injectPkgConfig({
      ...this.stepOptions,
      stagingDir: this.staging,
      entryBin: ENTRY_BIN,
      assetGlobs: ASSET_GLOBS,
    })
  }

  /** Package one whitelisted target onto disk. */
  async pack(target: TargetSpec): Promise<string[]> {
    const [nodeRange, platform, arch] = target.split('-') as [string, string, string]
    await stageNativePtyAddon({
      ...this.stepOptions,
      stagingDir: this.staging,
      targetPlatform: platform,
      targetArch: arch,
      // Cross-target packs keep their staged prebuilds; only same-host linux
      // may overwrite the addon (parity with the shared guard).
      hostPlatform: process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : 'win',
      hostArch: process.arch,
    })
    return packTarget({
      ...this.stepOptions,
      stagingDir: this.staging,
      outDir: this.outDir,
      outputBaseName: OUTPUT_BASENAME,
      target: { nodeRange, platform, arch },
    })
  }
}

if (import.meta.main) await main()

async function main(): Promise<void> {
  const cli = DesktopCli.parse(process.argv.slice(2))
  console.log(`build-exe-for-desktop: targets: ${cli.targets.join(', ')}`)
  verifyCompositionPatches()
  const pipeline = new DesktopSidecarBuild(cli)
  console.log(`build-exe-for-desktop: staging: ${pipeline.staging}`)
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.restoreClosure()
  await pipeline.injectConfig()
  const products: string[] = []
  for (const target of cli.targets) products.push(...await pipeline.pack(target))
  printProducts(products, { logPrefix: 'build-exe-for-desktop', dryRun: cli.dryRun })
}
