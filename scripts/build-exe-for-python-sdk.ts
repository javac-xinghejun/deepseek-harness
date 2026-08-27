/**
 * Build the SDK runtime executables and Python node carrier. The fixed
 * `@yao-pkg/pkg --sea` route, deploy flags, and artifact layout are owned by
 * .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md.
 * Staging mechanics live in `scripts/exe-packaging/shared.ts`; this script owns
 * the SDK-specific targets, closure manifest, and Python sync destinations.
 */

import { statSync } from 'node:fs'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DEFAULT_NODE_RANGE,
  PKG_SPEC,
  injectPkgConfig,
  packTarget,
  prepareDeployStaging,
  printProducts,
  pnpmBin,
  runStep,
  stageNativePtyAddon,
} from './exe-packaging/shared.ts'

const root = resolve(import.meta.dirname, '..')

/** The closure manifest whose dependencies define the executable. */
const DEPLOY_ROOT_PACKAGE = 'dsh-jsonrpc-agent-pkg'
/** The closed-runtime app entry inside the deployed closure. */
const ENTRY_BIN = 'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js'
const OUTPUT_BASENAME = 'dsh-jsonrpc-agent-pkg'
const OUT_DIR = 'dist-exe'
/** Python package destination; created when absent. */
const PYTHON_RUNTIME_DIR = 'python/sdk-runtime/src/deepseek_harness_runtime/runtime'
/** The deployed closure doubles as the node-mode carrier. */
const PYTHON_NODE_SUBDIR = 'node'
/** Legacy deploy may hoist peer-specialized workspace packages back here. */
const DEPLOY_SOURCE_NODE_MODULES = 'python/sdk-runtime/node_modules'

/**
 * Whole-tree assets cover Cordis's runtime bare-package imports, which pkg's
 * static analysis cannot see. Package manifests are explicit because bare-name
 * resolution depends on them.
 */
const ASSET_GLOBS = [
  'package.json',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.node',
  'node_modules/**/*.wasm',
]

const PLATFORMS = ['linux', 'macos'] as const
const ARCHES = ['x64', 'arm64'] as const
type Platform = (typeof PLATFORMS)[number]
type Arch = (typeof ARCHES)[number]

function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value)
}

function isArch(value: string): value is Arch {
  return (ARCHES as readonly string[]).includes(value)
}

/**
 * A parsed pkg target triple, constructed from `--targets` or the host.
 */
class Target {
  private constructor(
    /** pkg Node range (`node<major>`). */
    readonly nodeRange: string,
    /**
     * pkg platform tag. Windows is a documented non-goal
     * (.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).
     */
    readonly platform: Platform,
    /** pkg CPU tag. */
    readonly arch: Arch,
  ) {}

  /** The pkg `--targets` spec string `<nodeRange>-<platform>-<arch>`. */
  get spec(): string {
    return `${this.nodeRange}-${this.platform}-${this.arch}`
  }

  /**
   * Parse one target spec, rejecting malformed triples and unsupported platform or architecture.
   * @param spec - the raw triple, e.g. `node24-linux-x64`.
   * @returns the parsed target.
   */
  static parse(spec: string): Target {
    const parts = spec.split('-')
    const [nodeRange, platform, arch] = parts
    if (parts.length !== 3 || nodeRange === undefined || platform === undefined || arch === undefined) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)} must be <nodeRange>-<platform>-<arch>, e.g. node24-linux-x64.`)
    }
    if (!/^node\d+$/.test(nodeRange)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: node range must look like node24, got ${JSON.stringify(nodeRange)}.`)
    }
    if (!isPlatform(platform)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(platform)}.`)
    }
    if (!isArch(arch)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(arch)}.`)
    }
    return new Target(nodeRange, platform, arch)
  }

  /**
   * Resolve the host-platform default on Node 24.
   * @returns the host target; throws on an unsupported host platform or arch.
   */
  static host(): Target {
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined
    if (platform === undefined) {
      throw new Error(`build-exe-for-python-sdk: unsupported host platform ${process.platform}; pass --targets explicitly.`)
    }
    const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
    if (arch === undefined) {
      throw new Error(`build-exe-for-python-sdk: unsupported host arch ${process.arch}; pass --targets explicitly.`)
    }
    return new Target(DEFAULT_NODE_RANGE, platform, arch)
  }
}

