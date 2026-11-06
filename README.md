# DSH TUI · v0.1.2

**DeepSeek Harness 的原生同进程终端应用插件。** Agent、模型、认证、工具、权限、preset、会话与持久化全部归 DSH；本仓库提供 CC 风格终端界面，并 vendored Pi TUI 作为终端/输入组件。它不是另一个 Harness，也不是独立后端。

当前发布版本为 **v0.1.2**（`private: true`），新增原生 Subagent 目录／子会话／Stop/Reply，以及编辑框上方的 Pi 风格进度和名字限定内部链接；保留 v0.1.1 的原生插件化、诊断隔离与 compaction 修复。本次按用户授权通过 GitHub `main` 与 `v0.1.2` tag 发布，不发布 registry。当前工程验收见 [验收记录](docs/ACCEPTANCE.md)；历史阶段记录只作对照，不代表当前健康状态。

## 安装与启动（当前本机边界）

需要 Node >= 24.9 与 DSH `0.2.2-rc.1`（与原生 DSH 的最低 Node 要求一致）。插件装载的是编译后的 `lib/*.js`，构建产物（`lib/`、`vendor/pi-tui/dist/`）不提交到仓库，首次使用或有源码变更后需要先构建：

```bash
cd /Users/fulei/workspace/dsh-tui
pnpm install --ignore-scripts
pnpm build          # 先构建 vendor/pi-tui，再把 src 编译到 lib
```

构建后日常直接启动，**不需要先手动挂载，也不需要 screen 参数**：

```bash
dsh-tui
```

- **首次安全自动挂载。** 入口从将要执行的 DSH 安装加载公开 package/profile API；缺少本应用时，通过 DSH 原生 package operation 把当前已构建包以 `link:` 加入默认 `dsh-tui` profile。后续已挂载时不重复安装。首次出现一行挂载提示；包操作有取消、静默和总时限，失败明确退出，不再留一个没有界面的后台 profile。
- **只处理本应用。** 本项目同一路径的旧名称依赖由原生包管理先安装新身份，再移除旧别名；失败不会先删掉原应用。其他插件、模型、凭据和用户 patch 不迁移、不重建。另一个来源占用同名包、明确禁用本 bundle，或 profile 已选择其他已知前端时，会报错而非擅自替换。
- **默认 fullscreen。** 要主屏/终端 scrollback 才用 `dsh-tui --inline`。显式保存的 screen 偏好仍然生效，`--inline`/`--fullscreen` 可覆盖它。
- **原生同进程入口。** 本机 `/opt/homebrew/bin/dsh-tui` 软链仍指向项目 `bin`，不需要更换全局可执行文件。包检查/挂载完成后别名委托 native `dsh`，并通过一层原生 startup assertion 验证终端真的激活；不是私有 backend、profile 镜像或第二套启动树。
- **其他 profile。** `dsh-tui --profile <name>` 对指定 profile 做相同安全检查；不会自动关闭它原有的前端。`--dsh` 指向原生 DSH launcher，不能是无法定位公开 SDK 的任意 shell wrapper。
- **仍可手动用 DSH 管理。** `dsh plugin --profile dsh-tui add /Users/fulei/workspace/dsh-tui` 是可选的显式安装方式。之后也可直接 `dsh --profile dsh-tui`；原生 `dsh` 本身不会替一个尚未包含本插件的 profile 做 TUI 的自动挂载。
- 通过 native DSH 启动时，应用版本参数要越过 launcher 边界：`dsh --profile dsh-tui -- --version`。裸 `--version` 属于 DSH 启动器。直接运行别名时 `dsh-tui --version` 由别名自身处理。
- `dsh-tui` 在 POSIX 上用 `process.execve` 把自己替换成 native `dsh`：TUI 与 DSH 处于同一进程，没有前端/后端 IPC 或 supervisor。没有 `execve` 的平台只做整应用委托（spawn native dsh），不保留 TUI 壳层。

### 离线 demo（不需要 DSH）

```bash
dsh-tui --demo                 # 默认 fullscreen + tools 场景
dsh-tui --demo tools-group     # 连续工具分组、I/O 详情与独立 Diff
dsh-tui --demo images          # 用户/assistant/工具图片与重复附件
dsh-tui --demo subagent        # 编辑框上方进度、子会话与原生 Reply/Stop 的离线 fixture
```

demo 始终是离线 fixture，不加载 DSH、不读 profile、不调用模型、不执行真实工具。它不会在真实连接失败时自动启用。

## 原生同进程边界

启动与组合归 DSH，本插件只做终端界面和窄适配：

