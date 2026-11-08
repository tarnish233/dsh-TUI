# 版本记录

## v0.1.4（本地 tag）

按用户确认，将当前已验收改动收录为 **v0.1.4/private**，范围仅为本地版本提交与 annotated `v0.1.4` tag；未推送、未发布 registry 或 GitHub release，不修改全局安装、真实 profile／凭据／会话。

- 原生 Skills：metadata 补全、user-only／命令优先、pending preset scope 与迟到结果隔离；修复 Enter 提交旧前缀，Tab 仍只补全。Skills 加载／注入仍归 DSH。
- 单页设置与弹窗：连续分组、搜索／滚动、Tab／Shift+Tab 导航、按项编辑／恢复默认、统一 overlay 和唯一 Editor；收录队列、工具 Inspector、图片与 Agents 查看优化，以及 legacy autoTitle 静默兼容修复。
- Rex／Ghostty：通用 OSC 7501 根／子状态、原生标题、OSC 7 workspace、焦点安全通知与兼容进度；仅 Rex 采用已获用户同意的 `app=terminal` 分类和原生 `>_` 图标，标题只保留静态 `🐳`，无前置工作帧或标题动画时钟。
- 应用图标：蓝底白色像素鲸鱼 SVG／512px／64px PNG 与可重复生成器；资产不是 Rex 图片上传，不替换其内置资源。
- 版本 metadata、shared VERSION、编译后 CLI 与启动页统一为 **0.1.4**，保持 `private:true`；依赖、lockfile 与 vendored Pi 版本不变。
- 本地版本验收：完整 `pnpm check` **1761/1761**（131 文件，build＋strict TypeScript，0 fail/cancel/skip/todo，tests 345991ms），CLI／启动 identity PTY **6/6**（inline／fullscreen、Kitty／none、正常退出与外部 SIGINT 均恢复终端）。证据 `.cache/release-v0.1.4/`，见 [验收记录](docs/ACCEPTANCE.md)。
- 已知限制保持：用户现场退出卡住未被确证修复；Rex 原自定义标题恢复及 Ghostty GUI／OS 通知弹窗验收未补齐。没有真实 provider 请求。

以下保留打 tag 前的开发阶段记录：其中的版本、未提交状态及测试数字描述当时状态；动态标题方案已被后续静态鲸鱼修正取代，不能作为 v0.1.4 的当前行为。

### 开发阶段：Rex 标题仅保留静态鲸鱼

- 按用户要求移除 `🐳` 前的星号与工作帧，标题现在为 `🐳 <native/fallback title>`。删除标题动画常量、snapshot 时钟字段、App 时钟传入和标题专用 Reduced-motion 分支，而非仅暂停动画。
- 保留 Rex 原生 `>_` 图标与 `app=terminal` 分类、原生状态／通知、DSH 持久化标题与普通 Working／Subagent UI 动画。工作／审批／结算和周期 UI 重绘不再重写标题；只有 native title／workspace 变化更新。
- 验收：build＋strict TypeScript、专项 **111/111**、真实 Rex App 静态标题／状态 **2/2**、CLI/PTY **8/8**、native fixtures **2/2** 通过。本次未重跑全量；上一阶段 **1761/1761** 保留为历史记录，见 [验收](docs/ACCEPTANCE.md)。版本／依赖／用户配置不变，无提交或发布。

### 开发阶段：Rex 原生通用终端图标

- 用户拒绝 Docker 分类后，明确接受 Rex 的通用终端分类。仅 Rex 的 root／child／fatal OSC 7501 记录使用 `app=terminal`；其它终端仍为 `app=dsh-tui`。DSH 本体／进程名／窗口标题／直接通知名不变，没有新的配置、图标上传、Rex 资源替换或生产 CLI 依赖。
- 自有 Node 进程实机 GUI 对照确认：只切 app 字段，同一进程的 sidebar 与 pane-header 从绿色 Node 图标变为内置 `>_`。测试 session 已删除，原可见 tab 已恢复。Terminal status Off／协议不可用时会恢复 Rex 的进程图标策略；这是活动分类选择，不是独立图片替换接口。
- 验收：build＋strict TypeScript＋全量 **1761/1761**（131 文件），专项 **77/77**，真实 App Rex **2/2**、协议 CLI/PTY **8/8**、native fixtures **2/2**。GUI 裁剪证据与当前结果见 [验收](docs/ACCEPTANCE.md)；无真实模型调用、配置／凭据改写、提交／发布或全局替换。

### 开发阶段：Rex 动态标题标记（已由静态鲸鱼取代）

- 按用户选择，Rex 标题采用 `✦ 🐳 <native/fallback title>`；原生 root working 时工作符号在 `⠂/⠐` 间切换，鲸鱼不动。复用 App 原来的 100ms 动画 tick，每十个 tick 切一次，不新增定时器或输入消费者。
- Terminal title Off 不发送，Reduced motion 固定首个工作帧；审批／回答、结算／空闲停止移动，子代理工作不改 root busy。其它终端保持原有标题。
- `app=dsh-tui`、DSH 持久化标题、状态／通知、权限／模型／工具行为不变；帧切换不触发 OSC 7501 heartbeat／通知。这是标题文字，不是把 SVG／PNG 上传到 Rex 的原生图标位。
- 验收：build＋strict TypeScript＋完整 **1759/1759**（131 文件）、专项 **75/75**、真实 Rex 双工作帧／状态 **2/2**、协议 CLI/PTY **8/8** 与 native DSH fixture **2/2**；临时 homes／零真实模型调用。没有提交／发布／改版本、全局替换或用户配置改写，见 [验收](docs/ACCEPTANCE.md)。

