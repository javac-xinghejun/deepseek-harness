# DeepSeek Harness Desktop 一期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 Web GUI 打包为三平台可安装、可自更新的 DeepSeek Harness Desktop（一期 sidecar 子进程形态）。

**Architecture:** Electron 壳（`apps/desktop`）spawn 一个 @yao-pkg/pkg 打出的单文件 sidecar exe（内嵌 `--profile desktop` 组合 = dsh-base + dsh-web-app + dsh-desktop-app），renderer 加载 `http://127.0.0.1:<动态端口>`，交互链路与浏览器版完全同一条；desktop bundle 一期仅禁用浏览器弹出并作为二期 IPC carrier 的席位。更新走 electron-updater → GitHub Releases。

**Tech Stack:** TypeScript (ESM)、Electron + electron-builder + electron-updater、@yao-pkg/pkg (SEA 单文件)、vitest、Cordis 插件体系（不改 agent-loop）。

**Spec:** `docs/superpowers/specs/2026-08-27-desktop-app-design.md`（本计划从中立论；执行者需同时阅读两份文档）

## Global Constraints

以下约束适用于每一个任务：

- 全仓 ESM（`"type": "module"`）；package 间导入一律用包名，本地相对导入用 `.ts` 后缀。
- 仓库版本序列当前为 `0.1.0-rc.8`；所有新增 workspace 包版本必须设为 `0.1.0-rc.8` 并跟 dsh 发布家族一起升。
- `apps/*` 与 `packages/<group>/<pkg>` 都被 `scripts/release/families.ts` 的 dsh 家族 patterns 自动收编：**任何新包不得带 `"private": true`**，否则 `release:verify` 失败。
- harness 引擎约束 `node ^22.19 || >=24`：sidecar（pkg node24 基线）天然满足；Electron 内置 Node ≥22.19 是二期 carrier 化的前置项（本期只记录，不验证）。
- vitest 根配置已收录 `apps/*/tests/**/*.spec.ts` 与 `packages/*/*/tests/**/*.spec.{ts,tsx}`；测试放各包 `tests/`，命名 `*.spec.ts`（client 面 `*.client.spec.{ts,tsx}`），不要新建各包自有 vitest 依赖（根 devDeps 已有 vitest ^4.1.8）。
- coverage 100% 门只扫 `packages/*/*/src/**`：`packages/bundle/desktop-app` 必须满覆盖；`apps/desktop/src` 不在门内但仍受 typecheck/lint 管。
- `scripts/**` 被 jscpd duplication 门扫描（`.jscpd.json`）：从 `build-exe-for-python-sdk.ts` 提取共享模块后再写新打包脚本，禁止复制粘贴实现。
- 每个包必须拥有自己的 `./invariant` 导出并在 manifest 注册（见 `packages/CLAUDE.md`）。
- 功能插件导出形态二选一且不可混用：function 插件 named-export `name`/`inject`/`apply`，无 default export；Service 类 default-export。
- 生命周期/子进程/teardown 代码遵守 `docs/defensive-patterns.md`：结果的正交事实独立上报（`exitCode`/`signal`/`timedOut` 各自独立字段）、dispose 达到静默（kill → await 退出，且先解绑监听再 kill）、dispatcher 内 try/catch 包住用户回调异常。
- **env scrub 反向决策（有意为之，勿"修复"）**：壳 spawn sidecar 时继承完整用户 env，不做 `*KEY*/*SECRET*` 清洗——credentials 的最高优先级来源就是 inherited env（`$HOME/.dsh/.credentials.yaml` 同级机制的第一层），清洗会破坏用户显式导出 `DEEPSEEK_API_KEY` 的配置途径。defensive-patterns 的 scrub 规则针对的是 harness 向下派生用户命令的场景，方向相反。
- prose 遵守一物理行一段落；文件结尾恰一个换行符（pre-commit whitespace 门会查）。
- fixture/keyless 回放必须在 macOS/Linux 上成立；不许用 normalizer 掩盖平台差异。

---

## Phase 0 — Spike：pkg Windows 闭合可行性（R1 最先消解）

