# DeepSeek Harness Desktop 设计文档

状态：已获批准（2026-08-27，brainstorming 会话定案）。产品名 **DeepSeek Harness Desktop**，包名 `@deepseek-ai/dsh-desktop`。

## 背景与目标

把现有 CLI + 浏览器形态的 DeepSeek Harness 交付为最终用户可直接安装使用的桌面软件。本仓库已具备完整 Web GUI（`apps/web` 前端 dist、`packages/host/webserver`、`packages/client/*` 插件体系、`packages/bundle/web-app`），桌面化的本质是把既有 surface 包进一个可安装、可自动更新的壳，而不是新建 GUI。仓库侧此方向已有预告：`.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md` 写明 "A future Electron application reuses the same web client packages over an IPC fetch carrier"，且 `packages/host/webserver` 的 README 把其 carrier 层明确标注为 Web-only（Electron 不复用）。

## 已确认的需求决定

| 决定点 | 结论 |
|---|---|
| 目标用户 | 最终用户产品：自包含安装包，不要求用户装 Node/pnpm；首启引导填写 API key |
| 平台 | 三平台全做；macOS 一期降优先级——能构建出 dmg、基本流程可走通，不承诺分发体验 |
| 更新能力 | 一期内实现检查更新 + 应用内一键升级（非静默自动更新） |
| 发布渠道 | GitHub Releases，electron-updater 对接 |
| macOS 签名 | 一期不做签名公证，构建配置预留 signing 位 |
| 技术路线 | 方案 C 分期：一期 sidecar 子进程形态打通分发闭环并立起 desktop bundle 席位；二期演进为 Electron 进程内嵌 + IPC carrier |

## 架构总览

```
┌─────────────────────── DeepSeek Harness Desktop (apps/desktop) ───────────────────────┐
│                                                                                        │
│  ┌──────────────────┐        spawn + env/port          ┌───────────────────────────┐  │
│  │  Electron Main   │ ────────────────────────────────▶ │  sidecar: dsh-node.exe    │  │
│  │  ├─ SidecarMgr   │ ◀──── TCP probe (ready?) ──────── │  (@yao-pkg/pkg 单文件     │  │
│  │  ├─ WindowMgr    │                                   │   exe：node closure       │  │
│  │  └─ Updater      │                                   │   + dsh-desktop bundle)   │  │
│  └────────┬─────────┘                                   └────────────┬──────────────┘  │
│           │ loadURL                                     ┌────────────┴──────────────┐  │
│           ▼                    127.0.0.1:<port>                       │                │
│  ┌──────────────────┐   HTTP uplink / WebSocket downlink             ▼                │
│  │  Renderer        │ ─────────────────────────────────▶  agent runtime（dsh-base）   │
│  │  (web dist)      │                                     tools / llm / sessions…    │
│  └──────────────────┘                                                  │                │
└─────────────────────────────────────────────────────────────────────────┼──────────────┘
                                                                          ▼
                                              ~/.dsh/（settings·credentials·sessions·profiles…）
                                                          ＋ ~/.dsh/profiles/* 用户插件
```

两条不变式：

1. **壳不知道 profile 组合，bundle 不知道窗口**。Electron 壳只负责窗口、子进程与更新；挂载什么由 `dsh-desktop-app` bundle 组合声明。
2. **交互链路与浏览器版是同一条**（WebSocket downlink + HTTP uplink + api-gateway）。壳只是把「用户自己打开的浏览器」换成「确定性指向 sidecar 端口的受控视图」，不新增任何协议面。

选型说明：不采用 Tauri——引入 Rust 构建链与 webkitgtk/WebView2 的平台差异只为节省体积，与本纯 TS 仓库栈不符；Electron 主进程即 Node，与 harness 同栈。一期的 sidecar 形态还规避了 Electron 内置 Node 版本对 engines（`^22.19||>=24`）的约束问题，该约束推迟到二期切换进程内嵌时再处理。

## 新增组件