### 开发阶段：应用图标资产

- 沿用已确认的 DeepSeek 字符块鲸鱼几何与资产蓝，制作蓝底白色像素鲸鱼圆角图标：自包含 SVG、512px 与 64px 透明 PNG。启动 logo、界面主题与 DSH 行为不变。
- 新增开发期生成器与只读 `--check`，复用现有 Sharp，不新增依赖；资产已被现有 package `files: assets` 包含。图标／启动 logo／主题／终端专项 **62/62** 与 strict TypeScript 通过；本次未重跑全量。
- 明确当前 Rex 没有公开的项目级自定义 SVG／PNG 图标注册接口；保持 `app=dsh-tui`，不伪造 app id、不发明 OSC 图标字段、不替换 Rex 资源或修改用户配置。**资产完成不等于 Rex 原生图标显示已接入。** 见 [说明](docs/APP-ICON.md)。

### 开发阶段：Rex / Ghostty 终端协议适配

基于 Rex 官方协议、Grok Build 1.0.77 打包文档、Claude Code 官方说明、Ghostty 1.4.0 匹配版本源码与独立验收。版本仍 **0.1.3/private**，不提交、推送、发布、替换全局程序或改真实 profile/凭据。

- 复用私有 `#pi-tui` 的单输入链，接入通用 OSC 7501 根/子记录、完整替换、能力子集、长度/UTF-8/id 校验、64 记录有界恢复；无效 id 不回落 root。原生 root 可以完成/空闲而 child 仍工作，不把历史恢复制造成新提醒。
- 新 renderer-owned `TerminalIntegration`：依据 DSH durable turn/end、原生 commandId/kind、待决策和当前 activity map 映射状态；尝试结算、retry、诊断或局部弹窗不冒充完成。真实 native ready 恢复展示，关闭后迟到事件不重放；正常退出不伪装成失败。
- native title 从现有 `sessionProjections.title` baseline/change 只读投影，窗口标题遵循 native label/workspace fallback；OSC 7 独立报告 DSH workspace。没有本地 title generator、provider 开关、profile 镜像或模型调用。
- General 增加 Terminal status / Terminal title / Terminal notifications（Automatic/Off/Always），仍是一张连续设置页和一个稀疏文件。Rex 默认由 Program Activity 决定提醒；Ghostty（或 Rex status-off fallback）需要明确未聚焦证据才请求 OSC 777。通知固定文案，Always 可能重复原生提醒。
- `ProcessTerminal` 持有 focus、title-stack 和 progress 生命周期；协商后停止与 rich status 冲突的 legacy heartbeat，Ghostty 可保留兼容进度。停滞/超长/分片终端回复失败关闭，不当作 Editor 输入；paste/lone-Esc/Alt 语义不被第二读取器抢占。emergency 终止 heartbeat，后续 stop 仅清理输入/raw bookkeeping，不向已归还的终端重写。
- 真实 Rex 两 renderer 验证 root/kinds/独立 child/title/workspace/mode cleanup；协议级 CLI/PTY **8/8**，原生 DSH title/显式 resume/composition 字节不变 **2/2**。Ghostty GUI 取不到有效 owned window，不宣称 GPU 或 OS 通知弹窗验收。当前 Rex 的标题查询/栈不支持，匹配 Ghostty GUI 也忽略标题栈，原自定义标题恢复是明确限制，不改用户配置掩盖。
- 最终完整 `pnpm check` **1744/1744**、130 文件、build＋strict TypeScript，0 fail/cancel/skip/todo；首轮 1731/1731 另保留。复核修复、独立专项 **41/41** 及最终全量期间实际 Rex **2/2**／CLI/PTY **8/8** 复跑见 [验收记录](docs/ACCEPTANCE.md)。用临时 homes/workspaces 与 hermetic stream，没有真实 provider 请求。支持矩阵与手测见 [TERMINALS](docs/TERMINALS.md)，深度对照见 [研究](docs/TERMINAL-RESEARCH.zh-CN.md)。

### 开发阶段：弹窗与设置重设计

按用户确认的 Grok Build / OpenCode 调研方案，统一弹窗交互并补齐近期展示能力的设置入口。生产仍是 native DSH app bundle＋同进程薄适配；应用版本保持 **0.1.3/private**，本轮未 commit／tag／push／publish，也未修改真实 profile／凭据／会话或全局安装。

