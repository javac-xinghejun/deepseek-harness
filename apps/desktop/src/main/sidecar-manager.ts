/**
 * The sidecar lifecycle state machine: spawns the harness server executable
 * on a manager-chosen loopback port, probes until ready, restarts with
 * exponential backoff when a previously-ready sidecar crashes, and tears
 * down to quiescence. Chromium-free by design (pure node:child_process), so
 * the whole machine unit-tests with a fake spawner.
 * @module @deepseek-ai/dsh-desktop/sidecar-manager
 */

import { spawn } from 'node:child_process'
import { openSync, writeSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { pickFreePort, probeTcp } from './port-probe.ts'
import { nextBackoffDelayMs } from './restart-policy.ts'

/** Delay between consecutive readiness probes; also each probe's connect budget. */
const PROBE_INTERVAL_MS = 250
/** Default grace period between SIGTERM and SIGKILL during teardown. */
const KILL_GRACE_MS = 5_000
/** Hard cap on the append-only sidecar log so a runaway child cannot fill the disk. */
const MAX_LOG_BYTES = 8_000_000

/** Manager construction seams; tests replace every process-touching member. */
export interface SidecarManagerDeps {
  /** Spawns the sidecar process; defaults to node:child_process.spawn. */
  spawn?: typeof spawn
  /** One bounded connect attempt; defaults to {@link probeTcp}. */
  probe?: typeof probeTcp
  /** Free-port picker; defaults to {@link pickFreePort}. */
  pickPort?: () => Promise<number>
  /** Sleep between probes/restarts, for deterministic tests. */
  delay?: (ms: number) => Promise<void>
  /** SIGTERM→SIGKILL grace; defaults to {@link KILL_GRACE_MS}. */
  killGraceMs?: number
}

/** Everything start() needs; unset members fall back to production defaults. */
export interface SidecarStartOptions {
  /** Absolute path or PATH command of the packaged / dev server executable. */
  executablePath: string
  /** Launch arguments placed before the manager-owned `--port <N>` suffix. */
  args?: readonly string[]
  /** Whole readiness budget per launch, approximated by probe iterations. */
  readyTimeoutMs?: number
  /** Automatic-restart budget applied over the whole manager lifetime. */
  restartPolicyMaxAttempts?: number
  /** Interval between readiness probes; also each probe's connect budget. */
  probeIntervalMs?: number
  /** Append-target for piped stdout/stderr, byte-capped; absent disables logging. */
  logFilePath?: string
}

/**
 * A lifecycle snapshot broadcast to subscribers.
 *
 * - `starting` — spawned, readiness probing.
 * - `ready` — loopback accepting connections; consumers own any URL reload.
 * - `stopped` — the child exited; the three cause facts are orthogonal
 *   (a process can time out AND exit 0 when it traps the signal).
 * - `failed` — never reached a serving phase; carries the diagnostic.
 */
export type SidecarState =
  | { kind: 'starting'; port: number }
  | { kind: 'ready'; port: number }
  | { kind: 'stopped'; port: number; cause: SidecarExitCause }
  | { kind: 'failed'; port: number; diagnostic: string }

/** Orthogonal exit report for a stopped sidecar. */
export interface SidecarExitCause {
  /** Process exit code, null when signaled. */
  exitCode: number | null
  /** Terminating signal name, null for clean exits. */
  signal: NodeJS.Signals | null
  /** True only when teardown escalated past SIGTERM into SIGKILL. */
  timedOut: boolean
}

/** Resolution of start(): either a serving sidecar or why it cannot serve. */
export type SidecarStartResult =
  | { kind: 'ready'; port: number }
  | { kind: 'failed'; diagnostic: string }

interface SpawnedSidecar {
  child: ChildProcess
  port: number
}

/** How one awaitReady round ended. */
type ReadinessRound =
  | { kind: 'ready' }
  | { kind: 'exited'; diagnostic: string }

/**
 * Owns exactly one sidecar process per lifetime: start() resolves at first
 * readiness, crash restarts continue under supervision, stop() disposes.
 * All listener dispatch is exception-contained; teardown unbinds listeners
 * before killing so late completions stay silent.
 */
export class SidecarManager {
  private readonly deps: Required<SidecarManagerDeps>

  private readonly listeners = new Set<(state: SidecarState) => void>()

  private current: SpawnedSidecar | undefined

  private restartAttempt = 0

  /** Restart budget applied over the whole manager lifetime. */
  private maxAttempts = 5

  // Lifecycle flags live in one mutable holder; isStopping() mediates reads
  // because cross-method races settle only at await boundaries.
  private readonly lifecycle = { owning: false, stopping: false }

  /** Whether stop() has begun; read through a method so awaits re-check state. */
  private isStopping(): boolean {
    return this.lifecycle.stopping
  }

  public constructor(deps: SidecarManagerDeps = {}) {
    this.deps = {
      spawn: deps.spawn ?? spawn,
      probe: deps.probe ?? probeTcp,
      pickPort: deps.pickPort ?? pickFreePort,
      delay:
      deps.delay ?? (ms => new Promise<void>((resolve) => { setTimeout(resolve, ms) })),
      killGraceMs: deps.killGraceMs ?? KILL_GRACE_MS,
    }
  }

  /**
   * Subscribe to lifecycle broadcasts.
   * @param listener - called for every state change; throwing listeners are
   * logged and skipped, never propagated into the state machine.
   * @returns the unsubscribe function.
   */
  public onStateChange(listener: (state: SidecarState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Launch the sidecar and resolve once it serves or definitively cannot.
   * Only misconfiguration (an unspawnable path) rejects; every runtime
   * failure resolves through `failed`.
   * @param options - launch parameters; see {@link SidecarStartOptions}.
   * @returns the serving port, or the failure diagnostic covering the probe
   * port, attempt count, and last observed fact.
   */
  public async start(options: SidecarStartOptions): Promise<SidecarStartResult> {
    if (this.lifecycle.owning) throw new Error('dsh-desktop: sidecar already started')
    this.lifecycle.owning = true
    this.lifecycle.stopping = false
    this.restartAttempt = 0
    this.maxAttempts = options.restartPolicyMaxAttempts ?? 5
    let lastDiagnostic = 'sidecar start did not complete'
    for (;;) {
      const launched = await this.launchOnce(options)
      if (typeof launched === 'string') return { kind: 'failed', diagnostic: launched }
      const { child, port } = launched
      this.current = { child, port }
      this.emit({ kind: 'starting', port })
      const round = await this.awaitReady(options, child, port)
      if (round.kind === 'ready') {
        this.emit({ kind: 'ready', port })
        void this.superviseCrashes(options)
        return { kind: 'ready', port }
      }
      lastDiagnostic = round.diagnostic
      if (this.isStopping()) break
      if (!this.exited(child)) {
        // A live-but-never-ready sidecar cannot be left bound on its port:
        // reap it before reporting, so a failed start leaves no orphans.
        await this.kill(child)
        if (this.isStopping()) break
      }
      // A crashed launch is retryable only before any ready phase: an
      // initial start that never served fails its caller outright.
      const backoff = this.consumeRestartAttempt()
      if (backoff === null) break
      await this.deps.delay(backoff)
      if (this.isStopping()) break
    }
    this.lifecycle.owning = false
    return { kind: 'failed', diagnostic: lastDiagnostic }
  }

  /** Decide one more automatic restart; consumes the attempt when allowed. */
  private consumeRestartAttempt(): number | null {
    if (this.restartAttempt >= this.maxAttempts) return null
    const backoff = nextBackoffDelayMs(this.restartAttempt)
    if (backoff === null) return null
    this.restartAttempt += 1
    return backoff
  }

  /**
   * Tear the sidecar down to quiescence: unbind all listeners first, then
   * SIGTERM, escalate to SIGKILL after {@link KILL_GRACE_MS}, and await the
   * exit event. Idempotent; safe against a missing or already-dead child.
   */
  public async stop(): Promise<void> {
    if (this.isStopping()) return
    this.lifecycle.stopping = true
    this.lifecycle.owning = false
    // Close the notification registry BEFORE killing so late completions
    // stay silent; no consumer wants updates from a dying child.
    this.listeners.clear()
    const spawned = this.current
    this.current = undefined
    if (spawned === undefined || !liveChild(spawned.child)) return
    await this.kill(spawned.child)
  }

  /** Restart cycle for a formerly-ready sidecar; ends at stop() or budget exhaustion. */
  private async superviseCrashes(options: SidecarStartOptions): Promise<void> {
    for (;;) {
      const spawned = this.current
      if (spawned === undefined || this.lifecycle.stopping) return
      const cause = await this.awaitExit(spawned.child)
      if (this.isStopping()) return
      const backoff = this.consumeRestartAttempt()
      if (backoff === null) {
        // Budget exhausted: the terminal stopped state ends supervision and
        // the shell surfaces it; nothing restarts silently afterwards.
        this.emit({ kind: 'stopped', port: spawned.port, cause })
        this.current = undefined
        this.lifecycle.owning = false
        return
      }
      this.emit({ kind: 'stopped', port: spawned.port, cause })
      await this.deps.delay(backoff)
      if (this.isStopping()) return
      const launched = await this.launchOnce(options)
      if (typeof launched === 'string') {
        this.emit({ kind: 'failed', port: spawned.port, diagnostic: launched })
        this.current = undefined
        this.lifecycle.owning = false
        return
      }
      this.current = launched
      this.emit({ kind: 'starting', port: launched.port })
      const round = await this.awaitReady(options, launched.child, launched.port)
      if (this.isStopping()) return
      if (round.kind !== 'ready') {
        // Never-ready relaunches consume the crash budget rather than fail
        // silently; the stopped state above carries the orthogonal facts.
        this.emit({ kind: 'failed', port: launched.port, diagnostic: round.diagnostic })
        this.current = undefined
        this.lifecycle.owning = false
        return
      }
      this.emit({ kind: 'ready', port: launched.port })
    }
  }

  /** Pick a fresh port and spawn one child; a string result is the failure diagnostic. */
  private launchOnce(options: SidecarStartOptions): Promise<SpawnedSidecar | string> {
    return this.deps.pickPort().then(
      port => new Promise<SpawnedSidecar | string>((resolve) => {
        let settled = false
        const args = [...options.args ?? [], '--port', String(port)]
        // Full environment inheritance is deliberate: credentials resolve
        // from inherited env first, so scrubbing *KEY*/*SECRET*/*TOKEN*
        // would break explicitly exported user configuration. This direction
        // (shell feeding its own sidecar) is the inverse of the defensive-
        // patterns downward-scrub rule, not a violation of it.
        const child = this.deps.spawn(options.executablePath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        })
        pipeToLog(child.stdout, buildLogWriter(options.logFilePath))
        pipeToLog(child.stderr, buildLogWriter(options.logFilePath))
        child.once('error', (error: Error) => {
          if (!settled) {
            settled = true
            resolve(`sidecar could not be launched from ${options.executablePath}: ${error.message}`)
          }
        })
        child.once('spawn', () => {
          if (!settled) {
            settled = true
            resolve({ child, port })
          }
        })
      }),
      (error: unknown) => `sidecar port selection failed: ${String(error)}`,
    )
  }

  /** Poll the port until it accepts, the iteration budget dies, or the child exits first. */
  private awaitReady(
    options: SidecarStartOptions,
    child: ChildProcess,
    port: number,
  ): Promise<ReadinessRound> {
    const interval = options.probeIntervalMs ?? PROBE_INTERVAL_MS
    const budget = Math.ceil((options.readyTimeoutMs ?? 30_000) / interval)
    return new Promise((resolve) => {
      let attempts = 0
      let done = false
      let exitCode: number | null = null
      let exitSignal: NodeJS.Signals | null = null
      let exited = false
      const onExit = (code: number | null, termSignal: NodeJS.Signals | null): void => {
        exited = true
        exitCode = code
        exitSignal = termSignal
      }
      child.once('exit', onExit)
      const step = async (): Promise<void> => {
        while (!done) {
          // Consult the process state itself, not only the event flag: the
          // exit event can fire before this watcher attaches, and the
          // authoritative exitCode/signalCode fields never miss it.
          if (exited || child.exitCode !== null || child.signalCode !== null) {
            finish({
              kind: 'exited',
              diagnostic:
                `sidecar exited before becoming ready on port ${String(port)} `
                + `(exitCode=${String(child.exitCode ?? exitCode)}, signal=${String(child.signalCode ?? exitSignal)}, probes=${String(attempts)})`,
            })
            return
          }
          if (await this.deps.probe(port, { timeoutMs: interval })) {
            finish({ kind: 'ready' })
            return
          }
          attempts += 1
          if (attempts >= budget) {
            finish({
              kind: 'exited',
              diagnostic:
                `sidecar readiness probe timed out on port ${String(port)} `
                + `after ${String(attempts)} attempts`,
            })
            return
          }
          await this.deps.delay(interval)
        }
      }
      const finish = (round: ReadinessRound): void => {
        if (done) return
        done = true
        child.off('exit', onExit)
        resolve(round)
      }
      void step()
    })
  }

  /** Resolves with the child's exit facts whenever it terminates. */
  private awaitExit(child: ChildProcess): Promise<SidecarExitCause> {
    return new Promise((resolve) => {
      child.once('exit', (code, termSignal) => {
        resolve({ exitCode: code, signal: termSignal, timedOut: false })
      })
    })
  }

  /** Whether the child terminated without our asking (used to gate retries). */
  private exited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null
  }

  /** SIGTERM → wait up to {@link KILL_GRACE_MS}-grace for exit → SIGKILL → bounded settle. */
  private kill(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      let done = false
      // A trapping process may surface every terminal shape (signal-trapped,
      // SIGKILL-forced, settled timers); the done flag makes them idempotent.
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(escalation)
        clearTimeout(forcedSettle)
        resolve()
      }
      const escalation = setTimeout(() => {
        if (!liveChild(child)) { finish(); return }
        try {
          child.kill('SIGKILL')
        } catch {
          // Lost the race to an exiting child; finish() owns resolution.
        }
      }, this.deps.killGraceMs)
      // One bounded settle window past SIGKILL so an unresponsive kernel
      // cannot hang teardown forever.
      const forcedSettle = setTimeout(finish, this.deps.killGraceMs * 2)
      child.once('exit', finish)
      try {
        child.kill()
      } catch {
        // An already-exited child raises ESRCH here; the exit listener above
        // has fired or is about to, so the bounded waits stay correct.
      }
      if (!liveChild(child)) finish()
    })
  }

  /** Broadcast one snapshot; a throwing subscriber is contained and logged. */
  private emit(state: SidecarState): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(state)
      } catch (error: unknown) {
        console.error('dsh-desktop: sidecar state listener threw', error)
      }
    }
  }
}

/** Whether the child object reports a live OS process we can still signal. */
function liveChild(child: ChildProcess): boolean {
  // The `killed` flag only records that kill() was called — a trapping
  // process keeps running past it — so liveness reads the exit fields alone.
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null
}

/** Forward one stdio stream into the capped writer; null streams are legal. */
function pipeToLog(stream: NodeJS.ReadableStream | null, write: ((chunk: string) => void) | undefined): void {
  if (stream === null || write === undefined) return
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => { write(chunk) })
}

/** Build one append-mode writer per stream; writing stops at the byte cap. */
function buildLogWriter(logFilePath: string | undefined): ((chunk: string) => void) | undefined {
  if (logFilePath === undefined) return undefined
  const fd = openSync(logFilePath, 'a')
  let written = 0
  return (chunk: string) => {
    if (written >= MAX_LOG_BYTES) return
    written += Buffer.byteLength(chunk)
    try {
      writeSync(fd, chunk)
    } catch {
      // Log-write pressure must never kill the shell; drop the chunk.
    }
  }
}
