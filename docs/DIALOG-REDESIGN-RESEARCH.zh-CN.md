# 弹窗与设置重设计：Grok Build / OpenCode 深度调研

> **状态：调研方案已按此实施（未发布）。** 调研日期：2026-11-07；实现与最终验收见 [实施契约](DIALOG-IMPLEMENTATION-CONTRACT.md) 与 [验收记录](ACCEPTANCE.md)。本文保留竞品依据、缺口分析和设计取舍，不是发布记录。
>
> 本轮不改应用代码、依赖、全局程序、真实用户配置、凭据或会话；此前 Skills / Enter 修复保留。没有安装或运行竞品、没有真实模型调用。公开源码只下载到忽略的 `.cache/dialog-research/`；交互结论来自源码、代表性测试与官方文档，不冒充真机视觉、IME、鼠标或性能验收。

## 1. 结论

推荐采用 **Grok 的窗口一致性与设置元数据 + OpenCode 的可搜索选择器与行结构**，在现有 Pi TUI 上实现一套自有、轻量的弹窗组件；不引入 Ratatui / OpenTUI / SolidJS，也不迁入它们的 Agent、配置、权限或持久化实现。

当前主要问题不是颜色，而是：

1. Settings、Model、Resume、Help、审批问答等替换主输入区；Tools、Agents、图片使用 `showOverlay`。同为用户眼中的“弹窗”，挂载、鼠标、尺寸与返回方式却不同。
2. 缺少共享的窗口尺寸、搜索行、选中行、操作栏、可见错误和返回位置契约。
3. 设置项不是全部缺失：已有 **16 个持久设置键，其中 Tools / Diff 11 个、Thinking 3 个**。真正的新增展示缺口主要在 Agents、图片、队列与终端交互。
4. **Agents 消息分组复用 `groupTools`**，导致“工具分组”设置隐含控制 Agents，设置名称与实际作用不一致。
5. 模型、effort、preset、权限与 Skills 已有原生入口，但没有在 Settings 中形成清晰的“当前状态 / 原生操作 / 默认值 / 能力不可用”导航。
6. 不应为每个新功能创建开关：Skills 注入、工具执行、权限判定、子 Agent 生命周期、终端恢复与资源保护仍由 DSH 或既有安全契约决定。

建议先统一组件与交互，再迁移 Tools / Agents 等详情，最后补充少量有明确用途的本地展示偏好和受能力约束的 DSH 原生设置入口。

## 2. 调研来源与版本边界

### 2.1 核验对象