### Task 0.1: Spike — @yao-pkg/pkg 打 win-x64 全量 closure

**Files:**
- Create: `.github/workflows/desktop-spike.yml`（spike 专用，结论落定后删除）
- Read first: `scripts/build-exe-for-python-sdk.ts`（全部）、`docs/testing.md`

**Interfaces:**
- Consumes: 现有 python sdk 打包链路（作 staging 流程模板）
- Produces: go/no-go 结论（写入本计划的执行附注与最终 Agent Note）；spike 用 workflow 为临时产物，正式管线由 Task 5.x 重写

**为什么是 spike 而不是正式任务**：python 脚本的 `PLATFORMS = ['linux','macos']` 显式排除 Windows 是既定 non-goal；我们把 win-x64 变成目标，最大未知是 koffi（Windows ACL 后端的 N-API native 模块）等 native 依赖能否进入 SEA 闭合并被正确加载。此答案决定后续所有打包任务的形态，必须最先消解。

- [ ] **Step 1: 写 spike workflow**

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

注：`--dry-run` 分支若在 python 脚本中不存在 staging 输出物化，则临时改为手跑 `pnpm deploy` 段（Step 1 的目的只是拿到「closure 能否收集成功 + 体积 + *.node 清单」，允许 spike 脚本粗糙）。

- [ ] **Step 2: 触发运行并记录三项事实**

Run: `gh workflow run desktop-spike && gh run watch`
Expected 记录：① staging 成功率（pnpm deploy 是否报错）；② `*.node` 文件清单是否含 koffi 的预编译产物；③ uncompressed 总体积数字。

- [ ] **Step 3: 本机装载冒烟（可选但强烈建议）**

在有 Windows 环境可用时：把 exe 拉起 → TCP 探测就绪 → 杀进程。无 Windows 时在 issue 正文记录此欠账，由 DoD 阶段（Task 7.1）补验。

- [ ] **Step 4: 记录结论并删除 spike workflow**

结论以一句话形式追加到 Agent Note（Task 7.2 创建）：例如「Spike 2026-08-xx: win-x64 SEA closure OK/NOK，koffi 加载 OK/NOK，uncompressed 体积 N MB」。然后 `git rm .github/workflows/desktop-spike.yml`。

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/desktop-spike.yml
git commit -m "chore(desktop): spike pkg win-x64 closure feasibility"
# 结论写入单独 commit：
git commit --allow-empty -m "docs(desktop): record spike conclusion"
```

---

## Phase 1 — desktop bundle

### Task 1.1: 创建 `packages/bundle/desktop-app` 包骨架

**Files:**
- Create: `packages/bundle/desktop-app/package.json`
- Create: `packages/bundle/desktop-app/tsconfig.json`
- Create: `packages/bundle/desktop-app/src/index.ts`
- Create: `packages/bundle/desktop-app/src/invariant.ts`
- Create: `packages/bundle/desktop-app/cordis.patch.yml`（本任务先放占位数组 `[]`，Task 1.2 填真身）
- Create: `packages/bundle/desktop-app/README.md`、`README.zh.md`、`README.i18n.yaml`
- Create: `packages/bundle/desktop-app/tests/desktop-app.spec.ts`（Task 1.3 填实）
- Modify: `tsconfig.json`（根 solution 不动——聚合面由 `tsconfig.host.json` seed）

**Interfaces:**
- Consumes: `packages/bundle/headless/package.json` 的逐字段形态（对照抄写）；`packages/bundle/headless/tsconfig.json` extends 关系
- Produces: 包名 `@deepseek-ai/dsh-desktop-app`，export 面 `.` / `./invariant` / `./startup`（暂缺）/ `./cordis.patch.yml`；`dsh.bundle.patch` 字段指向 `./cordis.patch.yml`

- [ ] **Step 1: 写 package.json（对照 headless 逐字段复刻，dependencies 只留 cordis peer）**

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

（对齐点：`peerDependencies` 的 cordis 版本号以 `packages/bundle/headless/package.json` 实际值为准抄写。）

- [ ] **Step 2: 写 src/index.ts 与 src/invariant.ts**

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

invariant 文件的准确签名（installer 形状、manifest 注册方式）以任一现有 bundle（如 `packages/bundle/web-app/src/invariant.ts`）为准抄写结构——上面只示意文案义务；如果 manifest 还需在某处注册名字，跟随同一现行模式。

- [ ] **Step 3: tsconfig.json 与 README**

`tsconfig.json`：extends `../../tsconfig.base.json`，`rootDir: "src"`、`outDir: "lib/types"`、`include: ["src"]`，references 数组含 `../base`、`../web-app`（形态照抄 headless 的 tsconfig）。README 按 Model Experience 格式写模型/token/KV 影响（本 bundle 无模型面影响，明说 no model-facing rows），并加 `## Known Limitations and Deferred Work`（二期 carrier 方向一句）；README.zh.md 对应翻译，README.i18n.yaml 登记。

