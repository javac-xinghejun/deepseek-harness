# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness Desktop —— 把既有 Web GUI 变成可安装、可自更新桌面应用的 Electron 壳。壳只拥有三件事：窗口、sidecar 进程、更新器。agent runtime、工具、会话以及一切模型可见行为，都归属 sidecar 挂载的 harness 组合（`dsh --profile desktop` = `[dsh-base, dsh-web-app, dsh-desktop-app]`，其 patch 层在 [`@deepseek-ai/dsh-desktop-app`](../../packages/bundle/desktop-app/README.md)）。

renderer 加载 sidecar 的 `http://127.0.0.1:<port>`，因此交互链路与浏览器 surface 完全同一条；壳只是把「用户自己打开的浏览器」换成指向回环端口的确定性窗口。

## Layout

- `src/main/main.ts` —— 入口：就绪门控、失败窗口、生命周期挂接。
- `src/main/sidecar-manager.ts` —— spawn → TCP 探测 → 就绪/崩溃重启/回收状态机（纯 node，单测覆盖）。
- `src/main/window-manager.ts` —— 单实例窗口、错误页切换、唯一白名单 IPC 通道（`openLogsDir`）。
- `src/main/updater.ts` / `updater-config.ts` —— electron-updater 绑定与纯函数的 feed 解析决策。
- `src/preload/index.cjs` —— 沙箱化的 CommonJS 桥；通道名由测试钉死在 `api-names.ts`。
- `src/renderer/error.html` —— 启动失败时的自包含恢复页。

## Development

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build
DSH_DESKTOP_DEV=1 pnpm --filter @deepseek-ai/dsh-desktop exec electron apps/desktop/lib/main/main.js
```

设置 `DSH_DESKTOP_DEV=1` 后，壳改为从工作区源码启动 `pnpm dsh web --profile desktop --no-open`，而不是打包后的可执行文件；可搭配 `pnpm run dev:web` 获得 client 插件 HMR。dev 与 prod 挂载完全相同的组合——只有运行时来源不同。

## Known Limitations and Deferred Work

- **一期交付回环形态** —— renderer 经 HTTP/WebSocket 访问本地 sidecar。进程内 Electron 内嵌与 IPC fetch carrier 属于二期（见 `.agents/notes/implemented/architecture/`）。
- **Windows 开发模式要求 pnpm 在 PATH** —— 不经 shell spawn `pnpm` 无法解析 `pnpm.cmd`；Windows 贡献者请使用能解析 `pnpm.cmd` 的 shell，或等待二期。
