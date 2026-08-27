# `@deepseek-ai/dsh-desktop-app`

[English](README.md) | 中文

dsh 桌面 surface bundle。[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`@deepseek-ai/dsh-web-app`](../web-app/README.md) 之上，禁用浏览器 handoff（`openBrowser: false`），同时保持 URL 打印、surface context 与信任围栏语义不变：桌面壳拥有窗口，组合后的 web runtime 绝不能拉起系统浏览器。本包不贡献任何自己的插件行。

本包同时是桌面壳在组合中的正式席位：二期 Electron carrier 行（复用 web client 包、走内嵌 runtime 的 IPC fetch carrier）通过本 bundle 挂载而非另起新包，因此 `[dsh-base, dsh-web-app, dsh-desktop-app]` 的 profile 元组在 sidecar 到内嵌的过渡中保持稳定。一期的决策记录见 `.agents/notes/implemented/architecture/`。

## Model Experience

无；这是纯 config patch。所有模型可见的贡献都来自它所叠加的 base 与 web-app bundle 行。

#### KV Cache effect

无；除已叠层包含的内容外，该 patch 不向请求前缀增加任何内容。

## Known Limitations and Deferred Work

- **二期尚未实现** —— 本包目前不挂载任何 carrier；Electron main 进程仍只通过回环 HTTP/WebSocket 传输访问 harness，进程内 IPC fetch carrier 随后续切换落地。
