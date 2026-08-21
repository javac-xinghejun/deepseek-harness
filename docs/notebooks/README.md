# notebooks — 个人学习笔记

这里是个人向的学习材料，**不是产品文档**：不参与双语配对（`docs/notebooks/` 在 [translation-pairing 清单](../../scripts/translation-pairing.manifest.json) 中排除）、不进网站投影、不受字数预算约束。权威结论永远以正式文档为准。

## 阅读顺序

0. [series/](series/index.md) —— 「从零看懂 DeepSeek Harness」图解系列：推荐主线，从零起步、边读边动手，共十五讲。
1. [01-what-is-dsh.md](01-what-is-dsh.md) —— 项目定位、产品形态、能力地图，先知道「它是什么」。
2. [02-architecture-map.md](02-architecture-map.md) —— Cordis 框架、组装层、core spine、capability seams、事件三域与 turn/step 循环，解决「代码怎么组织」。
3. [architecture-diagram.html](architecture-diagram.html) —— 浏览器打开的单文件架构图，可导出 PNG/PDF；建议学完系列第 14 讲再看。

## 读完后建议的下一步

- 精读 [architecture.md](../architecture.md) 与 [cordis-primer.md](../cordis-primer.md)，对照 02 篇查漏。
- 跑 `pnpm dsh --profile web --dump-config` 看真实插件树。
- 挑一条 seam（推荐 `shell` 或 `fs`）从 Service Definition → Provider → Consumer 三端各读一个包。
- 动手向导在 [cookbook/](../cookbook/extension-cookbook.md)。