- [ ] **Step 4: 构建 + hygiene 自检**

Run: `pnpm install && pnpm run build:lib && pnpm run constraints`
Expected: PASS（constraints 校验 workspace 结构合法性）。

- [ ] **Step 5: Commit**

```bash
git add packages/bundle/desktop-app
git commit -m "feat(desktop): add dsh-desktop-app bundle skeleton"
```

### Task 1.2: cordis.patch.yml — 禁用浏览器 handoff

**Files:**
- Modify: `packages/bundle/desktop-app/cordis.patch.yml`

**Interfaces:**
- Consumes: `packages/bundle/web-app/cordis.patch.yml` L137-144 的 `web-runtime` 行原文
- Produces: desktop 组合下 `openBrowser === false` 的组合语义（Task 1.3 断言对象）

- [ ] **Step 1: 写 patch（patch 替换整行 config，必须复述全部 owned keys）**

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

注意两个严格事项：① 注释里的事实（“替换整行”）来自 web-app patch 头部 L5-6 的原注释，不得遗漏 keys——`printUrl`/`surfaceContext` 保持原值，`trustedHosts` 保持原 `!!js` 表达式；② 如果 `ctx.webStartup.trustedHosts` 表达式在该 patch 语境不可达（同一 overlay scope），跟随 web-app 原文件的写法一字不改地搬运表达式，若搬运后发现 Loader 报错，回读 `docs/cordis-primer.md#loader-configuration` 并以 primer 允许的最小修正落地，同时在 PR 说明。

- [ ] **Step 2: Commit**

```bash
git add packages/bundle/desktop-app/cordis.patch.yml
git commit -m "feat(desktop): disable browser handoff in desktop composition"
```

### Task 1.3: REAL-composition 测试 — 组合后 openBrowser 为 false

**Files:**
- Test: `packages/bundle/desktop-app/tests/desktop-app.spec.ts`
- Read first: `packages/bundle/web-app/tests/browser-open.spec.ts`（断言手法母版）、`docs/testing.md`（REAL composition 政策）

**Interfaces:**
- Consumes: Task 1.2 的 patch；web-app bundle 的 patch 行为
- Produces: 该文件同时充当 desktop 组合的回归锚点；二期加 carrier 行时在此追加断言

- [ ] **Step 1: 写失败测试**

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

具体装配形式必须以 browser-open.spec.ts 实际使用的 Loader/boot 辅助为准（它是唯一权威样板）；禁止 hand-built `ctx.plugin(...)` 替代真实 Loader 组合（`packages/CLAUDE.md` REAL-composition 政策）。

- [ ] **Step 2: 跑红**

Run: `pnpm vitest run packages/bundle/desktop-app --project thread-safe`
Expected: FAIL（openBrowser 还是 true，或组合还叠不上 desktop patch）。

- [ ] **Step 3: 若跑红原因是 patch 未生效，修 patch 至绿**

常见原因：bundle 名拼写与 `dsh.bundle.patch` 路径不符；patch 文件顶层不是数组；`!!js` 缺双叹号。

Run: `pnpm vitest run packages/bundle/desktop-app --project thread-safe`
Expected: PASS。

- [ ] **Step 4: 覆盖率自检（该包 src 在 100% 门内）**

