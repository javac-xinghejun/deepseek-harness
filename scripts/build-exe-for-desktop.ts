/**
 * Build the DeepSeek Harness Desktop sidecar executables: one SEA single-file
 * server per release target, serving the full desktop composition through a
 * generated closed-runtime entry. Staging mechanics live in
 * `scripts/exe-packaging/shared.ts`; the desktop-specific facts are the
 * `apps/cli` deploy closure, the full workspace closure backfill, the
 * linked-vendor restore, and the four-platform whitelist.
 *
 * The SEA bootstrap (2026-08-27): the sidecar deliberately does not walk the
 * launcher's profile machinery — loader imports anchor bare-name plugins at
 * the profile directory on real disk, whose `profiles/node_modules` fallback
 * symlinks cannot point into `/snapshot`. Instead the pipeline dumps the
 * composed `[dsh-base, dsh-web-app, dsh-desktop-app]` entry list to
 * `cordis.desktop.yml` at build time and emits `desktop-entry.mjs`, which
 * boots that config with `bareModuleBaseUrl` anchored inside its own snapshot,
 * next to the staged node_modules.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
 * The generated closed-runtime entry the desktop shell spawns with --port <N>.
 * It sits at the staging root so `bareModuleBaseUrl` anchors loader imports at
 * the snapshot directory beside the staged node_modules.
 */
const ENTRY_BIN = 'desktop-entry.mjs'
/** The composed entry list the generated entry mounts directly. */
const CONFIG_OUT = 'cordis.desktop.yml'
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
  CONFIG_OUT,
  ENTRY_BIN,
  'package.json',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.node',
  'node_modules/**/*.so',
  'node_modules/**/*.so.*',
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

/**
 * The generated closed-runtime entry: mounts the pre-composed entry list with
 * loader imports anchored inside this snapshot (`bareModuleBaseUrl`), provides
 * the launcher facts an ordinary `dsh web` invocation would, and maps signals
 * to bounded exits. Written per pack; content is pipeline-owned.
 */
const DESKTOP_ENTRY = `#!/usr/bin/env node
/**
 * DeepSeek Harness Desktop closed-runtime sidecar. GENERATED by
 * scripts/build-exe-for-desktop.ts — do not edit the emitted copy.
 *
 * Bare plugins resolve from this snapshot's node_modules (bareModuleBaseUrl =
 * this file's URL); the composed cordis.desktop.yml carries the whole
 * [dsh-base, dsh-web-app, dsh-desktop-app] stack exactly as the dev-mode
 * profile renders it.
 */
import { fileURLToPath } from 'node:url'
import { boot, installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const NAME = 'dsh-desktop-server'
installFailLoud(NAME)
loadEnv(NAME)

let exiting = false
let appContext
async function disposeAndExit(code) {
  if (exiting) return
  exiting = true
  try {
    if (appContext !== undefined) await appContext.fiber.dispose()
  } finally {
    process.exit(code)
  }
}

appContext = await boot(
  NAME,
  fileURLToPath(new URL(${JSON.stringify('./' + CONFIG_OUT)}, import.meta.url)),
  [],
  (hostCtx) => {
    // Runtime argv: [--no-open] --port <N>; the web-startup commander owns it.
    provideCmdline(hostCtx, {
      args: process.argv.slice(2),
      exit: (code) => { void disposeAndExit(code) },
    })
    // Loader rows created at runtime (host-side plugins mounting children, agent
    // presets mounting session plugins) import through the internal loader with
    // ctx.baseUrl — a DIRECTORY url — as parent. The internal loader treats a
    // parent as a file and walks up from its dirname, which skips this
    // snapshot's node_modules entirely (include rows never hit this because
    // their parent is this entry FILE). Normalize directory parents onto a
    // sentinel filename inside the same directory.
    const internal = hostCtx.loader?.internal
    if (internal !== undefined && internal.import.normalizeParent !== true) {
      const rawImport = internal.import.bind(internal)
      internal.import = (name, parentUrl, ...rest) =>
        rawImport(name, typeof parentUrl === 'string' && parentUrl.endsWith('/') ? parentUrl + 'package.json' : parentUrl, ...rest)
      internal.import.normalizeParent = true
    }
  },
  import.meta.url,
)

process.on('SIGTERM', () => { void disposeAndExit(0) })
process.on('SIGINT', () => { void disposeAndExit(130) })
`

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

  /**
   * Emit the closed-runtime launch pair into staging: the composed entry list
   * (`cordis.desktop.yml`, dumped from a scratch-home profile boot so the
   * bundle layers and desktop patch apply exactly as dev mode sees them) plus
   * `desktop-entry.mjs`, whose snapshot-anchored boot replaces profile
   * resolution entirely.
   */
  async emitPackagedLaunch(): Promise<void> {
    if (this.cli.dryRun) {
      console.log(`build-exe-for-desktop: [dry-run] would dump ${CONFIG_OUT} from an isolated-home profile boot`)
      console.log(`build-exe-for-desktop: [dry-run] would write ${join(this.staging, ENTRY_BIN)}`)
      return
    }
    const configPath = join(this.staging, CONFIG_OUT)
    const dump = this.dumpComposedConfig()
    if (dump.status !== 0) {
      throw new Error(`build-exe-for-desktop: composed-config dump exited ${String(dump.status)}:\n${String(dump.stderr ?? '')}`)
    }
    const yaml = dump.stdout ?? ''
    if (!yaml.includes('id: web-runtime')) throw new Error('build-exe-for-desktop: dumped composition has no web-runtime row')
    if (!/openBrowser: false/.test(yaml)) throw new Error('build-exe-for-desktop: dumped composition did not disable the browser handoff')
    await import('node:fs/promises').then(fs => fs.writeFile(configPath, yaml))
    await import('node:fs/promises').then(fs => fs.writeFile(join(this.staging, ENTRY_BIN), DESKTOP_ENTRY))
    console.log(`build-exe-for-desktop: emitted ${CONFIG_OUT} + ${ENTRY_BIN} into staging`)
  }

  /** Dump the desktop composition from sources under an isolated home. */
  private dumpComposedConfig(): { status: number | null; stdout: string; stderr: string } {
    const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-pack-dump-'))
    // Direct node invocation (equivalent to the root `pnpm dsh` script) so
    // the packaging pipeline never depends on the pnpm wrapper's own
    // dependency-verification behavior.
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/cli/src/bin.ts', '--profile', 'desktop', '--dump-config'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DSH_HOME: scratchHome },
    })
    return {
      status: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    }
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
  await pipeline.emitPackagedLaunch()
  await pipeline.injectConfig()
  const products: string[] = []
  for (const target of cli.targets) products.push(...await pipeline.pack(target))
  printProducts(products, { logPrefix: 'build-exe-for-desktop', dryRun: cli.dryRun })
}