| # | 组件 | 位置 | 职责 |
|---|------|------|------|
| 1 | Electron 壳工程 | `apps/desktop`（沿用 `apps/cli`、`apps/web` 的 apps 布局惯例） | main / preload / renderer 三件套；SidecarManager；WindowManager；Updater 接入 |
| 2 | desktop bundle | `packages/bundle/desktop-app` | 叠加在 web-app 组合之上：patch 掉「启动后弹系统浏览器」等 browser-only 行为；作为二期 IPC carrier 行的正式席位从一期就存在 |
| 3 | sidecar 打包脚本 | `scripts/build-exe-for-desktop.ts`（参照先例 `scripts/build-exe-for-python-sdk.ts`） | @yao-pkg/pkg 打四目标单文件 exe：win-x64、linux-x64、linux-arm64、macos-arm64；node closure 含 dsh-desktop 组合所需全部依赖 |
| 4 | 首启引导插件 | `packages/client/ui-onboarding` | 检测 credentials 缺失 → 欢迎向导页（填 DeepSeek API key）。以 client 插件进 roster，而非壳内独立 HTML，保持「一切都是插件」 |
| 5 | CI 发布流水线 | `.github/workflows/desktop-release.yml` | Windows/Linux runner matrix → 构建 sidecar exe 与前端 dist → electron-builder 出 NSIS（Windows）/ AppImage（Linux）→ 上传 GitHub Releases |
| 6 | Agent Note | `.agents/notes/` | 记录 C 路线分期决策与二期 carrier 方向（non-trivial change 规范要求） |

Linux 一期只出 AppImage：deb 无 electron-updater 自更新支持，会造成永远手动更新的死角；deb/rpm 后续按需补。

### SidecarManager 要点

- 端口由 main 动态选择空闲 TCP 端口，经 argv 显式传给 sidecar（`--port <N>`），从根本上避开默认 3080 冲突；sidecar 强制绑定 `127.0.0.1`。
- 就绪判定用 TCP probe（退避循环，总超时上限 30 秒），不为冒烟新增健康检查端点。
- 崩溃恢复指数退避重启，连续失败达上限转错误态并停止重试。
- 实施前先读 `docs/defensive-patterns.md`（生命周期/并发/子进程/teardown 领域的强制前置阅读）。

## 关键流程

### 冷启动

双击图标 → main 启动并选空闲端口 → spawn `<pkg-exe> --profile desktop --port <N>`（env 继承 `$DSH_HOME`，未设置时落 `~/.dsh`）→ TCP probe 至就绪 → `BrowserWindow.loadURL("http://127.0.0.1:<N>")` → 现有链路接管渲染与对话 → `ui-onboarding` 检查 credentials：缺失则进向导，否则直达会话列表。

### 更新

sidecar exe 经 electron-builder extraResources 进入安装包，与壳同源同版本产出（单一 artifact，不存在版本错位面）。Updater 在启动后与周期性查询 `latest.yml` → 应用内提示「发现新版本」→ 用户确认后下载 → 重启完成升级；sidecar 为壳的子进程，随壳退出被回收，无孤儿进程。updater feed URL 与 channel 作为可配置字段（默认 GitHub Releases），符合「部署可变项配置化、不硬编码」约定。

### 开发模式

main 在开发模式下 spawn `pnpm dsh web`（源码直启）而非 pkg exe，并可接 `packages/client/hmr` —— 改前端无需重新打包 exe。dev 与 prod 共享同一个 `--profile desktop` 组合，保证两端行为一致；两者仅运行时来源不同（tsx 源码 vs 单文件 exe）。

## 错误处理

| 故障域 | 行为 |
|--------|------|
| sidecar 拉起失败（文件缺失/损坏/杀软拦截） | 壳内错误页：诊断摘要 + 「打开日志目录」按钮；壳自行收集 sidecar 的 stdout/stderr 与壳内诊断写入日志目录（置于 `~/.dsh/` 下，具体目录名实现时定），不依赖 harness 是否自带文件日志 |
| sidecar 运行中崩溃 | 指数退避自动重启；连续失败封顶后转错误态，永不静默假装正常运行 |
| 就绪探测超时 | 转错误态，展示 probe 过程详情（端口、尝试次数、最后错误） |
| 更新检查失败 | 本轮静默跳过，下个周期重试；不打扰用户 |
| Windows SMARTScreen / macOS Gatekeeper 未签名警告 | 一期以文档 FAQ 应对（对应 macOS 降级决策）；签名配置位预留 |

