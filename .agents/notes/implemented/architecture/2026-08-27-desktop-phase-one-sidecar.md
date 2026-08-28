# Agent Note: DeepSeek Harness Desktop phase one (sidecar)

Status: implemented

English | [中文](2026-08-27-desktop-phase-one-sidecar.zh.md)

## Problem

The harness ships as a CLI plus a browser tab. End users need an installable, self-updating desktop application on all three platforms, without a Node or pnpm prerequisite — while the repository keeps "everything is a plugin" and the browser interaction path byte-identical.

## Decision

Route C in two phases ([spec](../../../../docs/superpowers/specs/2026-08-27-desktop-app-design.md), [plan](../../../../docs/superpowers/plans/2026-08-27-desktop-app.md)):

1. **Phase one (this note)** — an Electron shell (`apps/desktop`, `@deepseek-ai/dsh-desktop`) owns only window + sidecar process + updater; the agent runtime is a `@yao-pkg/pkg` SEA single-file server carrying the full `dsh --profile desktop` composition (`[dsh-base, dsh-web-app, dsh-desktop-app]`). The renderer loads `http://127.0.0.1:<manager-chosen port>` over the unchanged web transport.
2. **Phase two (recorded, unbuilt)** — embed the runtime inside Electron's main process with an IPC fetch carrier reusing the web client packages; prerequisites: Electron's bundled Node ≥22.19 and N-API addon ABI verification (koffi).

New composition facts: `@deepseek-ai/dsh-desktop-app` stacks after the web bundle and pins `openBrowser: false` while restating every key the targeted `web-runtime` row owns (a patch replaces whole configs); `PROFILE_TEMPLATES.desktop` ships the three-bundle tuple; `apps/cli` depends on the new bundle so profile bundles resolve from the installation anchor.

Packaging centralizes deploy staging, pkg injection, native-pty placement, and CLI parsing in `scripts/exe-packaging/shared.ts`; both consumers (python SDK and desktop) now differ only in closure anchors, targets, and outputs.

**Port semantics** are pinned to `SidecarManager picks a free loopback port and passes it via argv` — `--port 0` + stdout parsing was rejected because it leans on unpinned URL-print text, while the argv contract is fully owned here and every probe failure lands in manager diagnostics (port, attempts, last error).

**Environment inheritance for the sidecar is deliberate**: credentials resolve from inherited env first, so scrubbing `*KEY*/*SECRET*/*TOKEN*` would break explicitly exported user configuration. The defensive-patterns scrub rule targets harness → derived-user-command flows, the inverse direction of shell → own sidecar.

**Update feed resolution fails loud** (env JSON → userData file → default GitHub Releases); a generic feed without its URL throws at startup validation rather than silently falling back.

## Spike findings (2026-08-27, closed same day)

Local linux-x64 evidence chain ends green: the packaged SEA exe boots the full composition, serves the web surface (`GET /` returns the app HTML), and tears down under SIGTERM — 202 MB with native assets (`scripts/smoke-sidecar.ts`). Three findings, two product-relevant:

- Vendored override packages (`cordis` family + cosmokit/schemastery) drop out of legacy deploy entirely; the desktop pipeline backfills them from `vendor/` and the rest of the workspace closure from repository sources.
- **Internal-loader directory parents (the blocker)**: rows mounted at runtime through `loader.create` — host-side plugins mounting children, agent presets mounting session plugins — import via Node's internal cascaded loader with `ctx.baseUrl`, a DIRECTORY url, as parent. The internal loader treats a parent as a file and walks up from its dirname, skipping this snapshot's node_modules entirely (include rows never hit this because their parent is the entry FILE). The generated entry wraps `loader.internal.import` once, normalizing directory parents onto a sentinel filename in the same directory.
- **Native shared objects**: sharp's libvips `.so` files need explicit `**/*.so*` asset globs.

Design: the pipeline dumps the composed `[dsh-base, dsh-web-app, dsh-desktop-app]` entry list to `cordis.desktop.yml` at build time (scratch-home `--dump-config`, so bundle layers apply exactly as dev mode sees them) and emits `desktop-entry.mjs`, which boots that config with `bareModuleBaseUrl` anchored inside its own snapshot — the `dsh-jsonrpc-demo/lib/packaged-bin.js` pattern. The sidecar never touches launcher profiles; its argv is web-surface flags only (`--no-open`, with `--port` appended by the manager), so the shell's prod contract dropped `--profile`.

Windows/koffi collection is now runnable through a `desktop-release.yml` dispatch on a real Windows runner (still unverified there); electron-builder keeps the unsigned dmg seat with `identity: null`.

## Alternatives considered

- **Tauri shell** — rejected in the spec review: a Rust toolchain plus webkitgtk/WebView2 platform spread buys only binary size on an all-TypeScript repository stack; Electron's main process is already Node.
- **In-process embed first (no sidecar phase)** — would force the Electron-node ≥22.19 and koffi ABI questions before any installable artifact exists; the sidecar form decouples shipping the app from solving the embed.
- **`--port 0` + stdout URL parsing** — removes manager-owned port choice but leans on unpinned print text for readiness; argv passing keeps the control surface entirely local, with probe diagnostics covering the millisecond TOCTOU window.
- **One new `ui-onboarding` client plugin** — rejected by YAGNI after exploration showed `ui-settings-models` already ships `OnboardingReadiness` and its DeepSeek dialog; the desktop composition inherits it through the existing roster.


## Consequences

- Users get one artifact per platform from GitHub Releases via `desktop-release.yml` (tag publish / dispatch draft); update checks poll `latest.yml` on a fixed 4h cadence behind a configurable feed.
- The three-bundle tuple survives the phase-two transition unchanged, so profiles initialized today keep working when the carrier moves in-process.
- Linux-x64 packaging is proven end to end; `desktop-release.yml` dispatches produce draft artifacts per platform, with Windows native (koffi) collection still awaiting its first real-runner run. The DoD checklist records the platform acceptance debts.
