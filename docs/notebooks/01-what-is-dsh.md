# 01 · DeepSeek Harness 是什么

> 个人学习笔记，不是产品文档；结论以 [architecture.md](../architecture.md) 和各包 README 为准。阅读顺序见 [README](README.md)。

## 一句话定位

DeepSeek Harness（命令名 `dsh`）是 DeepSeek AI 开源的 agent harness：一个把大模型变成能真正动手干活的 agent 的运行时。模型只负责思考和决策；会话持久化、工具执行、进程沙箱、审批权限、上下文组装、子代理编排这些工程问题全部由 harness 承担。

它构建在 vendored 的 [Cordis](../../vendor/README.md) 插件框架之上，架构哲学是 **everything is a plugin**：模型适配器、工具注册表、会话日志、甚至 agent loop 本身都是插件，都能通过配置替换，没有需要打补丁的特权核心。

## 从一次对话看它做了什么

用户在 Web UI 输入「帮我修好这个失败的测试」，harness 内部大致发生这些事：

```text
user/message 事件追加到 append-only 的 session log
agent-loop 认领输入，向 system-prompt 注册表收集 prompt sections 和全部工具 schema
agent/request 事件把请求交给 LLM 适配器（llm-deepseek），流式返回 assistant/chunk*
模型决定调用 bash 工具 → tools 管线依次过 pre 策略、守卫、执行、post 策略
bash 工具通过 ctx.shell seam 找到执行器，执行器经 ctx.subprocess 拉起进程
沙箱后端按策略包裹 argv，审批 seam 在需要时向 UI 请求人类放行
tool/result 写回日志，循环派生下一个请求，直到没有任何"欠账"，turn/end
```

关键不变量：**凡是模型看得见的东西，必须能从 session log 重放出来**（model-visible ⟺ logged）。这一条决定了整个数据流的设计。

## 产品形态（入口）

| 入口 | 形态 | 说明 |
|---|---|---|
| `dsh web` | 本机 Web GUI | 启动 `http://127.0.0.1:3080`，浏览器操作会话 |
| `dsh --profile headless "任务"` | 一次性执行 | 跑一个新会话、打印最终答案、退出，无服务器 |
| `dsh --profile <name>` | 自定义组合 | profile 是 bundle 叠加顺序 + 用户补丁层，见 [CLI README](../../apps/cli/README.md) |
| ACP server | 自动化协议 | Agent Client Protocol，供编辑器等外部程序驱动 |
| TypeScript SDK | 进外 SDK | JSON-RPC 协议 + 客户端 + server 插件（`packages/sdk`） |
| Python SDK | 进外 SDK | 以子进程方式驱动 bundled runtime，stdio 上跑 ndjson JSON-RPC（`python/`） |

## 核心能力地图

模型侧工具与系统能力按用途分组（包组名见 [packages/README.md](../../packages/README.md)）：

| 类别 | 能力 |
|---|---|
| 命令执行 | bash / PowerShell 工具、持久 PTY 终端、Code Mode（模型写程序调宿主绑定）、subprocess、后台 jobs |
| 进程约束 | 沙箱 seam，后端有 bwrap / Landlock / Seatbelt（`native/` 是 Landlock addon 源码），E2B 云沙箱 POC |
| 文件与代码 | 文件读写编辑工具、LSP 导航（跳转/引用/诊断）、文件引用补全 |
| 信息获取 | web search（exa / perplexity / deepseek 三个 provider）+ HTTP fetch |
| 编排 | subagent 委派（in-process / fork / ACP / Codex / Claude Code / dsh-sdk 六种 transport）、Agent Teams（实验）、workflow 引擎 + ralph 工具、同会话 goal、定时 follow-up |
| 会话数据 | JSONL / SQLite 双持久化后端、compaction 压缩、session-query 全文检索、会话标题、附件存储、超大工具结果 spill |
| 人机协作 | approval 审批、permission presets、人类命令注册表、ask-user 提问、plan mode、todo、消息反馈 |
| 扩展机制 | skills 目录、MCP client 桥（把外部 MCP server 的工具注册进 `ctx.tools`）、Claude Code / Codex hooks 桥、per-session preset 组合 |
| 自我修改 | extensions 组：agent 可以检查并挂载/卸载运行时里的其他插件（`tool-cordis`） |

## 技术栈与工程形态

- TypeScript strict 全量 ESM，pnpm workspaces monorepo，Node `^22.19 || >=24`。
- 框架层整体 vendored（`vendor/` 下的 Cordis 及其基础库重命名进 `@deepseek-ai` scope），可审计可修补。
- 测试：vitest；CI 覆盖率门禁是 `test:coverage`，对 `packages/*/*/src` 要求逐文件 100%；另有 keyless 快照回放和真实 API e2e（无 key 自动跳过），政策见 [testing.md](../testing.md)。
- 文档即代码：`doc-sync` 聚合了几十个门禁（目录、链接、mermaid 渲染、类型等价、双语配对、字数预算），产品文档英中双语成对维护。
- 官网是 docs/ 精选源的 VitePress 投影（`website/`）。

## 怎么跑起来

```sh
pnpm install
pnpm run build
pnpm dsh web                          # 本机 Web UI
pnpm dsh --profile headless "列出手感最差的三个测试并说明原因"   # 一次性任务
pnpm dsh --profile web --dump-config  # 不启动，只打印组装出的插件树
```

真实任务需要 `DEEPSEEK_API_KEY`（可放根目录 `.env`）。

## 延伸阅读

- [architecture.md](../architecture.md)：官方架构地图，本笔记 02 篇的权威底本。
- [cordis-primer.md](../cordis-primer.md)：Cordis 框架五要点，读插件代码前的必经之路。
- [capability-seams.md](../capability-seams.md)：全部 ctx 服务的声明/实现/消费关系图（生成物）。
- [subsystems/](../subsystems/README.md)：每个子系统一页的类型级参考。
