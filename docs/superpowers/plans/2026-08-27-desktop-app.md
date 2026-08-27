# DeepSeek Harness Desktop phase-one implementation plan

English | [中文](2026-08-27-desktop-app.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the existing Web GUI into DeepSeek Harness Desktop — installable and self-updating on all three platforms (phase one, sidecar subprocess form).

**Architecture:** The Electron shell (`apps/desktop`) spawns a single-file sidecar exe packed by @yao-pkg/pkg carrying the `--profile desktop` composition (= dsh-base + dsh-web-app + dsh-desktop-app); the renderer loads `http://127.0.0.1:<dynamic port>` on a path byte-identical to the browser edition; the desktop bundle only disables the browser handoff in phase one and serves as the phase-two IPC-carrier seat. Updates flow through electron-updater → GitHub Releases.

**Tech Stack:** TypeScript (ESM), Electron + electron-builder + electron-updater, @yao-pkg/pkg (SEA single file), vitest, Cordis plugin system (no agent-loop changes).

**Spec:** `docs/superpowers/specs/2026-08-27-desktop-app-design.md` (this plan argues from it; implementers read both documents)

## Global Constraints

The following constraints apply to every task:

- Whole-repo ESM (`"type": "module"`); inter-package imports always use package names, local relative imports use the `.ts` suffix.
- The repository version series is currently `0.1.0-rc.8`; every new workspace package version must be set to `0.1.0-rc.8` and rise with the dsh release family.
- `apps/*` and `packages/<group>/<pkg>` are auto-collected by the dsh family patterns in `scripts/release/families.ts`: **no new package may carry `"private": true`**, otherwise `release:verify` fails.
- Harness engines constrain `node ^22.19 || >=24`: the sidecar (pkg node24 baseline) satisfies them naturally; Electron bundled Node ≥22.19 is a prerequisite of the phase-two carrier move (recorded this phase, not verified).
- The root vitest config already includes `apps/*/tests/**/*.spec.ts` and `packages/*/*/tests/**/*.spec.{ts,tsx}`; tests live in each package `tests/`, named `*.spec.ts` (client-face `*.client.spec.{ts,tsx}`); do not add per-package vitest dependencies (root devDependencies already carry vitest ^4.1.8).
- The coverage 100% gate scans only `packages/*/*/src/**`: `packages/bundle/desktop-app` must be fully covered; `apps/desktop/src` sits outside the gate but remains under typecheck/lint.
- `scripts/**` is scanned by the jscpd duplication gate (`.jscpd.json`): extract the shared module from `build-exe-for-python-sdk.ts` before writing the new packaging script; copy-paste implementations are forbidden.
- Every package must own its `./invariant` export and register it in the manifest (see `packages/CLAUDE.md`).
- Function-plugin export forms are either/or and never mixed: function plugins named-export `name`/`inject`/`apply` with no default export; Service classes default-export.
- Lifecycle/subprocess/teardown code follows `docs/defensive-patterns.md`: orthogonal outcome facts reported independently (`exitCode`/`signal`/`timedOut` each their own field), disposal reaches quiescence (kill → await exit, unbinding listeners before killing), dispatcher try/catch contains user-callback exceptions.
- **Env-scrub reversal decision (deliberate — do not "fix")**: when spawning the sidecar the shell inherits the full user env without `*KEY*/*SECRET*` scrubbing — inherited env is the highest-priority credentials source (the first layer alongside `$HOME/.dsh/.credentials.yaml`), and scrubbing would break explicitly exported `DEEPSEEK_API_KEY` configuration. The defensive-patterns scrub rule targets harness deriving user commands downward — the opposite direction.
- Prose keeps one physical line per paragraph; files end with exactly one trailing newline (the pre-commit whitespace gate checks).
- Fixture/keyless replay must hold on macOS/Linux; normalizers must not paper over platform differences.

---

## Phase 0 — Spike: pkg Windows closure feasibility (resolving R1 first)

### Task 0.1: Spike — @yao-pkg/pkg packing the win-x64 full closure

**Files:**
- Create: `.github/workflows/desktop-spike.yml` (spike-only, deleted once the conclusion lands)
- Read first: `scripts/build-exe-for-python-sdk.ts` (entirely), `docs/testing.md`

**Interfaces:**
- Consumes: the existing python-sdk packaging pipeline (as the staging-flow template)
- Produces: a go/no-go conclusion (written into this plan’s execution annex and the final Agent Note); the spike workflow is a temporary artifact — Task 5.x rewrites the real pipeline

**Why a spike rather than a formal task**: the python script’s `PLATFORMS = ['linux','macos']` exclusion of Windows is an established non-goal; making win-x64 a target makes native dependencies — koffi (the N-API module behind the Windows ACL backend) chief among them — entering the SEA closure and loading correctly the largest unknown. That answer decides the form of every later packaging task and must resolve first.

- [ ] **Step 1: write the spike workflow**

```yaml
# .github/workflows/desktop-spike.yml
name: desktop-spike
on:
  workflow_dispatch:
    targets:
      description: 'pkg targets, e.g. node24-win-x64'
      default: 'node24-win-x64'
jobs:
  pack:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11.7.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # 复用既有 deploy 路径产 staging（jsonrpc-demo 先例），验证 win 平台收集率
      - run: pnpm run build
      - run: npx tsx scripts/build-exe-for-python-sdk.ts --targets node24-win-x64 --dry-run
      - name: report staging closure size & native deps
        shell: pwsh
        run: |
          Get-ChildItem -Recurse staging目录 | Measure-Object -Property Length -Sum
          Get-ChildItem -Recurse staging目录 -Filter *.node | Select-Object FullName
```

Note: if the python script has no materialized staging output behind `--dry-run`, temporarily hand-run its `pnpm deploy` section instead (Step 1 only needs “closure collected? + size + *.node inventory”; spike-grade scripts are acceptable).

- [ ] **Step 2: trigger the run and record three facts**

Run: `gh workflow run desktop-spike && gh run watch`
Expected records: ① staging success rate (does pnpm deploy error); ② whether the `*.node` inventory includes koffi prebuilds; ③ the uncompressed total size figure.

- [ ] **Step 3: local launch smoke (optional but strongly advised)**

Wherever a Windows environment is available: bring up the exe → TCP probe ready → kill the process. Without Windows, record the debt in an issue body; DoD (Task 7.1) closes it.

- [ ] **Step 4: record the conclusion and delete the spike workflow**

Append the conclusion as one sentence to the Agent Note (created in Task 7.2), e.g. “Spike 2026-08-xx: win-x64 SEA closure OK/NOK, koffi load OK/NOK, uncompressed size N MB”. Then `git rm .github/workflows/desktop-spike.yml`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/desktop-spike.yml
git commit -m "chore(desktop): spike pkg win-x64 closure feasibility"
# 结论写入单独 commit：
git commit --allow-empty -m "docs(desktop): record spike conclusion"
```

---

## Phase 1 — desktop bundle

### Task 1.1: create the `packages/bundle/desktop-app` package skeleton

**Files:**
- Create: `packages/bundle/desktop-app/package.json`
- Create: `packages/bundle/desktop-app/tsconfig.json`
- Create: `packages/bundle/desktop-app/src/index.ts`
- Create: `packages/bundle/desktop-app/src/invariant.ts`
- Create: `packages/bundle/desktop-app/cordis.patch.yml` (placeholder array `[]` this task; Task 1.2 fills the real rows)
- Create: `packages/bundle/desktop-app/README.md`, `README.zh.md`, `README.i18n.yaml`
- Create: `packages/bundle/desktop-app/tests/desktop-app.spec.ts` (filled in Task 1.3)
- Modify: `tsconfig.json` (root solution untouched — aggregates are seeded by `tsconfig.host.json`)

**Interfaces:**
- Consumes: the field-by-field shape of `packages/bundle/headless/package.json` (copy against it); the extends relation of `packages/bundle/headless/tsconfig.json`
- Produces: package name `@deepseek-ai/dsh-desktop-app`; export face `.` / `./invariant` / `./startup` (absent for now) / `./cordis.patch.yml`; the `dsh.bundle.patch` field points at `./cordis.patch.yml`

- [ ] **Step 1: write package.json (replicate headless field by field; dependencies keep only the cordis peer)**

```json
{
  "name": "@deepseek-ai/dsh-desktop-app",
  "version": "0.1.0-rc.8",
  "description": "Desktop surface bundle: the web application composition minus browser-only handoff.",
  "license": "MIT",
  "repository": { "directory": "packages/bundle/desktop-app" },
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/invariant.js", "cordis.patch.yml", "lib/types/**/*.d.ts"],
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
  "devDependencies": { "@deepseek-ai/cordis": "workspace:^" },
  "publishConfig": { "access": "public" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

(Alignment point: copy the actual cordis version number in `peerDependencies` from `packages/bundle/headless/package.json`.)

- [ ] **Step 2: write src/index.ts and src/invariant.ts**

```ts
// src/index.ts
/**
 * Desktop surface bundle entry.
 *
 * The composition lives in cordis.patch.yml (stacked after @deepseek-ai/dsh-web-app);
 * this module exists so the bundle mounts as an ordinary loader-entry plugin and
 * keeps the ./invariant seam. Phase-two IPC-carrier rows will be added here.
 *
 * @module @deepseek-ai/dsh-desktop-app
 */
export const name = 'desktop-app'
export const inject = [] as const

/**
 * Install nothing today: the bundle's effect is its stacked patch rows.
 * @param _ctx - unused while the installer stays empty
 */
export function apply(_ctx: import('@deepseek-ai/cordis').Context): void {}
```

```ts
// src/invariant.ts
/**
 * Package invariant installer for the desktop bundle.
 * @module @deepseek-ai/dsh-desktop-app/invariant
 */
// No runtime invariant: a pure patch-layer bundle owns no event/data relation of
// its own; behavioral assertions live in tests/desktop-app.spec.ts over the
// composed tree.
export function installInvariants(): void {}
```

Copy the invariant file’s exact signature (installer shape, manifest registration) structurally from any existing bundle (e.g. `packages/bundle/web-app/src/invariant.ts`) — the snippet above only sketches the wording duty; wherever the manifest still needs a name registered, follow that same current pattern.

- [ ] **Step 3: tsconfig.json and READMEs**

`tsconfig.json`: extends `../../tsconfig.base.json`, `rootDir: "src"`, `outDir: "lib/types"`, `include: ["src"]`, with a references array containing `../base` and `../web-app` (shape copied from the headless tsconfig). Write the README in the Model Experience format covering model/token/KV effects (this bundle has none — say no model-facing rows outright) plus `## Known Limitations and Deferred Work` (one sentence on the phase-two carrier direction); translate README.zh.md correspondingly and register README.i18n.yaml.

- [ ] **Step 4: build + hygiene self-check**

Run: `pnpm install && pnpm run build:lib && pnpm run constraints`
Expected: PASS (constraints validates workspace structure legality).

- [ ] **Step 5: Commit**

```bash
git add packages/bundle/desktop-app
git commit -m "feat(desktop): add dsh-desktop-app bundle skeleton"
```

### Task 1.2: cordis.patch.yml — disable the browser handoff

**Files:**
- Modify: `packages/bundle/desktop-app/cordis.patch.yml`

**Interfaces:**
- Consumes: the `web-runtime` row text at `packages/bundle/web-app/cordis.patch.yml` L137-144
- Produces: composed semantics where `openBrowser === false` under the desktop composition (the Task 1.3 assertion target)

- [ ] **Step 1: write the patch (a patch replaces the row’s whole config — restate every owned key)**

```yaml
# Stacks strictly after @deepseek-ai/dsh-web-app: desktop shells own the window,
# so the composed runtime must never hand off to the system browser. Replaces the
# targeted row's whole config, so every key the row owns is restated here.
- id: web-runtime
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true
    trustedHosts: !!js ctx.webStartup.trustedHosts
```

Two strict notes: ① the commented fact (“replaces the whole config”) comes from the original comment at the top of the web-app patch, so no keys may go missing — `printUrl`/`surfaceContext` keep their values and `trustedHosts` keeps its `!!js` expression; ② if the `ctx.webStartup.trustedHosts` expression is unreachable in this patch context (same overlay scope), lift the expression verbatim following the web-app original, and should the Loader then error, consult `docs/cordis-primer.md#loader-configuration` and land the smallest primer-sanctioned correction, explaining in the PR.

- [ ] **Step 2: Commit**

```bash
git add packages/bundle/desktop-app/cordis.patch.yml
git commit -m "feat(desktop): disable browser handoff in desktop composition"
```

### Task 1.3: REAL-composition test — composed openBrowser is false

**Files:**
- Test: `packages/bundle/desktop-app/tests/desktop-app.spec.ts`
- Read first: `packages/bundle/web-app/tests/browser-open.spec.ts` (assertion master template), `docs/testing.md` (REAL composition policy)

**Interfaces:**
- Consumes: the Task 1.2 patch; the web-app bundle patch behavior
- Produces: this file doubles as the regression anchor of the desktop composition; append assertions here when phase two adds carrier rows

- [ ] **Step 1: write the failing test**

```ts
import { describe, expect, it } from 'vitest'
// 组合装配辅助沿用 web-app/browser-open.spec.ts 的现有做法；
// 该 helper 若未导出，就地以其开头 30 行为蓝本在本文件内建最小版本。

describe('desktop bundle composition', () => {
  it('resolves web-runtime with openBrowser disabled', async () => {
    // 通过 Loader 挂载三层组合（base → web-app → desktop-app），
    // 断言 web-runtime 插件实际收到的 config.openBrowser === false，
    // 且 printUrl/surfaceContext/trustedHosts 未被整行替换抹掉。
    const config = resolveCommittedWebRuntimeConfig(basePlusWebAppPlusDesktop())
    expect(config.openBrowser).toBe(false)
    expect(config.printUrl).toBe(true)
    expect(config.surfaceContext).toBe(true)
  })
})
```

The concrete assembly must follow the Loader/boot helpers browser-open.spec.ts actually uses (it is the sole authoritative template); hand-built `ctx.plugin(...)` substitutes for real Loader composition are forbidden (`packages/CLAUDE.md` REAL-composition policy).

- [ ] **Step 2: run red**

Run: `pnpm vitest run packages/bundle/desktop-app --project thread-safe`
Expected: FAIL (openBrowser still true, or the composition cannot stack the desktop patch yet).

- [ ] **Step 3: if red because the patch did not take effect, fix the patch to green**

Common causes: bundle name spelling mismatching the `dsh.bundle.patch` path; patch file top level not an array; missing double bang on `!!js`.

Run: `pnpm vitest run packages/bundle/desktop-app --project thread-safe`
Expected: PASS。

- [ ] **Step 4: coverage self-check (this package’s src is inside the 100% gate)**

Run: `pnpm vitest run packages/bundle/desktop-app --coverage --project thread-safe`
Expected: both desktop-app files at 100%.

- [ ] **Step 5: Commit**

```bash
git add packages/bundle/desktop-app/tests
git commit -m "test(desktop): assert composed openBrowser is disabled"
```

---

## Phase 2 — profile template wiring

### Task 2.1: add the desktop entry to `PROFILE_TEMPLATES`

**Files:**
- Modify: `packages/boot/app-boot/src/profile.ts:113-117`
- Test: the existing spec managing PROFILE_TEMPLATES under `packages/boot/app-boot/tests/` (locate via `ls packages/boot/app-boot/tests/`; keep the assertion style)
- Modify: the template-listing section of `packages/boot/app-boot/README.md` (if present)

**Interfaces:**
- Consumes: the Task 1.1 `@deepseek-ai/dsh-desktop-app`
- Produces: first use of `dsh --profile desktop` auto-initializes the `[dsh-base, dsh-web-app, dsh-desktop-app]` composition — one shared entry for sidecar and development modes

- [ ] **Step 1: write the failing test (inside the existing template-managing spec)**

```ts
it('initializes the desktop profile from the shipped three-bundle tuple', () => {
  expect(PROFILE_TEMPLATES['desktop']).toEqual([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-desktop-app',
  ])
})
```

Also assert names absent from the table still fall through to `DEFAULT_PROFILE_BUNDLES` (regression guard; skip if an equivalent assertion already exists).

- [ ] **Step 2: run red**

Run: `pnpm vitest run packages/boot/app-boot --project thread-safe`
Expected: FAIL (no desktop key yet).

- [ ] **Step 3: minimal implementation**

```ts
export const PROFILE_TEMPLATES: Record<string, readonly string[]> = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  desktop: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-app'],
}
```

- [ ] **Step 4: run green + manual end-to-end verification (the dev chain works from here!)**

Run: `pnpm vitest run packages/boot/app-boot --project thread-safe && pnpm dsh --profile desktop --dump-config | grep -A3 web-runtime`
Expected: tests PASS; the dump shows the web-runtime row `openBrowser: false`.

- [ ] **Step 5: Commit**

```bash
git add packages/boot/app-boot
git commit -m "feat(desktop): ship desktop profile template (base+web-app+desktop-app)"
```

### Task 3.0 (folded into this phase): verify existing first-run onboarding works under the desktop composition

**Background correction (versus the spec)**: exploration confirmed the onboarding capability already exists in `packages/client/ui-settings-models` (the `OnboardingReadiness` closed union, `onboardingReadiness()`, and `DeepSeekOnboardingDialog.tsx` mounted at the `settings.onboarding` slot), and credentials privileged RPCs pin to loopback — the desktop side qualifies. **Do not create a new ui-onboarding package** (YAGNI); spec component-table item 4 stands corrected accordingly.

**Files:** (zero additions; pure verification plus possibly a one-line roster fix)
- Verify: whether the web-app browser roster already carries `ui-settings-models` (grep `packages/bundle/web-app/cordis.patch.yml` and the client-shell assembly sites)

- [ ] **Step 1: static verification**

Run: `grep -rn "ui-settings-models" packages/bundle/web-app packages/client/web`
Expected: assembly-site hits. If none: add one roster/assembly mounting line following the neighboring plugin registration format, committed with this step.

- [ ] **Step 2: dynamic verification (manual; evidence into the PR)**

Clear `~/.dsh/.credentials.yaml`, then `pnpm dsh web --no-open`; opening the browser should surface the onboarding modal, and after entering a dummy key `credentials.describe` returns configured:true. Attach screenshots/screen capture to the PR.

- [ ] **Step 3: Commit (only when Step 1 needed a fix)**

```bash
git commit -m "fix(desktop): mount ui-settings-models into browser roster for onboarding"
```

---

## Phase 4 — the Electron shell project `apps/desktop`

### Task 4.1: project skeleton + main/preload/renderer channels

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/main/main.ts` (entry point)
- Create: `apps/desktop/src/main/window-manager.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/error.html` (sidecar-failure error page, statically self-contained)
- Create: `apps/desktop/tests/bootstrap.spec.ts` (smoke-level unit test: modules importable, constants legal)

**Interfaces:**
- Consumes: SidecarManager arrives only after Task 4.2; this task leaves the import site as an explicit compile-time dependency (top-level static ESM import, never string-assembled dynamic imports)
- Produces: the `createMainWindow(opts)` window lifecycle and the `MAIN_PROCESS_API` names (the preload exposure consumed by Tasks 4.3/4.4)

Key decisions (pinned here; implementers stop choosing):
- Package name `@deepseek-ai/dsh-desktop`, `version` on the same rc series, **no private field**, `bin: { "dsh-desktop": "lib/main.js" }` (even though this phase does not distribute the app itself on npm, release-family membership demands public semantics).
- Build: **not through the root tsdown workspace** (`apps/web` precedent); main/preload compile straight to `lib/` via tsc, renderer is static html/css. `tsconfig.json` extends `../../tsconfig.base.json`, rootDir src, outDir lib/types, include src.
- devDependencies gain `electron` (version rule pinned: install the current stable line whose bundled Node ≥22.19 — check `pnpm why electron` then assert `process.versions.node` on node; bump the line when short), plus `electron-builder` and `electron-updater`.

- [ ] **Step 1: write the three entry skeletons**

```ts
// src/main/main.ts
/**
 * DeepSeek Harness Desktop main process entry: window lifecycle owned here,
 * agent runtime owned by the sidecar process started by SidecarManager.
 *
 * @module @deepseek-ai/dsh-desktop/main
 */
import { app } from 'electron'
import { SidecarManager } from './sidecar-manager.ts'
import { createMainWindow } from './window-manager.ts'

const manager = new SidecarManager()

app.whenReady().then(async () => {
  const handle = await manager.start()          // Task 4.2 的契约：ready 或 failed
  if (handle.kind !== 'ready') {
    renderErrorPage(handle.diagnostic)
    return
  }
  createMainWindow(`http://127.0.0.1:${handle.port}/`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown(signal === 'SIGTERM' ? 0 : 130) })
}
app.on('window-all-closed', () => { void shutdown(0) })

async function shutdown(code: number): Promise<void> {
  await manager.stop()                          // quiescence: kill → await exit
  app.exit(code)
}
```

```ts
// src/main/window-manager.ts — createMainWindow(url): BrowserWindow
// 要点：单实例窗口；宽度默认 ≥1024 高度 ≥720；loadURL(url)；
// did-fail-load 时切换 error.html 并提供「打开日志目录」按钮所需 IPC 通道名
// MAIN_PROCESS_API = { openLogsDir: 'dsh-desktop:openLogsDir' }（唯一 preload 面）
```

```ts
// src/preload/index.ts — contextBridge.exposeInMainWorld(MAIN_PROCESS_API.openLogsDir 等薄桥)
// 安全基线：contextIsolation true、nodeIntegration false、sandbox true；
// 暴露的方法仅限白名单常量，不接受任意 channel。
```

error.html contents: a title, the `diagnostic` placeholder paragraph, the “open log directory” button (calling the preload bridge), and a retry button (location.reload). Diagnostic copy lives here, not hardcoded in main.

- [ ] **Step 2: bootstrap.spec.ts**

```ts
import { describe, expect, it } from 'vitest'

describe('desktop shell bootstrap', () => {
  it('exposes a single whitelist bridge namespace', async () => {
    const { MAIN_PROCESS_API } = await import('../src/main/api-names.ts')
    expect(Object.keys(MAIN_PROCESS_API)).toContain('openLogsDir')
  })
  it('pins renderer security flags document', () => {
    // 断言常量：contextIsolation/nodeIntegration/sandbox 期望值集中定义于此
    expect(SECURITY_FLAGS).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true })
  })
})
```

(api-names.ts holds the MAIN_PROCESS_API and SECURITY_FLAGS constants shared by main and preload so strings cannot drift.)

- [ ] **Step 3: pass typecheck**

Run: `pnpm exec tsc -p apps/desktop --noEmit`
Expected: PASS. Note Electron types come from the `electron` package; do not let tsconfig types introduce global node-dom conflicts (use apps/web’s exclude technique to fence off test files).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): scaffold electron shell with thin preload bridge"
```

### Task 4.2: SidecarManager (this plan’s TDD core)

**Files:**
- Create: `apps/desktop/src/main/sidecar-manager.ts`
- Create: `apps/desktop/src/main/port-probe.ts` (pure functions: free-port selection + TCP probe loop)
- Create: `apps/desktop/src/main/restart-policy.ts` (pure functions: exponential-backoff decisions)
- Test: `apps/desktop/tests/sidecar-manager.spec.ts`, `apps/desktop/tests/port-probe.spec.ts`, `apps/desktop/tests/restart-policy.spec.ts`

**Interfaces:**
- Consumes: nothing (standalone unit)
- Produces (main.ts, updater, and the error page all depend on these shapes):

```ts
export interface SidecarStartOptions {
  /** absolute path to the packaged (or tsx-launched dev) server executable */
  executablePath: string
  args: readonly string[]
  readyTimeoutMs?: number            // 默认 30_000
  restartPolicyMaxAttempts?: number  // 默认 5
}

export type SidecarState =
  | { kind: 'starting' }
  | { kind: 'ready'; port: number }
  | { kind: 'stopped'; cause: { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean } }
  | { kind: 'failed'; diagnostic: string }

export declare class SidecarManager {
  start(options?: Partial<SidecarStartOptions>): Promise<{ kind: 'ready'; port: number } | { kind: 'failed'; diagnostic: string }>
  stop(): Promise<void>
  onStateChange(listener: (state: SidecarState) => void): () => void
}
```

- [ ] **Step 1: write failing tests — port/probe pure functions**

```ts
// tests/port-probe.spec.ts
describe('pickFreePort', () => {
  it('returns an unbound port (listen 0 semantics)', async () => {
    const port = await pickFreePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })
  it('probe resolves once the port accepts a connection', async () => {
    const server = net.createServer().listen(0, '127.0.0.1')
    const port = (server.address() as net.AddressInfo).port
    await expect(probeTcp(port, { timeoutMs: 1000 })).resolves.toBe(true)
    server.close()
  })
  it('probe times out against a dead port and reports so independently', async () => {
    await expect(probeTcp(1, { timeoutMs: 50 })).resolves.toBe(false) // port 1 不可绑定监听但 connect 会被拒绝
  })
})
```

```ts
// tests/restart-policy.spec.ts — 纯决策表
it.each([
  [0, 1000], [1, 2000], [2, 4000], [3, 8000], [4, 16000], [5, null],
])('attempt %i yields backoff %j', (attempt, delay) => {
  expect(nextBackoffDelayMs(attempt)).toBe(delay) // null = 放弃，转 stopped/failed
})
```

- [ ] **Step 2: run red**

Run: `pnpm vitest run apps/desktop --project thread-safe`
Expected: FAIL (modules do not exist).

- [ ] **Step 3: minimal implementation (three defensive-patterns rules land as code shapes)**

```ts
// port-probe.ts 核心
export function pickFreePort(): Promise<number>            // net.createServer().listen(0)
export async function probeTcp(port: number, o: { timeoutMs: number }): Promise<boolean>

// restart-policy.ts
export function nextBackoffDelayMs(attempt: number): number | null  // 1000<<attempt，封顶 16000，超上限 null

// sidecar-manager.ts
// · spawn(child_process.spawn(executablePath, [...args, '--port', String(port)], { stdio:['ignore','pipe','pipe'], env: process.env }))  ← env 继承是有意决策，见 Global Constraints
// · stdout/stderr 各 pipe 到日志文件（userData/logs/sidecar.log，'a' 模式）并同时计 bytes 以防失控（上限截断）
// · ready 判定 = probeTcp(port) 循环直至 timeout → state starting；readyTimeoutMs 到期仍不通 → state failed
// · 子进程 exit → state stopped{ exitCode, signal, timedOut:false }（三个正交字段齐全）
// · stopped 自动重启仅当此前曾达到过 ready；restartPolicyMaxAttempts 耗尽 → stopped 终态 + onStateChange 通告
// · stop(): 先 onStateChange listeners 全部解绑 → child.kill() → await exit 事件（quiescence），两段式 SIGKILL 兜底（5s）
// · 任何 listener 抛错被 dispatcher try/catch 吞掉并 console.error（callback containment）
```

- [ ] **Step 4: run green + complete the state-machine cases (one it() per list item)**

Required case list (each mandatory): ready before restart attempts exhausted; crash during starting → failed; crash after ready → restarted with new port (window reloadURL owned by the onStateChange consumer); stop double-call idempotent; post-stop probes fail too; listener throw does not break the stop promise.

Run: `pnpm vitest run apps/desktop --project thread-safe` → PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src apps/desktop/tests
git commit -m "feat(desktop): sidecar manager with tcp probe and bounded restart"
```

### Task 4.3: wire SidecarManager into main + dual dev/prod start sources

**Files:**
- Modify: `apps/desktop/src/main/main.ts`, `window-manager.ts`
- Create: `apps/desktop/src/main/resolve-sidecar-command.ts`
- Test: `apps/desktop/tests/resolve-sidecar-command.spec.ts`

**Interfaces:**
- Consumes: the Task 4.2 `SidecarManager`
- Produces: `resolveSidecarCommand(env): { command: string; args: string[] }` — prod takes the exe from extraResources; dev (`DSH_DESKTOP_DEV=1`) returns `{ command: 'pnpm', args: ['dsh','web','--profile','desktop','--no-open','--port', '<filled later>'] }`

- [ ] **Step 1: failing tests**

```ts
it('dev flag selects pnpm dsh web with desktop profile', () => {
  const r = resolveSidecarCommand({ DSH_DESKTOP_DEV: '1' })
  expect(r.command).toBe('pnpm')
  expect(r.args.slice(0, 4)).toEqual(['dsh', 'web', '--profile', 'desktop'])
  expect(r.args.join(' ')).toContain('--no-open')
})
it('prod selects the bundled executable path', () => {
  const r = resolveSidecarCommand({})
  expect(r.command.endsWith(process.platform === 'win32' ? '.exe' : '')).toBe(true)
})
```

- [ ] **Step 2: red → implement → green** (same cadence; exe paths rooted at `app.isPackaged ? process.resourcesPath : repoDist`)

- [ ] **Step 3: manual dev smoke**

Run: `DSH_DESKTOP_DEV=1 pnpm --filter @deepseek-ai/dsh-desktop exec electron lib/main.js`
Expected: window appears rendering the desktop composition UI; after closing, no leftover node processes (`pgrep -f "profile desktop"` empty).

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(desktop): wire sidecar lifecycle into main with dev/prod switch"
```

### Task 4.4: updater encapsulation

**Files:**
- Create: `apps/desktop/src/main/updater.ts`, `apps/desktop/src/main/updater-config.ts`
- Test: `apps/desktop/tests/updater-config.spec.ts`

**Interfaces:**
- Consumes: electron-updater `autoUpdater` (glue layer, no unit-coverage demand)
- Produces: `readUpdaterConfig(userData): UpdateFeed` (pure, testable) + `initUpdater(feed): void`; `UpdateFeed = { provider: 'github'; owner; repo } | { provider: 'generic'; url }`

- [ ] **Step 1: failing tests (pure decision function)**

```ts
it.each([
  [{}, { provider: 'github', owner: 'deepseek-harness', repo: 'deepseek-harness' }],   // spec 默认渠道
  [{ feedProvider: 'generic', feedUrl: 'https://example.com/updates/' }, { provider: 'generic', url: 'https://example.com/updates/' }],
])('%j resolves %j', (input, expected) => expect(readUpdaterConfig(input)).toEqual(expected))
it('generic without url fails loud at startup config validation', () => {
  expect(() => readUpdaterConfig({ feedProvider: 'generic' })).toThrow(/feedUrl/)
})
```

- [ ] **Step 2: red → implement → green**; resolution order: env `DSH_UPDATE_FEED_JSON` (CI testing seam) → userData/update-feed.json → default GitHub Releases. Misconfiguration fails loud (repository rule) — no silent fallback.

- [ ] **Step 3: glue initUpdater**: `autoUpdater.setFeedURL(...)`, idempotent `checkForUpdates()` polling (interval constant 4h; exposing interval configurability is YAGNI until upgrade demand appears), completed downloads raise `update-downloaded` through a dialog offering one-click restart-install. Channel constant `latest`.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(desktop): configurable update feed with github releases default"
```

---

## Phase 5 — sidecar packaging pipeline + installer assembly

### Task 5.1: extract the exe-packaging shared module (before the clone-detection red line)

**Files:**
- Create: `scripts/exe-packaging/staging.ts` (parameterized extraction of deploy-staging/materializeStagedLinks/restoreLegacyHoists/injectPkgConfig)
- Modify: `scripts/build-exe-for-python-sdk.ts` (consume the shared module, behavior unchanged)
- Test: `scripts/exe-packaging/staging.spec.ts` (move over the movable cases from the existing `build-exe-for-python-sdk-native-pty.spec.ts`)

**Interfaces:**
- Produces: a shared API shaped like `prepareDeployStaging(o: { manifestFilter?: string; extraAssetGlobs?: string[]; entryBin: string; outStageRoot: string }): Promise<void>` (the sole consumption entry for Task 5.2)

- [ ] **Step 1: mechanical extraction**: move the python script’s L245-269/360-376 regions wholesale into staging.ts, converting class state to function parameters (behavior-preserving refactor; delete no validation, including the repo-root guard and DEPLOY_ONLY_DOCS stripping).
- [ ] **Step 2: python-script regression**: `pnpm vitest run scripts/build-exe-for-python-sdk-native-pty.spec.ts --project thread-safe` → PASS (old cases keep passing alongside their new home).
- [ ] **Step 3: duplication gate**: `pnpm run duplication` → PASS (compare reports pre/post extraction to confirm the drop).
- [ ] **Step 4: Commit**: `refactor(exe-packaging): extract deploy staging shared module from python sdk script`

### Task 5.2: `scripts/build-exe-for-desktop.ts`

**Files:**
- Create: `scripts/build-exe-for-desktop.ts`
- Modify: root `package.json` gains the `"build:exe:desktop": "tsx scripts/build-exe-for-desktop.ts"` script
- Test: `scripts/build-exe-for-desktop.spec.ts` (CLI-parse and target-validation level suffices)

**Interfaces:**
- Consumes: the Task 5.1 shared module
- Produces: four artifacts named `dist-desktop/dsh-desktop-server-<platform>-<arch>[.exe]` plus same-named `-rg` ripgrep companions

Four differences from the python script (all stated explicitly in the script-header comment):
1. `PLATFORMS/ARCHES` become the desktop whitelist intersection of `['linux','win32','darwin'] × ['x64','arm64']`: `[win-x64, linux-x64, linux-arm64, darwin-arm64]`.
2. The deploy object is `apps/cli` (a synthetic deploy manifest via `pnpm --filter @deepseek-ai/dsh-desktop-server-manifest deploy …`? **No** — `apps/cli` itself is the deploy target; following how the python script deploys the jsonrpc-demo package, `--legacy --prod` collects apps/cli’s ~70-item closure).
3. `ENTRY_BIN = 'node_modules/@deepseek-ai/dsh/lib/bin.js'`; injectPkgConfig points its bin field there while SidecarManager passes argv (`--profile desktop --port N --no-open`).
4. **`extraAssetGlobs: ['**/cordis.patch.yml']`** — without this SEA asset whitelist entry the desktop bundle patches never enter the exe (the most-missed point of this packaging chain).

- [ ] **Step 1: implement CLI parsing** (parseArgs: `--targets`, `--skip-build`, `--dry-run`) + `verifyClosure()` (assert at startup that the patch-yml glob hits ≥3: base/web-app/desktop-app) + pack loop over four targets.
- [ ] **Step 2: dry-run self-proof**: `pnpm run build:exe:desktop --dry-run` prints the plan executing nothing → `git status` stays clean.
- [ ] **Step 3: one real local Linux pack round (single host-arch target)** → `dist-desktop/dsh-desktop-server-linux-*` exists → **smoke: spawn it with `--profile desktop --no-open --port <pickFreePort result>`**. Port semantics settle here (overriding any wavering earlier wording): **SidecarManager picks a free port itself and passes it via argv** (the native Task 4.2 contract); the `--port 0` + stdout-parsing option is rejected because it leans on URL-print protocol text unverified here, and its millisecond TOCTOU window falls back to probe-failure diagnostics anyway — the control plane stays entirely ours. Smoke criteria: probe ready → `GET /` returns HTML → SIGTERM leaves zero residue.
- [ ] **Step 4: Commit**: `feat(desktop): package sidecar exe via shared staging module (yml assets included)`

### Task 5.3: electron-builder config + artifact consolidation

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Modify: `apps/desktop/package.json` (script `"dist": "electron-builder --config electron-builder.yml"`)

**Interfaces:**
- Consumes: the Task 5.2 `dist-desktop/*` outputs (extraResources)
- Produces: NSIS exe / AppImage under `apps/desktop/dist-artifacts/`

- [ ] **Step 1: write the config**

```yaml
appId: ai.harnessment.dsh.desktop
productName: DeepSeek Harness Desktop
directories: { output: dist-artifacts }
files: [ lib/**/* , src/renderer/error.html ]
extraResources:
  - from: ../dist-desktop/
    to: sidecar/
    filter: [ dsh-desktop-server-* ]