- **生命周期**：startup 插件负责 native 命令行解析与选项服务，主插件通过 native `appReady` 启动。卸载时 `ctx.effect` 先**同步**恢复终端，再异步关闭 App 与 backend；`appExit` 属于 DSH，本插件不调用 `process.exit`，也不 dispose 宿主 root。
- **没有第二套 Harness**：不存在 bridge/protocol/discover/runtime-home/native-profile，不存在 scratch home、profile 镜像、YAML 合并器、第二个 Agent loop、调度器或前端/后端 IPC。`src/backend/context.ts` 只是同进程薄适配，直接使用宿主 Cordis context 的公开服务。
- **preset**：从宿主 `profileContext.installAnchor`（嵌入宿主可用公开 `pluginPackages` lookup）解析 DSH 公开 resource 和原生 `AgentPreset` 类，用 native `loadOverlayPatches` / `composeEntries` 组合；不从本包目录找可选 peer、不挂 Web 前端，也不复制工具清单、权限规则或 plan 语义。
- **模型目录**：`ctx.llm.listProviders()` / `listModels()` / `resolveModelInfo()` 加 native `agentDefaultModel` 的只读投影（`src/backend/model-view.ts`）；不挂完整 SessionController，不导入 Pi 目录/凭据，不维护第二套默认策略。
- **默认保存**：模型/effort 的落盘由真实 native ConfigEditor 负责。适配器无法从 getter 证明已落盘，因此正常确认返回 `defaultsPersisted:false` / `defaultPersistence:'native'`；正常成功只更新底栏，不向对话区追加确认，失效/未知警告仍然可见。
- **工具**：优先消费原生 `presentCall/presentResult`；模型提出调用不等于已执行，没有结果不冒充成功/失败。命令执行、校验与审计由 DSH 拥有。
- **流式与会话**：真实订阅 `agent/assistant-stream`、`session/event`、`agent/status`、`agent/error`；保留原生 `surfaceOp` / `sourceEventSeqs`，模型上下文裁剪不覆盖人类历史。普通启动不创建 Agent，首次真正发送或需要会话的命令才物化；`--resume` / `-r` 显式恢复。
- **附件与图片**：`ctx.attachments` 原生准入与按引用读取；同进程没有 8 MiB IPC 帧或 6 MiB 图像传输上限，图像仍受 DSH 存储/准入限制和本层显示/编辑内存预算约束。模型 vision 准入仍归 DSH。
- **诊断**：TUI 生命周期内的原生 JS `console.*`/stdout/stderr 写入通过独立受控日志通道；Pi renderer/protocol 用专用原始终端 writer，目录刷新成功不会进入编辑框/对话。日志脱敏、限长与轮换；警告通过现有 notice 去重限流，致命错误先恢复终端再保留原生错误输出/退出。不改 provider 刷新、会话/工具/图片事实。原生 addon、子进程直接 fd 或 `/dev/tty` 写入不属于这个 JS 层隔离范围。

## 当前能力

- CC 风格主输入、历史搜索、kill/yank、undo、原子大段粘贴、外部编辑器、Unix 挂起恢复；一套可热更新的键位设置。
- inline / fullscreen 两种 Pi renderer；工具卡、Markdown、原生 Diff、连续工具分组、Input/Output 预览与只读 Inspector；思考折叠摘要。
- 真实模型流式上屏与结算、排队/steering、取消、权限预设、审批与问题；`/model` 模型选择器（搜索、provider 分组、effort 保留）。
- 原生 preset 选择、原生命令透传、会话新建/恢复与启动会话选择器；`/reload` 走 native HMR 配置重组合。
- 图片：`[Image #N]` 原子附件输入、显式只读查看器、用户/assistant/工具/历史图片保序投影；`history.json` 只存文字，不写 base64；队列图片 refs 需要显式 Up 取回重试，不新增调度器。
- Subagents：编辑框上方的 Pi 风格紧凑进度树；点击 agent 直接查看子会话，另有完整 Agents 树、原生 Stop/Reply 与子审批来源。
- 状态栏：原生 usage/sessionStats 投影、上下文占用、缓存命中、速率/TTFT、cwd 与 git 只读状态。
- 品牌蓝主题与静态字符块 DeepSeek logo；无启动动画、无原生图片 logo。

## 常用键