Run: `pnpm vitest run packages/bundle/desktop-app --coverage --project thread-safe`
Expected: desktop-app 两文件 100%。

- [ ] **Step 5: Commit**

```bash
git add packages/bundle/desktop-app/tests
git commit -m "test(desktop): assert composed openBrowser is disabled"
```

---

## Phase 2 — profile 模板接线

### Task 2.1: `PROFILE_TEMPLATES` 增加 desktop 模板

**Files:**
- Modify: `packages/boot/app-boot/src/profile.ts:113-117`
- Test: `packages/boot/app-boot/tests/` 下管理 PROFILE_TEMPLATES 的现有 spec（`ls packages/boot/app-boot/tests/` 定位，断言风格照旧）
- Modify: `packages/boot/app-boot/README.md` 中列模板的小节（如有）

**Interfaces:**
- Consumes: Task 1.1 的 `@deepseek-ai/dsh-desktop-app`
- Produces: `dsh --profile desktop` 首次使用时自动初始化 `[dsh-base, dsh-web-app, dsh-desktop-app]` 组合——sidecar 与开发模式的统一入口

- [ ] **Step 1: 写失败测试（挂在管理模板的现有 spec 里）**

```ts
it('initializes the desktop profile from the shipped three-bundle tuple', () => {
  expect(PROFILE_TEMPLATES['desktop']).toEqual([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-desktop-app',
  ])
})
```

另断言未名列出的名字仍走 `DEFAULT_PROFILE_BUNDLES`（防回归，如已有同类断言则跳过）。

- [ ] **Step 2: 跑红**

Run: `pnpm vitest run packages/boot/app-boot --project thread-safe`
Expected: FAIL（desktop 键不存在）。

- [ ] **Step 3: 最小实现**

```ts
export const PROFILE_TEMPLATES: Record<string, readonly string[]> = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  desktop: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-app'],
}
```

- [ ] **Step 4: 跑绿 + 端到端手动验证（此时 dev 链路已通！）**

Run: `pnpm vitest run packages/boot/app-boot --project thread-safe && pnpm dsh --profile desktop --dump-config | grep -A3 web-runtime`
Expected: 测试 PASS；dump 里 web-runtime 行 `openBrowser: false`。

- [ ] **Step 5: Commit**

```bash
git add packages/boot/app-boot
git commit -m "feat(desktop): ship desktop profile template (base+web-app+desktop-app)"
```

### Task 3.0（并入本阶段）: 验证既有首启引导在桌面组合下生效

**背景更正（相对 spec）**：探索证实 onboarding 能力已存在于 `packages/client/ui-settings-models`（`OnboardingReadiness` closed union、`onboardingReadiness()`、`DeepSeekOnboardingDialog.tsx` 挂在 `settings.onboarding` slot），且 credentials 特权 RPC 钉在 loopback——桌面侧满足。**不新建 ui-onboarding 包**（YAGNI）；spec 组件表第 4 项按此更正。

**Files:**（零新增，纯验证 + 可能的一行 roster 修正）
- Verify: web-app 浏览器 roster 是否已含 `ui-settings-models`（grep `packages/bundle/web-app/cordis.patch.yml` 与 client-shell 装配处）

- [ ] **Step 1: 静态验证**

Run: `grep -rn "ui-settings-models" packages/bundle/web-app packages/client/web`
Expected: 命中装配处。若无命中：在 roster/装配清单补一行挂载（照邻居插件的登记格式），随本步提交。

- [ ] **Step 2: 动态验证（manual，证据入 PR）**

清空 `~/.dsh/.credentials.yaml` 后 `pnpm dsh web --no-open`，浏览器打开 → 应弹 onboarding modal 且填入假 key 后 `credentials.describe` 返回 configured:true。截图/录屏贴 PR。

- [ ] **Step 3: Commit（仅在 Step 1 需要修正时）**

```bash
git commit -m "fix(desktop): mount ui-settings-models into browser roster for onboarding"
```

---

## Phase 4 — Electron 壳工程 `apps/desktop`