- 新增共享 `ModalFrame`：统一标题、边框、关闭按钮、实际快捷键提示、操作 chip、可测量 body 与鼠标命中区；正常终端保留少量页边距，极矮终端退化为紧凑标题和可操作 footer。没有新 renderer、backdrop alpha 或竞品运行时。
- 所有 prompt-slot 弹窗改为真正的 `showOverlay`，**唯一主 Editor 保持挂载且草稿／undo／图片 registry 不被复制或清空**；模态拥有输入，关闭后恢复同一 Editor。不再有两套不相干的“替换输入区 vs 浮层”外观。
- Settings 改为可搜索的连续单页：General / Thinking / Tools & Diff / Agents / Images / DSH / Keyboard 是同一页的分组标题，不再使用 tab/segment 栏或分类页面。原有 16 个设置全部保留，布尔、枚举、数字选择与自定义数字编辑分开；每项可恢复默认，保存按确认快照回写，失败只回退该项并在当前窗口可见。`settings.json` 继续是单一扁平文件，新增 `formatVersion` 标记但正常保存只写实际 override，不再把全部默认值展开落盘。
- 新增 6 个纯展示偏好：Agents 上方进度显示、Agents 消息独立分组、图片预览自动／文本、全屏选字自动复制、队列默认折叠、减少动态效果。它们不改变 DSH 工具执行、权限、Skills 注入、Agent 调度、附件存储或模型能力。
- 修复 Agents 消息分组错误复用 `groupTools` 的耦合：新 `groupSubagentMessages` 独立生效；旧配置首次迁移沿用当时 `groupTools` 的值，迁移后恢复默认不再回读 Tools。Ctrl+O 仍只共享临时展开动作，不复制事实。
- Settings 增加只读／导航型 DSH 行：当前 model、effort、preset、permission、Skills 目录、plan 状态，以及“默认值／MCP／凭据由 DSH 管理”的诚实说明。复用已有 picker／command；权限切换增加明确二次确认；不实现对 credential、MCP env/headers 或整个 profile 的通用自动表单。
- Settings → Keyboard → Back 恢复原分类、选中行、查询与滚动；模型／effort／preset／权限等异步选择先在当前窗口显示 loading／错误，不阻塞输入层，迟到结果不能替换新 surface。Auto title 最终改为 DSH 分类只读原生状态，不再保存或应用本地 override。
- Tools Inspector 使用 wide 帧与查找（Input/Output 分别保留查询）、可选调用列表、wrap、真实原生 diff、原始源 copy 和嵌套图片返回；没有从当前文件猜测改动或重跑工具。Image viewer 使用 wide 帧，`auto`／`text` 预览，`p` 可切换；text 模式不发起读取／解码，切换时 abort 旧请求，迟到结果不绘制。
- Agents overlay 增加搜索与 Active/All 过滤、稳定原生 id 选择、`captureView`／`initialState` 返回状态和当前 surface 错误提示；hover／选择不 follow 或 stop。Child viewer 保持只读、显式 loading、原生 Reply/Stop 和返回原 Agents 位置，没有第二 composer／调度器。
- Help 增加按需 `Ctrl+F` 搜索，只读 Skills 可用性／完整性／user-only 语义保留；普通字母、数字、Enter 与点击仍不执行、不填入草稿。Resume、Model、Select、Decision 统一 loading／empty／no-match／error 状态；模型异步目录首次到达时尊重当前 provider，而不是误选名册第一项。
- 新增 Queue 弹窗（`Ctrl+X Ctrl+Q`）：按原生 message id 查看、编辑、Send now、Cancel；图片队列编辑 fail-closed 并提示先用 Up 恢复引用，操作失败显示在当前弹窗，不伪称已移除。没有本地队列、调度器或第二条持久化。
- 新增弹窗导航 actions/contexts（`settingsList`、`keybindingsList`、`modalList`、`queueList`、`modalSearch`）：搜索、分类切换、reset、keyboard edit/disable/reset、scope toggle、Agents 过滤、Tools 查找／调用列表／wrap、队列编辑／取消／立即发送。全部进入同一 Keyboard 列表，可重绑／禁用／恢复默认；没有 `/hotkeys` 或新的 override 层级。
- 审查修复：异步模型目录尊重当前 provider；`/new` 保留 staged preset；`queue-send-now` 在原生 admission 成功后才移除旧项（失败保留原队列）；Queue 弹窗把状态行纳入 measure、窄 QueueList 不溢出且裁掉的 chip 无 hitbox；图片队列行禁止直接 Edit；选择器 press 不再提前移动窗口，首次点击可选中；Settings 粘贴中的 Ctrl+C 不中断回合、物理 Esc 可解锁、短 picker 自动滚到选中项；Keybindings 保存中允许 Esc 返回；Agents 滚轮不再被每帧回弹；Tools 查找字段不再被 browse chord 抢先解析；并补充对应回归。
- 并行优化收口：Settings／Keybindings 共用 `ModalListSurface`/`windowList`，状态行计入测量且超高聚焦行不被回填隐藏；auto-title 删除 Loader mutation 和本地偏好，旧配置仅作 known legacy 清理；Resume 直接保留 `sessionQuery` 原生顺序，不再 stat artifact／按 mtime 重排；启动 Resume 在 connect 前 Esc 仍保留 positional prompt；嵌套 Settings 的 `[×]` 先返回上一级。
- 修复旧 `autoTitle` 兼容告警：启动与 `/reload` 静默忽略已废弃的本地字段，下次正常保存时清理；未知字段与有效设置的格式错误仍报告，启动／reload 不改写文件或 DSH composition。build＋strict TypeScript、相关回归 **103/103** 和两 renderer CLI/PTY **2/2** 通过。
- 用户反馈收口：Tab/Shift+Tab（及 Right/Left）在同一列表跳转分组，Up/Down 跨组逐项移动，跳转不清空搜索或发起 native 调用；保留单项编辑/重置、Keyboard 返回位置。鼠标只锁定目标的 press 不再触发额外重绘，组标题/空白点击不触发动作或重绘；同帧 native 元数据只投影一次。复用既有 paste filter，粘贴中的 Tab/Enter/reset/interrupt 不执行，未完成粘贴不被鼠标改换输入目标。单页 CLI/PTY **2/2**、Keyboard 编辑与 resize **2/2**、取消/终端恢复 **8/8**，原生 DSH 单页 Settings **2/2** 通过（profile 逐字节不变）。
- 验收：完整 `pnpm check` **1646/1646**，121 个测试文件，build＋strict TypeScript，0 fail/cancel/skip/todo；两种 renderer、实际 VT 几何／鼠标／返回状态／异步失败／旧 grouping 迁移／text 预览零读取／精确 Skills Enter 时序均有回归。前一阶段离线 CLI/PTY **23/23**（Tools、Help、Model、Subagent progress/links/retirement、Skills、Images 4、Theme、Thinking 3）证据保留，native model **2/2**、native Skills **2/2**；另有 auto-title native 只读／拒绝开启／provider 保持 disabled／profile 逐字节不变探针。均使用临时 home/workspace＋hermetic stream，无真实 provider 请求。证据见 [验收记录](docs/ACCEPTANCE.md)。