| 键 | 行为 |
| --- | --- |
| Enter | 空闲发送，工作中排队；补全打开时先接受候选 |
| Shift+Enter / Alt+Enter / Ctrl+J | 换行 |
| Ctrl+P / Ctrl+N | 视觉行导航，到边界浏览历史；列表导航；空输入可取回排队文本 |
| Ctrl+A / E / B / F | 当前逻辑行首尾 / 字符左右 |
| Alt+B / F / D | 普通词移动 / 删除，标点与中文分词 |
| Ctrl+W | 删到前一空白，路径 / flag 一次删完 |
| Ctrl+Backspace / Alt+Backspace | 普通词删除，与 Ctrl+W 分开 |
| Ctrl+U / K / Y、Alt+Y | 行 kill / yank / yank-pop |
| Ctrl+_ / Ctrl+Shift+- | 撤销 |
| Ctrl+R | 历史搜索；Tab/Esc 放回编辑，Enter 发送，Ctrl+C 取消 |
| Ctrl+S | 暂存 / 恢复完整草稿 |
| Ctrl+C | 全局中断前台操作（包括审批/问题中）；空闲有草稿时先清空并保存，再按一次退出 |
| Esc | 关闭局部面板；审批中拒绝该工具；问题中取消该问题。回合进行中或已有排队消息时，不发送当前草稿，把队列发出去。空闲且没有队列时，非空草稿双 Esc 清空 |
| Ctrl+D | 有文本删字符，空输入重复确认退出 |
| Ctrl+L | 重绘，保留草稿和会话 |
| Ctrl+G / Ctrl+X Ctrl+E | 外部编辑器（VISUAL / EDITOR / nano） |
| Ctrl+O | 全局工具折叠 / 展开 |
| Ctrl+X Ctrl+O | 工具 Inspector；`[` / `]` 或 Alt+Left/Right 浏览调用，Tab 切 Input/Output，c 复制 |
| Alt+P | 模型选择 |
| Shift+Tab | 循环 DSH 暴露的权限预设（执行原生 `/permission`，不切换 plan） |
| Ctrl+Enter | 根会话：取消当前回合并立刻发送草稿；空输入发送队列第一条。其余排队消息留在 inbox；child reply 中明确拒绝该根语义 |
| Ctrl+X Ctrl+S | 把草稿插进当前回合的下一步（DSH steer） |
| Ctrl+X Enter | 明确排到下一回合 |
| Ctrl+Z | Unix 挂起，`fg` 恢复 |
| Ctrl+V | 原生剪贴板图片附件；无图片时回退为文本（Windows/WSL 另有 Alt+V） |
| Ctrl+X Ctrl+I | 查看当前草稿或会话图片；`[`/`]` 或 Alt+Left/Right 切换，Esc 关闭 |
| Ctrl+X Ctrl+A | 打开 Agents 树；Enter 查看子会话，R 回复 continuable child，S 停止活动 child |

回合进行中按 Enter 把消息排进 DSH inbox。排队的消息列在输入框上方，每一行可以 Send now、Edit 或 Cancel。Up 在空输入框仍把可收回的消息取回同一个草稿。Ctrl+C 只中断当前回合，队列留在原地，不会自动接着发。

Subagent 进度紧贴编辑框上方：蓝色 `● Agents` 标题、树形 agent 摘要和下一行原生当前活动。fullscreen 仅点击蓝色、加粗、带下划线的 agent 名字进入对应子会话，Esc 返回原编辑框并保留草稿／图片；`Agents`／`+N more` 文字打开完整树。状态、指标、模型、活动和空白不触发跳转，保留正常拖选／复制；External 不显示伪链接。这些是 TUI 内部导航，不生成外部 URL。inline 保留相同进度样式，通过 `Ctrl+X Ctrl+A` 查看。活跃 child 与回复目标优先显示，终端变矮或输入变高时缩减为摘要／标题；没有 child 时不占行。

macOS Option/Alt 快捷键需要终端发送 Meta；无法区分的控制字节会标记诊断，不伪造支持。完整动作与兼容说明见 [输入说明](docs/INPUT.md)。

## 命令与设置

`/help`、`/settings`、`/model [provider/model]`、`/effort [id|status]`、`/preset [id|status]`、`/resume [id]`、`/new`、`/reload`、`/exit` 属于界面或原生控制服务；`/compact`、`/permission`、`/plan`、`/goal`、`/feedback` 等以当前 DSH 命令注册表为准，原样转交并保留原生校验、审计与结果。快捷键入口在 `/settings`，不另设 `/hotkeys`。