### Task 4.1: 工程骨架 + main/preload/renderer 通道

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/main/main.ts`（入口）
- Create: `apps/desktop/src/main/window-manager.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/error.html`（sidecar 失败错误页，静态自包含）
- Create: `apps/desktop/tests/bootstrap.spec.ts`（冒烟 level 单测：模块可 import、常量合法）

**Interfaces:**
- Consumes: Task 4.2 之后才有 SidecarManager；本任务先把 import 点留作明确编译依赖（ESM 顶层静态 import，不可字符串动态拼）
- Produces: `createMainWindow(opts)` 的窗口生命周期、`MAIN_PROCESS_API` 名称（preload 暴露面，Task 4.3/4.4 消费）

关键决策（在此钉死，实施者不再自行选择）：
- 包名 `@deepseek-ai/dsh-desktop`，`version` 同 rc 序列，**无 private 字段**，`bin: { "dsh-desktop": "lib/main.js" }`（即使本期不上 npm 分发应用本体，release 家族成员身份要求公共语义）。
- 构建：**不走根 tsdown workspace**（`apps/web` 先例）；main/preload 用 tsc 直出 `lib/`，renderer 只是静态 html/css。`tsconfig.json` extends `../../tsconfig.base.json`、rootDir src、outDir lib/types、include src。
- devDependencies 增加 `electron`（版本要求写死规则：安装当期 stable 主线，且其内置 Node ≥22.19——`pnpm why electron` 后在 node 上 `process.versions.node` 断言，不达标就升主线）、`electron-builder`、`electron-updater`。

- [ ] **Step 1: 写三个入口的骨架代码**

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

error.html 内容：标题、`diagnostic` 占位段落、「打开日志目录」按钮（调 preload 桥）、重启按钮（location.reload）。诊断文案入此处而非硬编码在 main。

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

（api-names.ts 存放 MAIN_PROCESS_API 与 SECURITY_FLAGS 常量——main 与 preload 共享，避免字符串漂移。）

- [ ] **Step 3: typecheck 过闸**

Run: `pnpm exec tsc -p apps/desktop --noEmit`
Expected: PASS。注意 Electron 类型从 `electron` 包读取，tsconfig types 不要全局引入 node-dom 冲突（以 apps/web 的 exclude 手法隔离测试文件）。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): scaffold electron shell with thin preload bridge"
```

### Task 4.2: SidecarManager（本计划 TDD 核心）

**Files:**
- Create: `apps/desktop/src/main/sidecar-manager.ts`
- Create: `apps/desktop/src/main/port-probe.ts`（纯函数：空闲端口选择 + TCP probe 循环）
- Create: `apps/desktop/src/main/restart-policy.ts`（纯函数：指数退避决策）
- Test: `apps/desktop/tests/sidecar-manager.spec.ts`、`apps/desktop/tests/port-probe.spec.ts`、`apps/desktop/tests/restart-policy.spec.ts`

**Interfaces:**
- Consumes: 无（独立单元）
- Produces（main.ts、updater、错误页均依赖此形状）:

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

- [ ] **Step 1: 写失败测试 — 端口与 probe 纯函数**

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

- [ ] **Step 2: 跑红**

Run: `pnpm vitest run apps/desktop --project thread-safe`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 最小实现（三条 defensive-patterns 规则落实到代码形状）**

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

- [ ] **Step 4: 跑绿 + 补状态机用例（列表形式，逐条落成 it()）**

必备用例清单（每个都要有）：ready before restart attempts exhausted；crash during starting → failed；crash after ready → restarted with new port（window 重新 loadURL 由 onStateChange 消费方负责）；stop 双调用幂等；stop 后 probe 也不通；listener throw 不炸 stop promise。

