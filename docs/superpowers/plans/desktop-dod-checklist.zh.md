# DeepSeek Harness Desktop —— 一期 DoD 清单

[English](desktop-dod-checklist.md) | 中文

Status: in-progress（自动化欠账记录于一期 [Agent Note](../../../.agents/notes/implemented/architecture/2026-08-27-desktop-phase-one-sidecar.md)）

验收标准来自已批准的 spec，并附当前证据。真实平台环节需要本 checkout 没有的 runner 或硬件；每个未勾选项都标注其归属面。

## 1. Windows 10/11 x64

- [ ] 下载 → 安装 NSIS → 10 秒内冷启动见到 UI。**被阻断**：packaged-bin 的 SEA 阻断点（Agent Note §Spike 结论）。
- [ ] 无 key 进入向导；有效 key 完成一轮真实对话。
- [ ] 应用内端到端更新一轮（electron-updater 走 GitHub Releases）。

## 2. Ubuntu 22.04+ x64

- [ ] AppImage 达到与 Windows 相同标准。**同一阻断点**；sidecar 本体已在宿主 Node 下可启动（`scripts/smoke-sidecar.ts` 证据链）。
- [x] sidecar exe 组合通过：staged 闭包可服务 `dsh web`（宿主 Node 探针），打包产物内 `--dump-default-config` 以 0 退出。

## 3. macOS arm64

- [ ] dmg 可构建且人工基本流程走通（一期降级承诺，`continue-on-error` 泳道）。**运行行为同受阻断**；electron-builder 配置已就绪（未签名）。

## 4. 卸载

- [ ] 程序文件移除、`~/.dsh/` 用户数据保留（各平台卸载器 + 人工确认）。

## 已落地的回归锚

- [x] `packages/bundle/desktop-app/tests/desktop-app.spec.ts` 钉死组合后 `openBrowser: false` 且其余 owned keys 全部复述。
- [x] `apps/desktop/tests/*` 钉死 SidecarManager 状态机（TDD）、重启退避表、端口探测、更新 feed fail-loud 解析，以及 preload/api-names 防漂移契约。
- [x] `dsh --profile desktop --dump-config` 显示三层 bundle 叠加且浏览器 handoff 关闭。

## 平台之外的欠账

- [ ] desktop packaged-bin 入口落地后再跑 win-x64 `@yao-pkg/pkg` 收集 spike（koffi 预编译产物）。
- [ ] 持真实 key 做 ui-settings-models 引导动态验证（roster 挂载已完成静态验证）。
