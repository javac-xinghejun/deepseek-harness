# Agent Note: 用桌面快捷方式启动 web 面,而不是桌面壳

Status: implemented

[English](2026-08-28-web-launcher-over-desktop-shell.md) | 中文

## Problem

web 面需要一个"双击即用"的 Windows 入口。`desktop` 分支为此构建了 Electron 壳,但它的分发链在安装环节就失效:pkg `--sea` 产出的 sidecar 可执行文件把整个运行时和依赖树作为一整块追加的高熵数据嵌入文件尾部,启发式引擎将这种形态判定为加壳木马(火绒报 `Trojan/Fake.bn`),实时监控会在 NSIS 安装器把文件释放到临时解包目录的瞬间将其删除。安装流程照常完成但 sidecar 已缺失,因此每次安装都得到一个损坏的应用;且每次重新构建都产出新 hash,按文件的加白永远积累不起来。

## Decision

受支持的启动路径是 `scripts/launch-web.cmd`,由 `scripts/install-web-shortcut.ps1` 打包成桌面快捷方式。启动器从仓库工作树运行 `pnpm dsh --profile web`;组合出的 web 运行时绑定本地服务并把 UI 交接给系统浏览器——这是该运行时的默认行为(只有 desktop 补丁层会关闭它)。链条中由 Node 执行脚本文件,不存在无签名的自包含可执行文件,判定 SEA 形态的那条启发式永远不会被触发。

最小化的控制台窗口拥有服务的生命周期:它承载日志,关闭它即停止服务、不留残留。没有隐藏进程模式、托盘或停止脚本;第二次并发启动会因端口被占而显式失败。

Electron 壳保留为 `desktop` 分支上的分支级工作,不是受支持的交付面。回到它的前提是把产品分发给没有 Node 的机器,且届时 sidecar 以官方 `node.exe` 加暂存资源树的形式发布——绝不使用单文件 blob——并配 Authenticode 签名。

## Alternatives considered

**用 VBS 包装或托盘宿主隐藏控制台。** 日志不可见,且仍需要一套停止机制(停止脚本、按端口查杀或托盘宿主)——又回到桌面壳工程。最小化窗口已经提供了"关窗即停"。

**保留桌面壳,靠管理杀软解决。** 信任区和误报申诉只覆盖一个确切的 hash;下次构建重新触发,且默认的自动删除让所有没加排除的人继续装出损坏的应用。

**更换单文件打包器(Bun compile、Deno compile、nexe)。** 产出的都是同一种"追加数据块"可执行形态;启发式判定的是形状,不是工具。

**用 Tauri 重写壳。** 体积和复杂度的大头不在壳:Node 依赖树占主导,Tauri 仍然要携带 Node 加脚本或 blob,而现有 Electron 主进程面(sidecar 管理、窗口管理、更新器)要为此全部重写,杀软层面却毫无收益。

**把服务端跑进 Electron 主进程。** 这是最干净的壳终态——单可执行文件、无 sidecar 进程——但它把 harness 生命周期耦合到窗口上,且 pty 原生模块要按 Electron ABI 重编。与壳一起推迟。

## Consequences

双击快捷方式即从源码启动服务并在默认浏览器打开 UI;退出方式是关闭窗口。该路径要求机器上有 Node、pnpm 和本仓库,且脚本仅支持 Windows(`.cmd` 加 `.lnk` 安装器);其他平台继续使用 `dsh --profile web` 直接调用。启动失败和端口冲突在控制台呈现,而非对话框。
