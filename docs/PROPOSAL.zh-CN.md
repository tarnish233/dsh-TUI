# DSH TUI 方案：Pi 渲染底座 + CC 交互 + DSH 后端

> **当前实施更新：原生插件化。** 用户已选择 DSH 原生应用 bundle + 同进程 Cordis TUI 插件；默认 profile 仍为 `dsh-tui`，模型选择采用直接消费 DSH `llm`/default-model 公开服务的轻投影。旧 IPC、独立后端进程、临时 home/profile 镜像及自动替换其他前端均已移除。应用身份现已统一为 `dsh-tui`；入口首启通过所选 DSH 的公开 package APIs 自动挂载本地应用，只升级同源旧别名、不重建配置或替换其他前端，再委托 native launcher 并断言终端激活。原生 preset 资源/类从宿主安装锚点解析。启动、资源释放和配置组合仍由 DSH 接管；入口与当前验收见 README / BACKEND / ACCEPTANCE。下文保留原始方案与历史版本调查，§5 的单 Editor/输入原则继续适用，历史隔离备选不代表当前架构。

## 结论

推荐做一个独立的 TypeScript TUI：

- **DSH 保有 Agent、模型路由、工具、权限、会话与持久化的所有权。**
- **以 `@earendil-works/pi-tui` 为终端组件与渲染底座。**
- **输入层尽量完整对齐 Claude Code 的 readline 行为，作为首版核心验收项，不仅补齐 Ctrl+P/N，也不以 Pi 默认支持范围为上限。**
- **从 `pi-cc-extensions` 提取展示算法与设计，不原样加载整套运行时补丁。**
- **优先复用、组合；必要时只对 Pi TUI 的编辑策略等小范围做版本锁定的补丁，不 fork 整个 Pi Agent。**

这与“配置 Pi 调 DeepSeek 模型”不同：后者仍然是 Pi 的 Agent、工具和会话，不是 DSH 的新界面。

第一版只支持当前核验的 DSH 版本线，不复制旧 dsh-tui 的全部历史版本兼容层。

---

## 1. 本次核验范围与边界

