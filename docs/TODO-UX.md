# Todo 固定区：CC 调研与最终实现

## 最终行为

- 当前根会话的原生 `TodosSnapshot` 显示在编辑器上方的固定底部区域，**不在 transcript 的滚动容器里**。长回答、历史增长和全屏滚动不会把它带走。
- 原生快照更新原位替换清单；不从模型文字推断状态，不维护另一份任务事实。`null`／空列表立即消失；全部完成时收起当前工作托盘。
- **Ctrl+T 是显隐切换，不再向历史追加摘要。** 空清单／全部完成时没有可见效果，也不追加 notice。用户隐藏后，原生更新不会自动打开；切换根会话或 attachment 后重置为可见。
- 完整托盘最多显示五项，按原生顺序；有溢出计数。只剩一行时显示 `Todos · 完成数/总数 · 首个未完成项` 的紧凑行，不再直接消失；零行预算才隐藏，不挤走唯一 Editor。紧凑行只在原生顺序中过滤已完成项，宽度不足先舍弃项目文字，再舍弃计数。
- `StatusDockStack` 统一 Todo／Goal／Subagent 的可见性、总高度、顺序和间距，固定顺序是 **Todo → Goal → Subagent → Editor**。通常保留四行 transcript；短屏可借到只剩一行，每个真正可见区域保留紧凑内容。先满足 comfortable 内容再购买统一间距；三者间距 all-or-none，最后一个区域后不加空行。已结束 child 不占名额，Root 组件不再各自加分隔行。
- 根 transcript 设置 `suppressLiveTodos: true`，只抑制重复的 live checklist 显示节点；原生 store、持久工具／消息／事件不变。没有独立 dock 的 child view 保持默认 `false`。
- Dock 使用共享 `t`／`cc` 语义前景，没有独立黑色背景。Working glyph 由现有 renderer clock 提供，不增加 Todo timer，不恢复标题动画。

这里默认显示非空未完成清单，是将旧版本已自动显示的清单移到固定位置的项目选择。CC 当前版本的默认展开／恢复策略不作为 DSH 的会话业务政策；不建立 TUI-owned 持久 tasks。

## Todo／Goal／Subagent 共存

共用布局预算，不共用业务状态，也不互相替换组件。屏幕够高时，Todo 展开清单、Goal 展示目标／状态，Subagent 展示名字／当前活动；短屏先收缩明细，再退化为三行：

```text
⏺ Todos · 1/6 · ◐ 当前未完成项
⏺ Goal · active · rounds 2/6 · armed
● Agents · 2 children
────────────────────────────────
❯ 同一份多行草稿
```

高度分配：`chrome = separator + queue + editor + hint + footer`（全部按实际宽度测量），`preferred = max(0, min(15, floor(rows/2), rows-chrome-4))`，`available = max(0, rows-chrome-1)`，`pool = min(available, max(preferred, n))`。`n` 只统计可见的未完成 Todo、实际 Goal、开启且含 running／initializing 的 Subagent 区域。

有至少三个可用状态行时，三者各保留一行。编排读取三个组件的纯 preferredRows／comfortableRows／compactRows，先为各区域保留有用内容；满足 comfortable 内容且可同时放下所有间距时统一加一行，否则全部零间距。总高度包含内容和间距，始终不超过 pool；每个成员每帧只绘制一次，不反复 render 测量。极短屏仍优先保护 Editor／Todo，不虚增终端高度。完整 native facts 不被显示预算删除。详见 [展示层整体收敛](PRESENTATION-COMPOSITION.zh-CN.md)。

这是 DSH TUI 的共存／短屏产品取舍，不宣称 CC 当前版本具有同一 Goal 或 Subagent 布局。

## CC 证据与核验范围

调研日期：2026-11-08。macOS Darwin 27.2.0 arm64、Node 26.13.0。本机未找到 `claude` 可执行文件，因此没有本地 CC GUI／PTY 观察，也没有解编译或复制专有实现。

官方公开资料（缓存及哈希在 `.cache/native-ui-expansion/cc-todos/evidence/`）：

