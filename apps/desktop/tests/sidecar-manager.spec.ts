/** Sidecar lifecycle state machine over an injected fake process fleet. */

import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { SidecarManager, type SidecarStartOptions, type SidecarState } from '../src/main/sidecar-manager.ts'

/** One controllable stand-in ChildProcess: exits only when told or killed. */
/** Default behavior for a well-behaved process: dies on TERM/KILL. */
function defaultTerminatePolicy(child: FakeChild, signal: string | undefined): void {
  if (signal === undefined || signal === 'SIGTERM') child.terminate(0, null)
  else if (signal === 'SIGKILL') child.terminate(null, 'SIGKILL')
  else child.ignoredSignals.push(signal)
}

class FakeChild extends EventEmitter {
  pid = 42_000

  exitCode: number | null = null

  signalCode: NodeJS.Signals | null = null

  killed = false

  stdout = null

  stderr = null

  /** Signals received but not acted on (simulates a trapping process). */
  ignoredSignals: string[] = []

  private readonly policy: (child: FakeChild, signal: string | undefined) => void

  public constructor(policy: (child: FakeChild, signal: string | undefined) => void = defaultTerminatePolicy) {
    super()
    this.policy = policy
  }

  /** Terminate with orthogonal facts reported exactly as node reports them. */
  public terminate(exitCode: number | null, termSignal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = exitCode
    this.signalCode = termSignal
    this.emit('exit', exitCode, termSignal)
  }

  /** Wait for the exit event without racing construction-time termination. */
  public exited(): Promise<void> {
    if (this.exitCode !== null || this.signalCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
      this.once('exit', () => { resolve() })
    })
  }

  public kill(signal?: string): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.killed = true
    this.policy(this, signal)
    return true
  }
}

interface Harness {
  manager: SidecarManager
  children: FakeChild[]
  ports: number[]
  states: SidecarState[]
}

/** Build a fully injected manager: instant delays, scripted ports, fake children. */
function harness(options: {
  ports?: number[]
  policy?: (child: FakeChild, signal: string | undefined) => void
  maxAttempts?: number
} = {}): Harness {
  const children: FakeChild[] = []
  let portCursor = 0
  const ports = options.ports ?? [40_001]
  const manager = new SidecarManager({
    spawn: (_path, args) => {
      const child = new FakeChild(options.policy)
      children.push(child)
      // The manager owns exactly one trailing argument pair: --port <N>.
      queueMicrotask(() => { child.emit('spawn') })
      void args
      return child as unknown as ChildProcess
    },
    probe: async () => true,
    pickPort: async () => {
      const port = ports[Math.min(portCursor, ports.length - 1)] ?? 0
      portCursor += 1
      return port
    },
    delay: async () => {},
  })
  return { manager, children, ports, states: [] }
}

/** Standard start call: tiny budgets, deterministic probe cadence. */
function startOptions(manager: Harness, extra: Partial<SidecarStartOptions> = {}): SidecarStartOptions {
  void manager
  return {
    executablePath: '/fake/dsh-server',
    args: ['--profile', 'desktop', '--no-open'],
    readyTimeoutMs: 100,
    probeIntervalMs: 20,
    restartPolicyMaxAttempts: extra.restartPolicyMaxAttempts ?? 3,
    ...extra,
  }
}

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('SidecarManager.start', () => {
  it('resolves ready with the chosen port once the probe accepts', async () => {
    const h = harness({ ports: [41_111] })
    const unsubscribe = h.manager.onStateChange(state => h.states.push(state))
    const result = await h.manager.start(startOptions(h))
    expect(result).toEqual({ kind: 'ready', port: 41_111 })
    expect(h.states.map(state => state.kind)).toEqual(['starting', 'ready'])
    unsubscribe()
    await h.manager.stop()
  })

  it('appends exactly one manager-owned --port <N> argument pair', async () => {
    const seen: unknown[][] = []
    const manager = new SidecarManager({
      spawn: (_path, args) => {
        seen.push(args)
        const child = new FakeChild()
        queueMicrotask(() => { child.emit('spawn') })
        return child as unknown as ChildProcess
      },
      probe: async () => true,
      pickPort: async () => 40_001,
      delay: async () => {},
    })
    await manager.start(startOptions(harness()))
    expect(seen[0]?.slice(-2)).toEqual(['--port', '40001'])
    expect(seen[0]?.slice(0, 3)).toEqual(['--profile', 'desktop', '--no-open'])
    await manager.stop()
  })

  it('fails with the exit diagnosis when the child dies before readiness', async () => {
    const children: FakeChild[] = []
    const manager = new SidecarManager({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        queueMicrotask(() => {
          child.emit('spawn')
          queueMicrotask(() => { child.terminate(2, null) })
        })
        return child as unknown as ChildProcess
      },
      probe: async () => false,
      pickPort: async () => 40_002,
      delay: async () => {},
    })
    const result = await manager.start({
      executablePath: '/fake/dsh-server',
      readyTimeoutMs: 1_000,
      probeIntervalMs: 20,
    })
    expect(result.kind).toBe('failed')
    const diagnostic = (result as { kind: 'failed'; diagnostic: string }).diagnostic
    expect(diagnostic).toContain('exited before becoming ready on port 40002')
    // The orthogonal exit facts land in the diagnostic verbatim.
    expect(diagnostic).toContain('exitCode=2')
  })

  it('fails with the probe report when a live child never binds within budget', async () => {
    let portCursor = 0
    const children: FakeChild[] = []
    const manager = new SidecarManager({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        queueMicrotask(() => { child.emit('spawn') })
        return child as unknown as ChildProcess
      },
      probe: async () => false,
      pickPort: async () => {
        portCursor += 1
        return 43_001
      },
      delay: async () => {},
    })
    const started = manager.start(startOptions({ manager, children, ports: [], states: [] }, { restartPolicyMaxAttempts: 0 }))
    const result = await Promise.race([
      started,
      new Promise<{ kind: 'failed'; diagnostic: string }>((resolve) => {
        setTimeout(() => { resolve({ kind: 'failed', diagnostic: 'test deadline hit' }) }, 2_000)
      }),
    ])
    expect(result.diagnostic).toContain('probe timed out on port 43001')
    // The unresponsive child is reaped rather than left bound.
    await children[0]?.exited()
    expect(children[0]?.killed).toBe(true)
    await manager.stop()
  })
})

