# DeepSeek Harness Desktop design document

English | [中文](2026-08-27-desktop-app-design.zh.md)

Status: approved (2026-08-27, settled in a brainstorming session). Product name **DeepSeek Harness Desktop**, package `@deepseek-ai/dsh-desktop`.

## Background and goals

Ship the existing CLI + browser form of DeepSeek Harness as desktop software end users can install and run directly. The repository already has a complete Web GUI (`apps/web` frontend dist, `packages/host/webserver`, the `packages/client/*` plugin family, `packages/bundle/web-app`); desktop packaging is essentially wrapping the existing surface in an installable, self-updating shell, not building a new GUI. The direction was already foreshadowed on the repository side: `.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md` states "A future Electron application reuses the same web client packages over an IPC fetch carrier", and the README of `packages/host/webserver` marks its carrier layer explicitly Web-only (Electron does not reuse it).

## Confirmed requirement decisions

| Decision point | Conclusion |
|---|---|
| Target users | End-user product: self-contained installers; users are not asked to install Node/pnpm; first launch guides API-key entry |
| Platforms | All three; macOS is deprioritized in phase one — a buildable dmg with a walkable basic flow, no distribution-quality promise |
| Update capability | Phase one implements check-for-updates + in-app one-click upgrade (not silent auto-update) |
| Distribution channel | GitHub Releases, wired through electron-updater |
| macOS signing | No signing/notarization in phase one; build config reserves a signing seat |
| Technical route | Option C in phases: phase one ships the sidecar-subprocess form to close the distribution loop and establish the desktop bundle seat; phase two evolves into Electron in-process embedding + IPC carrier |

## Architecture overview

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

Two invariants:

1. **The shell does not know the profile composition; the bundle does not know the window.** The Electron shell is responsible only for window, child process, and updates; what mounts is declared by the `dsh-desktop-app` bundle composition.
2. **The interaction path is byte-identical to the browser edition** (WebSocket downlink + HTTP uplink + api-gateway). The shell merely replaces "the browser the user opened themselves" with a controlled view deterministically pointed at the sidecar port; it adds no protocol face.

Option notes: Tauri is rejected — introducing a Rust build chain plus webkitgtk/WebView2 platform spread buys only binary size and does not fit this pure-TypeScript repository stack; Electron's main process is already Node. The phase-one sidecar form also sidesteps the constraint that Electron's bundled Node version places on engines (`^22.19||>=24`); that constraint moves to phase two when switching to in-process embedding.

## New components

| # | Component | Location | Responsibility |
|---|------|------|------|
| 1 | Electron shell project | `apps/desktop` (following the apps layout convention of `apps/cli`, `apps/web`) | main / preload / renderer trio; SidecarManager; WindowManager; Updater integration |
| 2 | desktop bundle | `packages/bundle/desktop-app` | Stacks over the web-app composition: patches away browser-only behaviors such as "launch the system browser after startup"; exists from phase one as the formal seat for the phase-two IPC carrier row |
| 3 | sidecar packaging script | `scripts/build-exe-for-desktop.ts` (precedent: `scripts/build-exe-for-python-sdk.ts`) | @yao-pkg/pkg packs four-target single-file exes: win-x64, linux-x64, linux-arm64, macos-arm64; node closure contains every dependency of the dsh-desktop composition |
| 4 | First-run onboarding plugin | `packages/client/ui-onboarding` | Detects missing credentials → welcome wizard page (enter DeepSeek API key). Ships as a client plugin in the roster rather than standalone HTML inside the shell, preserving "everything is a plugin" |
| 5 | CI release pipeline | `.github/workflows/desktop-release.yml` | Windows/Linux runner matrix → build sidecar exe and frontend dist → electron-builder produces NSIS (Windows) / AppImage (Linux) → upload GitHub Releases |
| 6 | Agent Note | `.agents/notes/` | Records the option-C phasing decision and the phase-two carrier direction (non-trivial change norm) |

Phase one Linux ships AppImage only: deb has no electron-updater self-update support, which would create a permanently-manual-update dead corner; deb/rpm follow on demand later.

### SidecarManager essentials

- The port is chosen dynamically by main as a free TCP port and passed to the sidecar explicitly via argv (`--port <N>`), fundamentally avoiding default-port 3080 collisions; the sidecar binds `127.0.0.1` mandatorily.
- Readiness uses a TCP probe (backoff loop, overall timeout cap 30 seconds); no new health-check endpoint for smoke purposes.
- Crash recovery restarts with exponential backoff; exhausting consecutive failures moves to an error state and stops retrying.
- Before implementation read `docs/defensive-patterns.md` (mandatory prerequisite reading for lifecycle/concurrency/subprocess/teardown work).

## Key flows

### Cold start

Double-click icon → main starts and picks a free port → spawns `<pkg-exe> --profile desktop --port <N>` (env inherits `$DSH_HOME`; falls to `~/.dsh` when unset) → TCP probe until ready → `BrowserWindow.loadURL("http://127.0.0.1:<N>")` → existing path takes over rendering and conversation → `ui-onboarding` checks credentials: wizard when missing, session list otherwise.

### Updates