### 开发阶段：原生 Skills 接入

- 修复直接 Enter 选择 slash／skill 时发送旧前缀的问题：在同一个 Editor 先应用选中项，再捕获 `onSubmitContent` payload／snapshot，最后清空并提交。`/skill-stu` 单次 Enter 发送完整 `/skill-studio`；Tab 仍只补全，文件候选 Enter 仍只填草稿。覆盖实际内容消费者、非首项、UI／native 命令、图片／拒绝恢复与非 demo 生产 CLI，不再用 text-only 回调或先 Tab 的测试掩盖该路径。
- `/` 补全增加当前 DSH Agent 范围的用户可调用技能元数据，保留原生 `/name` 文本形式，标注 user-only；不使用 Pi `skill:` 别名，不新增 `/skill`／`/skills` 管理命令或技能目录/正文子系统。Tab 编辑、Enter 提交、文件／参数补全与唯一 Editor 的 undo／图片／草稿语义保留。
- 同名原生命令优先；首次输入通过提交时的 native Agent 范围查询判定，避免 pending 菜单尚未见到 `/plan`／`/compact` 等 scoped 命令时误送模型。技能引用复用原来的文字／图片 queue、steer、send-now 路径，加载与注入仍由 DSH 原生 pre-step 完成。
- 后端 `skills` 只投影原生 registry 的名字／描述／whenToUse／resolved invocation 元数据。**用户反馈后修正桌面对齐**：pending 使用 `agentPresets.acquireScope`，启动即可列目录且不创建 Agent；live 优先 preset registry。移除 `tools.get('skill')` 的人类目录门槛，支持 list-only 元数据（完整性未知），不 `get` 正文／复制 provider 或目录。preset／attachment／reload／close 清理隔离迟到结果与 lease。
- `/help` 始终保留只读 Skills 区，即使能力缺失也显示 unavailable，区分不可读、不完整和真实为空。不可用不再永久缓存；相同前缀可以重试，输入 provider 只做单飞、不永久记忆 query。异步元数据更新不应用／提交文本；Esc、焦点转移、替换 attachment 不能被迟到目录复活。根目录不冒充 child scope。新增非 demo 生产 CLI/PTY 与未发消息／普通消息后直接补全的验收，不用 Help 预热掩盖目录问题。
- 生产仍是 native DSH app bundle＋同进程薄适配；没有新增 Agent loop、目录扫描器、私有进程／IPC、依赖或配置层。应用版本仍为 **0.1.3/private**，此阶段未 commit／tag／push／publish，也未修改真实 profile／凭据／会话或全局安装。验收见 [记录](docs/ACCEPTANCE.md)。

## v0.1.3

按用户明确确认，将已验收的 Subagent 进度、消息分组、名字导航及启动／退场修复发布为 **v0.1.3**。范围为本地 release commit、GitHub `main` 与 annotated `v0.1.3` tag；保持 `private:true`，不发布 registry、不修改全局安装或真实配置／凭据／会话。**退出卡住仍是已知未解决问题**，下面的原生退出测试与故障类型调查不等于已修复用户现场。

- 进度区的 native running／initializing 图标改为 Working 同款 `· / ✻ / ✶ / ✳`，复用 App 原来的 100ms 动画时钟；根会话 ready 时仍转，不改变 root busy／badge、退出确认、native token／time 或模型／工具调度。两行摘要＋活动不变，结算后收起并停止空闲动画。
- 连续 catalog 状态／subagent-settled／agent-message 记录按 Tools 风格分组，复用 `groupTools`、Ctrl+O 和共享临时 disclosure；原生 facts／seq／sender／text 不改、不跨真实 user／assistant／tool／notice 等边界。组标题展开，正文纯选择／复制，不作为折叠或导航区域。
- 把名字-only 链接覆盖到原始 transcript 状态行和两类 durable 消息，不再整行进入 child：仅可见的原生名字为品牌蓝／加粗／下划线，未知 sender 普通 id 不伪造可打开状态。统一最终 clip／Unicode 宽度几何；motion／drag 不抢选择，outside press／消失再出现不能串成旧导航，hover 后首次复制保留。
- 发布前 UI 功能验收 `pnpm check` **1291/1291**（104 files）；新增实际 VT records **15/15**、progress／动画 **25/25**，UI 两类 Subagent 专项 **127/127**。离线 Subagent CLI/PTY **10/10**，含名字消息两类各 5 个非名字位置、同款动态帧、退场、复制、草稿和恢复；完整检查另包含原生 live-child 退出 **6 个场景**。编译归档 **300 entries** 的新 Group／Link／Spinner 模块导入与静态 smoke 通过；没有真实 provider 请求。证据 `.cache/subagent-ui-followup/`。
- 退出问题仅完成调查，未擅改原生退出策略：常规 live-child 原生退出和 native 5s 保底都正常，隔离故障注入证明 App 退出 promise 可能被后续清理挂住，导致尚未请求 native appExit。用户现场具体触发未确证；原生生命周期仍归 DSH，不添加 child drain／私有 supervisor／process.exit。