Run: `pnpm vitest run apps/desktop --project thread-safe` → PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src apps/desktop/tests
git commit -m "feat(desktop): sidecar manager with tcp probe and bounded restart"
```

### Task 4.3: main 接线 SidecarManager + dev/prod 双启动源

**Files:**
- Modify: `apps/desktop/src/main/main.ts`、`window-manager.ts`
- Create: `apps/desktop/src/main/resolve-sidecar-command.ts`
- Test: `apps/desktop/tests/resolve-sidecar-command.spec.ts`

**Interfaces:**
- Consumes: Task 4.2 的 `SidecarManager`
- Produces: `resolveSidecarCommand(env): { command: string; args: string[] }` — prod 从 extraResources 取 exe；dev（`DSH_DESKTOP_DEV=1`）返回 `{ command: 'pnpm', args: ['dsh','web','--profile','desktop','--no-open','--port', '<filled later>'] }`

- [ ] **Step 1: 失败测试**

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

- [ ] **Step 2: 跑红 → 实现 → 跑绿**（同前节奏；exe 相对路径基于 `app.isPackaged ? process.resourcesPath : repoDist`）

- [ ] **Step 3: 手动 dev 冒烟**

Run: `DSH_DESKTOP_DEV=1 pnpm --filter @deepseek-ai/dsh-desktop exec electron lib/main.js`
Expected: 窗口出现并渲染 desktop 组合 UI；关窗后无残留 node 进程（`pgrep -f "profile desktop"` 空）。

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(desktop): wire sidecar lifecycle into main with dev/prod switch"
```

### Task 4.4: Updater 封装

**Files:**
- Create: `apps/desktop/src/main/updater.ts`、`apps/desktop/src/main/updater-config.ts`
- Test: `apps/desktop/tests/updater-config.spec.ts`

**Interfaces:**
- Consumes: electron-updater `autoUpdater`（粘合层不求单测覆盖）
- Produces: `readUpdaterConfig(userData): UpdateFeed`（纯函数可测）+ `initUpdater(feed): void`；`UpdateFeed = { provider: 'github'; owner; repo } | { provider: 'generic'; url }`

- [ ] **Step 1: 失败测试（决策纯函数）**

```ts
it.each([
  [{}, { provider: 'github', owner: 'deepseek-harness', repo: 'deepseek-harness' }],   // spec 默认渠道
  [{ feedProvider: 'generic', feedUrl: 'https://example.com/updates/' }, { provider: 'generic', url: 'https://example.com/updates/' }],
])('%j resolves %j', (input, expected) => expect(readUpdaterConfig(input)).toEqual(expected))
it('generic without url fails loud at startup config validation', () => {
  expect(() => readUpdaterConfig({ feedProvider: 'generic' })).toThrow(/feedUrl/)
})
```

- [ ] **Step 2: 跑红 → 实现 → 绿**；配置读取顺序：env `DSH_UPDATE_FEED_JSON`（CI 测试用）→ userData/update-feed.json → 默认 GitHub Releases。misconfigured 必须 fail loud（仓库约定），不放静默回退。