/**
 * Validated CLI configuration; construction owns help and parse-error exits.
 */
class BuildCli {
  private constructor(
    /** Build targets; defaults to the host platform only. */
    readonly targets: readonly Target[],
    /** Skip step 1 (`pnpm run build`); lib/ artifacts must already exist. */
    readonly skipBuild: boolean,
    /** Print every command and config patch instead of executing. */
    readonly dryRun: boolean,
  ) {}

  /**
   * Parse argv. Help exits 0; malformed flags exit 1; invalid or colliding
   * targets throw.
   * @param argv - the raw arguments (`process.argv.slice(2)`).
   * @returns the parsed, validated configuration.
   */
  static parse(argv: string[]): BuildCli {
    let values: ReturnType<typeof BuildCli.parseRaw>
    try {
      values = BuildCli.parseRaw(argv)
    } catch (error) {
      console.error(`build-exe-for-python-sdk: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(BuildCli.usage())
      process.exit(1)
    }
    if (values.help) {
      console.log(BuildCli.usage())
      process.exit(0)
    }
    const targets = values.targets === undefined
      ? [Target.host()]
      : values.targets.split(',').map(part => part.trim()).filter(part => part !== '').map(spec => Target.parse(spec))
    if (targets.length === 0) throw new Error('build-exe-for-python-sdk: --targets is empty.')
    const seen = new Set<string>()
    for (const target of targets) {
      const key = `${target.platform}-${target.arch}`
      if (seen.has(key)) {
        throw new Error(`build-exe-for-python-sdk: duplicate platform-arch ${key} in --targets; canonical product names would collide.`)
      }
      seen.add(key)
    }
    return new BuildCli(targets, values['skip-build'], values['dry-run'])
  }

  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'targets': { type: 'string' },
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  private static usage(): string {
    return [
      'Usage: pnpm exec tsx scripts/build-exe-for-python-sdk.ts [flags]',
      '',
      '  --targets=<t1,t2,...>  pkg targets, e.g. node24-linux-x64,node24-linux-arm64,node24-macos-arm64.',
      '                         Default: the host platform only (on node24).',
      '  --skip-build           skip `pnpm run build` (lib/ artifacts must already exist).',
      '  --dry-run              print every command and config patch without executing.',
      '  --help                 print this help.',
      '',
      `Build route: ${PKG_SPEC} --sea; see .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md.`,
      `Stages the node carrier in ${PYTHON_RUNTIME_DIR}/${PYTHON_NODE_SUBDIR} and writes executables to ${OUT_DIR}/.`,
    ].join('\n')
  }
}

/**
 * Sequential build pipeline over the shared staging machinery plus the
 * SDK-specific Python sync.
 */
class SingleExeBuild {
  /**
   * The cleared deploy target, pkg input, and Python node-mode carrier. The
   * checked-in default `cordis.yml` remains in its parent directory.
   */
  readonly staging = resolve(root, PYTHON_RUNTIME_DIR, PYTHON_NODE_SUBDIR)
  private readonly outDir = resolve(root, OUT_DIR)

  constructor(private readonly cli: BuildCli) {}

  /** Options routed into every shared staging call. */
  private get stepOptions(): { root: string; logPrefix: 'build-exe-for-python-sdk'; dryRun: boolean } {
    return { root, logPrefix: 'build-exe-for-python-sdk', dryRun: this.cli.dryRun }
  }

  /** Verify the closure before compiling or packaging. */
  async verifyClosure(): Promise<void> {
    await this.run('runtime dependency closure', pnpmBin(), ['run', 'verify-runtime-closure'])
  }

  /** Build all package artifacts unless `--skip-build` was passed. */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('build-exe-for-python-sdk: skipping pnpm run build (--skip-build)')
      return
    }
    await this.run('build', pnpmBin(), ['run', 'build'])
  }

  /** Clear and deploy the runtime closure into the node carrier. */
  async deployStaging(): Promise<void> {
    await prepareDeployStaging({
      ...this.stepOptions,
      deployPackage: DEPLOY_ROOT_PACKAGE,
      stagingDir: this.staging,
      hoistSourceNodeModules: DEPLOY_SOURCE_NODE_MODULES,
    })
  }

  /** Add the executable entry and pkg assets to the staged manifest. */
  async injectConfig(): Promise<void> {
    await injectPkgConfig({
      ...this.stepOptions,
      stagingDir: this.staging,
      entryBin: ENTRY_BIN,
      assetGlobs: ASSET_GLOBS,
    })
  }

  /**
   * Package one target; SEA mode accepts one target per invocation.
   * @param target - the pkg target triple to build.
   * @returns the executable, ripgrep sidecar, and macOS spawn helper paths.
   */
  async pack(target: Target): Promise<string[]> {
    const host = Target.host()
    await stageNativePtyAddon({
      ...this.stepOptions,
      stagingDir: this.staging,
      targetPlatform: target.platform,
      targetArch: target.arch,
      hostPlatform: host.platform,
      hostArch: host.arch,
    })
    const products = await packTarget({
      ...this.stepOptions,
      stagingDir: this.staging,
      outDir: this.outDir,
      outputBaseName: OUTPUT_BASENAME,
      target,
    })
    return [...products, ...(await this.copyMacSpawnHelper(target, products[0] ?? ''))]
  }

  /** Copy macOS's spawn-helper beside the executable when the platform needs it. */
  private async copyMacSpawnHelper(target: Target, product: string): Promise<string[]> {
    if (target.platform !== 'macos') return []
    const helperPath = `${product}-spawn-helper`
    const source = join(this.staging, 'node_modules', 'node-pty', 'prebuilds', `darwin-${target.arch}`, 'spawn-helper')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] cp ${source} ${helperPath}`)
      return [helperPath]
    }
    await copyFile(source, helperPath)
    await chmod(helperPath, 0o755)
    return [helperPath]
  }