- **`/compact`**：摘要目标仍是最近一次实际路由时，原生插件接缝继承该请求的显式 reasoning effort；不同摘要模型不串用 effort，没有历史 effort 时保留 DSH 默认。消息、工具和输出预算不变。若压缩失败，界面在原生提示的下一行显示按 command/session 关联、脱敏且限长的 `Native cause`，不再只剩笼统错误。
- **Subagents**：编辑框上方默认显示 Pi 风格进度树，使用原生状态、当前活动与可用的 child session 累计指标，不照搬 Pi 的 turn/tool/context 计数。fullscreen 仅点击进度中的 agent 名字链接直接查看子会话，Esc 返回原 Editor；仅 `Agents`／`+N more` 文字打开完整树。其余进度文本可选字复制但不跳转，External 名字不是链接。主对话仍保留每个 direct child 一条不可展开的原生事实行；`Ctrl+X Ctrl+A` 打开 Agents 树，Enter/点击查看子会话，Esc 返回。R 把同一个主 Editor 切到 continuable child 回复目标，S 停止 running/initializing child，两种操作也有可点击 chips；Ctrl+C 在活动 child/回复目标上只中断该 child。回复支持原生 queue/steer 与文本/图片，accepted receipt 不冒充执行完成；失败保留草稿。子审批／问题带来源标签，子 transcript 使用独立 store，不会混入父会话。token/timing 是 child session 累计值，不冒充 per-run 统计。快捷键可在 `/settings` 修改，详见 [Subagents](docs/SUBAGENTS.md)。可运行 `dsh-tui --demo subagent` 查看离线示例。

- **`/model` / Alt+P**：按原生 provider 分组；输入文字过滤模型 ID/名称/描述，切换 provider 保留查询；Enter 明确选择，Esc 关闭。字母/数字是查询文本，不是快捷键。搜索框复用同一个 `CcEditor`。
- **`/effort`**：来自目标模型的原生 `resolveModelInfo().reasoning`；`default` 清除显式等级，回到模型/适配器默认。模型选择后只携带目标仍声明支持的显式等级，不把目标默认值提升为显式设置。
- **`/preset`**：原生 Agent preset 名册；空白会话可原地切换，已开始的会话保留给下一次 `/new`，底栏用 `next preset` 区分。
- **正常成功不刷对话区**：模型、effort、权限和 preset 的成功切换只更新底栏（自动标题显示在 Settings）；失败、保存异常和原生警告仍可见。`/preset status`、`/effort status`、裸 `/permission` 不回显状态列表，当前值看底栏。
- **取消与排队**：中断调用原生 `Agent.cancel({kind:'user'}, {keepInbox:true})`；草稿与两个 inbox 队列保留，取消本身不主动续发。空输入 Up/Ctrl+P 取回可编辑的人类文本；后台任务唤醒仍归 DSH。已完成工具副作用不回滚。
- **审批与问题**：问题中 Esc 以原生 `{cancelled:true}` 结算；Ctrl+C 中止整个回合；审批 Esc 返回原生 `rejected`，与回合 abort 的 `cancelled` 区分。
- **`/reload`**：空闲且无待决策时，先做本层 idle 检查，再调用 `hmr.runExclusive(() => hmr.reconcileProfile())`。当前 Agent、会话、transcript、草稿和缓存不重建；结果与 restart/pending 提示来自 DSH。忙碌、保留队列或待决策时拒绝。普通配置与插件启停由 DSH 原生重组；需要重启的情况以原生结果为准。直接重载前端插件会卸载/重建界面，不自动恢复最近会话。
- **`/settings`**：General / Thinking / Tools 三个 tab，加 Keyboard shortcuts 分组编辑。Tools 统一管理分组、默认展开、预览行数、摘要长度与 Diff 布局；设置写同一个 `settings.json`，不增加 profile/覆盖层级。
- **`/resume`**：启动参数 `--resume <id>` / `-r <id>`，或 `-r` 不带 id 打开当前目录会话选择器（Tab 切当前目录/全部，模糊搜索，Esc 保留新会话）；不自动选择最近会话。重复恢复当前 id 按 DSH 原生语义保留已有 Agent/attachment，不取消流式、队列或待决策；切换其他 id 先准备成功再释放旧连接，失败仍可继续使用当前会话。
- **状态栏**：第一行模型、effort、状态、preset、上下文占用、缓存命中、速率/TTFT 与瞬态提示；第二行 cwd、git 分支/状态、权限值。usage/sessionStats 来自原生投影，git 只读本地轮询，绝不 fetch/写索引。

## 偏好文件

界面偏好、键位与输入 recall 默认在 `~/.dsh-tui/`（`--config-dir` 优先，其次 `DSH_TUI_CONFIG_DIR`）：