- 修复首次名字点击要等原生 follow／snapshot 读取完成才出现界面的问题：立即打开现有只读子会话的 `Loading child session…`，再用原生快照和有界实时缓冲更新同一个 view。`initializing` 本来就可打开，不增加 Agent 状态门槛、占位 SessionInfo 或第二 Editor。
- 加载时 Esc 只关闭子视图，不取消根会话、不丢草稿／图片；关闭、移除、替换 attachment 后的迟到读取不复活界面，同 id 再打开不会被旧请求 unfollow。
- 编辑框上方进度仅显示 native `running`／`initializing`，保持原有两行摘要＋活动设计。idle／completed／failed／stopped 等结算项立即退场；全部结算则隐藏整个 widget，header／overflow 只统计已知活动项。原生目录与 transcript 事实不删除，continuable 再激活时自然重新出现；显式 idle 回复目标仍显示在唯一 Editor 的目的地提示中。
- 新增根会话 `/agent`，仅导航现有 Agents 目录／历史；键盘入口、只读子 transcript、原生 Reply/Stop 与 child 回复中的 slash 文本语义不变。手动打开的详情不因结算而自动关闭，避免打断结果阅读。
- 原生 `subagent-follow:true` 对 external／非本地成员 fail closed，与 child-session 读取一致；释放不重查 membership。没有新增调度、模型调用、持久化、轮询或前端替换。
- 只读参考 `@tintinweb/pi-subagents` 0.23.1：其 aboveEditor widget 按父回合年龄清理、fleet list 使用独立短暂 linger，conversation viewer 不因完成自动关闭。本项目按本次用户要求立即依据 DSH 原生结算退场，不复制 Pi timer／运行时。`pi-cc-extensions` 没有对应 Subagent 进度 widget。
- 启动／退场阶段父级 `pnpm check` **1253/1253**（102 files），App 接入 **54/54**、原生 DSH＋hermetic stream **4/4**、Subagent CLI/PTY **8/8**、编译归档 **296 entries** 导入／加载／退场／两行再激活 smoke 通过。草稿、图片、迟到 read/ack、同 id 新 owner、原生控制、命中区与终端恢复都有回归；证据 `.cache/subagent-startup-research/`。
- v0.1.3 发布源码再次完整 `pnpm check` **1291/1291**（104 files、build／strict TypeScript、约 236 秒），Subagent CLI/PTY **10/10**、启动 identity CLI/PTY **6/6**、compiled archive **300 entries** 的版本／welcome／Group／Link／Spinner smoke 通过。应用 package／shared VERSION／CLI／welcome 统一为 **0.1.3/private**；只提交源码、测试、文档与版本 metadata，构建／缓存／运行状态不进 Git。证据 `.cache/release-v0.1.3/`，详见 [验收记录](docs/ACCEPTANCE.md)。

## v0.1.2

按用户授权，将本轮 Subagent 只读闭环、原生干预、编辑框上方进度与名字限定内部链接发布为 **v0.1.2**。包仍为 `private:true`；发布范围为 release commit、GitHub `main` 与 `v0.1.2` tag，不发布 registry，不修改真实配置／凭据／会话或全局安装。

- 发布源码完整检查 **1228/1228**，CLI／编译后 welcome／package metadata 统一为 `0.1.2`；Subagent **6/6** 与启动身份 **6/6** CLI/PTY 全通过，正常退出和 SIGINT 均恢复终端。编译归档 **296 entries** 导入、版本和 name-link smoke 通过；源码／测试／文档提交，不提交构建／缓存／运行数据。发布验收证据：`.cache/release-v0.1.2/`。

- 第一阶段：主对话单行 child 状态、Agents 树 Overlay、全屏只读子 transcript、durable settlement/trigger 与带来源的子审批／问题。原生 catalog/lifecycle/projections 与 child session 为唯一事实源；显式 follow＋有界缓冲隔离父子 transcript，不新建 Agent/scheduler/persistence，token/timing 不冒充 per-run。
- 第二／第三阶段：新增 `subagent-interrupt` 与 `subagent-prompt` 原生 adapter commands，严格使用当前树与真实 direct parent；支持 one-shot/continuable 中断、continuable 的 queue/steer 文本／图片回复、精确 capabilities、延迟服务能力刷新与 in-flight abort。Reply 复用唯一主 Editor 并保留草稿，Stop/Reply 支持可配置键和鼠标 chips；accepted 不伪造 stopped/completed，失败恢复草稿，根 slash/send-now 不误路由到 child。
- 编辑框上方进度：按用户的 Pi 截图采用蓝色 Agents 标题、树形摘要与原生活动次行；fullscreen 点击 agent 按 Grok 式交互直接进入子会话，Esc 返回同一 Editor／草稿。标题／溢出行进入完整树；活跃 child 与回复目标优先、有界高度和窄屏降级，空 catalog 不占行。只用已有原生投影，不增加 child read／轮询、计时器、编辑器或假造 Pi turn/tool/context 指标；临时浮层阻断底层 mouse hits，失效手势不能串到新 attachment。
- 名字限定内部链接：仅蓝色、加粗、下划线的 agent 名字打开 child；仅 `Agents`／`+N more` 文字打开完整树。图标、状态／指标／活动／空白保留选字复制，不跳转；external 无伪链接，不发出 OSC8／浏览器 URL。可见列命中区支持 CJK／emoji／clip，hover 只提亮；outside press、drag、reattach／blocking 不得串成旧 click。原始子会话、Editor、R/S 与 queue/steer 不变。
- 保持排除：无常驻 sidebar、第二任务系统、per-run usage、child `/resume` 或私有 persistence；真实验收使用临时 home/workspace 与 hermetic model stream，不调用真实 provider。
- 上一轮原生干预父级验收：完整 `pnpm check` **1160/1160**（99 个测试文件）、Subagent 专项 **127/127**、真实 DSH **4/4**、真实 CLI/PTY **2/2** 通过；fullscreen 实际点击控制 chips。编译归档 294 entries 且解压导入成功。详细证据见 `docs/ACCEPTANCE.md` 与 `.cache/subagent-controls/`。
- 进度阶段父级验收：完整 `pnpm check` **1209/1209**（101 个测试文件）、新增进度 **49/49**（组件 37＋App 12）、Subagent 全链 **176/176**、真实 DSH **4/4**、真实 CLI/PTY **4/4**，编译归档 **296 entries** 且解压导入／Progress smoke 成功。Esc 后立即再点、图片草稿、原始 transcript 点击、overflow、decision blocking、失效手势与多行单行化均有回归；未修改原生业务或真实配置／凭据／全局程序。当前证据见 `docs/ACCEPTANCE.md` 与 `.cache/subagent-progress/`。

