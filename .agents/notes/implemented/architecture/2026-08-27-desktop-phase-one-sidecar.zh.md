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

## Spike 结论（2026-08-27）

linux-x64 本机证据链：全闭包收集成功（未压缩 sidecar 约 184 MB + 5.5 MB rg），SEA 内 `--dump-default-config` 通过（bundle patch 资产靠 `cordis.patch.yml` asset glob 进入快照——极易遗漏，缺了在加载期致命），staged 闭包在宿主 Node 下完整启动。过程中修正两点：

- vendored override 包（cordis 家族 + cosmokit/schemastery）会被 legacy deploy 整体丢弃；desktop 管线现在从 `vendor/` 回填它们，workspace 闭包其余部分从仓库源码回填。
- **一期遗留阻断点**：插件行的动态裸名导入以真实文件系统上的 profile 目录为锚，而该处的 `profiles/node_modules` 符号链接无法指向 `/snapshot/...` 快照路径。宿主 Node 可启动；SEA 在 loader apply 阶段失败，尽管组合与资产都通过。修复方案是 desktop packaged-bin 入口直接从快照锚挂载组合好的 cordis.yml（`dsh-jsonrpc-demo/lib/packaged-bin.js` 先例），不再走 launcher profile。在该入口落地前，Windows/koffi 收集保持未验证状态；win-x64 spike workflow 因此未运行，结论记录于此而非计划中的独立 spike 笔记。

macOS 目标的对齐随 packaged-bin 工作一并决定；electron-builder 配置已按一期降级承诺保留未签名 dmg 席位（`identity: null`）。

## 考虑过的备选

- **Tauri 壳** —— spec 评审否决：为省体积引入 Rust 工具链与 webkitgtk/WebView2 平台差异，与纯 TS 仓库栈不符；Electron 主进程本来就是 Node。
- **直接一期内嵌（跳过 sidecar）** —— 会把 Electron 内置 Node ≥22.19 与 koffi ABI 问题顶在任何可安装产物诞生之前；sidecar 形态把「先把应用发出去」与「解决内嵌」解耦。
- **`--port 0` + stdout 解析** —— 省掉端口自选，但就绪判定依赖未钉死的打印文本；argv 直传让控制面完全归本方，毫秒级 TOCTOU 窗口由探测诊断兜底。
- **新建 `ui-onboarding` 客户端插件** —— 探索证实 `ui-settings-models` 已自带 `OnboardingReadiness` 与 DeepSeek 对话框，桌面组合经既有 roster 继承即可，按 YAGNI 否决。


## 后果

- 用户从 GitHub Releases 经 `desktop-release.yml` 获取每平台一个安装包（tag 发布 / dispatch 出草稿）；更新检查以固定 4 小时节拍轮询 `latest.yml`，feed 地址可配置。
- 三元组 profile 在二期切换中保持不变，今天初始化的 profile 在 carrier 内嵌化后继续可用。
- 在 packaged-bin 阻断点闭合之前，CI 安装包会携带无法启动的 sidecar；`desktop-release.yml` 必须保持 dispatch-only（草稿）或停用。平台验收欠账记录于 DoD 清单。