| 对象 | 本地核验版本 / 状态 | 位置 |
| --- | --- | --- |
| DSH | `@deepseek-ai/dsh` `0.2.1-rc.5` | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh` |
| 实际安装的 dsh-tui | `@deepseek-harness-tui/dsh-tui` `0.18.0` | `/opt/homebrew/lib/node_modules/@deepseek-harness-tui/dsh-tui` |
| dsh-tui 备份工作树 | package version `0.17.0`，`slim` 分支，存在大量既有未提交修改 | `/Users/fulei/workspace/dsh-tui-bk` |
| Pi / Pi TUI | `1.5.0` | `/Users/fulei/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works` |
| 实际安装的 CC 扩展 | `pi-cc-extensions` `1.0.13` | `/Users/fulei/.pi/agent/npm/node_modules/pi-cc-extensions` |
| CC 扩展本地工作树 | package version `1.0.8`，部分文件与安装版不同 | `/Users/fulei/workspace/pi_extensions/pi-cc-extensions` |
| 现有原型 | `agent_tui` `0.1.0`，依赖 `pi-tui` `1.4.0`，当前后端是 Pi RPC | `/Users/fulei/workspace/agent_tui` |
| Claude Code | 按官方交互与快捷键文档对照，未做其内部渲染器的源码级结论 | 见文末链接 |

当前 `dsh-tui` 项目目录在分析开始时为空。分析没有修改任何既有项目、全局安装或用户配置，也没有调用模型执行付费任务。

完成了 Pi Editor 的离线输入行为探针；**没有完成同一真实终端下的 dsh-tui / Pi / CC 流式性能基准测试**。下文把实现事实、可疑因素与拟议方案分开，不把静态阅读当成故障已复现。

为缩短源码引用，后文使用：

- `DSH_TUI` = 实际安装的 dsh-tui 根目录。
- `PI_TUI` = 上述 Pi 安装目录中的 `pi-tui`。
- `DSH_PACKAGES` = DSH 根目录下的 `node_modules/@deepseek-ai`。
- `CC_EXT` = 实际安装的 `pi-cc-extensions` 根目录。
- `PROTO` = `/Users/fulei/workspace/agent_tui`。

## 2. 各项目的实际情况

### 2.1 dsh-tui：输入问题属实，但不是完全没有配置

安装版 `0.18.0` 的键位注册表只开放一组应用动作；编辑器、导航的一部分行为仍然硬编码。

典型默认键位：

- `Ctrl+P` → context panel，而不是向上移动 / 历史。
- `Ctrl+B` → side panel，而不是 readline 字符左移。
- `Ctrl+A` / `Ctrl+E` 同时被应用动作与编辑行为使用，存在上下文优先级的复杂性。
- `Ctrl+U/K/W` 等有一部分编辑支持，但没有完整的可配置 readline 编辑动作表。
- PromptInput 的上下导航分支直接判断 `key.upArrow` / `key.downArrow`。

所以，更准确的描述是：**能配置部分应用快捷键，不能靠现有配置完整补齐编辑器和所有列表的 readline 行为。**

备份工作树已经出现 `src/keys/registry.ts`、`fixed.ts`、`intents.ts` 的集中化改造，包括 `historyPrevious = Ctrl+P`、`historyNext = Ctrl+N`。这说明输入问题本身可以局部修复，不必为了修几个键重写渲染器。但备份是定制工作树，不能把它的实现当成安装版 `0.18.0` 的行为。

依据：

- `DSH_TUI/lib/types/utils/keymap.js:167–199`：应用动作与默认键位。
- `DSH_TUI/lib/types/utils/keymap.js:303–340`：不可重映射的固定键。
- `DSH_TUI/lib/types/components/PromptInput.js:2597–2769`：箭头导航分支。
- 备份 `src/keys/registry.ts:271–278`：readline 动作声明。

### 2.2 dsh-tui：不是因为完全缺少差分渲染或同步输出

安装版使用 React reconciler、Yoga 布局、Screen cell buffer 与差分输出。它已经具备：

- `16ms` 的帧调度间隔。
- 单帧缓冲写入。
- DEC 2026 synchronized output。
- 流式 Markdown 的稳定前缀 / 不稳定后缀处理。
- 对缩高、滚动、终端差异的多个修复路径。

因此不能简单得出“React / Ink 必然卡”“加一个 throttle 就能解决”或“旧实现完全全屏重画”的结论。

需要重点复现的风险点：

1. **布局高度变化与光标 / 视口状态的组合。** 增长、收缩、滚动、重锚定分别有复杂分支；某个边界错误可能形成错行、重复行。
2. **Markdown 流式视图与最终视图的差异。** 不稳定后缀有 `3584` 字符预算、`1024` 步进的裁剪逻辑，完成时再显示完整文本；这会产生实际布局变化，需验证是否与视口重定位相互放大。
3. **高频工作不只发生在最后写屏。** 即使最后合并为 16ms 一帧，事件处理、React 提交、词法分析、换行和布局仍可能占用交互线程。
4. **终端能力判断。** 本次运行环境是 `TERM=xterm-rex`、`TERM_PROGRAM=rex`。实际调用 dsh-tui 的能力判断函数得到 `SYNC_OUTPUT_SUPPORTED = false`。其 fullscreen 输出路径会在这一结果为 false 时省略同步输出标记；Pi 的渲染路径则发送 2026 标记。

第 4 点是具体、值得优先检查的兼容性嫌疑，**不是 Rex 实际不支持同步输出的证明，也不是已经证明用户此前的乱行由它导致**。需要在出现问题的同一终端与模式里记录 ANSI 输出，确认标记是否发出、终端是否支持，以及布局结果是否正确。Inline 路径的标记策略与 fullscreen 不同，不能混为一谈。

依据：

- `DSH_TUI/lib/types/ink/constants.js:2`：16ms。
- `DSH_TUI/lib/types/ink/ink.js:275–296`：提交后的合并调度。
- `DSH_TUI/lib/types/ink/ink.js:1207`：fullscreen 的同步输出开关。
- `DSH_TUI/lib/types/ink/terminal.js:101–155`：同步输出的环境判断。
- `DSH_TUI/lib/types/ink/terminal.js:392–501`：差分缓冲与写入。
- `DSH_TUI/lib/types/ink/log-update.js:135–274`：resize、scroll、shrink 等路径。
- `DSH_TUI/lib/types/components/StreamingMarkdown.js:16–47`：后缀预算与步进。

### 2.3 Pi：适合复用的是 TUI 包，不必复用整个 Agent

Pi TUI 的主要模型是：

```text
Component.render(width) → string[]
                       → 行差分
                       → synchronized output
                       → Terminal
