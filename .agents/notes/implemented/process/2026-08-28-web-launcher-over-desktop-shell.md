# Agent Note: Launch the web surface from a desktop shortcut, not a desktop shell

Status: implemented

English | [中文](2026-08-28-web-launcher-over-desktop-shell.zh.md)

## Problem

The web surface needed a one-double-click entry on Windows. The `desktop` branch built an Electron shell for this, but its distribution chain fails at installation: the pkg `--sea` sidecar executable embeds the whole runtime and dependency tree as one appended high-entropy blob, heuristic engines classify that form as a packed trojan (Huorong reports `Trojan/Fake.bn`), and real-time monitoring deletes the file the moment the NSIS installer releases it into temp extraction. Installation then completes with the sidecar missing, so every install produces a broken application, and every rebuild produces a new file hash, so per-file whitelisting never accumulates.

## Decision

The supported launch path is `scripts/launch-web.cmd`, which `scripts/install-web-shortcut.ps1` packages into a desktop shortcut. The launcher runs `pnpm dsh --profile web` from the repository working tree; the composed web runtime binds the local server and hands off to the system browser, which is that runtime's default behavior (only the desktop patch layer disables it). Node executes script files, so the chain contains no unsigned self-contained executable and the heuristic that classifies the SEA form never sees one.

The minimized console window owns the server lifetime: it carries the logs, and closing it stops the service without residue. There is no hidden-process mode, tray, or stop script; a second concurrent launch fails loud on the occupied port.

The Electron shell remains branch-only work on `desktop`, not a supported surface. Returning to it requires distributing to machines without Node, and then the sidecar ships as the official `node.exe` binary plus the staged resource tree — never a single-file blob — behind Authenticode signing.

## Alternatives considered

**Hide the console behind a VBS wrapper or tray host.** Removes the visible logs and still requires a stop mechanism (a stop script, a port-scanning killer, or a tray host) — desktop-shell machinery again. The minimized window already provides close-to-stop.

**Keep the desktop shell and manage the antivirus.** Trust-zone entries and false-positive appeals cover one exact hash; the next build re-triggers, and the default auto-delete keeps producing broken installs for anyone without the exclusion.

**Swap the single-file packager (Bun compile, Deno compile, nexe).** All produce the same appended-blob executable form; the heuristic classifies the shape, not the tool.

**Rebuild the shell as Tauri.** The shell is not where the mass is: the Node dependency tree dominates, Tauri still has to carry Node plus scripts or a blob, and the existing Electron main-process surface (sidecar manager, window manager, updater) would be rewritten for no antivirus gain.

**Boot the server inside the Electron main process.** The cleanest shell end state — one executable, no sidecar process — but it couples the harness lifetime to the window and requires rebuilding the native pty addon against the Electron ABI. Deferred together with the shell.

## Consequences

Double-clicking the shortcut starts the server from source and opens the UI in the default browser; quitting is closing the window. The path requires Node, pnpm, and this repository on the machine, and the scripts are Windows-only (`.cmd` plus a `.lnk` installer); other hosts keep the plain `dsh --profile web` invocation. Boot failures and port conflicts surface in the console rather than a dialog.
