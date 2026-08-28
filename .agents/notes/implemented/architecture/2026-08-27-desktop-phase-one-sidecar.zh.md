# Agent Note：DeepSeek Harness Desktop 一期（sidecar 形态）

Status: implemented

[English](2026-08-27-desktop-phase-one-sidecar.md) | 中文

## 问题

harness 目前的交付形态是 CLI 加浏览器标签页。最终用户需要一个三平台可安装、可自更新的桌面应用，且不要求预装 Node 或 pnpm——同时仓库必须保持「一切都是插件」，浏览器交互链路一字不改。

## 决定

C 路线分两期（[spec](../../../../docs/superpowers/specs/2026-08-27-desktop-app-design.md)、[plan](../../../../docs/superpowers/plans/2026-08-27-desktop-app.md)）：

1. **一期（本笔记）** —— Electron 壳（`apps/desktop`，`@deepseek-ai/dsh-desktop`）只拥有窗口、sidecar 进程与更新器；agent runtime 是 `@yao-pkg/pkg` 的 SEA 单文件服务端，携带完整 `dsh --profile desktop` 组合（`[dsh-base, dsh-web-app, dsh-desktop-app]`）。renderer 加载 `http://127.0.0.1:<管理器选定端口>`，传输层与浏览器版完全同一条。
2. **二期（已记录、未实现）** —— 把 runtime 以 IPC fetch carrier 内嵌进 Electron 主进程并复用 web client 包；前置条件：Electron 内置 Node ≥22.19 与 N-API 插件 ABI 验证（koffi）。

新的组合事实：`@deepseek-ai/dsh-desktop-app` 叠加在 web bundle 之后，把 `openBrowser` 钉为 `false`，同时复述目标 `web-runtime` 行拥有的全部键（patch 是整行替换）；`PROFILE_TEMPLATES.desktop` 交付三元组模板；`apps/cli` 依赖新 bundle，使 profile bundle 能从安装锚解析。

打包机制收敛进 `scripts/exe-packaging/shared.ts`（deploy staging、pkg 注入、native-pty 摆放、CLI 解析），两个消费方（python SDK 与 desktop）只剩闭包锚点、targets 和产物差异。

**端口语义**定案为「SidecarManager 自选空闲回环端口经 argv 直传」；否决 `--port 0` + stdout 解析——它依赖未钉死的 URL 打印文本，而 argv 完全归本方所有，探测失败全部落在 manager 诊断里（端口、次数、最后错误）。

**sidecar 继承完整环境是有意的**：credentials 第一优先级来源就是继承 env，清洗 `*KEY*/*SECRET*/*TOKEN*` 会破坏用户显式导出的配置。defensive-patterns 的 scrub 规则针对 harness → 派生用户命令方向，与 shell → 自有 sidecar 相反。

**更新 feed 解析 fail loud**（env JSON → userData 文件 → 默认 GitHub Releases）；generic feed 缺 URL 在启动校验期抛错而非静默回退。

## Spike 结论（2026-08-27，当日闭环）

linux-x64 证据链终局为绿：打包后的 SEA exe 完整启动组合、服务 Web 界面（`GET /` 返回应用 HTML）、SIGTERM 下有界回收——含原生资产共 202 MB（`scripts/smoke-sidecar.ts`）。三个发现，两个与产品相关：

- vendored override 包（cordis 家族 + cosmokit/schemastery）会被 legacy deploy 整体丢弃；desktop 管线现在从 `vendor/` 回填它们，workspace 闭包其余部分从仓库源码回填。
- **internal loader 的目录 parent（即阻断点）**：运行期经 `loader.create` 挂载的行——宿主侧插件挂子行、agent preset 挂会话插件——经 Node 内部级联 loader 导入，parent 是 `ctx.baseUrl` 这个**目录 URL**；internal loader 把 parent 当文件、从其 dirname 向上找 node_modules，恰好跳过本快照的 node_modules（include 行从不踩坑，因为它们的 parent 是入口文件）。生成的入口对 `loader.internal.import` 做一次性包装，把目录 parent 规范化为同目录哨兵文件名。
- **原生共享库**：sharp 的 libvips `.so` 需要显式的 `**/*.so*` asset glob。

设计：打包管线在构建期把组合好的 `[dsh-base, dsh-web-app, dsh-desktop-app]` 条目列表 dump 为 `cordis.desktop.yml`（隔离 home 的 `--dump-config`，bundle 层的叠加与 dev 模式所见完全一致），并生成 `desktop-entry.mjs`，以 `bareModuleBaseUrl` 锚定自身快照启动该配置——即 `dsh-jsonrpc-demo/lib/packaged-bin.js` 的模式。sidecar 从此不再触碰 launcher profile；其 argv 只有 web 面旗标（`--no-open`，`--port` 由管理器追加），壳的 prod 契约因此去掉了 `--profile`。

Windows/koffi 收集现在可通过 `desktop-release.yml` 在真实 Windows runner 上 dispatch 验证（该处仍待首次验证）；electron-builder 保留未签名 dmg 席位（`identity: null`）。

## 考虑过的备选

- **Tauri 壳** —— spec 评审否决：为省体积引入 Rust 工具链与 webkitgtk/WebView2 平台差异，与纯 TS 仓库栈不符；Electron 主进程本来就是 Node。
- **直接一期内嵌（跳过 sidecar）** —— 会把 Electron 内置 Node ≥22.19 与 koffi ABI 问题顶在任何可安装产物诞生之前；sidecar 形态把「先把应用发出去」与「解决内嵌」解耦。
- **`--port 0` + stdout 解析** —— 省掉端口自选，但就绪判定依赖未钉死的打印文本；argv 直传让控制面完全归本方，毫秒级 TOCTOU 窗口由探测诊断兜底。
- **新建 `ui-onboarding` 客户端插件** —— 探索证实 `ui-settings-models` 已自带 `OnboardingReadiness` 与 DeepSeek 对话框，桌面组合经既有 roster 继承即可，按 YAGNI 否决。


## 后果

- 用户从 GitHub Releases 经 `desktop-release.yml` 获取每平台一个安装包（tag 发布 / dispatch 出草稿）；更新检查以固定 4 小时节拍轮询 `latest.yml`，feed 地址可配置。
- 三元组 profile 在二期切换中保持不变，今天初始化的 profile 在 carrier 内嵌化后继续可用。
- linux-x64 打包已端到端证实；`desktop-release.yml` dispatch 按平台产出草稿产物，Windows 原生（koffi）收集仍待首次真实 runner 运行。平台验收欠账记录于 DoD 清单。
