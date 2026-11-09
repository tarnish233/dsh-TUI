# 原生 DSH 适配层收敛

> 当前 SDK 内的收敛已完成，收敛阶段验收 **1910/1910**（151 文件）。默认路由跟随、resident 子会话读取与 preset 失效详见 [收敛完成记录](ADAPTER-CONVERGENCE-COMPLETE.zh-CN.md)；之后两批原生 UI／Todo／共享配色的最新 **2170/2170** 见 [后续完成记录](NATIVE-UI-BATCHES.zh-CN.md)。下面 1861/1861 保留为第一轮历史结果。

基于上一轮 A1–A10 修复后的工作树（1833/1833），继续收敛 DSH `0.2.2-rc.1` 适配。版本仍为 `0.1.4/private`；本地 tag/HEAD 仍为 `4738db0`，本轮没有提交、打 tag、推送、发布或改变用户配置／全局安装。

## 已完成

| 部分 | 收敛方式 | 保留的边界 |
| --- | --- | --- |
| Subagent 目录 | 删除适配器递归 catalog walker，调用原生 `listDescendants(root, signal)`；控制地址的 direct-parent mode 查询调用 `listChildren(parent, signal)` | 目录顺序、分支处理与 catalog observation 释放归 DSH；保留每行实时投影、原生指标、root epoch 和 parent/tree 权限守卫 |
| 分支诊断 | `SubagentSnapshot.diagnostics` 只保留原生 id/parent/depth/reason metadata；diagnostic 不覆盖已有合法 child | 不传 raw errors、不生成 continuable/local 授权事实、不把不可读说成完整空树 |
| 控制与展示缓存 | 移除 750ms display refresh cooldown 对 control membership 的影响；用原生 direct-parent 查询确认新 child 的 mode | 当前 root、循环、跨树与原生最终授权仍 fail-closed；不增加 child manager、调度、恢复或持久化 |
| 公共投影读取 | context adapter 不再调用 deprecated `stateOf`；普通视图用 `sessionProjections.snapshot`，标题用 `sessionTitle.get`，blank 用 `agents.turnBoundaryOf` | 缺失/失败保留未知，不能编造 null/零值/locked；标题无 domain service 时只回退到公开 snapshot |
| Preset 选择 | 去掉 backend 的重复 blank→locked 判定，真正的 lock 只来自原生 select 拒绝；App 仅在 `blank===false` 时 staging，未知则交给 native selector | 精确 Agent/attachment 迟到结果守卫，缺失 select 明确 unavailable；不修改模型路由／权限语义 |
| Plan | 中性 DTO 缩为公开 `planMode.get(agent)` 的 `{active,pending?}`，不抄内部 wanted/running.commandId | 原生 pending-off 的 false 保留；按 preset scope 解析 controller，缺失/失败不伪装 inactive；不新增 Plan permission mode |
| 模型目录 | 单次读请求最多四个 provider 查询任务并行，最后按 native registry 顺序组装 | 成功/失败隔离、默认 badge 原生 getter、8s 单 provider 界限、无 TUI catalog/auth cache |
| 目录更新 | 原生 `llm/adapters-updated` / `llm/models-updated` → 当前 attachment 的 metadata invalidation；仅刷新已打开的 picker | single-flight + 一次 trailing read，保留 query/provider/selection/focus/draft，不自动开窗或重新选择模型 |
| Capability 元数据 | Subagent ready signature 纳入 read/session/follow/control；native enumeration 可用性变化重新公告当前 attachment | 不换 Session/Editor、不根据 mutation service 存在就广告可读目录 |

本轮没有增加 Jobs、Goal、rename、revisioned-settings 编辑、文件输入或其他新功能入口；输入、renderer、静态鲸鱼及 Rex 图标保持原样。

## SDK／语义边界

- 原生 `listDescendants` 没有 row/depth 参数。TUI 的 200 行／depth 8 是**展示界限**，不是伪装成 SDK 读取界限。一次 refresh 保留原生约 `N+1` 次 catalog observations；resident child 使用四键公开 snapshot，无额外 observation lease，cold child 才使用原生 lease（至多 200 个展示行）。这是调用次数收敛，不声称消除 native catalog 读取或所有磁盘延迟。
- 树与 direct-parent 原生读取保留 15s 本地 I/O 界限，child projection 保留 5s 界限，并把 epoch cancellation 与对应 deadline signal 传给支持取消的 SDK。迟到结果丢弃，observation 正常/失败/迟到路径都释放。
- `llm.listModels(provider)` 当前公开面没有 AbortSignal。四任务并行约束的是等待中的目录查询任务；超时不能由 TUI 杀掉 native transport，也不声称超时后的真实 I/O 永远只有四个。
- 默认跟随已用真实 native fixture 复现并修复：未选择／未请求时使用 live getters，CLI／显式选择／logged route 保持权威；见 [模型语义](MODEL-DEFAULT-FOLLOW.md)。
- Preset/profile default 失效已复用公开 settled config-reload/document-updated 信号，原位刷新已打开 picker，不新增 registry 或轮询；profile reload 外的直接 register/unregister 无 SDK 通知，保留为上游接口边界。
- [Subagent 详细边界](SUBAGENT-ADAPTER-CONVERGENCE.md) 包括 diagnostics、createdAt 原生 header 回退、membership 与 availability。

## 实际验收

- 完整 **`pnpm check` 1861/1861**，143 个测试文件，build＋strict TypeScript，0 fail/cancel/skip/todo；tests **381857ms**。`.cache/adapter-convergence/full-check-first.log`。
- 父级真实 native 专项 **28/28**：parallel child Agents、子审批、live/cold child transcript、continuation、interrupt、Plan review、显式 resume、原生标题/终态，以及上一轮 exact Skill / max-tokens 回归。所有 LLM stream 均为 hermetic fixture。
- 新增 native-shaped enum tests 验证 listing 调用、preorder、分支诊断、同 id child 不被 diagnostic 降级、外部叶子、200/8 展示界限、epoch cancellation、late result discard、跨树/root/cycle guard 与 projection leases。
- 公共 projection tests 使用 `stateOf` trap，验证 zero deprecated calls、unknown/null/title、public cut metrics/todos、Plan pending:false、exact Agent scope、native preset lock。
- 父级 catalog/App tests 验证四任务并行与 registry-order 稳定、失败隔离/脱敏、无目录缓存、native registry invalidation 不自行查询、query/draft/focus 保留、registration burst single-flight 和 dismissed/foreign picker 不复活。

测试只用 owned temporary homes/workspaces 和 native-compatible fixtures；没有实际 DSH Provider 请求、真实 profile／凭据读写、服务端操作或新 GUI／OS popup 验收。完整检查包含上一轮退出交接与终端恢复防回归。前次 1833/1833 与 tag 时 1761/1761 是独立历史记录。
