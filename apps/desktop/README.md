# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

DeepSeek Harness Desktop — the Electron shell that turns the existing Web GUI into an installable, self-updating desktop application. The shell owns three things only: the window, the sidecar process, and the updater. The agent runtime, tools, sessions, and every model-visible behavior belong to the harness composition the sidecar mounts (`dsh --profile desktop` = `[dsh-base, dsh-web-app, dsh-desktop-app]`, a stack whose patch layer lives in [`@deepseek-ai/dsh-desktop-app`](../../packages/bundle/desktop-app/README.md)).

The renderer loads `http://127.0.0.1:<port>` from the sidecar, so the interaction path is byte-identical to the browser surface; the shell is just the deterministic window pointed at the loopback port instead of a user-opened tab.

## Layout

- `src/main/main.ts` — entry: readiness gating, failure window, lifecycle attachment.
- `src/main/sidecar-manager.ts` — spawn → TCP probe → ready/crash-restart/teardown state machine (pure node, unit-tested).
- `src/main/window-manager.ts` — single-window creation, error page swap, the one whitelisted IPC verb (`openLogsDir`).
- `src/main/updater.ts` / `updater-config.ts` — electron-updater binding plus the pure feed-resolution decision.
- `src/preload/index.cjs` — sandboxed CommonJS bridge; channel names are pinned to `api-names.ts` by tests.
- `src/renderer/error.html` — self-contained recovery page for a failed start.

## Development

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build
DSH_DESKTOP_DEV=1 pnpm --filter @deepseek-ai/dsh-desktop exec electron apps/desktop/lib/main/main.js
```

With `DSH_DESKTOP_DEV=1` the shell spawns `pnpm dsh web --profile desktop --no-open` from workspace sources instead of the packaged executable; pair it with `pnpm run dev:web` for client-plugin HMR. Dev and prod mount the exact same composition — only the launch source differs.

## Known Limitations and Deferred Work

- **Phase one ships the loopback form** — the renderer reaches the runtime over HTTP/WebSocket against a local sidecar. The in-process Electron embed with an IPC fetch carrier is phase two (see `.agents/notes/implemented/architecture/`).
- **Windows dev mode requires pnpm on PATH** — spawning `pnpm` without a shell does not resolve `pnpm.cmd`; Windows contributors should use `pnpm.cmd`-aware shells or wait for phase two.