```

可直接复用的公共能力包括：

- `TuiMainScreen`、`TuiAltScreen`、`ProcessTerminal`。
- `Editor`、`Input`、`SelectList`、`SettingsList`。
- `Markdown`、`Text`、布局容器与滚动视图。
- `KeybindingsManager`、键盘协议解析、粘贴处理。
- Unicode / ANSI 显示宽度工具与 IME 光标定位。

Pi 有一个统一的渲染请求合并器，默认 16ms，输入能够抢占等待中的帧。历史组件可以缓存；无需保留 React + Yoga 的另一套终端布局链路。

但 Pi TUI 也不是无条件免疫错行和性能问题：

- 行差分不代表 Markdown 真正按 token 增量解析。文本改变后，活动 Markdown 仍可能重新词法分析；稳定组件缓存才是主要收益之一。
- 主屏模式下，宽度变化或变化发生在已有视口上方，会触发全量重绘，包含清屏与清 scrollback。
- 任意业务 `console.log`、超宽组件行、错误焦点传播、每 token 强制重绘，都仍然可以破坏体验。

在独立应用里使用 `pi-tui` 的 `Editor`；不要为了一个 `❯` 前缀引入依赖 Pi Agent 的 `CustomEditor`。

依据：

- `PI_TUI/dist/tui.js:193`、`:658–710`：帧间隔与请求合并。
- `PI_TUI/dist/tui-main-screen.js:224–420`：行差分、同步输出与 fullRender。
- `PI_TUI/dist/components/markdown.js:225–288`：文本 / 宽度缓存与 lex。
- `PI_TUI/README.md`：公共组件、两种渲染器、Terminal 接口。

### 2.4 Pi 的编辑语义与 CC 仍有差异，配置并不能解决全部问题

用户当前 `~/.pi/agent/keybindings.json` 已把 `Ctrl+P/N` 分配给 editor 上下移动与列表导航，并把模型循环移到 `Alt+P`。这解释了常用操作为什么已经比较顺手。

离线探针还确认了两个差异：

**一、从非空输入的第一视觉行浏览历史。**

Pi 的 `cursorUp` 在第一视觉行但光标不在行首时，先跳到行首，再次按才进入历史。

```text
输入 draft，光标在末尾：
Ctrl+P → draft（光标回行首）
Ctrl+P → newer
Ctrl+P → older
```

CC 官方文档描述的是：先在多视觉行内移动；已经处于第一 / 最后一视觉行时，再按即浏览历史。Pi 的额外“跳行首”步骤与之不同。

配置 Pi 的专用 `historyPrevious` 可以直接切历史，但也会跳过多行输入内部的移动，所以它不是完整的 CC 兼容修复。

**二、Ctrl+W 的词边界。**

```text
输入：src/utils/foo.ts
Pi 1.5.0 Ctrl+W 后：src/utils/foo.
CC 当前文档的 Ctrl+W：删除到前一空白，整条路径被删除
Pi Ctrl+Y：能够还原被删除的 ts
```

Pi 将 Ctrl+W 与词移动复用相同边界；CC 区分“空白分隔的 shell word”与 Alt+B/F/D 的普通词边界。

因此目标应是 **CC 行为兼容层**，不是仅添加 Ctrl+P/N 别名。编辑器内部部分方法目前是 private；严格匹配这些行为时，建议给 Pi TUI 增加小范围、可测试的编辑策略 seam，或者维护一个小补丁。不要在外部复制编辑状态、通过 setText 模拟删除而破坏 kill ring、undo、paste marker 与光标状态。

依据：

- `PI_TUI/dist/components/editor.js:753–778`：上下移动 / 历史优先级。
- `PI_TUI/dist/components/editor.js:1418–1452`：向后删词复用 moveWordBackwards。
- `PI_TUI/dist/word-navigation.js:1–101`：分词策略。
- `PI_TUI/dist/components/editor.d.ts`：编辑内部能力的可见性。
- CC interactive-mode 的多行导航与 word boundaries 文档。

### 2.5 pi-cc-extensions：展示值得借鉴，但不只是“换皮肤”

推荐借鉴 / 提取：

- 工具标题、摘要、分组与折叠 / 展开规则。
- Diff 的 parse、inline spans、unified / split 布局、宽度保护。
- 紧凑 thinking、回合摘要与 Working 状态。
- CC 风格主题、`❯` 输入前缀、精简 footer。

不推荐原样搬入：

- `ToolExecutionComponent`、`AssistantMessageComponent` 的 prototype 补丁。
- Pi 专用 session / extension 生命周期接线。
- Pi 主屏渲染器私有成员的修改。
- 为获得 write diff 而注册 / 重写 Pi 的 write 工具。

一个特别重要的例子是 `installMainScreenDoRenderPatch()`：它让差分比较忽略主屏视口上方的变化，避免动画反复触发清 scrollback。**代价是终端历史中已经写出去的那几行保留旧文本。** 这是一项明确的产品取舍，不是无损渲染优化。

独立 TUI 能直接设计自己的组件与动画位置，无需继续“抢补丁所有权”。先让历史行稳定、把持续动画放在当前可见的工作区；如仍需要这种策略，应把它做成明确的 renderer policy，而不是复制 monkey patch。

Diff 模块也不是完全零依赖：高亮函数、工具详情类型等仍有 Pi Agent 耦合。提取时换成前端自有的类型 / highlighter 接口；底层 diff 算法和布局可以复用。Diff 事实来自 DSH 工具或合法的后端呈现数据，不能由 UI 猜测执行效果。

依据：

- `CC_EXT/extensions/renderer/index.ts:136–146`：渲染层补丁组装。
- `CC_EXT/extensions/utils/fullscreen-detect.ts:22–61`：scrollback 取舍。
- `CC_EXT/extensions/feature/shell/prompt-editor.ts:31–51`：输入前缀及 CustomEditor 耦合。
- `CC_EXT/extensions/renderer/tool/diff/diff-renderer.ts`：diff 子模块边界。
- `CC_EXT/extensions/renderer/tool/diff/write-execution.ts:1`：Pi write 工具依赖。
- `CC_EXT/extensions/renderer/tool/diff/diff-highlight.ts:1`：Pi 高亮依赖。

### 2.6 agent_tui：现成原型能减少工作，但不是已完成的 DSH 前端

本地已有原型具备 CC 风格输入、工具卡、问卷、配置页、history search、两种 Pi renderer，以及一部分离线测试。

优先复用：

- `src/keys.ts` 的键位组织思路。
- `src/ui/dialogs.ts`、`questionnaire.ts`、`select.ts`。
- `src/ui/chrome.ts`、主题、文本换行辅助。
- 回合摘要与可移植的工具展示。

需要替换 / 清理：

- `src/pi/rpc.ts`：当前是 Pi 后端。
- `src/transcript.ts` 对 Pi RpcRecord 的直接依赖。
- Pi 会话文件读取、extension UI walker 与专用问卷 shim。
- 将 Shift+Tab 复用为 thinking 的 Pi 语义，以及“Pi 没有 todo / permission mode”的占位处理。

它可以作为 UX 样机和组件来源；不建议直接把整个 Pi-specific app 改名为 dsh-tui。升级它使用的 Pi TUI 1.4.0 到 1.5.0 也需要跑其现有回归，不能只改依赖号。

依据：`PROTO/README.md`、`src/transcript.ts:7`、`src/app.ts:164`、`src/keys.ts`。

## 3. 路线比较

| 路线 | 是否保留 DSH 行为 | 判断 |
| --- | --- | --- |
| 修现有 dsh-tui 键位 | 是 | 短期可行；已有备份改造可参考，但流式问题仍要定位 |
| Pi + DeepSeek provider + CC 扩展 | 否，仍是 Pi Agent | 如果只要模型和顺手 UI，这是最快路线；不是本项目目标 |
| fork Pi 整个 interactive / AgentSession，把 Agent 换成 DSH | 可以尝试 | UI 与 Pi 会话、队列、工具、扩展等耦合，维护成本高，不推荐 |
| 独立 TUI + Pi TUI + 薄 DSH adapter | 是 | **推荐**：复用终端基础设施，自有交互和呈现，不改 DSH 内核 |
| 直接套当前 SDK / ACP | 部分 | 协议存在，但当前覆盖不足以承载本项目完整交互与实时增量 |

## 4. 推荐架构与 DSH 接入

```text
                   独立 TUI 应用
