# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

The dsh desktop-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) stacks directly over [`@deepseek-ai/dsh-web-app`](../web-app/README.md) and disables the browser handoff (`openBrowser: false`) while keeping URL printing, surface context, and trust-fence semantics untouched: a desktop shell owns the window, so the composed web runtime must never open the system browser. It contributes no plugin rows of its own.

This package is also the desktop shell's formal seat in the composition: phase-two Electron carrier rows (the IPC fetch carrier reusing the web client packages over an embedded runtime) mount through this bundle rather than a new one, so the `[dsh-base, dsh-web-app, dsh-desktop-app]` profile tuple stays stable across the sidecar-to-embedded transition. See `.agents/notes/implemented/architecture/` for the phase-one decision record.

## Model Experience

None, as a config patch; every model-visible contribution belongs to the base and web-app bundle rows this bundle composes over.

#### KV Cache effect

None; the patch adds nothing to the request prefix beyond what the stacked layers already contain.

## Known Limitations and Deferred Work

- **Phase two is not implemented** — the package mounts no carrier today; the Electron main process reaches the harness through the loopback HTTP/WebSocket transport only, and the in-process IPC fetch carrier lands with that later transition.
