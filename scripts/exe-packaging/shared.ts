/**
 * Shared single-executable packaging machinery: the deploy-staging pipeline,
 * pkg config injection, native addon placement, and the pkg/SEA pack step.
 * `scripts/build-exe-for-python-sdk.ts` and
 * `scripts/build-exe-for-desktop.ts` are the two consumers; every deployment-
 * varying fact arrives through options, so neither script re-implements it.
 * @module scripts/exe-packaging/shared
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
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
export function formatCommand(command: string, args: string[]): string {
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
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.root,
      stdio: 'inherit',
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
  if (options.hoistSourceNodeModules !== undefined) {
    await restoreLegacyHoists(options)
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
async function restoreLegacyHoists(options: DeployStagingOptions & Required<Pick<DeployStagingOptions, 'hoistSourceNodeModules'>>): Promise<void> {
  if (options.dryRun) {
    console.log(`${options.logPrefix}: [dry-run] restore direct dependencies omitted by legacy deploy`)
    return
  }
  const { stagingDir } = options
  const manifestPath = join(stagingDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const sourceNodeModules = resolve(options.root, options.hoistSourceNodeModules)
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
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
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
export interface PkgTarget {
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
  const source = join(
    options.stagingDir,
    'node_modules',
    '@vscode',
    `ripgrep-${diskPlatform}-${options.target.arch}`,
    'bin',
    'rg',
  )
  const destination = `${product}-rg`
  if (options.dryRun) {
    console.log(`${options.logPrefix}: [dry-run] cp ${source} ${destination}`)
    return destination
  }
  if (!existsSync(source)) {
    throw new Error(`${options.logPrefix}: target ripgrep binary is missing at ${source}.`)
  }
  await copyFile(source, destination)
  await chmod(destination, 0o755)
  return destination
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
