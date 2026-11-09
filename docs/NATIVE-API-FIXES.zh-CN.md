# DSH 原生接口审计：已确认问题修复

> 本文记录 A1–A10 正确性修复阶段的 1833/1833 验收；之后 1910/1910 的原生适配层收敛见 [收敛报告](ADAPTER-CONVERGENCE-COMPLETE.zh-CN.md)，最新两批原生 UI／Todo／共享配色 **2170/2170** 见 [完成记录](NATIVE-UI-BATCHES.zh-CN.md)。旧阶段范围不表示当前仍缺这些已完成能力。

基线：本地 `v0.1.4` / `4738db0`，DSH `0.2.2-rc.1`。本轮是基于该 tag 的未提交工作树修复，**不改版本、依赖、lockfile 或 Git refs，不发布、不替换全局安装**。

范围为此前审计的 A1–A10 正确性问题，不包含可选原生能力 UI、条件性时序疑点或 Subagent 目录遍历重构。生产仍为 native DSH app bundle + 同进程 Cordis 插件；模型、工具、权限、规划、持久化与 root lifecycle 仍归 DSH。

## 修复对照

| 审计项 | 修复 | 主要实现 / 防回归 |
| --- | --- | --- |
| A1 精确 Skill 被前缀命令覆盖 | 在 native slash 名字空间按 exact → prefix → fuzzy 排列候选，保留原名册作为同等级稳定顺序；真正同名时仍 command 优先。Enter 使用内容消费者提交，显式导航不被改写，Tab 仍只编辑 | `src/input/native-autocomplete.ts`；`test/input-skills.test.ts`、`test/acceptance-native-audit.test.ts` |
| A2 原生退出请求晚于本地清理 | `App.exitRequested` 在同步 terminal restore 后结算；plugin 立即请求公开 `ctx.appExit`，`App.exited` 只代表 owned cleanup。重复 shutdown 加入同一清理，native root disposal 不再提前视为完成。startup failure 也不等待日志关闭才请求退出 | `src/app.ts`、`src/plugin/index.ts`；`test/app-native-audit.test.ts`、`test/plugin-exit-handoff-pty.test.ts` |
| A3 FileBlock 展示丢失 | 共享 display contract 保留 `{type:'file',attachment:{attachmentId,name,bytes}}`，校验 native metadata、允许空文件；live/cold/rebuild 保留 file-only 消息及 mixed/repeated 顺序。显示文件名/尺寸只读标记，不读 bytes、不猜 path、不作为图片 | `src/attachments.ts`、`src/backend/types.ts`、`src/state/transcript.ts`、`src/ui/file-marker.ts`；附件/UI tests 与 `test/acceptance-native-files.test.ts` |
| A4 原生非成功终态不明显 | 从原生 `turn/end` 重建精简结果提示：max-tokens、blocked、cold interrupted/forked/error；完成与未知扩展原因保持安静。已有 live API Error 不重复。用户中断归因只来自原生 aborted cause。冷错误的派生诊断复用脱敏，原日志不改写 | `src/state/transcript.ts`、`src/ui/blocks.ts`；`test/ui-turn-end.test.ts`、真实 max-tokens/live/resume 场景 |
| A5 commands/change 未接入 | 当前 native attachment/pending surface 的窄 invalidation；App single-flight + 一次 trailing reread，过时结果不替换当前名册。仍活跃的查询刷新，Esc 已关闭的菜单不复活，Help 原位更新并保留 search/focus/scroll/draft | `src/backend/context.ts`、`src/app.ts`、`src/ui/help.ts`；backend/App/Help 与 native mixed catalog tests |
| A6 当前路由误标 default | 标记只读 native default-model getter；CLI/current/pending route 与 default 分开，getter 不可用时不造 default。模型路由优先级、目录、凭据和保存方式不变 | `src/backend/context.ts`；`test/backend-audit-regressions.test.ts` |
| A7 标题失败误报 no-title | fulfilled/title、fulfilled/no-title、rejected/unavailable 分别为 string、null、omitted；App 不缓存未知为 null，显式重开可重试。picker 区分 `(untitled)` 与 `(title unknown)`，保留 native order 与显式 resume | backend/App/session-picker；backend/App/UI tests |
| A8 原生字段错位 | 权限 picker 读取 `name`；native `input.hint` 经 App 的 `inputHint` 被补全消费，Pi `argumentHint` 仅为已有 Pi caller 的回退。原生 revisioned settings 已存在，不再误称 SDK 尚未提供 | `src/app.ts`、`src/input/native-autocomplete.ts`；App native permission/setting path 与 input hint tests |
| A9 无选项自由文本编码错误 | 只有声明的 option label 进入 selected；自由文本进入 custom。option-bearing、多选和 plan-review 对照保持 | `src/backend/context.ts`；`test/backend-audit-regressions.test.ts` |
| A10 compaction effort provenance | header 的 `adapterDefaults.reasoningEffort:true` 不被提升成显式值；显式 effort 仍仅对同路由 compaction 继承。其它用途/目标、引用、单次 native dispatch 与 native 默认保持 | `src/plugin/compaction.ts`；`test/plugin-compaction.test.ts` 与既有 compaction tests |

