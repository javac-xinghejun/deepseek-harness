/**
 * Shared single-executable packaging machinery: the deploy-staging pipeline,
 * pkg config injection, native addon placement, and the pkg/SEA pack step.
 * `scripts/build-exe-for-python-sdk.ts` and
 * `scripts/build-exe-for-desktop.ts` are the two consumers; every deployment-
 * varying fact arrives through options, so neither script re-implements it.
 * @module scripts/exe-packaging/shared
 */

import { spawn } from 'node:child_process'
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveLinuxNodePtyAddon } from '../build-exe-for-python-sdk-native-pty.ts'

/** Pinned for reproducible builds. */
export const PKG_SPEC = '@yao-pkg/pkg@6.21.0'

/** Default Node major; SEA mode requires at least Node 22. */
export const DEFAULT_NODE_RANGE = 'node24'

export function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/**
 * Render a command for logs and errors, quoting arguments with spaces.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the printable command line.
 */
function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/** Common options every staged step carries. */
export interface SharedStepOptions {
  /** Absolute workspace root every relative path anchors to. */
  root: string
  /** Log prefix naming the calling pipeline in output and errors. */
  logPrefix: string
  /** Print commands and filesystem changes instead of executing them. */
  dryRun: boolean
}

/**
 * Run one subprocess with inherited stdio. Spawn and non-zero-exit errors
 * include the command; dry runs only print it.
 */