win:  { target: nsis }
linux:{ target: AppImage, category: Utility }
mac:  { target: dmg, identity: null }   # spec: 一期不签名；拿到证书后填 identity 即接
nsis: { oneClick: true, perMachine: false }
publish: { provider: github, owner: deepseek-harness, repo: deepseek-harness }
```

- [ ] **Step 2: local linux dist round + install smoke** (run the AppImage directly → window → conversation UI → exit with no orphans).
- [ ] **Step 3: Commit**: `build(desktop): electron-builder targets nsis/appimage with sidecar extraResources`

---

## Phase 6 — CI release pipeline

### Task 6.1: `desktop-release.yml`

**Files:**
- Create: `.github/workflows/desktop-release.yml`
- Read first: `.github/workflows/build-exe-for-python-sdk.yml` (matrix/setup master template)

**Interfaces:**
- Consumes: the Task 5.2/5.3 artifact paths and `secrets.GITHUB_TOKEN`
- Produces: a `dsh-v*` tag push or manual dispatch → GitHub Release carrying four-platform installers + latest.yml (electron-updater metadata generated automatically)

- [ ] **Step 1: three-job matrix**: `windows-latest` (win-x64 NSIS), `ubuntu-22.04` (AppImage x64), `ubuntu-24.04-arm` (AppImage arm64; where an arm runner is organizationally unavailable, build via qemu/binfmt and annotate in the job output). The macOS dmg job sets `continue-on-error: true` (phase-one degraded promise). Shared steps: checkout → pnpm/node setup → `pnpm install --frozen-lockfile` → `pnpm run build:lib && pnpm run build:web` → `pnpm run build:exe:desktop --targets <matrix-target>` → `electron-builder --publish always` (tag runs) / draft (dispatch runs).
- [ ] **Step 2: release-family impact check**: `pnpm run release:verify --dry-run` (or the verify precondition branch when no dry-run exists) confirms apps/desktop’s public package identity does not trip verifyPublishable; versions bump with the dsh family.
- [ ] **Step 3: Commit**: `ci(desktop): three-platform release pipeline publishing to github releases`

---

## Phase 7 — DoD acceptance + Agent Note

### Task 7.1: execute the acceptance checklist

**Files:**
- Create: `.agents/notes/plans/desktop-dod-checklist.md` (checkable list, linked from the PR)

- [ ] Execute the four spec acceptance criteria one by one (Win11 x64 / Ubuntu 22.04 x64 / macOS arm64 continue-on-error / uninstall keeps data); cold-start ≤10 s timing method: log timestamp deltas.
- [ ] One real conversation round needs `DEEPSEEK_API_KEY`; keyless environments (CI) stop at snapshot/package-level evidence, leaving manual checklist rows to be executed and backfilled where a key exists.

### Task 7.2: Agent Note (mandatory for a non-trivial change)

**Files:**
- Create: `.agents/notes/implemented/architecture/2026-MM-DD-desktop-phase-one-sidecar.md`

- [ ] Contents must include: the option-C phasing rationale; the spike conclusion (Task 0.1); the settled call plus rationale between `--port 0`+stdout parsing vs explicit port; the env-inheritance reversal decision; the two phase-two carrier prerequisites (Electron Node ≥22.19, koffi ABI). Write frontmatter per the `dsh-archive-agent-notes` skill archiving conventions.
- [ ] Commit: `docs(notes): record desktop phase-one decisions`

---

## Self-Review record (completed)

- **Spec coverage**: six components all covered — bundle (Task 1.x), packaging script (5.2), CI (6.1), updater (4.4), Agent Note (7.2); ui-onboarding corrected by YAGNI to verifying the existing capability in Task 3.0 (the deviation was declared to the user); R1→Task 0.1, R2→6.1 large-asset chunked download enabled by default, R3→4.4 configurable feed, R4→Task 2.1 dev/prod sharing one profile composition.
- **Placeholder scan**: no TBD/TODO anywhere; the two “Read first + master template” pointers (browser-open.spec.ts, workflows matrix) deliberately route to facts rather than stubbing code.
- **Type consistency**: `SidecarState`/`UpdateFeed`/`prepareDeployStaging` names agree everywhere; port semantics were settled at Task 5.2 as “Manager picks a free port, passed via argv,” matching the Task 4.2 interface contract with no cross-phase ambiguity.