- 本次名字链接父级验收：完整 **1228/1228**、进度／链接 **68/68**（组件 50＋App 18）、Subagent 全链 **195/195**、真实 DSH **4/4**、CLI/PTY **6/6**、编译归档 **296 entries** 导入与内部 name-link smoke 通过。fullscreen 实际 16 个非链接位置点击均不跳转，并验证 native drag/copy 与短屏 overflow；所有 copy packet 留在测试终端，未触及真实剪贴板／模型。证据：`.cache/subagent-links/`。

## v0.1.1

按用户明确确认，将当前原生 DSH 插件化与累计修复发布为 **v0.1.1**，版本号从此前的 v0.2.0 回退。包仍为 `private:true`；本次创建 release commit，推送 GitHub `main` 与 `v0.1.1` tag，不发布 registry。未修改真实 profile、凭据或全局安装。

- 修复 `/compact` 丢弃最近一次实际路由 reasoning effort、导致要求 thinking 的模型立即 400 的问题。仅在摘要目标与该路由完全相同时继承 effort，不改普通回合、摘要消息/工具或输出预算，也不把 effort 套到不同模型。失败时按 session/command 关联 `compaction/end.error`，在原生通用提示下一行显示脱敏、限长的真实原因。完整检查 **1033/1033**，两种 renderer 的真实 DSH＋hermetic provider compaction 验收通过；未擅自对真实会话执行压缩。
- 修复聊天过程中原生模型目录日志覆盖编辑框：同进程 JS stdout/stderr 诊断进入独立的脱敏、有限日志，Pi renderer/protocol 使用专用原始输出 writer；目录成功刷新不进输入/对话，警告限流去重，致命错误在恢复终端后仍可见。生命周期覆盖退出、挂起恢复、HMR 和失败，不删除 provider/凭据或复制刷新逻辑；直接 fd/native/子进程写入不冒充已隔离。
- 诊断修复后完整检查 **993/993**，新增 **6 个原生日志/生命周期 PTY 场景**与编译归档日志隔离通过；私有日志权限、分片 UTF-8/凭据脱敏、超长行丢弃、重复 lease、存储失败和多行 fatal 均有专项回归。
- 应用 package、唯一 bin、Cordis row/effect/service、环境变量、源码/fixture/脚本/文档统一为 `dsh-tui`；Pi TUI 的上游身份、许可与 `#pi-tui` seam 不改。
- 修复 DSH preset YAML/插件类从本项目目录解析而缺包的启动错误，改从宿主 installation anchor/公开 package lookup 加载，不需要挂 Web 前端。
- `dsh-tui` 首次通过所选 DSH 的公开 package APIs 自动挂载当前本地应用，后续幂等；同源旧别名先安装新身份再移除，其他前端、其他同名来源和明确禁用不自动覆盖。不重建 profile、迁移凭据或写用户 patch。原生 activation assertion 让整个前端被禁用时也明确退出；包操作有边界和可取消清理。
- 最新完整 `pnpm check` **937/937**、**46 个不同 CLI/PTY 场景**、统一名称的编译归档加载/首次自动挂载通过。最低 Node 版本与 native DSH 对齐为 24.9；开发验收未修改真实 profile/global 安装，用户运行入口时才按上述规则自动挂载。
- 默认使用 fullscreen，直接运行 `dsh-tui` 即可；`--inline` 是显式切换，已保存的 screen 偏好不被擅自改写。帮助和启动示例同步简化，原生 PTY 覆盖不带 screen flag 的启动。
- 正式收录原生 DSH 应用 bundle、同进程 Cordis TUI 插件与宿主 Context 窄适配；删除旧 IPC/后端进程/profile 镜像，模型目录沿用方案 A 的原生服务投影。
- 修复当前会话重复恢复导致连接丢失：遵循 DSH 单 Agent/单写入 owner 约束，当前 id 幂等复用已有连接，未物化的当前 id 保留 staging；真正切换其他 id 仍先准备成功再释放旧连接。不自动新建/选择会话，不复制 native persistence。
- 原生 create/resume/setup 的异常映射到稳定、脱敏的后端错误；保留取消/过期分类。不序列化未知异常对象，屏蔽 quoted/escaped credential assignments；不改写原始工具/会话/图片事实。
- 图片重绘测试在创建序列前显式注入 Kitty 能力，异常路径也清理 renderer/capability/cell geometry；普通终端的文字降级保持不变。清理 malformed recall 测试遗漏的临时父目录。
- CLI 与欢迎页统一读取 `src/version.ts`，包元数据通过版本一致性测试保护；编译后的 JS 与私有 `#pi-tui` seam 仍是唯一生产入口。更新 clean-install 验收脚本，隔离 HOME/DSH_HOME 并使用现行私有 Pi TUI 导入。
- 长 cwd/footer 的测试按实际逻辑行换行验收，保持完整路径、权限、状态顺序与颜色，不靠缩短全局临时目录掩盖失败；会话选择器先对长 HOME 做安全 `~` 缩写再应用展示预算，保留 live 状态提示。
- 自动挂载/统一命名之前的基础阶段：干净环境 `pnpm check` **901/901**、原生恢复专项 **10/10**、CLI/PTy **39 场景**与编译归档加载通过；离线空 cache 安装因缺公共包元数据中止，未冒充全新安装验收。
- 父级真实 native profile 回归包含当前 id 的 staging/live、流式双 inbox、待审批与不同 id 的 resume/setup 故障注入；完整数字与 PTY/产物范围见 [验收记录](docs/ACCEPTANCE.md)。没有真实 provider/vision/GPU 像素验收声明。