- [Interactive mode — task list](https://code.claude.com/docs/en/interactive-mode.md)：状态区域 checklist、Ctrl+T 显隐、最多五项、空列表没有可见效果。
- [Keybindings](https://code.claude.com/docs/en/keybindings.md)：`app:toggleTodos`，默认 Ctrl+T；Global／AbovePromptInput 上下文。
- [Agent SDK todo tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking.md)：pending／in_progress／completed 的更新语义。
- [Changelog](https://code.claude.com/docs/en/changelog.md)：本次快照顶部为 2.1.319（2026-11-06）；高度适配、减少全量重绘和展开状态恢复相关修复。

公开观察，**不当作当前版本官方保证**：

- [#15408](https://github.com/anthropics/claude-code/issues/15408)：CC 2.0.76／macOS，全部完成后托盘消失；加入 pending 后再出现。项目采用该收起行为，但当前最新版本未现场复核。
- [#54355](https://github.com/anthropics/claude-code/issues/54355)：CC 2.1.121／Linux，托盘显示前五项，无独立列表滚动。
- [#61593](https://github.com/anthropics/claude-code/issues/61593)：引用当时状态区和五项显示的文档约定。
- [#6654](https://github.com/anthropics/claude-code/issues/6654)：1.0.98 时的默认隐藏／按需查看 UX 说明。版本不同，不能直接推导当前默认值。

只读 MIT 参考 `/Users/fulei/workspace/pi_extensions/pi-cc-extensions` 用于了解 above-editor widget 组织方式；它没有原生 Todo widget，不是 CC 行为证据。

| 项目 | 结果 |
| --- | --- |
| 状态区／编辑器上方独立显示 | 按官方交互实现；不是复制 CC renderer |
| Ctrl+T show/hide、更新不追加摘要 | 已实现并在两种 renderer 验证 |
| 最多五项、随高度收缩 | 已实现；溢出计数是项目可见性补充 |
| 全部完成后收起 | 依据历史公开观察；最新 CC 现场未核验 |
| 精确 glyph、颜色、默认展开／恢复 | 不宣称逐像素／逐版本一致 |
| CC 持久 Task ID、依赖／调度／compaction 持久性 | 不复制；DSH 原生语义为权威 |

## DSH 所有权

DSH `TodoItem` 只有 `content` 和 `pending | in_progress | completed`。不生成持久 Task ID，不猜 `activeForm`，不重排或去重原生条目。索引只是一次快照内的显示位置。

原生 todos projection 在 `turn/start` 清空。这个原生 `null` 必须立即进入 dock，不保留上一轮 checklist；不为了 CC 的持久 tasks 行为增加任务存储。

Backend 发出的原生 projection 值保持权威，并带可选 attachment 过滤；旧根／旧 attachment 不能更新当前 dock。Ctrl+T 是 frontend 可见性，不修改原生状态，也不提交消息。

## 文件与接口

- `src/ui/todo-board.ts`：`TodoBoard`，`todos`／`visible`／`spinnerFrame`，`counts`／`hasOpenItems`／`toggle()`，width-safe `render()`。
- `src/ui/transcript.ts`：opt-in `suppressLiveTodos`，默认不改变 standalone 行为。
- `src/app.ts`：固定 bottom stack、共享高度池、原生快照赋值、静默 Ctrl+T、根切换重置、child view 不抑制。
- `src/input/actions.ts`：既有 `app.todo` id 和绑定不变，描述为编辑器上方显隐。

生产必须给 `TodoBoard.maxRows` 传动态预算 getter；默认 7 仅供 standalone／单测。组件没有 renderer、stdin、timer、业务回调或任务持久化。

## 验收与证据

- `test/ui-todo-dock.test.ts`：组件断言，含快照替换、隐藏、完成、空列表、五项上限、高度、CJK／emoji、控制字符、冻结输入及不绘制背景。
- `test/ui-todo-dock-transcript.test.ts`：root 单宿主、child／standalone 保持、分组和缓存。
- `test/app-todos.test.ts`、`test/app-task-dock.test.ts`：两种 renderer 的固定位置、长历史、原位更新、Ctrl+T、stale／foreign guard、多行／小屏预算及单 Editor。
- `test/app-native-features-pty.test.ts`：真实 PTY／生产 App 与输入组件；显式 fixture-only backend，验证固定位置、显隐、更新、resize、Settings 背景、文件 multipart 和终端恢复，不冒充原生服务验收。
- `test/app-task-dock-coexist.test.ts`：两 renderer 的 child start／settlement、三者短屏共存、resize／原位更新、Ctrl+T 与单 Editor 草稿保护；断言真实可见内容，不只验证总高度。
- `test/app-task-dock-pty.test.ts`：两模式真实 PTY，在五行草稿编辑期间注入离线 projection，验证紧凑／展开共存、结束释放高度、显隐／缩放和退出恢复。没有真实 Provider／native business API 调用。
- 原生服务验收见 `test/acceptance-native-feature-batches.test.ts`；所有流均为隔离 fixture，无真实 Provider 调用。

修复前对照 `.cache/native-ui-expansion/todo-before.result.json`：inline／fullscreen 在增长 70 行历史后均看不到旧 transcript Todo，Editor 和草稿仍在。修复后同组 dock 验收保持可见且只有一个显示宿主。

后续共存负向对照 `.cache/task-dock-coexist/before.json`：112 组 App 布局中，8 组原本可见 Todo 在 child start 后消失，而且 child completed 后仍因目录非空占位而无法展开。`after.json` 同组消失数为 0；有空间的三者共存没有缺项。原有总高度测试没有覆盖实际可见性，新增 App／PTY 断言补上这一缺口。最新完整回归见 [ACCEPTANCE](ACCEPTANCE.md)。

完整 CC 调研原稿保留在 `.cache/native-ui-expansion/cc-todos/original-agent-writeup.md`；其中“空／完成时追加摘要”的中间建议已由这里的**最终静默策略**替代。
