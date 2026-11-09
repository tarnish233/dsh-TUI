# 适配层收敛完成：默认跟随、resident 读取与 preset 失效

> 本文是 1910/1910 的历史收敛验收。后续两批原生 UI／Todo 固定区／共享配色已完成，最新 **2170/2170** 见 [后续完成记录](NATIVE-UI-BATCHES.zh-CN.md)。下面“未增加功能入口”仅描述当时范围。

基线为上一轮 1861/1861 工作树，DSH `0.2.2-rc.1`。当前 SDK 可支持的剩余三项已完成；未增加 Jobs/Goal/设置编辑等功能入口。版本仍 `0.1.4/private`，无提交、tag、推送、发布或全局安装／真实用户配置变化。

## 本轮完成

### 1. 模型默认跟随语义

- 未显式选择的 pending 会话通过 `agentDefaultModel.currentSelection()` 实时读取，不保存默认路由快照。
- 创建／恢复 Agent 使用原生允许的 `AgentOptions` live getters；未记录 selection/request 时跟随默认，原生 `model/selection` 或 `request/header` 一旦记录就由 `agent.model.current()` 保持权威。
- CLI provider/model pair 只固定新会话；显式 `/model`／`/effort` 固定会话选择。恢复不拿 CLI/default 覆盖已记录路由。
- 异步目录／effort 读取结束后复核当前路由与 attachment；前提已改变时拒绝旧选择，不做保存。
- 已结算的 native config/document 信号重新读取原生 getter，通过 current-attachment `model_route` 更新 footer 与已打开 model picker 的 current badge；不会选模型、准备请求、重建 Agent、移动用户选中行。
- 细节：[MODEL-DEFAULT-FOLLOW](MODEL-DEFAULT-FOLLOW.md)。

### 2. Subagent 读取成本

- 目录结构仍完全由原生 `listDescendants/listChildren` 决定，未新增私有遍历。
- resident child 使用公开 `sessions.get(id)` 与 `sessionProjections.snapshot(exactSession, fourRowKeys)`，无需第二次 `observeSession` lease 或全量 projection fold。
- cold／缺失／失败／不匹配的 resident surface 回退到原生 leased observation，保留 header/parent/origin 守卫、diagnostics、epoch/deadline cancellation 和全部释放路径。
- 两个 resident children 的适配器额外 lease 从 2 降到 0；两个 cold children 仍为 2；mixed 为 1。只是实际调用次数优化，不声称所有磁盘读取或延迟都下降。
- 细节：[SUBAGENT-ADAPTER-CONVERGENCE](SUBAGENT-ADAPTER-CONVERGENCE.md)。

### 3. Preset 名册失效

- 复用公开 `app-boot/config-reload()`（Loader 已结算）及 `settings/document-updated(ns,revision)`；不硬编码 Web 的 namespace，不使用 pre-commit `hmr/change`、内部 fiber hooks 或轮询。
- 同 tick signals 合并；preset/model picker 各自 single-flight＋一次 trailing read，只有已打开的当前 attachment surface 查询。
- Preset 选中行以 exact opaque value 维持，原生插入／重排行不会把 Enter 指向另一个 id；metadata 不选择 preset，不改变草稿、焦点或 current Session。
- 失败保留原有 rows 并显示 error，之后事件可恢复；关闭、外来 attachment、迟到结果都不复活窗口。模型 setter 的 persistence warning 不被同一路由 metadata 更新吞掉。

## 永久 SDK 边界（不是 TUI 未完成实现）

- 原生 descendant listing 没有 row/depth 参数；200/depth8 仍只是 UI 展示预算。原生 catalog observations 保留，resident acceleration 不改枚举语义。
- `agentPresets.register/unregister` 在 profile reload 之外没有专用 catalog event，部分 broken diagnostics 也可能无通知；下一次显式原生 list 会得到新值。自动覆盖此路径需要上游事件，TUI 不造 registry／poller。
- `llm.listModels`／部分 `query.readSession` 公开面无 AbortSignal，不能声称 TUI 可以终止 native transport。支持 signal 的目录／observation 路径已转发取消。

## 实际验收

- 完整 `pnpm check` **1910/1910**，151 个测试文件，build＋strict TypeScript，0 fail/cancel/skip/todo；tests **403009ms**。`.cache/adapter-convergence-final/full-check-first.log`。
- 真实 native default-follow **4/4**：pending、materialized-but-unrequested、request pin、显式 CLI／选择、new／resume；旧编译基线同组 **2 fail＋2 pass**，明确复现了 pending 默认快照问题。新实现同时验证 native config 信号更新 footer。
- 真实 native preset/config **2/2**：通过 owned temp profile 的 `settings.update` 修改实际 registry entry default，开放 picker 原位更新、保留 native id／草稿／焦点，未创建 Agent／请求模型；关闭后不自动打开。
- 其余 scoped tests 验证 route 异步 race、resident/cold/mixed read counts、projection fallback/lease、notification coalescing/ordering/close、stale/foreign picker、opaque value identity、current badge，以及既有 child continuation/approval/interrupt/terminal-exit 回归。

所有 Native streams 均为 hermetic fixture；真实配置写入只发生在测试拥有的临时 profile，未读取真实凭据、迁移认证、请求实际 Provider 或操作服务器。原先 51 个未提交源码文件保留。以前的 1761／1833／1861 计数是独立历史验收，不替代本轮结果。