| 对象 | 本次证据基线 | 注意事项 |
| --- | --- | --- |
| 本项目 | `HEAD 86061ba` / `v0.1.3`，加当前未提交的 Skills / Enter 工作树 | 本文文件行号基于当前工作树，不只基于已发布 tag |
| Native DSH | 只读安装源码 `@deepseek-ai/dsh@0.2.2-rc.1` | 不读取真实 profile / credential / session；宿主服务是否可用仍须运行时确认 |
| Grok Build | 官方 `xai-org/grok-build`，`main` commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`，2026-09-29 | monorepo `SOURCE_REV=559751fdcec02d413e4c57c8832ab275e4f44980`；公开同步源码不等于最新二进制 |
| Grok 官方发布文档 | 2026-11-07 抓取，changelog 页面当时显示最新 `v1.0.70` / 2026-10-23 | 对比源码以后的变化；滚动 reference 与 changelog 也可能不同步 |
| OpenCode 开发源码 | 官网指向 `anomalyco/opencode`，`dev` commit `2b3a0d441044c385c059d77866eecba6f0082629`，2026-11-07 | `packages/tui` package version `2.2.5`；下文主要布局/交互结论固定于这个快照，不等同于所有发布流 |
| OpenCode 已发布 v1 | `v1.19.5` / commit `810c0eba1a7348036f8bdf61e6632d0c36c6876c`，2026-10-28 | `@opencode-ai/tui@1.19.5`；没有集中 Settings dialog，使用 palette toggles / `tui.json` / KV |
| OpenCode 已发布 v2 | `v2.2.6` / commit `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06`，2026-11-06 | `@opencode/tui@2.2.6`；已核验有 `DialogConfig` / `/settings`。发布存在不等于实验新外观默认开启 |

Grok 官方 reference 仍列出旧 `simple_mode`，但 `v1.0.69` changelog 明确宣布它不再生效。这是不能把网页配置表直接作为实施规范的具体例子。

OpenCode 的 `/docs/tui`、`/docs/keybinds` 与 `/docs/cli/*` 描述不同配置代际，不宜不分版本地称某一页“错了”。已发布 `v1.19.5` 没有集中 Settings，新开发源码与已发布 `v2.2.6` 均有专门 Settings dialog。`/releases/latest` 本次仍指向 v1，虽然 v2.2.6 也是较新的非 draft / 非 prerelease 发布；release-channel/latest 标记原因未核验，不能仅凭这个 API 判定哪一流取代另一流。

**实验外观默认值已进一步核验：** 在固定的 dev 源码中，`useNewDesigns()` 仅在 `experimental["new-designs"] === true` 时开启，schema 中 experimental 可省略，所以默认 off / opt-in。标题搜索融合、增强的 trailing choice、description 区、保留选择与 raised footer 等，不是默认外观。v2.2.6 的集中 Settings 本身不依赖实验才存在；该 release 的全部实验/默认组合未单独实机验收。

**依据：** 固定 dev `O/packages/tui/src/config/index.tsx:250–252,393–397`；release/tag API 元数据；已发布 v1 component tree 与 command palette 源码；v2.2.6 `component/dialog-config.tsx:388–492`。父级已核对两个 tag 的 commit、公开发布元数据、v1 palette 与 v2 Settings 源码。

### 2.2 原始来源

- Grok 官方产品：<https://x.ai/cli>
- Grok 官方源码：<https://github.com/xai-org/grok-build>
- Grok Settings reference：<https://docs.x.ai/build/settings/reference>
- Grok 键盘交互：<https://docs.x.ai/build/keyboard-shortcuts>
- Grok 更新记录：<https://x.ai/changelog/build>
- OpenCode 官方网站：<https://opencode.ai/>
- OpenCode 官方源码：<https://github.com/anomalyco/opencode>
- OpenCode CLI config：<https://opencode.ai/docs/cli/config/>
- OpenCode CLI keys：<https://opencode.ai/docs/cli/keybinds/>
- OpenCode CLI TUI：<https://opencode.ai/docs/cli/tui/>

后文简称：

- `G/` = Grok `crates/codegen/xai-grok-pager/`，固定于上述 Grok commit。
- `O/` = OpenCode 仓库根，固定于上述 OpenCode commit。
- `N/` = 只读安装 DSH 的 `node_modules/@deepseek-ai/`。这些是 SDK 实现/类型证据，不是用户配置。

## 3. Grok Build：真正值得借鉴的内容

### 3.1 共享 ModalWindow，而不是各页自行画框

`G/src/views/modal_window.rs` 提供共享窗口外壳：标题、关闭按钮、可选 tab、内容区域、内边距、footer shortcuts 和共同鼠标处理。

- 默认/large：约 90% 宽，max 140 / min 60；medium：约 60% 宽，max 120 / min 44。尺寸仍最终限制在当前终端内。
- Settings 使用约 70% 宽、通常 max 110 / min 44，垂直 margin 3。
- Agents definitions modal 使用约 70% 宽、max 100 / min 44。
- footer 根据实际文字宽度换行，并反过来扣除内容高度；tabs 同样支持换行。
- 极小尺寸拒绝绘制时清空旧 hitbox，避免鼠标落到上一次的几何上。
- minimal 模式切为 embedded / borderless，复用内容而不是保留一个不适合 scrollback 的浮框。

**源码依据：** `modal_window.rs:90–154,234–401,576–628,900–1025`；`settings_modal/render.rs:95–172`；`settings_modal/state.rs:27–34`；`agents_modal.rs:1011–1076`。

视觉以中性边框、醒目标题、内容留白、选中行背景为主。源码开头的历史注释称 accent border，但当前 renderer 实际使用 `theme.gray_dim`；以实现为准，不把注释当截图。

**采用：** 一个外壳 + 少量尺寸 token + 实际内容预算 + 窄屏降级。

**不直接照搬：** 所有页同一固定 margin；过多 footer 提示；在 tiny terminal 只剩空框却没有可用返回内容。

### 3.2 设置是可搜索的分组元数据表

Grok Settings 不是“每个 tab 手写几个按钮”。

- registry 描述 `key/category/owner/label/description/keywords/kind/restart_required`。
- owner 区分 pager 内存、shell 原生配置、共享热路径展示值。
- category 包含 Appearance、Mouse、Editor & Input、Agent & Approval、Privacy、Models、Session、Advanced。
- kind 包含 boolean、enum、integer、string、动态选项与子设置组。
- 主视图是 **带 section headers 的扁平搜索列表**，不是桌面式左侧分类栏。
- Enter / Space 修改 boolean；enum / number / string 进入子编辑状态；有面包屑返回。
- 描述按需展开；长 label/value 在窄终端降为两行。
- 可编辑的标量项可恢复默认；分组导航项不需要标量 reset，被更高配置层锁定的项不允许伪修改。
- 对允许预览的 enum，选择过程可预览，取消回退；有副作用的设置不走这种预览。

**源码依据：** `G/src/settings/registry.rs:15–201,249–325`；`settings_modal/state.rs:55–146,161–214`；`settings_modal/input.rs:84–179,234–258,548–735`；`settings_modal/render.rs:369–473,614–729`。

这是本项目 Settings 应采用的核心，而不只是相同的边框。

### 3.3 Tools 详情并不都属于小弹窗

Grok 的 `BlockViewerPane` 是可查看工具 output / diff / reasoning / markdown 等内容的只读大视图，替换 scrollback 区域。

它提供搜索、filter、wrap、selection、copy；以真实 block identity 和内容 generation 更新，不需要重跑工具。diff / command / path 的 copy 是不同操作。

**源码依据：** `G/src/views/block_viewer/mod.rs:96–194,1039–1093,1150–1202`。

**采用：** Tools Inspector 要优先保证内容可阅读、可查找、可复制；不为了“统一弹窗”把大输出塞到六行选择器。

**不照搬：** 把 Enter quote、vim 字母键等竞品操作覆盖本项目 CC/readline 键位；新增工具执行或路径读取。

### 3.4 Agents definitions 与运行中的 subagents 必须分开

Grok `/agents` / `/config-agents` 对应 **Agent definitions / Personas 管理**，不是本项目 `/agent` 的运行中/历史子会话树。

- `AgentsModal` 有 definitions、source scope、enabled、persona 编辑等原生业务。
- 运行中的 subagents 位于统一 tasks pane，按任务种类分组，操作根据 variant 指向停止 task 或 agent、查看 output 或 session。
- definitions 上方打开详情 viewer 后关闭会回到保留的父 modal。

**源码依据：** `G/src/views/agents_modal.rs:1–128,1011–1129`；`views/tasks_pane.rs:1–5,133–200,924–1008`；`app/agent_view/modals.rs:273–305`。

**采用：** 状态行、名称/描述、scope badge、可读详情与明确返回；运行项使用原生状态。

**不照搬：** Persona 编辑、Grok 调度、worktree 生命周期、任务系统，或把 DSH preset 与 live child 混成一个“Agent 管理模式”。

### 3.5 发布文档中的新设置不代表本项目也需要同名键

当前 Grok 官方文档有 tool-call density、thinking、图片/selection、scroll 行为、follow-up 行为等配置；`/density` 是展示密度入口。

本项目可借鉴“常用紧凑/详细入口 + 高级细项”的展示，但：

- 不引入一套独立持久密度 profile 去覆盖已有 11 个 Tools 键。
- 不移植 Grok 的 permission mode、取消 subagent 策略、prompt merge、模型继承等业务配置。
- 不加入其认证、telemetry、commercial usage 设置。

## 4. OpenCode：统一可搜索选择器，而不是套桌面设置页

### 4.1 Dialog / DialogSelect 的分工

OpenCode 新 TUI 的结构是 `Dialog` 外壳 + `DialogLayout` + `DialogFooter` + 通用 `DialogSelect`。

- width tokens：medium 60 / large 88 / xlarge 116，最终 cap 为 terminal width − 2。
- 统一背景、标题、内容 inset、关闭入口和 footer。
- `DialogSelect` 接受 title、description、category、searchText、disabled、current、details、trailing value、actions、empty/no-match 等语义。
- 正常时按 category 分组；搜索时可以扁平化，选中项与“当前生效项”是不同标记。
- 数据列表改变、重排或项消失时重新对齐选择；saving / locked 时不能重复动作。
- keyboard hints 通过真实 command bindings 生成。

**源码依据：** `O/packages/tui/src/ui/dialog.tsx:26–84,145–210`；`ui/dialog-select.tsx` 的 props、filter/group、selection reconciliation 与 render；`ui/select-controller.ts`。

**采用：** 一个语义化行模型和选择器，服务 model、resume、preset、effort、设置子选项、只读目录。

**不照搬：** React/Solid/OpenTUI 运行时或配置；Ctrl+P command palette 等与本项目 readline 冲突的默认键。

### 4.2 新源码确实有专门 Settings dialog

`O/packages/tui/src/component/dialog-config.tsx`：

- 专门 `DialogSelect`，标题 `Settings`，搜索提示 `Search settings`。
- `/settings` 和 command palette 均可打开。
- 由 metadata array 驱动，类别有 Appearance、Session、Tabs、Diffs、Input、Alerts、Terminal、Debug。
- boolean / enum / integer 通过行内选择或子 picker 更改，立即调用同一个 config service 保存。
- command palette 可以搜索设置并跳到该项，不只是执行动作。

**源码依据：** `dialog-config.tsx:9–26,28–378,398–492`；`app.tsx:1044–1050`；`component/command-palette.tsx:37–70`。

区别必须保留：

| 机制 | OpenCode 所有权/用途 |
| --- | --- |
| Settings dialog | 新 TUI 本地展示/输入配置 |
| Palette setting entries / toggle commands | 同一偏好的快捷发现或动作入口 |
| `cli.json` | 新 CLI/TUI 持久设置与快捷键 |
| `opencode.json(c)` | Server / project 的模型、工具、Agent、MCP、权限等原生配置 |
| mini Settings | 同一配置服务的另一展示子集，不是桌面设置页 |

**采用：** 搜索即发现、统一值显示、立即保存的轻操作感。

**改进：** 保留本项目现有可编辑快捷键列表；补 per-item reset、保存失败状态和明确作用范围。不能把危险权限设置当作无提示的普通循环值。

### 4.3 有些“高级设计”也有缺点

1. 该源码的 Settings 没有可视快捷键编辑器，也没有通用 reset-to-default。
2. 部分新 trailing choice / description / preserveSelection 行为受默认关闭的 `new-designs` 控制；可以作为设计参考，但不能称作所有用户现有默认。
3. `replace()` 将 modal stack 替为单项；许多子页通过 closure 重建父页，并不是天然保留父页状态的真正历史栈。
4. filter 和 refocus 使用延迟 callback；代表性测试明确提到过快输入可能丢失并误选默认项的时序风险。
5. fixed widths 只做 cap，不完整 reflow；列表高度公式 `floor(height/2)−6` 在极矮终端有结构性风险，未实机复现。
6. hover 可以改变选择，不宜直接移植到权限放宽、删除或 stop 等有副作用的目标。
7. 无绑定的 footer action 会消失。我们应隐藏假的键名，但不因此隐藏仍可点击/从菜单发现的能力。
8. 多入口改变同一偏好容易形成三套不同名称；本项目以 Settings 为唯一完整偏好入口。

**源码依据：** `O/packages/tui/src/ui/dialog.tsx:182–190,327–431`；`ui/dialog-select.tsx` 的 focus ref、limit 与 row mouse handlers；`component/dialog-config.tsx`；代表性 `test/cli/tui/dialog-select.test.tsx` 与 `command-selection.test.tsx`。

### 4.4 审批问答不是普通选择器

OpenCode permission / form 主要是 composer 上方的专用 prompt，不经通用 Dialog host；permission 可显式展开大视图。

- 审批展示 action-specific 内容与原生权限 scope。
- Escape 拒绝/取消原生请求，不只是隐藏 UI。
- 问答有字段、校验、多选、自定义文本、review 与请求级草稿。
- 原生执行中的 prompt 与客户端设置操作必须分开。

**源码依据：** `O/packages/tui/src/routes/session/permission.tsx`、`routes/session/form.tsx`。

本项目可以选专用居中决策窗口或紧凑决策卡，**不能**因为采用共同外壳就把“关闭设置”“拒绝审批”“取消问答”“中断根回合”变成一个行为，也不能仅凭 UI 位置宣称实现了单 Editor。

## 5. 当前项目的弹窗/浮层完整盘点

### 5.1 现有组件类型与入口

现有主要界面分为 **7 个 prompt-slot dialog 类型、4 个 overlay 类型**，另有 HistorySearch、autocomplete 和持续状态区域。

| 当前界面 | 入口/角色 | 当前挂载 | 重设计方向 |
| --- | --- | --- | --- |
| `SelectDialog` | `/preset`、`/effort` | 替换 prompt slot | 通用 searchable chooser，动态 capability / current / disabled |
| `ModelPickerDialog` | `/model`、模型快捷键 | prompt slot | 同外壳 picker；provider 分组与当前模型标记保留；先显示 loading |
| `SessionPickerDialog` | `/resume` / `--resume` | prompt slot | 搜索、目录范围、原生 headers + 可见标题惰性 enrichment 保留 |
| `DecisionDialog` | Native approval / question | prompt slot | 专用决策窗口；原生 opaque options / review / cancel 契约保留 |
| `SettingsDialog` | `/settings` / `/config` | prompt slot | 可搜索 preferences modal；typed rows、reset、状态与返回位置 |
| `KeybindingsDialog` | Settings → Keyboard shortcuts | prompt slot | Settings 内一个分组可搜索子页，复用同一个 override 文件 |
| `HelpPanel` | `/help` / F1 | prompt slot | 同外壳的只读目录；命令/键位/Skills 分区和诚实可用性 |
| `ToolDetailsDialog` | Tools Inspector chord / 原位入口 | 80% overlay | 大型只读 inspector；调用导航、I/O、查找、copy 与原生 diff |
| `ImageDetailsDialog` | 图片 occurrence / tool image | 大 overlay | 图片 viewport、metadata、fallback、前后 occurrence，保留父 inspector |
| `AgentsOverlay` | `/agent` / Agents chord / 进度标题 | 85% overlay | 可搜索原生树；活跃/全部视图；metadata 预览，明确 open/reply/stop |
| `ChildSessionView` | 原生 agent 名字 / Agents Enter | 100% overlay | 大型只读 child viewer，显式 loading、返回原列表位置，无第二 composer |
| `HistorySearch` | Ctrl+R | prompt slot | 仅统一视觉/提示，不更改 CC inline/fullscreen 接受与取消语义 |
| Autocomplete | `/`、Skills、文件、参数 | 主 Editor 拥有 | 统一行风格，不搬到独立 modal，不复制 editor/undo/submit state |

**代码锚点：** `src/app.ts:834–1188,1829–1890,2185–2195,2518–2816,2912–2949`；各类见 `src/ui/dialogs.ts:254,390`、`model-picker.ts:224`、`session-picker.ts:176`、`settings.ts:163`、`keybindings.ts:79`、`help.ts:258`、`tool-details.ts:155`、`image-details.ts:71`、`agents-overlay.ts:143`、`child-session-view.ts:151`、`src/history-search.ts:6`。

### 5.2 不应强制改为居中 modal 的区域

- QueueList、SubagentProgress、footer 是持续状态，不应该为了看运行状态反复抢焦点。
- Tool / thinking / subagent groups 和图片 marker 是 transcript disclosure，不是独立弹窗。
- Todo 目前来自原生 projection / transcript；独立 Todo panel 仍未实现，不把它当成一个已存在但漏了设置的功能。
- Native diagnostics 已进入受控日志与精简 notice；目前不是可视 debug 控制台，也不应因本次改版加入 debug-heavy Settings。

## 6. 已确认的交互问题

### 6.1 挂载造成鼠标体验分裂

slot dialogs 没有自己的 `handleMouse`，overlays 有。Settings、Model、Resume 等缺少与 Tools / Agents 一致的可点击操作。

**证据：** `src/app.ts:1829–1840` 对比 `867–906,1059–1086`；上述各 dialog 类。

### 6.2 多套尺寸和滚动规则

- `dialogs.ts:205` 用 `rows−14` 的通用 row budget。
- Model 有自己的 `rows−6` 等预算。
- Tools / Image / Agents / Child 又有各自 chrome 高度与父级比例。
- Tools 将两个 `ScrollView` 用作 scroll state holder，实际内容自己 slice；传 `scrollbar:'auto'` 并不意味着使用了 ScrollView 的可见 scrollbar。

**证据：** `src/ui/model-picker.ts:78–79`；`tool-details.ts:194–195,607–629`；`child-session-view.ts:182–183,572`；`src/app.ts:889–906,1073–1086,1156–1159`。

需要统一测量和 line window 契约，而不是再增加一套 TUI 滚动引擎。

### 6.3 Settings 返回位置与异步更新

- Keybindings 替换并 dispose Settings；返回重建 General / row 0。
- Auto title 改动也先关闭 Settings，原生 round-trip 后重建。
- 目前模型目录读取完成后才打开 picker；Resume / Child 已有先显示 loading 的良好模式，应推广。
- 有些错误在 panel 内，有些进入背后 transcript；原生操作失败必须在当前操作区可见。

**证据：** `src/app.ts:2667–2694,2879–2949`；`src/ui/settings.ts:170–174`。

### 6.4 快捷键提示与实际绑定不一致

部分 slot dialog / Settings / Keybindings / HistorySearch hints 写死箭头、Enter、Esc；其他 overlay 已读 effective bindings。

**证据：** `src/ui/settings.ts:529`；`keybindings.ts:257`；`session-picker.ts:555`；`src/history-search.ts:73`；对比 Tools/Image/Agents 的 binding helpers。

重设计必须让 hint、keyboard action 和 mouse action 共享同一具名行为，关闭或重绑后不能显示假键名。

### 6.5 问答取消存在组件与 App 的旧契约差异

- `dialogs.ts:26–33,438–453` 仍描述“仅隐藏、保留 pending、同实例 reopen”。
- 实际 App 的 `cancelQuestion` 已明确 Esc 结算当前 native request 并 dispose，避免 hidden pending。

**证据：** `src/app.ts:1879–1925`；组件 standalone tests 与 App integration tests。

这是需整理的边界/注释/测试契约差异，不是本轮已复现的生产卡死。改版应以当前 App 的原生结算语义为依据，不擅自通过隐藏界面恢复旧 pending 行为。

## 7. 最近功能与 Settings 缺口矩阵

**分类：** A = 已有设置；B = 应补本地展示偏好；C = 原生状态/操作入口；D = 不应成为开关；E = 尚未实现，不虚报。

| 功能 | 现状 | 建议 |
| --- | --- | --- |
| Tools 分组/默认展开/I/O 预览/Diff | A，11 个键齐全 | 保留同一 roster；补搜索、数字输入/选择器、reset、常用/高级层次；不再建立密度配置层 |
| Thinking 显示/预览/计时 | A，3 个键 | 保留；明确“隐藏文本”不等于禁止原生 reasoning |
| Auto title | 初版曾有本地意图；最终复核确认没有安全 runtime-only public switch | DSH 分类只读显示 native 状态；删除本地覆盖与 Loader 写路径 |
| Agents 上方进度 | B，目前自动显示、没有持久展示偏好 | 首选补“自动显示 / 隐藏进度”；默认继续现有两行摘要+活动，结算立即退场 |
| Agents 消息分组 | B，当前绑定 `groupTools` | 补独立 `groupSubagentMessages`，default true；不改变事实边界或 Ctrl+O 临时 disclosure |
| Agents 转动状态符号 | B，可选 | 如果提供 reduced motion，统一控制所有工作状态动画；不新增 per-agent timer/fps 设置 |
| Agent 名字链接 | D，原生本地可打开才有链接 | 不做“整行跳转”或禁用真实性检查的设置；非名字区域继续选字复制 |
| Child viewer / Reply / Stop | C，原生能力；快捷键已可配置 | 改善列表、返回、反馈；没有调度、最大并行、取消 cascade 等 TUI 开关 |
| 图片 viewer | B，已有自动协议 fallback，没有展示偏好 | 补“自动预览 / 仅文本 metadata”；只改变显示，附件仍可提交和原生保存 |
| 图片输入/vision/内存保护 | D；粘贴键 A | 粘贴键留在 Keyboard；不做绕过 vision、像素/内存保护的设置 |
| QueueList 展示 | B，手动折叠与鼠标 chips | 可补默认“展开 / 摘要”；先补行级 keyboard 入口。不能用设置合并或重排原生 inbox |
| 模型与 effort | C，已有 `/model` `/effort`，Settings 无导航 | 先复用原生 picker；显示当前 route 与默认保存状态，不能伪造独立默认模型后端 |
| 当前 preset | C，已有 picker，开始对话后锁定 | Settings 提供当前/staged/locked 状态和已有 picker；不忽略锁定 |
| 默认 preset | C，DSH settings API 可写，但 TUI 未集成 | 后续窄接入；写 native `selectedDefault`，发现真实 namespace，标注仅新会话 |
| 当前/默认权限 | C，当前 native `/permission`，default 属于 profile | 先给当前原生入口；default 仅在 writable native settings 接通后编辑；不要另造 permission mode |
| Plan | C + D，native `/plan` 独立 | 可展示原生状态/已有入口，不混成“Plan 权限预设” |
| Skills | C + D，已接原生 metadata / `/name` | 目录可发现入口与 available/complete 说明；不新增“开启 Skills engine”或扫描路径配置 |
| fullscreen 选字复制 | B，硬编码 `copyOnSelect:true` | 可补“自动复制 / 手动复制”；Pi 已有 setter。inline 标注由终端负责，不声称设置生效 |
| 终端/鼠标滚动 | B，可选 | 有真实需求才补 scroll lines 等少量值，不先建全套鼠标 profile |
| 日志隔离/附件上限/迟到读取保护/退出恢复 | D | 是正确性和安全要求，不做关闭开关 |
| Todo 独立面板、Reasoning inspector、图片 zoom/save、MCP 管理 | E 或未集成 | 不能列为本轮已上线却没设置的功能；单独需求评估 |

### 7.1 Agents 分组耦合的准确证据

`src/ui/transcript.ts:275–277`：

```ts
return planSubagentGroupNodes(planTranscriptNodes(this.store.items, options), {
  groupRecords: options.groupTools,
})
```

所以缺的不只是一个 Agents tab，而是应明确拆分**持久展示偏好**与**共享临时展开动作**。新的偏好可以独立；Ctrl+O 的全局可见 disclosure 仍可共享，不复制一套状态。

旧设置兼容时，应把当时的 `groupTools` 值作为新 Agents 偏好的初值，避免升级后原先关闭分组的界面突然变化；这是一项明确、可测试的兼容迁移，不是长期继承层。迁移后两个键完全独立，Agents reset 恢复自身默认，不再回读 Tools 开关。空配置保持默认分组开启。

### 7.2 不能把新功能全部变成可配置规则

优先补用户确实可能选择的显示效果，而不是暴露实现常量：

- 可配置：是否展示进度、分组、图片预览、选字自动复制。
- 暂态：列表搜索、当前 tab、scroll、hover、某张图片/某次工具的查看位置。
- 原生操作：选模型、切 permission、回复/停止 child、执行 compact。
- 不变量：read-only、真实状态、名字-only hits、资源预算、epoch/abort、拒绝/取消结算、终端恢复。

## 8. DSH 原生设置的真实接入边界

### 8.1 可以使用的公开服务

| 原生服务 | 已核验能力 | 在 Settings 的处理 |
| --- | --- | --- |
| `agentDefaultModel` | `currentSelection/saveSelection` | 复用模型/effort选择；默认保存由 native ConfigEditor 决定 |
| `agentPresets` | `list/defaultId/select/acquireScope/serviceFor` | 当前/默认/锁定分开；metadata 不创建 Agent |
| `permissionPresets` | `catalog/current/set` | 当前 session command 与 profile default 分开 |
| `settings` | `describe/update/mutate` + revision、writable | 仅白名单原生字段的窄投影/修改，不整包生成配置页 |
| `configEditor` | `edit/documentPath` | 原生配置持久化 owner；TUI 不直接写用户 YAML |
| `skills` | `snapshot/list` | 当前 scope 用户可调用 metadata，不 get 正文 |
| `tools` | scoped `definitions/schemas/get` | 可只读查看能力；没有用户级工具 enable/disable API |

**原生类型依据：** `N/dsh-settings/lib/types/index.d.ts:80–114`、`types.d.ts:12–76`；`dsh-agent-default-model/lib/types/index.d.ts:42–50`；`dsh-agent-preset-registry/lib/types/index.d.ts`；`dsh-permission-presets/lib/types/index.d.ts:124–177`；`dsh-tools/lib/types/index.d.ts`；`dsh-skill/lib/types/index.d.ts:266–284`。

服务在 DSH 默认 profile composition 中有挂载依据，但用户可以禁用、更换或限制；**运行时 available/writable 是最终依据**。

### 8.2 当前模型选择不能被改写成“已确认落盘”

`src/backend/context.ts:2788–2878` 目前选择模型时同时更新 pending/live route，并调用 native default-selection service。

返回 `defaultPersistence:'native'` 不代表 adapter 已确认 profile flush；现有 adapter 明确保留 `defaultsPersisted:false`。

因此首轮 Settings 应显示：

- 当前会话实际 route。
- “通过 DSH 默认选择服务提交” / unavailable / failed 的实际结果。
- 若没有独立 default-only 操作，不能把已有 `/model` 包装成“只改下次默认，不影响当前”。

也不能把 route 存进 `~/.dsh-tui/settings.json`，制造另一套默认模型配置。

### 8.3 Auto title 最终收口为 DSH 只读状态

初版实现曾保存 `inherit/on/off` 本地意图，并通过 Loader entry 应用 runtime override。最终源码与临时目录探针证明：裸 `Entry.update` 虽通常不直接 commit，却绕过 DSH tree journal/reconcile，且 fiber unload 仍可能持久化 disabled；公开 plugin-manager 开关则明确写 profile。没有安全的 public runtime-only switch。

因此最终实现不再采用“本地意图可保存”的方案：backend 只读报告 provider/composition，写请求 fail-closed；Settings 在 DSH 分类展示只读状态，启动、reload、打开页面都只查询，不发送 `enabled`。旧 `settings.json.autoTitle` 是已知 legacy 键，启动／reload 静默忽略，不输出无须操作的兼容告警；下一次正常 TUI 设置写入会清理它，绝不改 DSH composition。

### 8.4 不使用通用 schema 自动展示整个 profile

即使 native `settings.describe({redactSecrets:true})` 有 schema-secret redaction，也不能直接将全部 `value/base/user` 显示到 TUI。

原因：MCP `env` / `headers` 在类型/实现里是普通 string dictionaries，不保证被 schema-secret 标记。泛化自动表单可能泄露认证信息。

**依据：** `N/dsh-settings/lib/types/types.d.ts:6–47`；`dsh-mcp-client/lib/types/index.d.ts:33–100`；`dsh-mcp-client/lib/index.js` 中对应普通 dictionary schema。

首轮采用 deny-by-default：

- 只读/写明确白名单的 preset default、permission default 等安全 scalar 字段。
- 不允许先全量获取可能含认证信息的 `describe` values，再仅在 renderer 端过滤。现有描述 API 是否能在安全字段投影之前避免读取非 schema-secret 值，仍须进一步核验；做不到就是 SDK 接缝缺口，不能用一个泛化配置页绕过。P2 在安全读写/revision 接缝成立前，继续使用公开 scalar getter 与已有原生入口。
- 不投影 provider credential、MCP env/header、原始 plugin options、profile patches。
- 不调用 credential `resolve()`，不显示 token 或复制原始 profile。
- 不根据工具名字推断一个完整 MCP catalog/health；没有公共只读状态就诚实说明暂不支持。
- Skills 当前中性契约没有 source/path/provider，不伪造“来自项目/用户目录”标签；若以后需要，先设计安全中性 source 元数据，不读取正文或 locator。

### 8.5 自动压缩与工具策略不属于 TUI 设置系统

- auto-compaction policy 属于 preset 中 `compaction-basic` 配置；当前没有公开 runtime on/off 服务。
- 工具可见性/限制由 native preset、scope 和 admission 决定，不是工具列表里的 checkbox。
- MCP/extension 安装、凭据和连接定义不是改版顺便开放的包管理/认证子系统。
- `/permission` 与 `/plan` 保持独立。

这些可有“由 DSH 管理”的说明或已有原生入口，不能伪装成保存成功的本地开关。

## 9. 推荐交互与视觉方案

### 9.1 统一外壳，四类交互

| 类别 | 适用 | 内容/行为 |
| --- | --- | --- |
| Chooser | Model / Resume / Preset / Effort / 设置选项 | 搜索、分组行、当前值、disabled、明确选择；通常中型 |
| Inspector | Tools / Image / Agents / Child / 只读目录 | 大型内容区域、查找、滚动、metadata、copy；不执行读取以外的隐式业务 |
| Decision | Approval / Question / native plan request | 明确来源、原生选项、文本/多选/review、拒绝/取消结算；专用安全布局 |
| Preferences | Settings / Keyboard 子页 | 可搜索分类、typed values、default/reset、保存状态、native scope 说明 |

共同拥有：title/close、尺寸规则、search/segment 区、content、status、keymap hints、ActionChips、返回位置。

**不共同拥有：** 权限规则、请求结算、native scheduling、Editor 提交、模型/凭据目录或 durable facts。

### 9.2 外壳与尺寸

建议三个内容宽度级别：

- compact chooser：目标 60 列左右。
- preferences / 普通 inspector：目标 88–100 列。
- 大输出 / child / image：最多使用当前终端宽度减安全 margin，不设置浪费空间的低固定上限。

以上是拟议设计 token，不是性能/真机测量结论。计算必须从**终端可用高度减实际 chrome**得到，而不是再散落 `rows−14`。

窄/矮降级：

1. 宽屏可用列表+metadata双区；窄屏改为同一窗口的列表→详情。
2. 分类不能无限换行吞掉 body；小屏用 category 行或搜索分组 headers。
3. status/hints 根据真实宽度压缩，保留 close/back 与当前核心操作。
4. extremely short terminal 使用紧凑文本与可用返回，不画不可操作空框。
5. inline 使用相同内容/键位契约，但不承诺与 fullscreen 相同遮罩、鼠标或原生 scrollback 行为。

### 9.3 Settings：可搜索分组列表为基础

首选分类：**General / Tools & Diff / Thinking / Agents / Images / DSH / Keyboard**。

不把新增类别全部做成横向 tabs。基础是 searchable grouped list；只有宽度充分时才允许分类导航占一列。

拟议窄到中型布局：

```text
┌─ Settings ─────────────────────────────────────────── [×] ┐
│ Search settings…                                         │
│ All · Tools & Diff · Thinking · Agents · Images · DSH      │
├───────────────────────────────────────────────────────────┤
│ Agents                                                    │
│ ❯ Progress above input                      Automatic     │
│   Group agent messages                      On · default  │
│                                                           │
│ Images                                                    │
│   Viewer preview                            Automatic     │
│                                                           │
│ DSH                                                       │
│   Current model                             Choose…       │
│   Current permission                        Native…       │
├───────────────────────────────────────────────────────────┤
│ Display preference only. Does not stop any native agent.   │
│ Saved locally · effective now                             │
│ [actual binding] change   [actual binding] reset   close   │
└───────────────────────────────────────────────────────────┘
```

这个 mockup 是本项目提案，不是竞品截图；文中的新增 Agents/Images 行已在本轮实现，实际布局以共享 `ModalFrame` 和验收记录为准。

设置行规则：

- boolean：选择后改变；复杂 enum/number：Enter 打开明确 picker/editor，不要求用户反复循环找到值。
- 数字保留既有合法范围，支持现有 JSON 自定义值；不要把只有固定 roster 当作完整 schema。
- description 明确 owner、apply time、是否影响当前/native defaults。
- 修改状态区分 saving / saved / failed / native unavailable / native persistence unconfirmed。
- 普通展示值保存后生效；失败恢复原值并在当前窗口说明。
- 需要安全确认的 native 放宽权限，不使用 hover preview 或普通 enum cycling。
- reset 仅移除本地这一 override 或通过 native `unset`；不是删除所有配置，不覆盖不可编辑的 native 上层值。

### 9.4 Tools Inspector

```text
┌─ Tools › run command · 7/12 · Running ─────────────── [×] ┐
│ Search calls…          │ Input  Output                   │
│ read src/app.ts        │ $ pnpm test                     │
│ run pnpm typecheck     │ … live native output …          │
│ ❯ run pnpm test        │                                 │
│ edit settings.ts       │ Find in output…                 │
├────────────────────────┴─────────────────────────────────┤
│ Copy input / Copy output · Wrap · Previous / Next        │
│ Read-only · viewing recorded/live native facts            │
└───────────────────────────────────────────────────────────┘
```

- 宽屏可有调用列表；窄屏使用调用切换 + 当前详情，不抢 body 高度。
- Input / Output 保留各自 scroll/查找状态；不是同一个粗糙纯文本页。
- Native 有真实 change/presenter 数据才提供 Changes/diff view；不从当前文件猜改动。
- copy 保持“原始可得源”语义，不把展示裁剪当作完整 source。
- Tool → Image → Back 回到相同 call / section / scroll。
- Settings / Inspector 中的展示选择不重跑工具。

### 9.5 Agents 与 Child

```text
┌─ Agents · 2 active / 5 known ────────────────────── [×] ┐
│ Search agents…       Active / All                       │
├─────────────────────────────────────────────────────────┤
│ ❯ reviewer     Running      native activity…            │
│   tests        Initializing                              │
│   docs         Completed                                  │
├─────────────────────────────────────────────────────────┤
│ Selected metadata / capability / native metrics only     │
│ Open transcript     Reply     Stop     Close             │
└─────────────────────────────────────────────────────────┘
```

- 搜索/过滤只处理当前原生 catalog；status/指标不推算，不用前端计时器伪造 per-run 数据。
- 移动选择最多显示现有 metadata / lastActivity；**不因 hover/选择自动 follow 读取多个 child transcript**。
- Enter 显式打开当前 child；立即 loading，然后仅以当前 owner 的原生 snapshot/stream 更新。
- 显式详情不因 completed 自动关闭；进度 widget 仍按 running/initializing 结算退场。
- Reply 回到唯一主 Editor 并绑定真实 child target，保留原 draft/图片；不在详情里创建第二 composer。
- Stop 只调用已有 native control；pending/accepted 不冒充 stopped。
- Back 恢复真实 agent id、query、filter 和 scroll；该 id 被移除时选择最近的可用项，而不是复活旧 child。
- native external / 不可本地打开项显示真实 disabled reason。

### 9.6 Image、Help 与决策窗口

- Image：显示 viewport 与 metadata 分区；automatic/text fallback、读取/解码 loading/error、前后 occurrence 导航；导航仍按 occurrence，不按 attachmentId 去重。
- Help：只读 commands/keys/Skills，可搜索；查无匹配 ≠ native catalog unavailable；不执行 skill、不改变 draft。
- Decision：request 来源固定，保留 native opaque option.value；自定义答案与多选使用既有 input family。关闭按钮对审批是拒绝、对问答是取消，文案需明确；不允许 backdrop 随手点击跳过 pending 请求。
- 现有 `DecisionRequest` 没有结构化 tool correlation。可以展示原生 message，但**不能用“最近一次工具”关联审批 diff**。富审批预览需要另行核验原生相关字段/窄事件桥。

## 10. 状态、焦点与持久化契约

### 10.1 少量公共组件，不再造一套 UI runtime

可提取的组件/工具：

- `ModalFrame`：视觉、实际 chrome 预算、尺寸 token。
- `KeyHints` / `ActionChips`：同一具名行为的实际 keyboard / mouse 入口。
- `SearchRow` / `ListRow`：只拥有该输入/列表本身，不复制主 Editor。
- `LineWindow` / 既有 Pi ScrollView：统一窗口数学，不写第二 terminal renderer。
- `SurfaceStatus`：当前操作区的成功/失败/capability说明。
- 小型 App-owned modal navigation/restore record：title、surface owner、返回位置；不持有 DSH 会话事实。
- 设置 metadata roster：key、category、label、description、kind、default、keywords、owner、apply time、availability。

native writes 保持在 adapter；Settings rows 不 import DSH runtime，不形成通用 schema执行器。

现有 vendored Pi TUI 已有实现所需的核心接缝：`showOverlay` 的宽度/高度/anchor/margin/visible、`OverlayHandle` 的 `setHidden/focus/unfocus/getBounds`、`Component.handleMouse/capturesViewportInput`。`hide()` 是永久移除，`setHidden()` 才是暂时隐藏；返回父窗口不能混用两者。main/alt 两种 renderer 都已在行差分之前组合 overlays。

**依据：** `vendor/pi-tui/src/tui.ts:122–147,263–339,763–863`；`tui-main-screen.ts:267–273`；`tui-alt-screen.ts:686–689`。

所以改版首先是 App/UI 的组合工作，不需要替换 Pi renderer。当前公开 OverlayOptions 没有 OpenCode 式 RGBA backdrop opacity 参数；可以先实现一致的 opaque modal surface/边框/层级，不能为了相同的蒙层截图就声称已有 alpha 支持或额外 fork 一套 renderer。

### 10.2 返回与异步

- 保留 main draft、cursor、undo、paste/image registry；modal 不能 setText 模拟主编辑状态。
- Settings → Keyboard → Back、Tools → Image → Back、Agents → Child → Back 都保存明确父位置。
- attachment replacement / close / unload tombstone read与write回调；迟到结果不 reopen UI。
- 设置 row 保存按 key/intent 有序；展示 saving 防双提交，失败留在当前 row，不把用户意图藏在背后 transcript。
- native settings 使用 `expectedRevision`；冲突重新读取安全 row并提示，不能覆盖用户外部更新。
- backdrop/resize/drag/数据重排不能将旧 press 变成新项目的 click。
- modal 中未识别 global/editor actions inert；中断与取消继续交给既有 keymap + App owner，不拷贝竞品硬编码键。
- autocomplete late refresh 只重查候选，Enter 仍先 apply selected item 再捕获 completed payload；Tab 编辑不提交。

### 10.3 不增加偏好层级

- 本地展示偏好继续使用一个 `settings.json`。
- 快捷键继续一个 `keybindings.json`，reset 删除一个 override；无 `/hotkeys`、键位 profiles 或冗余 override 层。
- 搜索、当前分类、返回位置和临时 disclosure 是 UI session state，不滥用 durable setting。
- DSH defaults/permissions/preset 仅由 DSH native configuration 写入，不写入 TUI 设置文件。
- 当前 `SettingsStore.set` 输出完整 resolved object，尚无 per-item unset / override provenance API；改版要先定义向后兼容的 reset 和 changed/default 标记，不能今天就伪造“该值来自哪层”的标签。

## 11. 建议实施顺序

### P0：统一基础与 Settings 完整入口

1. `ModalFrame` / 预算 / 实际键位 hints / row / status。
2. 迁移 Settings、Keyboard 和通用 chooser；补搜索、typed editing、reset、返回位置与 mouse parity。
3. 原有 16 个设置完整保留，不改默认业务，不新增配置层。
4. Settings 增加已有 native model/effort/preset/permission 的导航与诚实状态，Skills 只读可发现入口。

### P1：Tools / Agents / Image 的新布局

1. Tools Inspector 的调用列表、I/O search、原生 diff、copy 与 nested image 返回。
2. Agents 搜索/过滤、metadata 预览、Child back/feedback；仍无新调度。
3. Image 的大 viewport、text fallback 与 nested restore。
4. History/Help/Decision 统一外观与提示，但保持实际原生/CC契约。

### P1：少量确定的本地展示设置

优先四项：

- Agents 进度：自动 / 隐藏。
- Agents 消息独立分组。
- Image viewer：自动预览 / 文本。
- fullscreen copy-on-select：自动 / 手动。

Queue 默认展开方式和 unified reduced-motion 可按实际使用需求补；不自动把所有新功能转为设置。

### P2：受能力约束的 native defaults

- 在新的安全白名单 metadata / revision adapter 验收后，再接默认 preset、默认 permission 等 profile setting。
- 原生字段/namespace 不可用时显示 unavailable，不能保存到 TUI 假装成功。
- 所有真实 profile 编辑只在用户实际操作时经 native API；开发测试一律临时 home/workspace。

### 验收门槛

- 两种 renderer；40/60/80/120/160 列，10/18/24/40 行；中文/emoji/长 path/长错误；实时 resize。
- open/close/Back/切换/decision 抢占后草稿、图片、undo 与焦点正确。
- real keybindings 重绑/disable/chord，hint 与 mouse action 一致；没有隐藏 editor fallthrough。
- 空目录、搜索无匹配、loading、unavailable、incomplete、失败和重试逐一测试。
- 写失败/并发 revision/外部 malformed settings，单项 reset 不覆盖其他值或真实配置；Agents 分组旧设置兼容迁移与此后独立 reset 有专项回归。
- live output 时滚动稳定、copy原始源、native facts不重放/重跑；hover不触发读取或业务动作。
- request cancel 必须结算，native option/value/source不伪造，默认权限不得悄然放宽。
- 所有 terminal writes 仍归 renderer；退出/异常/interrupt/suspend 的恢复回归。
- 生产 CLI/PTY 以临时 profile + hermetic stream 独立验收；不以 demo 替代真实 plugin 边界，不声明 GPU/IME/实时模型效果已测。

## 12. 本轮交付边界

本文最初是调研、设置缺口矩阵、交互/布局提案和实施顺序；用户确认后已按 [实施契约](DIALOG-IMPLEMENTATION-CONTRACT.md) 完成当前工作树实现，完整验收见 [验收记录](ACCEPTANCE.md)。

实现仍未提交、推送、发布、升级版本或替换全局 executable。后续改动仍须读相关 Pi TUI 文档/示例并遵守项目单主 Editor、原生 DSH owner 与并行文件 ownership。

用户现场反馈后，Settings 已收口为 Grok 式连续单页：不保留 tab/segment 栏，不按分类隐藏行；所有分组共享滚动与搜索，Tab/Shift+Tab（或 Right/Left）只跳转分组位置。无状态变化的鼠标 press 不再多绘一帧，原生元数据在同一帧共享一次投影；未复现用户真机的严重卡顿，离线 PTY 只证明当前交互与首个重绘字节及时到达，不冒充真实终端 GPU 延迟。

既有 Skills 目录用户确认与 Enter 修复属于前一阶段；本轮最终完整检查为 **1646/1646**（121 个测试文件），不把更早的 1408/1408 当成新弹窗测试结果。

## 附：可直接核对的固定源码链接

### Grok

- [ModalWindow / sizing / footer / input](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/modal_window.rs#L90)
- [Settings registry / owner / category](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/settings/registry.rs#L15)
- [Settings render](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/settings_modal/render.rs#L95)
- [Settings typed edit / reset / filter](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/settings_modal/input.rs#L548)
- [BlockViewer](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/block_viewer/mod.rs#L96)
- [Agent definitions](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/agents_modal.rs#L1)
- [Live tasks/subagents](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/tasks_pane.rs#L1)

### OpenCode 发布代际对照

- [已发布 v1.19.5：commands-only palette](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/tui/src/component/command-palette.tsx#L26)
- [已发布 v2.2.6：集中 Settings dialog](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/tui/src/component/dialog-config.tsx#L388)
- [dev：new-designs 为显式 opt-in](https://github.com/anomalyco/opencode/blob/2b3a0d441044c385c059d77866eecba6f0082629/packages/tui/src/config/index.tsx#L393)

### OpenCode 新 TUI 快照

- [Dialog host / sizes](https://github.com/anomalyco/opencode/blob/2b3a0d441044c385c059d77866eecba6f0082629/packages/tui/src/ui/dialog.tsx#L26)
- [DialogSelect](https://github.com/anomalyco/opencode/blob/2b3a0d441044c385c059d77866eecba6f0082629/packages/tui/src/ui/dialog-select.tsx)
- [专门 Settings dialog](https://github.com/anomalyco/opencode/blob/2b3a0d441044c385c059d77866eecba6f0082629/packages/tui/src/component/dialog-config.tsx#L28)
- [Settings change / save / render](https://github.com/anomalyco/opencode/blob/2b3a0d441044c385c059d77866eecba6f0082629/packages/tui/src/component/dialog-config.tsx#L398)
- [Palette 搜索设置](https://github.com/anomalyco/opencode/blob/2b3a0d441044c385c059d77866eecba6f0082629/packages/tui/src/component/command-palette.tsx#L37)
- [Native permission prompt](https://github.com/anomalyco/opencode/blob/2b3a0d441044c385c059d77866eecba6f0082629/packages/tui/src/routes/session/permission.tsx)
- [Native form prompt](https://github.com/anomalyco/opencode/blob/2b3a0d441044c385c059d77866eecba6f0082629/packages/tui/src/routes/session/form.tsx)