┌────────────────────────────────────────────────┐
│ CC 风格交互                                    │
│ Editor / 快捷键上下文 / 历史搜索 / 问卷 / 审批  │
├────────────────────────────────────────────────┤
│ 前端状态与展示                                 │
│ Transcript / LiveAttempt / ToolCard / Diff      │
├────────────────────────────────────────────────┤
│ Pi TUI                                         │
│ 组件、宽度、焦点、行差分、同步输出、终端恢复     │
└───────────────────────┬────────────────────────┘
                        │ 薄 DSH adapter
┌───────────────────────▼────────────────────────┐
│ DSH 官方公开 API / Cordis 插件接缝              │
│ agent/assistant-stream + session/event          │
│ Agent / Tools / Approval / Questions / Session  │
│ Model / Skills / MCP / Persistence / Policy     │
└────────────────────────────────────────────────┘
```

### 4.1 首先做进程内的窄接入，不重做 DSH 域服务

首个接入样机以自有 Cordis TUI 插件消费公开包根导出。组装沿用 DSH 的产品能力，替换界面，不复制其 Agent loop、权限判定、文件工具、认证和持久化。

具体启动组装先验证：界面插件的挂载时机、Agent 获取 / 恢复、默认 profile 的继承与 GUI / logger 的关闭方式。不要在方案里假设一个未经核验的启动 helper 或命令已经存在，也不要复刻 DSH CLI 的私有装配清单。

DSH 适配集中到一个小目录；UI 不 import `@deepseek-ai/*` 的运行时实现。先支持核验版本 `0.2.1-rc.5`，通过契约测试再升级。

### 4.2 为什么不能直接把当前 SDK / ACP 当最终接口

DSH 当前有两个不同的数据平面：

1. **实时平面**：`agent/assistant-stream` 发布 start / chunk / end；chunk 是进程内临时发布。
2. **持久平面**：一次尝试结束后追加 `assistant/message` 或 `assistant/attempt`，内部保存完整 timed stream；`session/event` 通知已提交的事实。

SDK server 目前转发 `session/event`、agent status 与 subagent 生命周期，没有转发 `agent/assistant-stream`。收到某个已提交记录中的 stream，不能等同于实时收到 token。

SDK 还没有逐会话取消 / 关闭方法，审批客户端请求尚未使用。ACP 有取消与权限请求，但当前明确只发送已提交的语义更新，省略原始增量以及 DSH 专用计划、命令、终端和问卷等交互面。

因此：可以用它们做自动化或对照测试，不能假装它们已经提供本项目要求的实时 TUI 契约。

依据：

- `DSH_PACKAGES/dsh-agent/lib/types/runtime-types.d.ts:106–142`：实时帧类型。
- 同文件 `:358–369`：临时 chunk 与最终持久 settlement。
- 同文件 `:151–212`：cancel、steer、followup 等能力。
- `DSH_PACKAGES/dsh-sdk-jsonrpc-server/lib/index.js:68–116`：转发的事件。
- `dsh-sdk-protocol/README.zh.md`：协议方法与限制。
- `dsh-acp/README.zh.md`：已提交语义更新、能力覆盖与不支持的交互面。

### 4.3 需要隔离时，再把同一 adapter 放进后台桥接插件

进程内原型能减少初期协议工作，但任意第三方插件向 stdout 打印会破坏 TUI。

默认组合应把日志交给文件 / 受控日志通道，工具输出走 DSH 事件，不直接写 tty。若要支持无法约束的插件，或证实同进程后端负载影响输入响应，再把 adapter 放入独立 DSH 进程中的小型 Cordis bridge。

这是自有、版本化的 TUI 协议，不冒充官方 SDK / ACP；需补齐 live stream、cancel、审批 / 问卷、session snapshot 等必要能力。前端独占终端，后端 stdout 只承载协议，stderr 独立记录。仍然不修改 DSH 核心。

### 4.4 状态一致性是流式正确性的基础

- 用 SessionId、Agent 生命周期和 attemptId 标识实时流；revision 是每帧递增的发布版本，index 是 attempt 内的 chunk 位置。不能要求 chunk/end 的 revision 等于 start 的 revision。
- 一个 attempt 更新同一个 live component，不为每个 token 创建组件。
- 持久记录到达后按对应 settlement / seq 合并或替换，不把最终文本再次追加。
- abandoned / retry / cancel 不是成功提交；明确区分尝试性展示与真实会话历史。
- 会话切换后拒绝旧生命周期的迟到增量。
- 历史恢复用 DSH 公开日志 / 投影读取面，按 seq 防重；不要自建第二份对话事实。
- todo、goal 等由 DSH 已有投影提供，界面只展示，不从文字猜测。

取消必须调用 DSH 的 Agent cancel，而不是简单杀整个 runtime。保留 / 清除 queued inbox 的策略也应明确，审批与问卷的拒绝 / 取消必须结算后端请求，不能只是把弹窗隐藏。

## 5. 输入设计：尽量完整兼容 CC 的 readline 行为

### 5.1 目标与基准

**默认开箱即具有尽量完整的 CC/readline 手感，不要求用户配置后才获得基本支持。** 光标移动、词边界、删除、kill ring、yank-pop、撤销、历史搜索、多行、补全、粘贴与上下文优先级都属于输入层，而不是后续可选增强。

基准优先级：

1. 用户实际使用的 CC 版本与对应模式的可观察行为。
2. CC 官方文档，用来确认命令、平台差异和行为约定。
3. GNU Readline / Emacs 命令族，用来审计遗漏、补齐 CC 没有明确说明但不冲突的能力。
4. Pi 默认实现仅为复用起点，不是验收标准。

实施行为对照时记录 CC 版本、终端、平台和渲染模式；官方滚动文档不能替代实际版本基准。对每个命令记录 `匹配 / 有差异 / 未核验 / CC 应用级覆盖 / 终端无法区分`，不把“按键触发了某个动作”当成已经兼容。

目标是完整审计并覆盖 CC 支持的 readline 命令，而不是仅选择几个常用键。GNU Readline 中更多命令也进入审计清单，但不能假定 CC 支持全部 GNU 命令；CC 明确改作应用操作的键，默认跟随 CC。

### 5.2 命令族与行为覆盖

下表是拟议覆盖与验收清单，不代表新 TUI 已经实现，也不把所有平台别名当成已实测的 CC 默认值。

| 命令族 | 键 / 行为覆盖 | 必须验收的语义 |
| --- | --- | --- |
| 行与字符移动 | Ctrl+A/E/B/F、Left/Right、Home/End | Ctrl+A/E 对齐当前逻辑行首尾；字符移动不切断 emoji / 组合字符；软换行与真正换行分开处理 |
| 上下行与历史 | Ctrl+P/N、Up/Down | 先在视觉行内移动，到边界浏览历史；没有 Pi 额外的“先跳行首”步骤；保留草稿、光标与粘贴内容 |
| 词移动 | Alt+B/F，核验 Alt / Ctrl+Left/Right 的平台别名 | 区分字母数字、标点、路径、flag 与中文 / 日文词边界；跳过分隔符的方式也应匹配 |
| 字符删除 | Backspace、Delete、Ctrl+H、Ctrl+D | 向前 / 向后删完整字符；行边界合并；Ctrl+D 在非空输入与空输入时的行为不同 |
| 词删除 | Ctrl+W、Alt+D、Option+Delete / Ctrl+Backspace 等平台别名 | Ctrl+W 按空白边界删除整条路径或 flag；普通词删除按标点 / 分词边界，不能共享一套错误策略 |
| 行删除与 kill | Ctrl+U/K | 保留删除内容；行首 / 行尾、空行与跨行重复操作正确；不能只用 setText 模拟 |
| yank 与 kill ring | Ctrl+Y、Alt+Y | 连续 kill 的累积方向、kill 与普通删除的区别、yank-pop 只在合法时机生效、环内轮换与多行内容正确 |
| 撤销 | Ctrl+_ / Ctrl+Shift+-，核验终端编码别名 | 不仅还原字符串，也还原光标和粘贴标记；连续输入、kill、yank-pop、整块粘贴的撤销粒度匹配 |
| 历史搜索 | Ctrl+R、重复搜索、编辑查询、接受 / 执行 / 取消 | 匹配查询高亮、遍历方向和草稿恢复；主屏与全屏按所选 CC 基准处理 Enter / Tab / Esc / Ctrl+C，不能用普通列表冒充完整搜索 |
| 多行与提交 | Enter、Ctrl+J、Shift+Enter、Alt+Enter、反斜杠 + Enter fallback | 明确提交与换行；兼容软换行、长输入、行首尾、补全开启和流式运行状态 |
| 补全 | Tab、候选选择、Ctrl+P/N、关闭与继续编辑 | 候选列表拥有导航键；不能穿透到历史或模型切换；接受候选与提交草稿分开 |
| 粘贴 | bracketed paste、Ctrl+V 的 CC 语义、平台剪贴板别名 | 原子粘贴、碎片化协议、多行 / 大文本标记、图片附件路由；粘贴内容不能被当成快捷键或 chord 执行 |
| 编辑辅助 | Ctrl+L、Ctrl+G / Ctrl+X Ctrl+E、Ctrl+S、Ctrl+Z | 重绘保留草稿；外部编辑器返回后状态恢复；stash / restore；Unix 挂起恢复；按 CC 区分应用操作与编辑操作 |
| 组合键 | CC 支持的 Ctrl+X 前缀序列与用户自定义 chord | 前缀等待、超时、取消、焦点切换、失败后按键处理与组合键提示，不能只有单次 modifier+key 匹配 |

补充审计 GNU 命令族：transpose、大小写转换、quoted insert、跨整个输入移动、正向搜索、数字参数、其他 kill / history 命令。逐项核验 CC 是否支持或覆盖其默认键；没有依据的项不宣称已匹配。无冲突且确有用途的补齐动作可以提供可配置绑定，但不擅自改变 CC 默认键位。

**必须保留的 CC 应用级取舍：**

- Ctrl+T 默认是 todo，而不是传统 transpose-char。
- Ctrl+O 默认展开工具 / transcript，而不是传统 accept-line-and-down-history。
- Ctrl+V 默认按 CC 处理剪贴板 / 图片，而不是强制 quoted-insert。
- Ctrl+S 默认按 CC 处理草稿暂存；历史搜索内按对应 CC 模式处理，不能被 tty flow control 吞掉。
- Alt+P 选择模型，不能占 Ctrl+P；Shift+Tab 只调用 DSH 原生 `/permission` 切换权限预设。原生 `/plan` 是独立的规划引导/评审流程，不与权限混为一个 mode，也不复用为 Pi thinking level。
- Esc / Ctrl+C / Ctrl+D 按当前上下文处理拒绝、取消、清草稿、中断和退出，不能统一变成 kill process。

### 5.3 上下文与配置

同一套基础编辑规则用于主输入、问卷自定义答案、设置值、对话框输入；历史、提交、补全与取消等动作则按上下文分派，不让每个组件各自硬编码一套键位。

1. 可打印文字在文本字段中优先作为输入；列表的 j/k、数字选择等不能吞掉字段里的文字。
2. 补全打开时 Ctrl+P/N 导航补全；普通列表导航列表；多行文本字段内移动文本。不穿透触发模型切换或全局面板。
3. 已开始的 chord、终端回复与 bracketed paste 有独立解析状态；焦点变化时按既定规则取消或继续，不能造成粘贴误提交。
4. 审批 / 问卷的取消必须结算后端请求；历史搜索取消必须恢复原草稿；外部编辑器与挂起恢复不能丢 undo 或光标状态。
5. 所有支持的编辑动作都具名并可配置，而不仅是应用快捷键。支持多个键、禁用、用户覆盖、上下文冲突报告、热更新及 Settings 内的轻量分组快捷键编辑器；不独立暴露 `/hotkeys`。
6. 无效配置不能静默变成默认配置；未知动作和不可用绑定可见，避免用户以为已经生效。
7. 新 TUI 配置独立于 Pi / CC。显式导入用户已有 `tui.*` 绑定可以作为迁移能力，但不能盲目照搬 Pi 应用动作。
8. legacy terminal 的 Ctrl+I / Tab、Ctrl+M / Enter、Ctrl+[ / Esc，以及 Ctrl+H / Backspace 等字节等价或平台差异要按实际协议处理；不伪造终端无法提供的区分。macOS Option-as-Meta、tmux / screen 前缀冲突及 SSH 分片需要覆盖。

### 5.4 Pi 的复用边界与测试方法

复用 Pi 的输入协议、宽度 / 分词工具、Editor 状态、kill ring、undo、粘贴及光标基础设施，不启动第二个 Node readline / raw stdin 消费者。

**不接受“Pi 的 private 方法不方便，所以退回 Pi 行为”。** 如果公共扩展点不能正确实现 CC 策略，维护范围明确、版本锁定的 Editor 小补丁 / 薄 fork；保留单一编辑状态与现有 undo / kill / paste 机制，不在外围用反复 setText 拼出第二个编辑器。

测试以按键序列和状态变化为单位：`初始文本 + 光标 + 历史 / kill ring + 焦点 → 按键序列 → 文本 + 光标 + undo / paste 状态 + 应用动作`。例如 Ctrl+W 后紧跟 Ctrl+Y / undo、多行 Ctrl+P 后取消历史、yank-pop 后继续输入再撤销，都应与所选 CC 基准对照。

完整命令覆盖矩阵与差异清单属于首版交付物。M0 先验收编辑语义和上下文路由；依赖 DSH / 剪贴板 / 外部编辑器的动作还需在对应接入阶段验收真实效果，不能只测路由就宣称功能完成。

模式与权限的具体名字、工具允许范围和安全效果沿用 DSH。界面不能仅改一个标签就宣称具有 CC 的权限语义。

## 6. 渲染设计：先复用，后按证据优化

### 6.1 主屏与全屏

- 主屏适合 CC 传统体验、终端原生 scrollback 和复制。
- 全屏适合固定输入区、应用控制滚动、搜索及以后加入侧栏。
- 两者共用 Pi TUI 公共组件和业务状态，不维护两套底层渲染器。

样机阶段同时回放两种 renderer。默认优先尝试主屏；如果业务要求持续更新视口上方内容，则选择全屏，或为主屏提供明确的 freeze / redraw 策略。不能同时保证“已经进入终端 scrollback 的旧行实时修改”和“永远不重绘历史”。

### 6.2 热路径规则

- 消费每个业务事件，但合并绘制请求；不丢事实，可以跳过过期中间画面。
- 默认使用 Pi 的 16ms 合并器，不再套一层独立 FPS 定时器。
- 稳定消息保留 component 实例，按内容 / 宽度 / 主题缓存；增量只 invalidate 活动块。
- 普通增量只 `requestRender()`；不要每 token `requestRender(true)`。
- 先用原生 Markdown 建立基线，不一开始再写 Markdown parser。
- 活动消息变大后，按性能数据决定是否分块缓存；Markdown reference definition 等全局语义必须正确失效，不能盲目宣称每个已结束段落永远不变。
- 大代码高亮、Mermaid / 数学图像优先在完成后处理；不在逐 token 热路径启动高亮 CLI 或重新生成图像。
- Thinking 与工具卡折叠时机稳定；持续动画留在当前可见工作区，不让旧回合标题不停变化。
- 组件每行必须不超过给定显示宽度；复用 Pi 的 ANSI / CJK / emoji 宽度和切片工具。
- stdout 只属于渲染器；模型、工具、日志和调试输出不能绕过它。
- 正常退出、异常、取消和挂起恢复都处理 raw mode、光标、鼠标、图像和 alternate-screen 生命周期。

Pi 的公共组件是起点，不是流畅性的保证。所有优化必须能在同一条录制事件流中证明收益，避免把随机网络 token 到达速度当成 renderer 性能。

## 7. 复用与不复用清单

| 来源 | 复用 | 不照搬 |
| --- | --- | --- |
| Pi TUI | terminal、renderers、Editor、列表、Markdown、宽度、焦点、输入协议 | Pi AgentSession / SessionManager；私有渲染状态补丁 |
| pi-cc-extensions | 展示规则、diff 算法 / 布局、主题、摘要、footer 设计 | prototype patch、write override、Pi 生命周期接线 |
| dsh-tui | DSH 接入经验、事件投影、审批 / 问卷处理经验、录制 / 回归场景 | React / Ink / Yoga 渲染链与全部旧版本兼容层 |
| agent_tui | 自有 UI 原型、键位组织、通用问卷 / 设置组件与测试思路 | Pi RPC 协议形状、专用 extension walker、Pi 会话事实 |
| CC | 官方交互行为和上下文优先级 | 未核验的内部实现、专有源码或品牌资产 |

## 8. 分阶段实施与验收

### M0：输入与渲染样机，先回答“是否真的更顺手、更稳定”

交付：

- 锁定 Pi TUI / DSH 版本，建立最小应用与 mock backend。
- 完整 CC/readline 命令覆盖审计，不只验证 Ctrl+P/N；明确已匹配、差异、未核验及 CC 覆盖的命令。
- 验收移动 / 删除 / kill ring / yank-pop / undo / 历史搜索 / 多行 / 补全 / 粘贴 / chord 的按键序列、状态和上下文路由。
- 同一录制流在 main / alt 两种模式回放。
- 对 Rex 的同步输出路径做单独诊断，保留原始 ANSI 与终端画面证据。
- 明确最小 Pi TUI 编辑补丁范围，不 fork 整个 Pi。

门槛：输入层按完整 CC/readline 覆盖矩阵逐项验收，不能把“只绑定了几个常用键”描述成兼容完成；未达标或未核验项必须明确列出。连续流式输出没有错行、重复行、旧会话残留。输入手感和流式正确性都是首版核心，不用高级功能掩盖这两项的缺口。

### M1：DSH 实时接入与安全闭环

交付：

- 新建 / 恢复一个 DSH 会话。
- text / reasoning / tool 生命周期的真实实时更新。
- live attempt 与持久 settlement 合并正确。
- 中断、重试、后端异常、退出恢复。
- 审批与 ask-user 问卷能正常结算，默认不自动放宽权限。
- 如果同进程 stdout 或后端负载不能被可靠约束，完成最小进程隔离 bridge 再作为可用版本交付。

门槛：不能只有“正常回答成功”路径；取消、失败、拒绝、过期请求和恢复都必须通过。

### M2：完成日常编码体验

交付：

- CC 风格工具卡、正确来源的 edit / write diff、折叠 / 展开。
- 在 M0 已验收的历史搜索 / 草稿 / 外部编辑器语义上完成真实接入，补齐项目级历史及持久化。
- `/model`、`/resume`、`/compact`、`/settings`；快捷键查看/编辑收进 Settings，不增加独立 `/hotkeys` 命令或冗余配置层级。
- DSH 原生 `/permission` 与 `/plan` 的独立入口，queue / steer 的明确行为；不新增通用 `/mode` 或 Plan 权限预设。
- 主题、footer、回合摘要、配置热更新。

### M3：按需求扩展，不挤进首版

- 侧栏、subagent panes、任务 / goal / todo 视图。
- 图片附件与终端预览。
- 更丰富的 session tree、fork / rewind。
- 扩展 renderer registry。
- 更多 DSH 版本或其他后端；没有实际需求前不做万能 backend framework。

### 验收矩阵

**输入**：主输入、wrapped / multiline、补全、搜索、审批、问卷选项 / 文本、设置页；legacy / Kitty 扩展键；碎片化 bracketed paste；中文 IME 焦点；kill ring / undo / paste marker。

**显示**：40 / 80 / 120 / 160 列；24 / 40 行；中文、emoji、组合字符、OSC 8 链接、超长代码 / shell 输出；未闭合 fence / 列表 / 表格 / 链接；resize；main / alt。

**事件**：成功、error、aborted、abandoned、retry；并行工具 call-ID；会话切换迟到增量；最终记录与实时帧去重；恢复后内容与真实日志一致；审批拒绝 / 超时 / 取消。

**性能指标是拟议目标，不是本次测量结果**：

- 正常负载下单帧计算 p95 不超过一个 16ms 帧预算。
- 真实终端里输入到可见光标 / 文本更新的 p95 争取 <50ms。
- 固定宽度的正常流式场景没有连续清屏重绘。
- 跟踪全量重绘次数、每帧写字节、词法分析 / 高亮耗时、事件积压、CPU 与内存。
- 长时间回放没有无界缓存增长；真实终端测试与 headless VT 断言都需要，后者不能替代流畅性和 IME 检验。

## 9. 许可与维护

核验的 DSH、dsh-tui、Pi TUI 和 pi-cc-extensions 包均声明 MIT。提取代码保留对应 LICENSE 与版权声明。CC 扩展的 rich diff 另有 `pi-tool-display` 的 Attribution，必须一起保留：

`CC_EXT/extensions/renderer/tool/diff/ATTRIBUTION.md`

版本锁定优先于 `*` peer 范围。每次升级 Pi TUI 跑编辑语义与 ANSI 回放；每次升级 DSH 跑 runtime / session / approval 契约。对小补丁记录 upstream base、目的、行为取舍与退出条件。

## 10. 官方参考

- Pi TUI：<https://github.com/earendil-works/pi/tree/main/packages/tui>
- Pi：<https://github.com/earendil-works/pi>
- DSH：<https://github.com/deepseek-ai/deepseek-harness>
- dsh-tui：<https://github.com/ccch1mneyyy/dsh-TUI>
- pi-cc-extensions：<https://github.com/minuque/pi-cc-extensions>
- CC 交互行为：<https://code.claude.com/docs/en/interactive-mode>
- CC 可配置键位与上下文：<https://code.claude.com/docs/en/keybindings>

**建议下一步：只做 M0 + 最窄的 DSH live-stream 接入 spike。先验证输入语义和真实流式渲染，再决定是否需要 Pi TUI 小补丁与后端进程隔离。**