The sidecar exe enters installers via electron-builder extraResources, produced same-source same-version as the shell (single artifact, no version-skew face). The updater queries `latest.yml` after startup and periodically → in-app "new version found" prompt → user confirms download → restart completes upgrade; the sidecar is a child of the shell, reclaimed at shell exit, no orphan processes. The updater feed URL and channel are configurable fields (defaulting to GitHub Releases), honoring the "deployment-varying items configurable, nothing hardcoded" convention.

### Development mode

In development mode main spawns `pnpm dsh web` (source-launched) instead of the pkg exe, and can attach `packages/client/hmr` — frontend changes need no exe repack. Dev and prod share the same `--profile desktop` composition so both ends behave identically; they differ only in runtime origin (tsx sources vs single-file exe).

## Error handling

| Failure domain | Behavior |
|--------|------|
| Sidecar launch failure (missing/corrupt file, antivirus interception) | In-shell error page: diagnostic summary + "open log directory" button; the shell itself collects the sidecar's stdout/stderr plus shell diagnostics into a log directory (under `~/.dsh/`; exact directory name decided at implementation), never depending on harness-provided file logging |
| Sidecar crash while running | Exponential-backoff automatic restart; capping consecutive failures moves to error state, never silently pretending normal operation |
| Readiness probe timeout | Moves to error state showing probe detail (port, attempt count, last error) |
| Update check failure | Silently skipped this cycle, retried next period; user unperturbed |
| Windows SMARTScreen / unsigned-macOS Gatekeeper warnings | Phase one answers with documentation FAQ (matching the macOS downgrade decision); signing config seat reserved |

## Security and data

- Everything on disk follows the unified home structure: settings, credentials, sessions, storages, profiles all live under `~/.dsh/` (or wherever `$DSH_HOME` redirects); the desktop edition interoperates with an installed CLI by nature — a feature, not a defect.
- Network face unchanged: sidecar listens loopback only, no TLS/auth (inheriting the existing webserver's stated security semantics: serve browsers only, local only).
- Platform execution sandboxes inherit current backend auto-selection: Linux bwrap/Landlock, Windows ACL restricted-token (partial), macOS Seatbelt; the desktop form changes no sandbox semantics.
- Uninstall removes program files and keeps `~/.dsh/` user data (session history and credentials belong to the user).
- The plugin extension mechanism is inherited naturally: `$DSH_HOME/profiles/` + `dsh plugin add` works as-is in desktop form, leaving the path open as a hidden capability in phase one and an explicit feature later (in-app plugin management UI).

## Testing and acceptance

Evidence matches surface (testing policy):

| Layer | Evidence form |
|----|---------|
| SidecarManager state machine (port selection/probe/backoff policy) | vitest unit tests; injected fake spawner and fake timers, no real processes |
| ui-onboarding guidance behavior | keyless snapshot replayed through a real runnable example composition (the policy-required form for product-visible behavior change) |
| Installer usability | Per-platform CI smoke: bring up sidecar exe → probe ready → `GET /` returns frontend page; Linux shell smoke under xvfb-run |
| New project as a whole | typecheck / lint / hygiene gates cover the new workspace member as usual |
| Version governance | desktop joins the `scripts/release/families.ts` release family; npm version and updater feed share one source |

Acceptance criteria (phase-one Definition of Done):

1. Windows 10/11 x64: download → install → double-click icon → UI visible within ≤10 s → no key enters the wizard, entering a valid key completes one real conversation round with a reply → complete one in-app end-to-end simulated version upgrade.
2. Ubuntu 22.04+ x64: AppImage reaches the same bar; linux-arm64 artifacts require only successful CI builds passing smoke bring-up, no full manual acceptance.
3. macOS arm64: dmg builds and basic flow walks manually, no distribution-quality promise.
4. Uninstall removes program files cleanly; `~/.dsh` user data retained.

## Phasing boundary

Explicitly out of scope in phase one: IPC carrier / in-process embedding (phase two), deb/rpm formats, macOS signing notarization, app-store distribution, in-app plugin marketplace UI.

Phase two direction (recorded in an Agent Note): Electron-process-embedded harness runtime + IPC fetch carrier reusing the web client packages (eliminating the sidecar dual process); at that point verify Electron mainline bundled Node ≥22.19 compatibility with native addons (koffi and other N-API modules).

## Risk register

| # | Risk | Mitigation |
|---|------|------|
| R1 | @yao-pkg/pkg success rate and size collecting the full web closure (especially native dependencies like koffi on Windows) | Scheduled as implementation step one spike: validate against the Windows target first; fall back to evaluating alternative packaging if it fails |
| R2 | Large GitHub Releases assets (100MB+ multi-platform installers) bandwidth and throttling | electron-updater chunked downloads natively supported; operational, not architectural |
| R3 | Update request failures under corporate proxies | Configurable feed URL field mitigates |
| R4 | Dev (tsx sources) vs prod (pkg exe) environment drift | Both share the same `--profile desktop` composition; snapshot replay constrains composed behavior on both sides |

## Implementation order hints (detailed plan expanded by writing-plans)

1. Spike: @yao-pkg/pkg packing the Windows full closure (resolve R1 first)
2. `packages/bundle/desktop-app` + `packages/client/ui-onboarding`
3. `apps/desktop` shell skeleton + SidecarManager (TDD)
4. sidecar packaging script + CI workflow
5. updater integration
6. DoD itemized smoke acceptance