## 历史开发：原生 DSH 插件化（基于 v0.1.1，未另发布）

该阶段把 TUI 改成 DSH 的**原生同进程应用插件**，当时未另升版本、未 commit/publish，包版本仍为 `0.1.1` / `private:true`。旧图片阶段与云路由记录只保留历史状态。

- 删除旧桥接架构：`runtime/bridge.mjs`、`runtime/bridge.d.mts`、`backend/client.ts`、`discover.ts`、`protocol.ts`、`runtime-home.ts`、`native-profile.ts` 及其 wire/discovery/mirror 测试。不再有前端/后端 IPC、后端子进程、scratch home、profile 镜像/剪裁、Pi 目录导入或凭据迁移，也不自动禁用其他前端。
- 生产入口改为 native 插件：`src/plugin/index.ts` 通过 native `appReady` 启动，`startup.ts` 用原生 cmdline 解析选项，`presets.ts` 从 DSH 公开 resource 导出读取官方 preset 声明并用 native `loadOverlayPatches`/`composeEntries` 与 `AgentPreset` 类加载。不复制工具清单、权限规则或 plan 语义。
- 生命周期归 DSH：`ctx.effect` 卸载时**同步**恢复终端，再异步关闭 App/backend；`appExit` 属于 DSH，本插件不 `process.exit`。一个 profile 只允许一个前端，检测到其他已知前端即明确报错，不剪裁用户 patch。
- 模型/provider 直接投影 native `ctx.llm.listProviders()` / `listModels()` / `resolveModelInfo()` 加 `agentDefaultModel`；不挂完整 SessionController，不导入 Pi 目录/凭据。模型/effort 默认保存由真实 native ConfigEditor 负责；无法证明落盘时报告 `defaultsPersisted:false` / `defaultPersistence:'native'`，正常成功只更新底栏，失效/未知 warning 可见。
- 图片读取改走 `ctx.attachments`：同进程没有 8 MiB IPC 帧/6 MiB 图像传输上限；编辑/显示内存预算保留，模型 vision 准入仍归 DSH。`history.json` 仍只存文字，不含 base64；队列图片 refs 需显式 Up 取回重试，不新增调度器。
- Node CJS 兼容改用 public `createRequire` 加载 highlight/sharp，不修改 DSH/global 私有 patch。公共导出改为编译后的 `lib/*.js`；两个 `bin` 别名都指向 `lib/cli.js`。POSIX 别名用 `process.execve` 替换为 native `dsh`，其他平台只做整应用委托，不存在前端/后端 IPC。
- 构建/发布：`pnpm build` 先构建 vendored Pi TUI，再把 `src` 编译到 `lib`；`lib/` 与 `vendor/pi-tui/dist/` 不提交。私有 `#pi-tui` 指向同一份 vendor dist，已删除 `workspace:*` 顶层依赖；peer deps 由 DSH 宿主提供，`autoInstallPeers:false` 避免拉入第二个 Harness。
- 验收：native 同进程 stream/settlement、模型 picker 搜索/effort 保留、权限/cancel/ask/approval、HMR 配置重组合通过；私有 native PTY 覆盖 inline/fullscreen × 正常退出、外部 SIGINT 130、demo，以及卸载-重挂载，共 8 case 全通过；原有 UI/input/image 测试保留。最终完整 count 由父级复跑并写入 [验收记录](docs/ACCEPTANCE.md)，本记录不另造数字。
- 安装边界：本轮未修改任何真实 home/profile/global 安装，也未迁移凭据或重建 profile。保留已有 `/opt/homebrew/bin/dsh-tui` 本地 symlink；正常使用前需用户自行执行 `dsh plugin --profile dsh-tui add /Users/fulei/workspace/dsh-tui`，并用 DSH 移除/禁用该 profile 中的旧前端。`dsh-tui --demo --fullscreen [images|tools-group]` 始终离线可用，不需要 DSH。
- 未做真实 vision/GPU 截图验收，也没有宣称真实 provider 请求通过；历史 1021/1021、PTY 4/4 与旧 CloudAgent 实网数字仅作历史对照。