  /**
   * Copy each product into the Python runtime package. The deployed node
   * carrier is already in place, and `dist-exe/` retains upload copies.
   * @param products - the product paths returned by {@link pack}.
   */
  async syncToPythonRuntime(products: string[]): Promise<void> {
    const destDir = resolve(root, PYTHON_RUNTIME_DIR)
    if (this.cli.dryRun) {
      for (const path of products) {
        console.log(`build-exe-for-python-sdk: [dry-run] cp ${path} ${join(destDir, basename(path))}`)
      }
      return
    }
    await mkdir(destDir, { recursive: true })
    for (const path of products) {
      const destination = join(destDir, basename(path))
      await copyFile(path, destination)
      await chmod(destination, statSync(path).mode & 0o777)
      console.log(`build-exe-for-python-sdk: synced ${destination}`)
    }
  }

  /**
   * Run one subprocess through the shared runner.
   * @param label - the step name used in logs and error messages.
   * @param command - the executable.
   * @param args - its arguments.
   */
  private async run(label: string, command: string, args: string[]): Promise<void> {
    await runStep(this.stepOptions, label, command, args)
  }
}

await main()

async function main(): Promise<void> {
  const cli = BuildCli.parse(process.argv.slice(2))
  const pipeline = new SingleExeBuild(cli)
  console.log(`build-exe-for-python-sdk: targets: ${cli.targets.map(target => target.spec).join(', ')}`)
  console.log(`build-exe-for-python-sdk: staging: ${pipeline.staging}`)
  await pipeline.verifyClosure()
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.injectConfig()
  const products: string[] = []
  for (const target of cli.targets) products.push(...await pipeline.pack(target))
  printProducts(products, { logPrefix: 'build-exe-for-python-sdk', dryRun: cli.dryRun })
  await pipeline.syncToPythonRuntime(products)
}