## 安全与数据

- 全部落盘沿用统一 home 结构：settings、credentials、sessions、storages、profiles 都在 `~/.dsh/`（或 `$DSH_HOME` 重定向处），桌面版与已装 CLI 天然数据互通，这是特性不是缺陷。
- 网络面不变：sidecar 仅回环监听，无 TLS/auth（沿用现有 webserver 明示的安全语义：serve browsers only、local only）。
- 平台执行沙箱沿用现有后端自动选择：Linux bwrap/Landlock、Windows ACL restricted-token（partial）、macOS Seatbelt；桌面形态不改变沙箱语义。
- 卸载移除程序文件，保留 `~/.dsh/` 用户数据（用户会话历史 credentials 属于用户资产）。
- 插件扩展机制天然继承：`$DSH_HOME/profiles/` + `dsh plugin add` 在桌面形态下原样可用，为一期的隐藏能力、后续版本的显式功能（应用内插件管理 UI）留好通路。

## 测试与验收

证据匹配 surface（测试政策）：

| 层 | 证据形式 |
|----|---------|
| SidecarManager 状态机（端口选择/probe/退避策略） | vitest 单测；注入 fake spawner 与 fake timers，不依赖真进程 |
| ui-onboarding 引导行为 | keyless snapshot，通过真实 runnable example 组合回放（产品可见行为变化的政策要求形态） |
| 安装产物可用性 | CI 内逐平台冒烟：拉起 sidecar exe → probe ready → `GET /` 返回前端页面；Linux 壳冒烟用 xvfb-run |
| 新工程整体 | typecheck / lint / hygiene 门禁照常覆盖新 workspace 成员 |
| 版本治理 | desktop 加入 `scripts/release/families.ts` 发布家族，npm 版本与 updater feed 同源 |

验收标准（一期 Definition of Done）：

1. Windows 10/11 x64：下载 → 安装 → 双击图标 → ≤10 秒见到 UI → 无 key 进入向导、填入有效 key 后一轮真实对话获得回复 → 在应用内完成一次端到端模拟版本升级。
2. Ubuntu 22.04+ x64：AppImage 达到同样标准；linux-arm64 产物仅要求 CI 构建成功并通过冒烟拉起验证，不做完整人工验收。
3. macOS arm64：能构建 dmg 并手动走通基本流程，不承诺分发质量。
4. 卸载干净移除程序文件，`~/.dsh` 用户数据保留。

## 分期边界

一期明确不做：IPC carrier / 进程内嵌（二期）、deb/rpm 格式、macOS 签名公证、应用商店分发、应用内插件市场 UI。

二期方向（记录于 Agent Note）：Electron 进程内嵌 harness runtime + IPC fetch carrier 复用 web client 包（消灭 sidecar 双进程）；届时需验证 Electron 主线内置 Node ≥22.19 与 native addon（koffi 等 N-API 模块）兼容性。

## 风险登记

| # | 风险 | 缓解 |
|---|------|------|
| R1 | @yao-pkg/pkg 收集全量 web closure 的成功率与体积（尤其 Windows 上 native 依赖如 koffi） | 列为实施第一步 spike：先打 Windows 目标验证，失败即回退评估替代打包方案 |
| R2 | GitHub Releases 大资产（多平台 100MB+ 安装包）带宽与限流 | electron-updater 分段下载原生支持；属运营项非架构项 |
| R3 | 企业代理环境下 update 请求失败 | feed URL 可配置字段缓解 |
| R4 | dev（源码 tsx）与 prod（pkg exe）环境漂移 | 两端共享同一 `--profile desktop` 组合；snapshot 回放同时约束组合行为 |

## 实施顺序提示（详细计划由 writing-plans 展开）

1. Spike：@yao-pkg/pkg 打 Windows 全量 closure（R1 最先消解）
2. `packages/bundle/desktop-app` + `packages/client/ui-onboarding`
3. `apps/desktop` 壳骨架 + SidecarManager（TDD）
4. sidecar 打包脚本 + CI workflow
5. updater 接入
6. DoD 逐条冒烟验收