## 历史：图片能力（基于 v0.1.1，未另发布）

> 本节记录同进程插件化之前的图片阶段。其传输预算与测试数字属于历史状态，不能当作当前健康证明；现行边界见 [图片说明](docs/IMAGES.md) 与 [验收记录](docs/ACCEPTANCE.md)。

- 接通 DSH 原生附件按引用惰性读取与多模态 prompt-content；不自建附件存储、模型 vision、权限或 Agent loop。
- 用户/assistant/工具/历史保留 canonical 图片引用与顺序，图片标记可显式打开只读查看器；支持 PNG/JPEG/WebP/GIF 的显示转换。
- CC 风格原子 `[Image #N]` 输入、图片优先/文本回退剪贴板、重复 occurrence 保序、撤销/kill-yank/草稿恢复，以及失败保留完整图片 draft。
- 修复 vendored Kitty fullscreen 清屏后的 upload cache/旧 ID 重放；resize 通过 renderer 更新字符单元格几何。
- 8 MiB transport 与显示/编辑内存预算明确拒绝，不静默截断；图片读取取消独立于 Agent.cancel，迟到结果不得绘制。（历史：8 MiB 属旧桥接传输预算；同进程后不再有该 IPC 帧上限，显示/编辑预算仍保留。）
- 父级完整 `pnpm check` **1021/1021**；新增图片 CLI/PTy **4/4**，现有 Thinking/Tools/Settings/取消/Help/模型/主题/logo 回归通过。PTY 验证完整 PNG 与布局/恢复，不宣称真机 GPU 像素或真实模型 vision 已验收。
- 临时 Rex 测试页已清理，原工作会话及 server window 焦点恢复；未修改用户配置/凭据、全局安装或既有本地链接，无 commit/tag/push/publish，包版本仍 `0.1.1`。
- 新增本地显示 codec 依赖 `sharp@0.35.5`（Apache-2.0），许可见第三方声明；详情见 [图片说明](docs/IMAGES.md)。

## 历史：v0.1.1（Tools 展示阶段）

这是此前同名的本地开发标记，不是本次 GitHub release tag。按当时用户选择，仅更新本地版本标记。包、CLI 与启动页统一为 `0.1.1` / `v0.1.1`；该阶段未提交、未打 Git 标签、未推送或公开发布，包仍为 private。此阶段收录 Tools 展示升级。

- 新增连续工具分组、独立 Input/Output 预览、原生 Diff 布局与只读工具 Inspector。
- `/settings` 增加 Tools tab；保留一个设置/快捷键文件，不增加业务 mode。
- 复用鼠标 hitbox，正文单击收起/拖动选字，真实调用+section 目标锁定；Thinking 与工具共同锚定。
- Ctrl+O 全局开关，Ctrl+X Ctrl+O Inspector，[ / ] 浏览所有调用，Tab 切段，c 复制原始可得源。
- 真实时间/状态/原生 presenter 与大 Diff 源保留；不重跑工具、不伪造 applied/无结果/截断信息。
- 版本标记前的完整 `pnpm check` **898/898**；新 Tools PTY **2/2**，Thinking 与现有 CLI/PTY 回归同步通过。
- 更新为 v0.1.1 后：strict TypeScript、CLI/启动页/主题版本回归 **37/37**、启动区 PTY **6/6** 通过；`--version` 返回 `0.1.1`。
- 开发/返工的 subagent 调用均指定 `cloudagent/deepseek-v4.1-flash-1017`；工程测试只用临时目录/离线或 localhost fixture，未额外对真实 DSH provider 发起验收请求。详情见 [Tools](docs/TOOLS.md)。

## v0.1.0（暂定）

按用户要求，将当前实现作为 **v0.1.0 开发基线**。包版本、CLI 帮助与 `--version`、启动页统一为 `0.1.0` / `v0.1.0`，启动页不再显示 `prototype`。

### 基线内容

- DSH 原生后端的薄适配：实时流、取消、审批、问卷、原生命令和显式会话恢复；模型、凭据、权限及持久会话仍由 DSH 管理。
- Pi TUI 主屏与全屏渲染、CC 风格 readline 输入、工具卡、Markdown/diff、静态字符 logo 和主题。
- `/settings` 的 General / Thinking 分 tab 设置，以及同一套可编辑快捷键列表。
- 思考摘要显示时长、实际折行数和尾部预览；全屏单击标题或展开正文收起，拖动正文保留原生选字。复用鼠标命中区，处理流式重绘目标锁定；回到底部按钮不覆盖正文。

### 验收与边界

- 标记版本前的完整 `pnpm check`：**710 tests / 710 pass / 0 fail**。
- 版本显示调整后：严格 TypeScript、CLI/启动页/主题定向回归 **36/36**、启动区 PTY **6/6** 通过；正常退出与外部 SIGINT 均恢复终端。
- 思考预览 0/3 行与 inline 降级的 CLI PTY 验收通过，包含展开/收起、正文选字和终端恢复。
- 当前核验的 DSH 版本线为 `0.2.2-rc.1`。本次版本标记不新增远程模型调用，也不修改用户配置或凭据。
- 本记录不是 Git 快照或已发布产物；已知能力边界见 [README](README.md#已知边界)，详细验收见 [验收记录](docs/ACCEPTANCE.md)。