- [ ] **Step 3: 粘合层 initUpdater**：`autoUpdater.setFeedURL(...)`、`checkForUpdates()` 幂等轮询（间隔常量 4h，本任务不为间隔暴露配置——YAGNI，升级诉求出现再加）、下载完成 `update-downloaded` 事件经 dialog 提示一键重启安装。channel 常量 `latest`。

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(desktop): configurable update feed with github releases default"
```

---

## Phase 5 — sidecar 打包管线 + 安装包装配

### Task 5.1: 提取 exe 打包共享模块（先行于 clone 检测红线）

**Files:**
- Create: `scripts/exe-packaging/staging.ts`（deploy-staging/materializeStagedLinks/restoreLegacyHoists/injectPkgConfig 的参数化提取）
- Modify: `scripts/build-exe-for-python-sdk.ts`（改为消费共享模块，行为不变）
- Test: `scripts/exe-packaging/staging.spec.ts`（从 python 脚本现存 `build-exe-for-python-sdk-native-pty.spec.ts` 中平移可平移用例）

**Interfaces:**
- Produces: `prepareDeployStaging(o: { manifestFilter?: string; extraAssetGlobs?: string[]; entryBin: string; outStageRoot: string }): Promise<void>` 形状的共享 API（Task 5.2 唯一消费入口）

- [ ] **Step 1: 机械提取**：把 python 脚本 L245-269/360-376 区域整体搬入 staging.ts，class 改函数参注（movational refactor，不删任何校验，包括 repo-root 保护检查与 DEPLOY_ONLY_DOCS 剔除）。
- [ ] **Step 2: python 脚本回归**：`pnpm vitest run scripts/build-exe-for-python-sdk-native-pty.spec.ts --project thread-safe` → PASS（与新位置用例都过）。
- [ ] **Step 3: duplication 门**：`pnpm run duplication` → PASS（对比提取前后报告确认下降）。
- [ ] **Step 4: Commit**：`refactor(exe-packaging): extract deploy staging shared module from python sdk script`

### Task 5.2: `scripts/build-exe-for-desktop.ts`

**Files:**
- Create: `scripts/build-exe-for-desktop.ts`
- Modify: 根 `package.json` 增加 script `"build:exe:desktop": "tsx scripts/build-exe-for-desktop.ts"`
- Test: `scripts/build-exe-for-desktop.spec.ts`（CLI 解析与 targets 校验级别即可）

**Interfaces:**
- Consumes: Task 5.1 共享模块
- Produces: `dist-desktop/dsh-desktop-server-<platform>-<arch>[.exe]` 四产物命名 + 同名 `-rg` ripgrep 副产物

与 python 脚本的四点差异（全部显式写在脚本头注释）：
1. `PLATFORMS/ARCHES` → `['linux','win32','darwin'] × ['x64','arm64']` 的 desktop 白名单交集 `[win-x64, linux-x64, linux-arm64, darwin-arm64]`。
2. deploy 对象是 `apps/cli`（一个 synthetic deploy manifest：`pnpm --filter @deepseek-ai/dsh-desktop-server-manifest deploy …`？**否**——`apps/cli` 本体即 deploy 目标，参照 python 脚本 deploy jsonrpc-demo 包的方式，`--legacy --prod` 收 apps/cli 的 70 项 closure）。
3. `ENTRY_BIN = 'node_modules/@deepseek-ai/dsh/lib/bin.js'`；injectPkgConfig 的 bin 字段指向它，argv 由 SidecarManager 传入（`--profile desktop --port N --no-open`）。
4. **`extraAssetGlobs: ['**/cordis.patch.yml']`** —— SEA asset 白名单没有这一条，desktop bundle 的 patch 进不了 exe（这是本次打包链路最易漏的一点）。

- [ ] **Step 1: 实现 CLI parse**（parseArgs：`--targets`、`--skip-build`、`--dry-run`）+ `verifyClosure()`（启动即断言 patch yml glob 命中数 ≥3：base/web-app/desktop-app）+ pack 四 target 循环。
- [ ] **Step 2: dry-run 自证**：`pnpm run build:exe:desktop --dry-run` 打印计划不执行 → `git status` 干净。
- [ ] **Step 3: Linux 本机实打一轮（host 架构单目标）** → `dist-desktop/dsh-desktop-server-linux-*` 存在 → **冒烟：spawn 它 `--profile desktop --no-open --port <pickFreePort 结果>`**。端口语义在此定案（覆盖任何摇摆说法）：**SidecarManager 自选空闲端口经 argv 直传**（Task 4.2 的原生契约）；不使用 `--port 0` + stdout 解析方案，理由——它依赖未在此处验证的 URL 打印协议文本，且方案 A 的毫秒级 TOCTOU 窗口由 probe 失败诊断兜底，控制面全部在本方。冒烟判据：probe 就绪 → `GET /` 返回 HTML → SIGTERM 进程零残留。
- [ ] **Step 4: Commit**：`feat(desktop): package sidecar exe via shared staging module (yml assets included)`

### Task 5.3: electron-builder 配置 + 产物合一

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Modify: `apps/desktop/package.json`（script `"dist": "electron-builder --config electron-builder.yml"`）

**Interfaces:**
- Consumes: Task 5.2 的 `dist-desktop/*`（extraResources）
- Produces: `apps/desktop/dist-artifacts/` 下 NSIS exe / AppImage

- [ ] **Step 1: 写配置**

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

- [ ] **Step 2: linux 本机 dist 一轮 + 安装冒烟**（AppImage 直接执行 → 窗口 → 对话 UI → 退出无孤儿）。
- [ ] **Step 3: Commit**：`build(desktop): electron-builder targets nsis/appimage with sidecar extraResources`

---

## Phase 6 — CI 发布流水线

### Task 6.1: `desktop-release.yml`

**Files:**
- Create: `.github/workflows/desktop-release.yml`
- Read first: `.github/workflows/build-exe-for-python-sdk.yml`（矩阵/setup 手法母版）

**Interfaces:**
- Consumes: Tasks 5.2/5.3 产物路径、`secrets.GITHUB_TOKEN`
- Produces: tag `dsh-v*` push 或 manual dispatch → GitHub Release 附四平台安装包 + latest.yml（electron-updater 元数据自动生成）

- [ ] **Step 1: 三 job 矩阵**：`windows-latest`（win-x64 NSIS）、`ubuntu-22.04`（AppImage x64）、`ubuntu-24.04-arm`（AppImage arm64，若 arm runner 在组织层不可用则以 qemu/binfmt 构建并在 job 输出标注）。macOS dmg job 设 `continue-on-error: true`（一期降级承诺）。共用步骤：checkout → pnpm/node setup → `pnpm install --frozen-lockfile` → `pnpm run build:lib && pnpm run build:web` → `pnpm run build:exe:desktop --targets <matrix-target>` → `electron-builder --publish always`（tag 场景）/draft（dispatch 场景）。
- [ ] **Step 2: release 家族影响核验**：`pnpm run release:verify --dry-run`（若无 dry-run 则跑 verify 前置检查分支）确认 apps/desktop 的 public 包身份不炸 verifyPublishable；版本跟 dsh 家族 bump。
- [ ] **Step 3: Commit**：`ci(desktop): three-platform release pipeline publishing to github releases`

---

## Phase 7 — DoD 验收 + Agent Note

### Task 7.1: 验收清单执行

**Files:**
- Create: `.agents/notes/plans/desktop-dod-checklist.md`（可勾选清单，PR 关联）

- [ ] 逐条执行 spec「验收标准」四条（Win11 x64 / Ubuntu 22.04 x64 / macOS arm64 continue-on-error / 卸载保数据）；窗口冷启动 ≤10s 计时方式：日志时间戳差。
- [ ] 真实对话一轮需 `DEEPSEEK_API_KEY`；无 key 环境（CI）跳到 snapshot/包级证据为止，人工清单留待有 key 环境执行并回填。

### Task 7.2: Agent Note（non-trivial change 强制件）

**Files:**
- Create: `.agents/notes/implemented/architecture/2026-MM-DD-desktop-phase-one-sidecar.md`

- [ ] 内容必须含：C 路线分期理由；spike 结论（Task 0.1）；`--port 0`+stdout 解析 vs 显式端口的定案及依据；env 继承反向决策；二期 carrier 化的两个前置（Electron Node ≥22.19、koffi ABI）。按 `dsh-archive-agent-notes` 技能的归档规矩写 frontmatter。
- [ ] Commit：`docs(notes): record desktop phase-one decisions`

---

## Self-Review 记录（已完成）

- **Spec coverage**：六组件 → bundle（Task 1.x）、打包脚本（5.2）、CI（6.1）、updater（4.4）、Agent Note（7.2）齐；ui-onboarding 按 YAGNI 更正为 Task 3.0 验证既有能力（偏差已向用户声明）；R1→Task 0.1、R2→6.1 大资产分段下载缺省启用、R3→4.4 feed 可配置、R4→Task 2.1 dev/prod 同一 profile 组合。
- **Placeholder scan**：无 TBD/TODO；两处「Read first + 对照母版」（browser-open.spec.ts、workflows 矩阵）是有意为之的事实引路而非代码占位。
- **Type consistency**：`SidecarState`/`UpdateFeed`/`prepareDeployStaging` 各处名称一致；端口语义已在 Task 5.2 定案为「Manager 自选空闲端口 argv 直传」，与 Task 4.2 的接口契约一致，无跨阶段歧义。