```text
~/.dsh-tui/
├── settings.json      # 显示、思考、Tools 预览/Diff、自动标题偏好
├── keybindings.json   # 自定义快捷键；保存覆盖时才创建
├── history.json       # 按工作目录保存的文字 recall，不含图片 bytes/base64
└── logs/
    ├── terminal-diagnostics.log    # 0600、限长、脱敏的原生运行诊断
    └── terminal-diagnostics.log.1  # 至多一个轮换副本
```

这里不读取 Pi / CC 配置；模型、认证、权限、会话和插件组合仍使用 DSH 原生 profile/home。`--models-file` 已移除并明确失败，Pi 的 `models.json`/`auth.json` 永不被读取。

## 构建与验证

```bash
pnpm build          # vendor/pi-tui 先构建，再 src -> lib
pnpm typecheck
pnpm test
pnpm check          # build + typecheck + test
```

- 离线测试使用临时 home/workspace 与 fake Cordis 宿主；不读真实 profile、凭据、会话日志，也不访问真实 provider。
- 覆盖同进程原生流式/结算、模型选择器（搜索/effort）、权限/取消/ask/approval、HMR 配置重组合，以及原有 UI/input/image 回归。插件化之前的图片/PTY 与旧 CloudAgent 实网数字标为**历史记录**，不构成当前健康证明；本轮原生图片与 PTY 验收单独记录。
- 私有 native PTY（`test/plugin-pty.test.ts`）保留 inline/fullscreen × 正常退出、外部 SIGINT 130、demo 和卸载-重挂载的 8 个 case；`test/plugin-attachment-pty.test.ts` 额外覆盖无参数首启、全新 profile、幂等再启、同源旧名称升级、包操作失败/取消，以及整个前端行被禁用。全部使用临时 profile，要求终端恢复，不发送模型 prompt。当前完整结果见 [验收记录](docs/ACCEPTANCE.md)。
- 真实模型/vision/GPU 像素截图验收**不在本轮**：没有宣称真实 provider 请求、真机像素或真实模型 vision 已通过。
- 可选的手动真实小 prompt（明确 opt-in，不推荐自动运行）：`DSH_TUI_LIVE=1 DSH_TUI_LIVE_PROFILE=dsh-tui node scripts/live-smoke.ts`，会通过原生 CLI 启动完整 TUI。原 `scripts/live-providers-smoke.ts` 已删除。

## 已知边界

- 开发验收没有修改真实 home/profile/global 安装；用户之后运行 `dsh-tui` 时才会按上述规则自动挂载本应用。其他前端清理与凭据配置仍由用户通过 native DSH 明确完成；不会自动迁移凭据、重建 profile，或重写用户 patch 中的旧 row id。
- Pi 式 TUI 扩展热插拔暂未纳入；`/reload` 只做 native HMR 配置重组合，不重载 TUI 核心源码。
- 模型能力、上下文、推理级别与网关参数以 DSH 原生目录为准；TUI 不推断或另存第二份模型定义。默认模型的持久化由宿主 ConfigEditor 负责，本层只能如实报告 `defaultsPersisted:false`。
- 历史恢复有事件数/UTF-8 字节预算，截断会提示；完整持久日志仍在 DSH 数据 home。工具耗时包含审批/策略等待，不另抓取逐行输出；大 Diff 超预算时提示并保留完整 Before/After 源。
- 图片显示转换独立于模型 vision；被拒绝的附件不会绕过 DSH 准入。终端 inline-image 能力由 Pi TUI 公共实现决定，tmux/screen 等未确认环境保守降级文字。
- 主屏在 resize 或视口上方更新时可能全量重绘；全屏可避开原生 scrollback 限制。不要把任何 TUI 写入同一终端的普通日志。
- 已做 ANSI 仿真与真实 PTY 验收，但具体终端的输入法/字体/GPU 手感仍需亲手试用。

## 相关文档

- [输入 API 与限制](docs/INPUT-API.md) · [输入行为](docs/INPUT.md) · [输入生命周期](docs/INPUT-LIFECYCLE.md)
- [Tools 分组、详情与设置](docs/TOOLS.md) · [工具 Diff 归属](docs/TOOLS-DIFF-ATTRIBUTION.md)
- [图片投影、预览、附件输入与边界](docs/IMAGES.md)
- [模型/provider 原生投影](docs/PROVIDERS.md)
- [DSH 同进程集成](docs/BACKEND.md)
- [主题与启动区](docs/THEME.md) · [鼠标抽象](docs/MOUSE.md)
- [总体方案](docs/PROPOSAL.zh-CN.md) · [验收记录](docs/ACCEPTANCE.md)
- [Review 修复与取消最终验收（历史）](docs/REVIEW-ACCEPTANCE-2026-11-03.md)

MIT；来源与许可见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。