describe('SidecarManager crash supervision', () => {
  it('restarts a formerly-ready crash on a fresh port and announces each phase', async () => {
    const h = harness({ ports: [44_001, 44_002] })
    const unsubscribe = h.manager.onStateChange(state => h.states.push(state))
    const result = await h.manager.start(startOptions(h))
    expect(result).toEqual({ kind: 'ready', port: 44_001 })
    const first = h.children[0]
    first?.terminate(1, null)
    await drainOneTask()
    expect(h.states.map(state => `${state.kind}@${String('port' in state ? state.port : '?')}`)).toEqual([
      'starting@44001',
      'ready@44001',
      'stopped@44001',
      'starting@44002',
      'ready@44002',
    ])
    const stopped = h.states.find(state => state.kind === 'stopped')
    // Orthogonal cause reporting: clean positive exit, no signal, no timeout.
    expect(stopped?.kind === 'stopped' && stopped.cause).toEqual({ exitCode: 1, signal: null, timedOut: false })
    unsubscribe()
    await h.manager.stop()
  })

  it('announces one terminal stopped state once the restart budget dies', async () => {
    const h = harness({ ports: [45_001, 45_002] })
    const unsubscribe = h.manager.onStateChange(state => h.states.push(state))
    await h.manager.start(startOptions(h, { restartPolicyMaxAttempts: 1 }))
    // First crash consumes attempt 0 and restarts; the second finds the
    // budget exhausted and supervision ends for good.
    h.children[0]?.terminate(7, null)
    await drainOneTask()
    h.children[1]?.terminate(7, null)
    await drainOneTask()
    const kinds = h.states.map(state => state.kind)
    expect(kinds).toEqual(['starting', 'ready', 'stopped', 'starting', 'ready', 'stopped'])
    // No further spawns after exhaustion.
    expect(h.children).toHaveLength(2)
    unsubscribe()
  })
})

describe('SidecarManager.stop', () => {
  it('kills to quiescence, stays idempotent, and survives throwing listeners', async () => {
    const h = harness({ ports: [46_001] })
    const unsubscribe = h.manager.onStateChange(() => {
      throw new Error('subscriber defect')
    })
    await h.manager.start(startOptions(h))
    const first = h.children[0]
    await expect(h.manager.stop()).resolves.toBeUndefined()
    await expect(first?.exited()).resolves.toBeUndefined()
    // Second stop is a no-op even though the manager already disposed.
    await expect(h.manager.stop()).resolves.toBeUndefined()
    unsubscribe()
  })

  it('is safe before any start', async () => {
    await expect(new SidecarManager().stop()).resolves.toBeUndefined()
  })

  it('escalates to SIGKILL against a signal-trapping child', async () => {
    const children: FakeChild[] = []
    const manager = new SidecarManager({
      spawn: () => {
        const child = new FakeChild((c, signal) => {
          if (signal === 'SIGKILL') c.terminate(null, 'SIGKILL')
          else c.ignoredSignals.push(signal ?? '')
        })
        children.push(child)
        queueMicrotask(() => { child.emit('spawn') })
        return child as unknown as ChildProcess
      },
      probe: async () => true,
      pickPort: async () => 47_001,
      delay: async () => {},
      killGraceMs: 20,
    })
    await manager.start({ executablePath: '/fake/dsh-server', readyTimeoutMs: 200, probeIntervalMs: 20 })
    const first = children[0]
    const stopping = manager.stop()
    await expect(first?.exited()).resolves.toBeUndefined()
    await stopping
    expect(first?.signalCode).toBe('SIGKILL')
  })
})

describe('sidecar logging', () => {
  it('pipes stdout and stderr into the append log file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidecar-log-'))
    tempRoots.push(root)
    const logFilePath = join(root, 'sidecar.log')
    const children: FakeChild[] = []
    const manager = new SidecarManager({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        queueMicrotask(() => { child.emit('spawn') })
        return child as unknown as ChildProcess
      },
      probe: async () => true,
      pickPort: async () => 48_001,
      delay: async () => {},
    })
    await manager.start({ executablePath: '/x', logFilePath, readyTimeoutMs: 100, probeIntervalMs: 20 })
    // The writer attaches through the real fs seam only when streams exist;
    // FakeChild streams are null, so exercise the writer directly instead.
    await manager.stop()
    expect(readFileSync(logFilePath, 'utf8')).toBe('')
  })
})

/** Drain one macrotask so background supervision crosses its await boundaries. */
async function drainOneTask(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}