结果提示是 **从 DSH 持久事件重建的前端投影**，不是 TUI 自己保存的第二套会话事实。通用文件输入、命令图片附件和 timed question UI 没有混入本轮修复；native dequeue 原本就拒绝不可编辑的 file rows，App 也不把意外 file envelope 转成 image/upload。

## 生命周期边界

- DSH 的公开 AppExit 请求启动其既有 5000ms whole-tree protection；TUI 没有添加全局退出计时器、supervisor、`process.exit` 或私有 launcher 导入。
- 首次请求的进程退出码按 native controller 的契约由 DSH 拥有。之后 `App.exited` 的本地清理结果不能倒写已被原生接收的请求码；diagnostic lease 仍随 owned cleanup/root disposal 关闭。
- ProcessTerminal 自带的 input drain 界限不变。虚拟 drain hold 只测接口鲁棒性，真实 PTY fault 使用实际 Settings flush 与 adapter close。
- 受控故障证明修复了“清理卡住时没有启动 native deadline”的缺口，**不冒充此前用户现场退出卡住的根因复现**。

## 实际验收

- 完整 **`pnpm check` 1833/1833**，139 个测试文件，build + strict TypeScript，0 fail/cancel/skip/todo；测试耗时 **381514ms**。证据：`.cache/native-api-fixes/full-check-first.log`。
- 两种 renderer 的真实 native CommandService + Skill registry + App 内容提交：`/review` 不执行 `review-all`，native Skill 注入成功；显式 `/review-all` 仍执行，metadata discovery 不调用模型。原生注册事件无需 `/help` 即刷新。
- 两种 renderer 的真实 native max-tokens：原生 loop 记录原因，live 和显式 `new` → `resume` 都恰好显示一个结果提示。
- **4 个真实 native plugin PTY hold 场景**：Settings/Backend × inline/fullscreen，实际进入 hold，终端在 native grace 之前恢复；进程由原生 5000ms controller 在测试容许的 4.5–7s 内结束，退出码 0。使用真实 production plugin，而非复制退出控制器；ANSI 在 `.cache/native-api-fixes/exit-pty/`。
- 真实 native LocalAttachmentStore/saveFile/admitPromptContent/readFileStream 与 createUserMessage：文件 metadata、mixed/repeated 顺序、file-only live/cold 展示及宽度通过；源事件冻结/不变，native bytes 仍完整。
- 另有真实 Cordis waterfall + native canonical/folded header 的 effort provenance 控制，以及 App registration burst、foreign attachment、Escape dismissal、Help query、title retry、native permission confirmation、shutdown reentry 测试。

全部使用 owned temporary homes/workspaces 和 hermetic streams；没有真实 DSH Provider 请求、凭据读取/迁移、真实用户配置改写、GUI/OS popup 新验收或服务端操作。旧 tag 时的 1761/1761 是历史记录，不替代本轮新全量。
