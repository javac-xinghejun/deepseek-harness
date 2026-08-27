# DeepSeek Harness Desktop — phase one DoD checklist

English | [中文](desktop-dod-checklist.zh.md)

Status: in-progress (automation debt recorded in the phase-one [Agent Note](../../../.agents/notes/implemented/architecture/2026-08-27-desktop-phase-one-sidecar.md))

Acceptance criteria from the approved spec, with current evidence. Real-platform legs need runners or hardware this repository checkout does not have; each unchecked item names its owner surface.

## 1. Windows 10/11 x64

- [ ] Download → install NSIS → cold start UI within 10 s. **Blocked** by the packaged-bin SEA blocker (Agent Note §Spike findings).
- [ ] No key → onboarding wizard; valid key → one real conversation round.
- [ ] In-app end-to-end update round (electron-updater over GitHub Releases).

## 2. Ubuntu 22.04+ x64

- [ ] AppImage reaches the same bar as Windows. **Blocked** by the same blocker; the sidecar itself boots under host Node (`scripts/smoke-sidecar.ts` evidence chain).
- [x] Sidecar exe composition passes: staged closure serves `dsh web` (host-node probe), `--dump-default-config` exits 0 inside the packaged binary.

## 3. macOS arm64

- [ ] dmg builds and a manual basic walkthrough succeeds (phase-one degraded promise, `continue-on-error` lane). **Blocked** by the same blocker for runtime behavior; electron-builder config is in place unsigned.

## 4. Uninstall

- [ ] Program files removed, `~/.dsh/` user data retained (NSIS/AppImage uninstallers + manual check per platform).

## Regression anchors already landed

- [x] `packages/bundle/desktop-app/tests/desktop-app.spec.ts` pins composed `openBrowser: false` with every other owned key restated.
- [x] `apps/desktop/tests/*` pin SidecarManager state machine (TDD), restart policy table, port probe, updater feed resolution fail-loud, and the preload/api-names anti-drift contract.
- [x] `dsh --profile desktop --dump-config` shows the stacked three-bundle tuple with browser handoff disabled.

## Outstanding debts outside platforms

- [ ] win-x64 `@yao-pkg/pkg` collection spike (koffi prebuilds) once the desktop packaged-bin entry exists.
- [ ] ui-settings-models onboarding dynamic verification with a real key (roster mount already verified statically).