export async function runStep(
  options: Pick<SharedStepOptions, 'root' | 'logPrefix' | 'dryRun'>,
  label: string,
  command: string,
  args: string[],
): Promise<void> {
  const printable = formatCommand(command, args)
  if (options.dryRun) {
    console.log(`${options.logPrefix}: [dry-run] ${printable}`)
    return
  }
  console.log(`${options.logPrefix}: ${label}: ${printable}`)
  // Windows can only execute .cmd/.npm shims through a shell (Node >=20.12
  // spawns them with EINVAL otherwise), and shell mode joins args verbatim,
  // so space-bearing arguments carry their own quotes.
  const useShell = process.platform === 'win32'
  const spawnArgs = useShell ? args.map(arg => (arg.includes(' ') ? `"${arg}"` : arg)) : args
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, spawnArgs, {
      cwd: options.root,
      stdio: 'inherit',
      shell: useShell,
      // Artifact builds must not mutate or validate a developer's Git hooks.
      env: { ...process.env, CI: 'true' },
    })
    child.once('error', (error) => {
      reject(new Error(`${options.logPrefix}: ${label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`${options.logPrefix}: ${label} failed (${cause}): ${printable}`))
    })
  })
}

/** Documentation stripped from a generated runtime directory after deploy. */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml']

/** Options for {@link prepareDeployStaging}. */
export interface DeployStagingOptions extends SharedStepOptions {
  /** The workspace package passed to `pnpm --filter <deployPackage> deploy`. */
  deployPackage: string
  /** Cleared and populated absolute staging directory (the deploy target). */
  stagingDir: string
  /**
   * Where legacy deploy hoists direct dependencies of `deployPackage` instead
   * of inside the target; the source each missing dependency restores from.
   */
  hoistSourceNodeModules?: string
  /**
   * Packages legacy deploy can drop entirely because they enter the closure
   * through overrides that hoisting never hoists (linked vendored peers), mapped
   * to their real repository directories (absolute or root-relative).
   */
  extraPackageSources?: Readonly<Record<string, string>>
}

/**
 * Clear and deploy one closure into `stagingDir`, restore legacy hoists,
 * materialize package links into real directories, and strip generated docs.
 * The stage ends symlink-free so the packaged payload needs no link handling.
 */
export async function prepareDeployStaging(options: DeployStagingOptions): Promise<void> {
  const { root, stagingDir } = options
  if (stagingDir === root || root.startsWith(stagingDir + sep)) {
    throw new Error(`${options.logPrefix}: refusing to clear staging dir ${stagingDir}: it contains the repo root.`)
  }
  if (options.dryRun) console.log(`${options.logPrefix}: [dry-run] rm -rf ${stagingDir}`)
  else await rm(stagingDir, { recursive: true, force: true })
  await runStep(options, 'deploy', pnpmBin(), [
    '--filter',
    options.deployPackage,
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    stagingDir,
  ])
  const hoistSource = options.hoistSourceNodeModules
  if (hoistSource !== undefined) {
    await restoreLegacyHoists(options, hoistSource)
  }
  const extraSources = options.extraPackageSources
  if (extraSources !== undefined) {
    await restoreOverridePackages(options, extraSources)
  }
  await materializeStagedLinks(options)
  if (options.dryRun) {
    for (const name of DEPLOY_ONLY_DOCS) console.log(`${options.logPrefix}: [dry-run] rm -f ${join(stagingDir, name)}`)
  } else {
    await Promise.all(DEPLOY_ONLY_DOCS.map(name => rm(join(stagingDir, name), { force: true })))
  }
}

/**
 * Restore direct packages that pnpm's legacy hoister places beside the deploy
 * source instead of in the target. The runtime manifest supplies every peer,
 * so package-local node_modules trees are omitted to preserve one flat Cordis
 * instance and a symlink-free packaged payload.
 */
async function restoreLegacyHoists(options: DeployStagingOptions, hoistSourceNodeModules: string): Promise<void> {
  if (options.dryRun) {
    console.log(`${options.logPrefix}: [dry-run] restore direct dependencies omitted by legacy deploy`)
    return
  }
  const { stagingDir } = options
  const manifestPath = join(stagingDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const sourceNodeModules = resolve(options.root, hoistSourceNodeModules)
  const restored: string[] = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(stagingDir, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(
        `${options.logPrefix}: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`,
      )
    }
    await copyDereferenced(source, destination)
    restored.push(dependency)
  }
  const stillMissing = Object.keys(manifest.dependencies ?? {})
    .filter(dependency => !existsSync(join(stagingDir, 'node_modules', dependency)))
  if (stillMissing.length > 0) {
    throw new Error(`${options.logPrefix}: staged dependencies remain missing: ${stillMissing.join(', ')}.`)
  }
  if (restored.length > 0) {
    console.log(`${options.logPrefix}: restored legacy deploy hoists: ${restored.join(', ')}`)
  }
}

/** Options for {@link restoreWorkspaceClosure}. */
export interface WorkspaceClosureOptions extends SharedStepOptions {
  /** Staged closure directory receiving missing workspace packages. */
  stagingDir: string
  /** Directory of the app manifest whose transitive graph defines the closure. */
  anchorDir: string
}

interface ClosureManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/**
 * Discover every workspace member by manifest walk across the standard globs
 * (apps, nested packages, vendor roots). Later discoveries win, mirroring
 * Node's nearest-wins resolution when a name repeats.
 */
function discoverWorkspaceMembers(root: string): Map<string, string> {
  const members = new Map<string, string>()
  const manifests = [
    ...globSync('apps/*/package.json', { cwd: root }),
    ...globSync('packages/*/*/package.json', { cwd: root }),
    ...globSync('vendor/*/package.json', { cwd: root }),
    ...globSync('native/landlock-run/packages/*/package.json', { cwd: root }),
  ]
  for (const manifestPath of manifests.sort()) {
    const directory = resolve(root, dirname(manifestPath))
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as ClosureManifest
      if (manifest.name !== undefined && manifest.name !== '') members.set(manifest.name, directory)
    } catch {
      // A manifest outside our namespace (website, examples leaves) is not
      // part of any runtime closure; skipping keeps discovery tolerant.
    }
  }
  return members
}

/**
 * Fill in staged packages legacy deploy omitted entirely: anything reachable
 * from the anchor's dependency graph that the flat tree lacks gets copied
 * dereferenced from its repository source, so a bundled runtime never boots
 * with half its plugin closure.
 */
export async function restoreWorkspaceClosure(options: WorkspaceClosureOptions): Promise<void> {
  if (options.dryRun) {
    console.log(`${options.logPrefix}: [dry-run] restore missing workspace closure packages`)
    return
  }
  const members = discoverWorkspaceMembers(options.root)
  const anchorManifest = JSON.parse(
    readFileSync(join(resolve(options.root, options.anchorDir), 'package.json'), 'utf8'),
  ) as ClosureManifest

  const queue: string[] = []
  const seen = new Set<string>()
  const enqueue = (manifest: ClosureManifest): void => {
    const sections = { ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const name of Object.keys(sections)) {
      if (!members.has(name) || seen.has(name)) continue
      seen.add(name)
      queue.push(name)
    }
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!members.has(peer) || seen.has(peer)) continue
      if (manifest.peerDependenciesMeta?.[peer]?.optional === true) continue
      seen.add(peer)
      queue.push(peer)
    }
  }
  enqueue(anchorManifest)
  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index]
    if (name === undefined) continue
    const directory = members.get(name)
    if (directory === undefined) continue
    enqueue(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as ClosureManifest)
  }

  let restored: string[] = []
  for (const name of queue) {
    const destination = join(options.stagingDir, 'node_modules', name)
    if (existsSync(destination)) continue
    const sourceDirectory = members.get(name)
    if (sourceDirectory === undefined) continue
    await copyDereferenced(sourceDirectory, destination)
    restored.push(name)
  }
  restored = restored.sort()
  if (restored.length > 0) {
    console.log(`${options.logPrefix}: restored ${String(restored.length)} workspace closure package(s): `
      + restored.map(name => relative('', name)).join(', '))
  }
}

/** Copy one package directory dereferenced, dropping nested node_modules trees. */
async function copyDereferenced(sourceDir: string, destinationDir: string): Promise<void> {
  await mkdir(dirname(destinationDir), { recursive: true })
  const nestedNodeModules = join(sourceDir, 'node_modules')
  await cp(sourceDir, destinationDir, {
    recursive: true,
    dereference: true,
    filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
  })
}

/**
 * Restore packages whose override-mediated linkage makes legacy deploy skip
 * them outright; each named package must already sit in its mapped source or
 * the stage fails loud rather than shipping a runtime with a missing peer.
 */
async function restoreOverridePackages(
  options: DeployStagingOptions,
  extraPackageSources: Readonly<Record<string, string>>,
): Promise<void> {
  if (options.dryRun) {
    console.log(`${options.logPrefix}: [dry-run] restore override-linked packages`)
    return
  }
  for (const [packageName, relative] of Object.entries(extraPackageSources).sort()) {
    const destination = join(options.stagingDir, 'node_modules', packageName)
    if (existsSync(destination)) continue
    const source = resolve(options.root, relative)
    if (!existsSync(source)) {
      throw new Error(`${options.logPrefix}: override package ${packageName} has no source directory at ${source}.`)
    }
    await copyDereferenced(source, destination)
  }
}

/** Replace deploy-time package links with files and reject any remaining link. */
async function materializeStagedLinks(options: DeployStagingOptions): Promise<void> {
  if (options.dryRun) {
    console.log(`${options.logPrefix}: [dry-run] materialize staged package links`)
    return
  }
  const nodeModules = join(options.stagingDir, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    const nestedNodeModules = join(source, 'node_modules')
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/** Return the first symbolic link below a directory, if one exists. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}
/** Options for {@link injectPkgConfig}. */
export interface InjectPkgConfigOptions extends SharedStepOptions {
  /** Staged closure directory holding the manifest to patch. */
  stagingDir: string
  /** Manifest-relative bin path pointing at the executable's app entry. */
  entryBin: string
  /** Whole-tree asset globs appended under `pkg.assets`. */
  assetGlobs: readonly string[]
}

/**
 * Add the executable entry and pkg assets to the staged manifest; both fail
 * loud when the deploy step never produced a stage or the built lib is stale.
 */
export async function injectPkgConfig(options: InjectPkgConfigOptions): Promise<void> {
  const patch = { bin: options.entryBin, pkg: { assets: [...options.assetGlobs] } }
  const manifestPath = join(options.stagingDir, 'package.json')
  if (options.dryRun) {
    console.log(`${options.logPrefix}: [dry-run] patch ${manifestPath} with ${JSON.stringify(patch)}`)
    return
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`${options.logPrefix}: ${manifestPath} missing — pnpm deploy did not produce a staged package.`)
  }
  const entryAbs = join(options.stagingDir, options.entryBin)
  if (!existsSync(entryAbs)) {
    throw new Error(`${options.logPrefix}: ${entryAbs} missing — run without --skip-build so lib/ artifacts exist.`)
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`)
  console.log(`${options.logPrefix}: injected pkg config into ${manifestPath}`)
}

/** A parsed pkg target triple (`<nodeRange>-<platform>-<arch>`). */
interface PkgTarget {
  /** pkg Node range (`node<major>`). */
  nodeRange: string
  /** pkg platform tag (`linux`, `macos`, or `win`). */
  platform: string
  /** pkg CPU tag. */
  arch: string
}

/** Options for {@link stageNativePtyAddon}. */
export interface NativePtyOptions extends SharedStepOptions {
  /** Staged closure directory whose node-pty build tree is replaced. */
  stagingDir: string
  /** Target platform being packed; only linux receives an addon copy. */
  targetPlatform: string
  /** Target architecture being packed. */
  targetArch: string
  /** Host platform running this script (for the same-arch build guard). */
  hostPlatform: string
  /** Host architecture running this script. */
  hostArch: string
}

/**
 * Put the target node-pty addon in the staged closure and drop foreign build
 * trees. Non-linux targets keep the installed prebuild layout untouched after
 * the staged `build/` removal; the release workflow provides manylinux builds,
 * ordinary installs use node-pty's own prebuilds.
 */
export async function stageNativePtyAddon(options: NativePtyOptions): Promise<void> {
  const stagedBuild = join(options.stagingDir, 'node_modules', 'node-pty', 'build')
  if (options.dryRun) console.log(`${options.logPrefix}: [dry-run] rm -rf ${stagedBuild}`)
  else await rm(stagedBuild, { recursive: true, force: true })
  if (options.targetPlatform !== 'linux') return
  const packageDirectory = join(
    options.root,
    'packages',
    'subprocess',
    'subprocess-local',
    'node_modules',
    'node-pty',
  )
  const destination = join(stagedBuild, 'Release', 'pty.node')
  const source = resolveLinuxNodePtyAddon(packageDirectory, options.targetArch as 'x64' | 'arm64')
  if (options.dryRun) {
    console.log(`${options.logPrefix}: [dry-run] cp ${source} ${destination}`)
    return
  }
  if (options.targetPlatform !== options.hostPlatform || options.targetArch !== options.hostArch) {
    throw new Error(
      `${options.logPrefix}: build the Linux runtime on its target architecture; `
      + `target ${options.targetPlatform}-${options.targetArch} does not match host ${options.hostPlatform}-${options.hostArch}.`,
    )
  }
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}

/** Options for {@link packTarget}. */
export interface PackTargetOptions extends SharedStepOptions {
  /** Staged closure directory handed to pkg. */
  stagingDir: string
  /** Output directory receiving `<outputBaseName>-<platform>-<arch>`. */
  outDir: string
  /** Product file name stem. */
  outputBaseName: string
  /** The exact target triple to compile (SEA accepts one per invocation). */
  target: PkgTarget
}

/**
 * Package one target through pinned `@yao-pkg/pkg --sea` and copy the
 * ripgrep sidecar beside the product so Node can spawn it outside pkg's
 * virtual filesystem.
 * @returns the executable and ripgrep sidecar paths.
 */
export async function packTarget(options: PackTargetOptions): Promise<string[]> {
  const spec = `${options.target.nodeRange}-${options.target.platform}-${options.target.arch}`
  const product = join(options.outDir, `${options.outputBaseName}-${options.target.platform}-${options.target.arch}`)
  if (!options.dryRun) await mkdir(options.outDir, { recursive: true })
  await runStep(options, `pkg ${spec}`, pnpmBin(), [
    'dlx',
    PKG_SPEC,
    options.stagingDir,
    '--sea',
    '--targets',
    spec,
    '--output',
    product,
  ])
  if (!options.dryRun && !existsSync(product)) {
    throw new Error(`${options.logPrefix}: product ${product} is missing after the pkg run; inspect ${options.outDir}.`)
  }
  const ripgrep = await copyRipgrepSidecar(options, product)
  return [product, ripgrep]
}

/** Copy the target ripgrep binary beside the executable. */
async function copyRipgrepSidecar(options: PackTargetOptions, product: string): Promise<string> {
  // macOS manifests as `macos` in pkg triples but `darwin` on disk.
  const diskPlatform = options.target.platform === 'macos' ? 'darwin' : options.target.platform
  const isWindows = options.target.platform === 'win'
  const source = join(
    options.stagingDir,
    'node_modules',
    '@vscode',
    `ripgrep-${diskPlatform}-${options.target.arch}`,
    'bin',
    isWindows ? 'rg.exe' : 'rg',
  )
  // The harness resolves the sidecar as `${process.execPath}-rg`; on Windows
  // CreateProcess needs an .exe name to execute, so ship both.
  const destinations = isWindows ? [`${product}-rg`, `${product}-rg.exe`] : [`${product}-rg`]
  if (options.dryRun) {
    for (const destination of destinations) {
      console.log(`${options.logPrefix}: [dry-run] cp ${source} ${destination}`)
    }
    return destinations[0] ?? `${product}-rg`
  }
  if (!existsSync(source)) {
    throw new Error(`${options.logPrefix}: target ripgrep binary is missing at ${source}.`)
  }
  for (const destination of destinations) {
    await copyFile(source, destination)
    if (!isWindows) await chmod(destination, 0o755)
  }
  return destinations[0] ?? `${product}-rg`
}

/**
 * Print each product path and, outside dry-run mode, its size.
 * @param products - the product paths to report.
 * @param options - shared step context choosing dry-run phrasing.
 */
export function printProducts(products: readonly string[], options: Pick<SharedStepOptions, 'logPrefix' | 'dryRun'>): void {
  console.log(options.dryRun ? `${options.logPrefix}: [dry-run] would produce:` : `${options.logPrefix}: products:`)
  for (const path of products) {
    if (options.dryRun) {
      console.log(`  ${path}`)
      continue
    }
    const megabytes = statSync(path).size / (1024 * 1024)
    console.log(`  ${path}  (${megabytes.toFixed(1)} MB)`)
  }
}

/**
 * Parsed CLI face shared by every exe packaging script: one flag trio
 * (`--targets`, `--skip-build`, `--dry-run`, `--help`) with script-specific
 * target parsing supplied through {@link ExeCliOptions}.
 */
export interface ExePackagingCli<T> {
  /** Targets parsed via {@link ExeCliOptions.parseTarget}; defaults when `--targets` is absent. */
  readonly targets: readonly T[]
  /** Skip step 1 (`pnpm run build`); lib/ artifacts must already exist. */
  readonly skipBuild: boolean
  /** Print every command and config patch instead of executing. */
  readonly dryRun: boolean
}

/** Script-specific behavior hooks for {@link parseExeBuildCli}. */
export interface ExeCliOptions<T> {
  /** Log prefix naming the calling pipeline on errors. */
  logPrefix: string
  /** The script's own multi-line usage text printed for --help and errors. */
  usage(): string
  /** Parse one raw `--targets` entry; throws with the caller's message on bad input. */
  parseTarget(spec: string): T
  /** Default target set when `--targets` is absent. */
  defaultTargets(): readonly T[]
  /** Duplicate-detection key per target (thrown verbatim in the diagnostic). */
  key(target: T): string
}

/**
 * Parse argv for an exe packaging script. Help exits 0; malformed flags exit 1;
 * unknown flags become positional-argument errors; empty or duplicating target
 * lists throw.
 * @param argv - the raw arguments (`process.argv.slice(2)`).
 * @param options - script-specific hooks; see {@link ExeCliOptions}.
 * @returns the validated invocation.
 */
export function parseExeBuildCli<T>(argv: string[], options: ExeCliOptions<T>): ExePackagingCli<T> {
  interface CliValues {
    targets?: string
    'skip-build': boolean
    'dry-run': boolean
    help: boolean
  }
  let values: CliValues
  try {
    values = parseArgs({
      args: argv,
      options: {
        'targets': { type: 'string' },
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values as unknown as CliValues
  } catch (error) {
    console.error(`${options.logPrefix}: ${error instanceof Error ? error.message : String(error)}\n`)
    console.error(options.usage())
    process.exit(1)
  }
  if (values.help === true) {
    console.log(options.usage())
    process.exit(0)
  }
  const specs = values.targets === undefined
    ? undefined
    : values.targets.split(',').map(part => part.trim()).filter(part => part !== '')
  const targets = specs === undefined
    ? [...options.defaultTargets()]
    : specs.map(spec => options.parseTarget(spec))
  if (targets.length === 0) throw new Error(`${options.logPrefix}: --targets is empty.`)
  const seen = new Set<string>()
  for (const target of targets) {
    const id = options.key(target)
    if (seen.has(id)) throw new Error(`${options.logPrefix}: duplicate target key ${JSON.stringify(id)} in --targets.`)
    seen.add(id)
  }
  return { targets, skipBuild: values['skip-build'] === true, dryRun: values['dry-run'] === true }
}
