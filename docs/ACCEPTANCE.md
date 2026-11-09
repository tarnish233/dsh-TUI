# v0.1.4 原生 DSH 边界与交互语义验收

## 当前工作树：DSH 原生 `@file` 补全（未提交）

用户现场确认输入 `@` 没有候选。本轮先复现出 Pi `CombinedAutocompleteProvider` 未传 `fdPath` 因而恒空、原测试 `null === null` 假阳性，再改接 DSH 官方 `fileReferences` seam；没有把 Pi Agent/runtime 或全局 `fd` 带回生产。

- **最终完整 `pnpm check` 2370/2370**，194 测试文件，vendor/src build＋strict TypeScript，0 fail/cancel/skip/todo；tests **510467ms**。`.cache/native-file-references/full-check.log`。
- 应用 bundle 声明 canonical `@deepseek-ai/dsh-file-reference-local` Host row；后置用户 patch 可禁用／替换。Backend 只在实际 `ctx.fileReferences.list` 存在时广告 `file-references`，每次按 exact live Agent、verbatim query 与 owned AbortSignal 调用，保留 provider 顺序／长度，严验 unknown DTO 与 attachment identity；无扫描、`fd`、路径解析、文件读取／stage、目录缓存或第二 provider。
- 首个 `@` 查询先确认 provider，再通过现有 lazy path 物化同一 pending Agent；不发 model turn。缺 service／预取消不创建 Agent；查询中取消、session replacement、close、HMR service replacement 和 malformed／credential diagnostics 均有回归。共享 8s native-UI read bound 与 materialization 不可中断边界明确记录。
- Input 直接复用 DSH 公共 `activeAtToken`／`formatFileMention` grammar 与 native candidate order；Pi 仍唯一拥有菜单、Editor、undo、接受与目录光标。支持 file／directory、裸／嵌套、空格引号与连续下钻；邮箱／token 内 `@` 不触发。Tab／Enter 只填候选，第二 Enter 才提交；失败／取消／迟到结果静默为空，slash／参数／普通 Tab path 保持。
- `@path` 是普通 prompt text，候选浏览／接受从不调用 `stageFile`、不生成 `[File #N]`、不读取内容；显式 `/attach` 仍是唯一 native FileBlock 输入。根输入不把根 workspace 候选借给 child Reply。
- **Parent 独立专项**：Backend＋邻接 **52/52**、Input **63/63**、App **5/5**、真实临时 native profile **3/3**。后者覆盖 inline／fullscreen 首个 `@` 打开实际 native 候选、同 attachment 唯一 Editor、只物化 Agent／零 user message／零 model turn、接受后普通 path text／零 FileBlock，以及用户禁用 provider 后 capability 缺失、不建 Agent、不回退 Pi 扫描。日志与 final hygiene 在 `.cache/native-file-references/`。
- 最终 HEAD 仍 `4738db0`，version `0.1.4/private`，工作树共 188 个状态条目、index 空，`git diff --check` 与 `pnpm peers check` 通过；`pnpm pack --dry-run` 359 个文件且未生成 tgz，包含 native adapter、lazy grammar input build 与 bundle patch。所有 native 场景使用 owned HOME/workspace 和 hermetic/no-send 路径；无真实 Provider／用户 profile／credentials／session/global install 操作，无提交/tag/push/publish。

## 前次工作树：精确 Thinking 尾窗缓存（未提交）

缓存语义、边界与本机基准见 [性能优化记录](THINKING-PREVIEW-PERFORMANCE.zh-CN.md)。只优化 ThinkingBlock 的测量成本，不改原生原文／ID／工具／计时／输入／终端业务。

- **完整 `pnpm check` 2323/2323**，190测试文件，vendor/src build＋strict TypeScript，0 fail/cancel/skip/todo；tests **503378ms**。`.cache/thinking-preview-performance/full-check-final.log`。
- 同 source/width hit 不再sanitize/wrap；普通append重用稳定行计数、只wrap最后一条mutableline＋delta，tail/hidden计数精确；expanded全body lazy并复用未着色wrap。preview/clock/hover/disclosure用现有语义。
- Per-block默认16states／24tailrows／262144 UTF-16 code-unit retained budget，prune/LRU有界；超预算放弃reuse但保留精确输出。rewrite/shorten/width变化重建；retained ESC history／trailingCR保守重建，防止sequentialsanitize跨chunk露出早期CSI。
- Parent独立冻结旧compiledThinkingBlock作oracle，**800场景／87016对照**全部精确一致（普通/恶意append、rewrite、clear、width、preview0..25、expanded、Unicode/combining/ZWJ、CRLF/tab/control/OSC/CSI和eviction）。`.cache/thinking-preview-performance/differential-final.log`。
- Parent本机交替3轮中位数微基准（不含初次indexing）：1400hardlines／160append **866.73→14.11ms**（61.4x）；paragraph／100append **139.80→5.57ms**（25.1x）；16000字符unbroken-token／50append **55.26→2.13ms**（25.9x）；300timer-only **1590.98→0.443ms**；expandedunchanged70frame **370.22→4.24ms**。完整paint与旧module比较，非model/network/GPUlatency承诺。`benchmark.json`／`after-benchmark-final.log`。
- Parent专项 **70/70**包含cache/UI thinking、原生1400line PTC handoff／真实return42、前次hover/title/focus和双模式PTY；所有native文本／display计数／鼠标／disclosure保持。
- 独立对照抓到并补修两个cache边界：超预算用empty-string哨兵误命中真实clear；最后ESC分析不足以处理较早CSI被OSC移除后暴露。现在用undefined droppedstate＋conservativeescapehistory，nonfinitecachelimits回finite默认。source失败/修复与fuzzseed保留。
- Baseline173旧文件保留；本次只有thinking-block、新测量cache、相关tests/docs。没有backend/state/App/input/vendor/依赖/版本变化；HEAD/tag4738db0/v0.1.4、index空，无commit/tag/push/publish、真实Provider／credentials/profile／server/global操作。

## 前次工作树：四项现场渲染修复（未提交）

来源、实现和只读 pi-cc-extensions 对照见 [四项修复记录](RENDERING-FOUR-FIXES.zh-CN.md)。保留 DSH tool admission／原生事件／native durable id，未替换 renderer／输入／配置系统。

- **最终完整 `pnpm check` 2303/2303**，189 测试文件，vendor/src build＋strict TypeScript，0 fail/cancel/skip/todo；tests **496805ms**。`.cache/rendering-four-fixes/full-check-final.log`。
- Node v26.13.0／DSH0.2.2-rc.1 PTC host stripTypes 引发的 exact ExperimentalWarning＋紧邻 hint 降为 routine，日志保留。不同 API／措辞／独立 hint／provider failure／fatal 保持。没有 NODE_NO_WARNINGS 或 global listener；backend/UI diagnostic regressions通过。
- 1400行 expanded Thinking 在合法 streaming→assistant/attempt settlement→tool/call/result 后保留原文／展开；UI-only thinkingKey 移交，不改durable id/seq/status；event→paint 间的 disclosure count 也保持。取消/retry/unknown/隐藏思考和Image↔Thinking hover覆盖。
- 单一 hover owner 处理 tool／Thinking／group／child／gap/re-base/disclosure，Parent 补 Editor／Welcome／viewport／overlay／terminal focus 边界。使用 Terminal现有 onFocusChange（全屏先消费CSI O），未改vendor；helper/test模拟对应公开observer。draft/focus/drag/pins/selection保留。
- ToolSummaryInfo.detail 显式compose label＋space＋detail；only exact case-insensitive whole-word 重复prefix归一化，native raw内容保留，Read Image /path 不再Read ImageRead image。ANSI/OSC/wide/CJK/emoji/无描述/窄宽度回归。
- **Parent native2/2**：owned native profile＋hermetic model fixture，1400line thinking handoff与PTC真实执行 return42，工具状态done和结果42，exact warning/hint capture routine但原log可读；零remoteProvider。
- **Parent App3/3＋双模式PTY**：标题，fullscreen真实SGR逐Tool→Thinking→group→Editor的FG cell证据，窗口focusOut/In、overlay和单Editor草稿，normalexit恢复；main-screen仅标题/exit，不冒称SGR支持。焦点边界重复10轮（每轮3cases）通过。
- 首次 full-check **2303 tests／2302pass／1fail** 暴露新增focusOut断言：普通listener位于Pi fullscreen消费之后；已改成publicfocusobserver，修正mock与已有subclass字段冲突后，Parent37项相关integration和最终full-check通过。失败记录保留，不宣称首轮即通过。
- pi-cc-extensions只读commit b8530b9／v1.0.8：采用稳定run disclosure思路，不移植Agent prototype/mainRendererpatch。全文thinking逐chunk rewrap的tail-cache优化尚未引入，单独记录边界。
- 前153个未提交文件保留；只有授权诊断／UI/state／App及相关tests/docs变化。HEAD/tag仍4738db0/v0.1.4，index空，manifest/lock/version不变。无commit/tag/push/publish、真实credentials/profile/server/globalinstall操作。

## 前次工作树：Demo 展示整体编排（未提交）

只扩展既有 `--demo tasks` fixture，启动说明之后立即展示 tool/result → subagent-settled notice → agent-message relay，前两者混合，后者独立。已结束的第四个 catalog child 作为 sender，三个活动 child 不被假称结束；turn-scoped call/message id 防止重启覆盖旧事实。没有 UI／backend／命令／Renderer 改动。说明见 [Demo 指南](DEMO.md)。

- **最终 build＋strict TypeScript＋专项 139/139**，`.cache/demo-presentation/final-scoped.log`。包含 Demo/store/projection、相关旧 Demo、生产 App 6/6，以及实际构建 public CLI 的 inline／fullscreen PTY：初始 Activities 1 tool＋1 update、Ctrl+O 通知原文、独立 DEMO CHILD MESSAGE、统一固定区、原控制输入和退出恢复。
- 示例 tool、notice、relay、sender 全是确定性离线数据，无真实工具执行／Agent／模型，Root fixture active count3、catalog count4，sender无虚构 timing/token。clear/new/resume 重置，next/done 不重复发活动样例。
- 本次未复跑整仓；下节此前 Parent 完整 **2265/2265** 保持历史记录，不将 fixture 专项称为完整门禁。
- 版本／manifest／lock／旧 tag 不变，无提交／新 tag／推送／发布、真实 profile／credentials／Provider／服务器／全局安装操作。

## 前次工作树：展示层整体收敛（未提交）

用户确认固定区布局和活动分组一起改；实现与边界见 [整体编排记录](PRESENTATION-COMPOSITION.zh-CN.md)。内容块、只读分组投影、固定区编排与 renderer 分层，不改 DSH 业务或增设配置层。

- **最终完整 `pnpm check` 2265/2265**，184 测试文件，vendor/src build＋strict TypeScript，0 fail/cancel/skip/todo；tests **492448ms**。`.cache/presentation-convergence/full-check-final.log`。首个候选 full-check 同为 2265/2265；随后重建最后的 empty-member fallback 修正，再由 Parent 独立复跑完整门禁。
- **固定区组件与 Stack**：纯 preferred／comfortable／compact 行事实，一帧一成员绘制，uniform all-or-none 间距、内容先于空白、0..18 预算、standalone separator 兼容、冻结输入和实际 mouse spans。新增 Stack 19 个场景与相关组件断言。App 删除三套 sibling render 测量预算回调，Parent 生命周期与唯一 Editor 保持。
- **混合活动组 18/18**：真实工具和 source.kind=subagent-settled／form=notice 分开计数，两设置 conjunction，原生 form 直接消费不改 state/backend；普通工具和纯 Subagent 分组保持，actual message／unknown form／visible text／todo／diff／known turn 边界保持。共享 cache／Ctrl+O／single-expand／viewport／context ownership／鼠标委派完整。
- **Parent App 8/8**：宽裕统一间距、短屏全部零间距、空／隐藏／settled 释放、同一多行草稿，原生计数、原文与设置独立语义。
- **Parent real native Session／codec 2/2**：合法 synthetic first-class tool/result＋settlement notice 经真实公开 Session 日志和 adapter，不 fake 工具，before-control 两模式无 Activity 组；after 1 tool＋1 update，原文／source／seq 保留，Ctrl+O 和真实 agent-message 可见。这个 probe 没有实际执行 synthetic 工具或启动 child，模型 baseline 被 hermetic stream 截获。
- **新双模式 PTY**：production App 配 explicit offline fixture，统一／紧凑间距、混合展开、真实消息、多行／Ctrl+T、Agents 导航、正常退出；全屏额外用实际 SGR mouse 验证新 Stack span 坐标，main-screen 使用既有 keyboard／native scrollback。原 tasks demo 与原 UI／文件 PTY 同时回归。
- PTY 首轮对 resize 的旧帧立即断言、随后在半个 DEC 2026 write 上断言，以及给 legacy main-screen 强加 fullscreen mouse 的测试假设均已更正；不将它们写成生产布局／鼠标修复。日志保留。
- 只有 UI 编排／App 挂载和相关 tests/docs，本次无 backend/input/vendor/manifest/version/用户配置变化，已有未提交工作完整保留。HEAD/tag 仍 `4738db0`／`v0.1.4`，index 为空，无提交／新 tag／推送／发布、真实 Provider／credentials／服务器／全局安装操作。所有 acceptance 以 Parent 日志为准；不采纳越界重复运行的 delegated full suite 为门禁。

## 前次工作树：离线 tasks 交互 Demo（未提交）

通过既有 `dsh-tui --demo tasks`／`pnpm demo tasks` 入口使用生产 App、一个 Editor 和相同两种 renderer；不替换正常 native 连接。说明与控制文字见 [Demo 指南](DEMO.md)。

- **完整 `pnpm check` 2208/2208**，179 测试文件，vendor/src build＋strict TypeScript；0 fail/cancel/skip/todo；tests **529830ms**。`.cache/demo-tasks/full-check-first.log`。
- **Demo 状态 9/9**：六项有序 Todo、readonly GoalRead、三个本地活动 child；严格 tasks trigger、两步 next／原生 paused、done 的原生 complete／completed、clear、bounded history、new/resume/reset、cancel/close、有限 line-batched stream 和无虚构 child runtime。仅 fixture 数据，无真实 Agent／工具／模型。
- **生产 App 6/6**（两 renderer）：真实 initialPrompt 入口，根回到 idle 时三个 dock 共存；next/done/clear/restart，24 组有上限的历史事实、80×16／40×18 resize、Ctrl+T、Agents／Settings 原有 overlay、同一多行草稿／焦点保持。
- **public CLI PTY 双模式**：实际构建后的 `bin/dsh-tui.mjs --demo tasks`，给不可执行的 `--dsh` 路径并使用 owned HOME／DSH_HOME／cwd／config，证明 demo 不依赖 native launcher。覆盖进退阶段、history／小屏、Ctrl+T、Agents／Settings、重启和正常退出恢复。`.cache/demo-tasks/pty/`；没有 native API／真实模型／GUI 冒名验收。
- 首次 public CLI 发现默认 delay 下逐 grapheme 的长说明超过 8s，且 child 的历史 fixture 时间被显示为 12274h。修复为 task-only line/phrase chunks，并省略未观察到的 timing/token fields；Reply 不凭空补旧时间，现有 Stop/Reply 和其他 demo 的播放延迟保持。初次失败与最后回归日志均保留。
- 原有 tools／images／skills／subagents／cancel、实际 native 接入、输入、固定区与退出测试同时通过；裸 `--demo` 默认 tools 不变，没有自动播放器／Goal loop／新增模型 transport。
- 只有 `src/demo.ts` fixture、CLI help 和相关 tests/docs 改动；版本/manifest/lock、native backend、input/vendor 和用户配置没有本次变化。旧工作保留、HEAD/tag 仍 `4738db0`／`v0.1.4`，index 为空。无提交／新 tag／推送／发布、真实 Provider／用户凭据／服务器／全局安装操作。

## 前次工作树：Todo／Goal／Subagent 共存修复（未提交）

用户现场报告 Todo 被 Subagent 顶掉。父级实际 App 对照确认两处布局缺口：Todo 单行预算直接返回空；settled-only child catalog 仍按非空目录预留高度。新增可见性断言，不用原有“总高度未超标”替代共存验收。规则与原生所有权见 [Todo 共存说明](TODO-UX.md)。

- **完整 `pnpm check` 2192/2192**，176 测试文件，vendor/src build＋strict TypeScript；0 fail/cancel/skip/todo；tests **474406ms**。`.cache/task-dock-coexist/full-check-first.log`。包含此前全部 native、输入、Subagent、终端与退出回归，未改 native 业务。
- **112 组实际 App 布局对照**：两 renderer × 七种高度 × 四种草稿行数 × Goal 有／无；每组依次投影无 child／running／completed。Todo child-start 后消失数从 8 降到 0，有足够空间的三者共存无缺项。`.cache/task-dock-coexist/before.json`／`after.json`。
- **新增 App 8/8**：child start 不替换 Todo，settlement 释放预留高度；短屏三状态行顺序、resize／更新、Ctrl+T、编辑焦点与同一多行草稿保持。组件另覆盖一行摘要、冻结快照、CJK／emoji／控制字节，以及 active presence 与原 render filter 一致。
- **新增 PTY 双模式**：实际 raw input＋生产 App/renderers，在五行草稿编辑期间到达离线 Todo／Goal／child projection；紧凑／展开、Ctrl+T、40 列 resize、settled child 释放高度、正常退出恢复均通过。`.cache/task-dock-coexist/pty/`。显式 fixture-only backend，不声称真实 native model／GUI 验收；原两批 PTY 也重新通过。
- 平时保留四行 transcript，短屏最多借到一行，保证每个真正可见区域的紧凑行；editor／queue／hint／footer 保持实际测量高度。Todo 一行保留 native counts／首个未完成项，零预算才隐藏；active Subagent 的第一条名字在空间允许时优先保留，settled-only catalog 不占位。极短屏不虚增终端高度。
- 本次只修改 App 布局、Todo／Subagent 呈现与相关测试／文档；没有再改 backend／input／vendor／依赖／版本。旧未提交工作保持，HEAD/tag 仍 `4738db0`／`v0.1.4`，index 为空。无提交／新 tag／推送／发布、真实 Provider／用户配置／凭据／服务器／全局安装操作。

## 前次工作树：两批原生 UI、Todo 固定区与共享配色（未提交）

详见 [本轮完成记录](NATIVE-UI-BATCHES.zh-CN.md)、[CC Todo 调研](TODO-UX.md) 和 [共享 Theme](THEME.md)。八个分工并行开发，父级集成／验收；没有新的业务 Harness、服务自动启用或版本标记。

- **完整 `pnpm check` 2170/2170**，174 测试文件，vendor/src build＋strict TypeScript；0 fail/cancel/skip/todo；tests **442677ms**。`.cache/native-ui-expansion/full-check-third.log`。
- **真实 native 两批能力 8/8**（两 renderer × 四组）：Jobs/readAt 不消费模型 cursor、unowned/current-owner 更新，Goal／effective cwd／scoped tools／安装锚定 inventory；安全 defaults native mutate／unset fallback／revision conflict 且无 Agent；user-title rename、完整 native fork seed＋promptable root／显式 resume；file-only storage／cold refs、declaring command image admission／refusal保草稿、command file receipt owner 未挂载 fail-closed。
- **真实 native continued 2/2**：以隔离 Session 的合法 first-class timed replay facts 驱动 actual projection，现有 question dialog 经 native answer/inbox 录入，declared choice／custom 语义不变；local close 不发送 cancellation／blocking respond。默认 legacy tool 未被改成 timed。
- **新增 PTY 双模式**：production App／输入／renderer ＋ explicit offline fixture backend，fixed Todo、Ctrl+T、update、resize、Settings inherited canvas、file-only multipart 与退出 terminal restoration。`.cache/native-ui-expansion/pty/`；该项不冒充 GUI／native API 验收。
- 组件／App 验证 single-flight＋trailing、late/foreign/closed guards、opaque native id、safe default confirmation、one-editor draft/history/undo、file count queue mapping、width/CJK/emoji 和 truecolor/256-color nested surfaces。原有 Subagent continuation/approval/cancel、terminal/exit/native default-follow 等全量回归同时通过。
- 首轮 **2161 tests，2156 pass/5 fail**：两例暴露 Help frame-width/body-width 差异（真实漏末行，已修复），其余为旧 image wording／新 ready file recall／不守原生 order 的 admission fixture。第二轮 **2170 中 2168 pass/2 fail**：遗漏 image/attachment wording fixture 与既有 1ms wall-clock layout flake。后者固定测试 clock，严格布局断言保持；所有失败／修正日志保留，不宣称首轮即通过。
- Parent native acceptance 另抓到 direct ccSubmit 绕过 multipart（曾发 marker text）和 native projected form 移除 volatile flag 两处跨层错位；已修复并有实际 before/after 与新回归。原生路径最终通过，source/frame/control diagnostics 不被伪造为模型／用户事实。
- 前 64 个未提交文件保留；只有本轮相关 source/docs/tests 与批准的 vendor File marker seam 扩展。HEAD/tag 仍 `4738db0`/`v0.1.4`，index 为空、version/private/manifest/lock 未变。无提交／新 tag／推送／发布、真实 Provider／用户配置／凭据／服务器／全局安装操作。所有 native 写入仅在 owned temporary profiles。

## 前次工作树：适配层收敛完成（未提交）

当前 DSH 0.2.2-rc.1 能支持的剩余收敛项已完成，详见 [完成记录](ADAPTER-CONVERGENCE-COMPLETE.zh-CN.md)。未新增功能入口／私有 registry／轮询，版本与既有 tag 不变。

- **完整 `pnpm check` 1910/1910**，151 文件，build＋strict TypeScript，0 fail/cancel/skip/todo；tests **403009ms**。`.cache/adapter-convergence-final/full-check-first.log`。
- **真实 native 默认跟随 4/4**：pending／materialized-before-request 跟随原生 default，request/selection/CLI 固定，logged resume 不被覆盖；已结算配置事件更新 footer。旧编译基线同组 2 fail＋2 pass，验证问题真实可达。
- **真实 native preset/settings 2/2**：通过临时 profile 的 settings.update 改 actual registry entry default，公开 settled config-reload/document 信号刷新已有 picker，保留 native id、草稿／焦点，不创建 Agent，不调用模型。
- resident projection cuts 替代额外 row lease：2 resident children 从 2 lease 降到 0；cold/mixed/failing cuts 仍使用并释放原生 lease，行数据与权限守卫保持。
- 新回归覆盖 route async races、native config 失效合并／Owner／close、preset native id 插入重排／失败恢复、model current badge 不移动选择、关闭或外来 surface 不复活；完整检查含原有 continuation、审批／取消及 exit/PTY 防回归。
- 51 个原先未提交源文件保留，只有授权收敛相关文件继续修改；HEAD/tag 为 4738db0/v0.1.4，无提交／新 tag／推送／发布、真实凭据／用户配置或全局安装变化。模型流全为 hermetic fixture。SDK direct runtime preset register 无专用事件及 native listing 无行数参数作为已确认边界记录，不自造实现。

## 前次工作树：第一轮原生适配层收敛（未提交）

详见 [收敛对照与 SDK 边界](ADAPTER-CONVERGENCE.zh-CN.md)。在下节 A1–A10 修复基础上，改用原生 Subagent 枚举／diagnostics、公开 snapshot/title/turnBoundary/Plan view，删除重复 locked 判定；模型目录四任务并行，已打开 picker 消费原生目录事件并保留状态。

- **该阶段完整 `pnpm check` 1861/1861**，143 测试文件，vendor/src build＋strict TypeScript，0 fail/cancel/skip/todo；tests **381857ms**，`.cache/adapter-convergence/full-check-first.log`。
- **父级真实 native 专项 28/28**：parallel children、child approval/follow/live/cold/continuation/interrupt、native Plan review、显式 resume、终端标题/终态；上一轮 exact Skill/max-tokens/退出交接也由完整回归覆盖。所有模型流为 hermetic fixture，零真实 Provider 请求。
- 新测试覆盖 listing/preorder、合法 child 不被 diagnostic 降级、metadata-only diagnostics、200/8 展示预算、epoch/deadline cancellation、lease release、无 display 节流控制、跨树/root/cycle guard、public projection/no-stateOf、unknown blank→native select、并行 registry-order、query/focus/draft 与迟到 metadata 隔离。
- SDK `listDescendants` 没有 row/depth 参数；完整 native catalog + adapter row projection 的读取成本明确记录，不声称减少所有磁盘读取。创建模型 route 的 live-default-follow 差异仍未擅改，未增加 preset registry 轮询。
- HEAD/tag 仍 `4738db0` / `v0.1.4`，版本/manifest/lock/vendor 不变；原先未提交 A1–A10 修改保留，无提交、tag、推送、发布、真实 profile/凭据读写或全局替换。

## 前次工作树：原生接口审计确认问题修复（未提交）

范围为此前 A1–A10 确认的正确性问题；实现与每项防回归见 [修复对照](NATIVE-API-FIXES.zh-CN.md)。基于本地 `v0.1.4` / `4738db0` 与 DSH `0.2.2-rc.1`，不改版本／依赖／lock／tag，不增加可选原生能力或重做 Harness。

- **完整 `pnpm check` 1833/1833**，139 测试文件，vendor/src build＋strict TypeScript，0 fail/cancel/skip/todo，tests **381514ms**；`.cache/native-api-fixes/full-check-first.log`。这是本轮新执行结果，不是旧 tag 验收数字。
- **真实 native correctness 场景**：inline/fullscreen 下精确 `/review` Enter 注入原生 Skill、不执行 `review-all`，后者显式输入仍正常；commands/change 自动刷新无需 Help。真实 max-tokens 在 live 与显式恢复后恰好显示一个提示。
- **4 个真实 native plugin PTY fault 场景**：Settings flush/Backend close × 两 renderer，实际进入 I/O hold，终端先恢复，退出由 DSH 既有 5000ms whole-tree protection 接管；首次请求码 0，未添加私有退出控制器。ANSI `.cache/native-api-fixes/exit-pty/`。这不证明以前用户现场退出卡住的具体根因。
- **真实 native 文件 API**：saveFile/admitPromptContent/createUserMessage/readFileStream 与 live/cold 只读投影；mixed/repeated/file-only 可见，metadata/源事件不改写，bytes 完整，files 不当作 images。另有 native canonical/folded header + real Cordis waterfall effort provenance 回归。
- App 测试覆盖单次 trailing command reread、旧 attachment、Esc dismissal、Help query/draft/focus、title unknown/null/cache retry、原生 name/hint、权限确认与 shutdown reentry；正常 streaming 无新 settlement diagnostics。
- 早期两个 parent fixture 控制错误（错误地用 generic `/permission` 打开 Settings picker、只给 queued 数字却没有队列行）及 TS assertion-binding 问题已纠正，未改变 native routing/queue policy 或削弱 guard；初次失败日志留在同一 cache。
- 所有测试使用 owned temporary homes/workspaces 与 hermetic streams；未读取真实凭据、改变真实 profile／会话／全局安装或请求真实 Provider。未提交／打 tag／推送／发布；原静态鲸鱼与通用终端图标不变。没有新增 GUI／OS popup 或历史现场问题验收。

## 前次：v0.1.4 本地版本标记

用户明确选择 **v0.1.4**，收录当前已验收的源码／测试／文档，只创建本地版本提交和 annotated tag；没有推送、registry／GitHub release 发布或全局安装替换。生产仍为 native DSH app bundle＋同进程 Cordis 插件，DSH 的模型／工具／权限／Skills／会话所有权不变。

- **最终完整 `pnpm check`：1761/1761**，131 个测试文件，vendor/src build＋strict TypeScript，0 fail/cancel/skip/todo，tests **345991ms**；`.cache/release-v0.1.4/full-check.log`。包含静态鲸鱼标题、Rex-only terminal 分类、协议 CLI/PTY **8/8**、native DSH terminal fixtures **2/2** 与既有输入／弹窗／Skills／Subagent／终端恢复回归。
- **版本一致性**：package metadata、`src/version.ts`／`lib/version.js`、alias `--version` 与 welcome 为 **0.1.4**，`private:true`；依赖、lockfile 与 vendored Pi 版本不变。首次完整检查仅两个旧版固定断言失败，更新断言到本次版本、保留原 guard 后完整复跑通过；旧失败证据 `full-check-first.log` 保留，不冒充首轮成功。
- **启动 identity CLI/PTY 6/6**：inline／fullscreen × Kitty／none 启动页四场景，加两种 renderer 外部 SIGINT；可见 v0.1.4、静态字符 logo、草稿／resize、正常退出 0／SIGINT 130 与 terminal restored 全通过。`.cache/release-v0.1.4/identity-pty.log` 与 `identity-pty/*.ansi`，使用私有 HOME／DSH_HOME／config。
- **终端实机证据边界**：此前静态标题真实 Rex App **2/2** 和独立原生 `>_` 图标 GUI 对照保留在下面阶段记录，本轮打 tag 没有重新执行 GUI 对照。Ghostty GUI／OS popup、原自定义标题恢复与用户现场退出卡住仍不作成功／已修复声明。
- **Git／数据边界**：只提交源码、测试、文档、正式图标资产及版本 metadata；构建产物、缓存、运行状态和凭据不进入 Git。源码候选路径／大文件／credential-shaped literal 的脱敏审计通过，测试只用临时 homes/workspaces 与 hermetic streams，零真实 provider 请求，不读取或改写真实 profile／凭据。

以下记录保留各开发阶段当时的版本、未发布状态和测试结果；tag snapshot 的 1761/1761、正确性修复的 1833/1833 与适配层收敛的 1861/1861 是三次独立验收。

## 打 tag 前：移除鲸鱼前的标题动画（当时未发布）

- 按用户要求，标题仅为 `🐳 <native/fallback title>`；删除星号／工作帧常量、标题状态参数、snapshot 动画 tick、App 传入和标题专用 Reduced-motion 字段。不是暂停或隐藏动画。Rex `app=terminal` 的原生 `>_` 图标、DSH 原生标题／状态／通知、普通 Working／Subagent UI 时钟保留。
- **当前 build＋strict TypeScript＋专项 111/111**：UI terminal 40、App terminal 25、图标 6、record/URI/reconnect races 4、native DSH 2、App logo 3、App theme 13、UI theme 11、Welcome 7；`.cache/rex-static-title/focused.log`。两 renderer 的工作／审批／结算超过原标题切换周期仍不写标题，native title不被装饰回写、draft／Editor／状态分类不变。
- **真实 Rex App 2/2**：标题 query 为 `🐳 dsh-tui · workspace`，working 不改变标题，捕获的 app title events 无额外装饰；状态／kinds／独立 child／原生图标分类／终端清理／无重复通知仍通过，零模型调用；`.cache/rex-static-title/rex-live.log` / `rex-live/*-result.json`。**CLI/PTY 8/8** 同时验证静态前缀、Rex terminal 分类、generic dsh-tui 分类、Ghostty 和 opt-out；`.cache/rex-static-title/pty.log`。
- 本轮未重跑全量；下一节 **1761/1761** 是之前通用图标阶段的完整记录，不冒充本次结果。所有检查使用隔离 homes/workspaces，无真实 provider、配置／凭据改写或全局安装变更；版本和 manifest／lock 不变，没有提交／发布。

## 前次工作树：Rex 原生通用终端图标（未发布）

- 用户明确接受通用终端活动分类，只有 Rex 的 root／child／fatal OSC 7501 app 字段改为 `terminal`；其它终端仍 `dsh-tui`。DSH 应用／进程名／原生会话标题／直接通知名称与模型、工具、权限不变，`🐳` 标题工作帧保留。Terminal status Off／协议不可用时不发布图标专用记录，恢复 Rex 自己的进程图标。
- **真实 GUI 验证成功**：同一个隔离 Node.js 进程，仅将 `app=dsh-tui` 切为 `app=terminal`，Rex sidebar 与 pane header 从绿色 Node 图标变为内置 `>_`。不是仅看字段：两张应用窗口截图已对照，裁剪图 `.cache/rex-terminal-icon/native-icon-comparison.png`；`.cache/rex-terminal-icon/result.json`。未改程序名、Rex 配置／安装资源／OS 权限；测试 session 删除，原可见 DSH tab 用标题再次确认并恢复。
- **当前 build＋strict TypeScript＋完整测试 1761/1761**，131 文件，0 fail/cancel/skip/todo，tests **342375ms**；`.cache/rex-terminal-icon/full-test.log`。本次执行 `pnpm build`／`pnpm typecheck`／`pnpm test`，不把历史 `pnpm check` 1759 当作本轮结果。
- **专项 77/77**：UI terminal 40、App terminal 25、图标 6、record/URI/reconnect races 4、native DSH 2；`.cache/rex-terminal-icon/focused.log`。新增 root/child/fatal 的 Rex-only 分类、Ghostty 显式身份优先于继承 Rex hints、status Off 不强发图标记录、直接通知仍名为 dsh-tui；native title／composition 字节不变。
- **实际 Rex App fixtures 2/2**：root/child `app=terminal`、状态／审批／问卷／独立 child／`🐳` 两帧、退出模式清理与无重复通知，零模型调用；`.cache/rex-terminal-icon/rex-live.log` 与 `rex-live/*-result.json`。完整测试含 CLI/PTY **8/8** 与 native DSH fixtures **2/2**，PTY 明确断言 Rex 为 terminal、generic 为 dsh-tui。
- 版本／manifest／lock 不变，没有 commit/push/publish、全局可执行替换、真实 provider 请求或用户配置／凭据改写。自定义像素鲸鱼 SVG/PNG 仍仅为分发资产，未把它们上传给 Rex。

## 前次工作树：Rex `🐳` 动态标题（未发布）

- 用户明确选择标题符号方案与 `🐳`。Rex 正常标题前缀为 `✦ 🐳`，仅原生 root working 使用 `⠂/⠐ 🐳`；按 App 原有 100ms 时钟每十个 tick 切换，不新增 timer。Terminal title Off 停止发送、Reduced motion 固定工作帧、blocked/settled/idle 停止移动，子代理不聚合到 root busy；其它终端保持原有标题。DSH 持久化 title、app id、模型／工具／权限与通知行为不变。
- **完整 `pnpm check` 1759/1759**，131 文件，vendor/src build＋strict TypeScript，0 fail/cancel/skip/todo，tests **343095ms**；`.cache/rex-title/full-check.log`。包含新增图标资产 6 与标题 9 个回归，不把前阶段计数当作本轮全量。
- **专项 75/75**：UI terminal 38、App terminal 25、图标 6、record/URI/reconnect races 4、native DSH title/composition 2；`.cache/rex-title/focused.log`。实际 App 两 renderer 的既有时钟驱动两帧，100ms 重绘不逐帧写标题；审批／结算／Reduced motion 停止移动，不重发 program status、不新增 backend calls／prompt、原 Editor/草稿不变。
- **真实 Rex 2/2**：`scripts/rex-terminal-smoke.py` 自有 session 的 `title_changed` 同时收到 `⠂ 🐳` 与 `⠐ 🐳`，native state/kinds/child/title/workspace/模式清理及无重复通知仍通过，零 model calls；`.cache/rex-title/rex-live/*-result.json` / `*-events.jsonl`。这是协议／server title 事件验收，不冒充 GPU/OS popup 截图验收。标题栈原自定义标题恢复仍明确不支持。
- **协议 CLI/PTY 8/8**（Rex、generic、Ghostty、opt-out × 两 renderer）通过；全量含同一测试脚本的回归。所有测试使用临时 homes/workspaces／hermetic stream。没有真实 provider、配置／凭据改写、commit/push/publish、版本变更或全局安装替换。

## 前次工作树：应用图标资产（未发布）

- 已生成自包含 SVG、512px 与 64px 透明 PNG；沿用现有鲸鱼 grid／资产蓝，启动 logo、主题、终端协议和 DSH 业务源码未改变。
- 专项 **62/62**：新增图标 6、App logo 3、App theme 13、UI theme 11、Welcome 7、App terminal 22；384 几何 sample centers、透明角、512／64px 尺寸、白色主体、package assets 包含、只读生成器一致性均通过。`pnpm typecheck` 与生成器独立 strict TypeScript 检查通过，`git diff --check` 通过。所有执行使用临时 homes，无真实 provider 请求。
- 本轮只新增资产／开发脚本／测试／文档，**未重新运行全量**；下一节的 1744/1744 是终端适配阶段的完整记录，不冒充新增图标后的全量结果。
- 当前 Rex 未发现公开项目级自定义程序图标接口；图标资产完成 **不等于原生 tab／pane 图标显示接入**。未改用户 Rex 配置／资源／tab，也没有冒充其它 app id 或加标题 emoji。边界见 [APP-ICON](APP-ICON.md)。

## 前次工作树：Rex / Ghostty 终端协议（未发布）

用户要求深度对照 Grok Build / Claude Code 对 Rex 的通知、状态和 tab 信息，适配 Rex 与 Ghostty，并保持 DSH 原生特性。生产仍为 native DSH app bundle＋同进程薄适配，版本 **0.1.3/private**；没有 commit/push/publish、全局可执行替换、真实 profile/凭据改写或真实 provider 请求。

- **最终完整 `pnpm check`：1744/1744**，130 文件，vendor/src build＋strict TypeScript，0 fail/cancel/skip/todo，tests **332664ms**；`.cache/terminal-integration/full-check.log`。复核补齐 reply quarantine（整条/多块超长均不漏入 Editor）、emergency 后 stop、native ready 恢复、65 并行 command activity 等边界后最终复跑通过。首轮 **1731/1731** / 129 文件保留在 `full-check-first.log`，不替代最终结果。
- **真实 Rex 2/2**：`scripts/rex-terminal-smoke.py` 只创建自己的 session，public CLI 查询 program_status/title/pwd/modes/process。idle→working→done、approval permission、question、whole-turn cancel idle、native error、root done＋child working 均正确；Automatic 无额外 OSC 777 request，exit 0，paste/focus/mouse/alt/sync modes 与记录清理。`.cache/terminal-integration/rex-live.log`、`rex-live/*-result.json` / `*-events.jsonl`。未捕获用户现有 pane，OS 通知授权/弹窗未被假设。
- **标题栈限制的真实负证据**：owned Rex probe 先设 synthetic 原标题、CSI 21 查询，再 CSI 22/23 保存/恢复。查询零回复，最终仍为临时标题；CLI 两模式同样不能恢复原 synthetic 自定义标题。因此结果明确 `titleStackRestored:false`，不以 terminal mode restored 冒充 title restored。`.cache/terminal-integration/title-query/`。Ghostty 匹配版本 GUI 源码也忽略标题栈；最终由 shell integration 重设，不修改终端配置来绕过。
- **新 CLI/PTY 8/8**：Rex-compatible reply、其他支持者 reply（证明非品牌 gating）、Ghostty DA-only/focus/OSC777 fallback、PI_PROGRAM_STATUS=0 × inline/fullscreen。完成/待审批/待回答、whole-turn cancel、真实焦点与 pasted CSI I 隔离、focused completion 无通知、进度/退出恢复通过；零 model calls，独立临时 homes/workspaces。`.cache/terminal-integration/pty-terminal.log`，`test/acceptance-terminal-integration-pty.test.ts` 纳入完整检查。
- **真实 native DSH 2/2**：两 renderer 使用真实 composition 和 hermetic stream，确认 durable turn/end→Turn complete、原生 SessionTitleService.rename 的 title projection/change 传播、/new 后显式 /resume 的 title baseline、历史不生成新 completion、provider 保持 disabled/read-only、合成 profile patch 逐字节不变，没有多发 user prompt。`.cache/terminal-integration/native-terminal.log`，`test/acceptance-terminal-native.test.ts`；没有 live provider 请求。
- **独立 parent 回归**：App/VT：通知隐私、同一主草稿/Settings、原生 title/null/attachment 守卫、命令成功/失败≠turn、其他工作防止提前完成、65 command activity map 不受小 correlation cache 淘汰、fatal/normal close、ready/重复失败恢复。协议 races：DA 后迟到 reply、支撑回调重入、emergency late clear/title/heartbeat、分片 focus、旧 child 先清后增避免 root 瞬时淘汰、Unicode joiner/非法 UTF-16、整条及多块超长 reply 不进入 Editor。
- **Ghostty 证据限度**：安装版 1.4.0 的匹配源码/公开 VT 参考和协议 PTY已验证。尝试 `config-default-files=false`、私有 HOME/config、window-save-state=never 的 owned 新实例，未得到有效窗口，激活观察遇到 CoreGraphics deadline；按 unsafe retry 规则未盲目重复或物理注入，已只清理自己启动的实例。没有截图/GPU/IME或 OS popup 成功声明，也没有授予或修改系统通知权限。
- **最终独立专项 41/41**：App terminal 22、parent record/URI/reconnect races 4、terminal protocol races 6、reply recovery 7、native DSH 2，`.cache/terminal-integration/final-focused.log`。此后完整 1744/1744 包含相同当前代码的所有回归；实际 Rex **2/2** 与协议 CLI/PTY **8/8** 又在最终全量运行期间复跑通过，`rex-live.log` / `pty-terminal.log`，零 model calls。
- **保留的设置回归 17/17**：当前新 General 行下的 App modal／单页 Settings CLI/PTY、Tab/Shift+Tab/左右、鼠标 press-no-frame、Keyboard 返回与 typed enum/reset 保留；脚本不再硬编码 General 四行。`.cache/terminal-integration/settings-regression.log`。
- **DSH 边界**：Terminal integration 只消费原生事实和现有 activity map，不创建第二 Harness、Agent loop、调度器、模型 catalog/auth、标题 provider 或 Rex socket/CLI生产依赖。`/permission` 和 `/plan` 独立，显式 resume 不变；CLI/PTY 只是 fixtures。指南：[TERMINALS](TERMINALS.md)；对照：[研究](TERMINAL-RESEARCH.zh-CN.md)；映射：[Native mapping](TERMINAL-NATIVE-MAPPING.md)。

## 前次工作树：弹窗与设置重设计（未发布）

按用户确认的 Grok Build / OpenCode 方案，统一 prompt-slot 弹窗为真实 overlay，保留唯一主 Editor 挂载与草稿；Settings 在用户反馈后改为可搜索、可滚动的连续单页分组，不再采用多个 tab 页面，并补齐近期展示能力。应用版本仍为 **0.1.3/private**；本轮未 commit／tag／push／publish，未修改真实 profile／凭据／会话或全局安装。

- **该阶段完整 `pnpm check`：1646/1646**，121 个测试文件，vendor/src build＋strict TypeScript 通过，0 fail/cancel/skip/todo，tests **293564ms**；`.cache/settings-single-page/full-check.log`。全量包含新的单页 Settings CLI/PTY 两模式测试。
- **单页 Settings 收口**：删除 tab/segment 栏和分类过滤，所有分组共享一张列表及其 viewport；Up/Down 跨组，Tab/Shift+Tab 或 Right/Left 只跳分组位置，查询和 roster 不变。保留类型化编辑/单项 reset/异步错误/Keyboard 返回/草稿与图片/只读 native auto-title。`SettingsViewState.category` 只表示当前行所属分组。
- **输入与鼠标**：证实缺失的 Tab 默认绑定及 Shift+Tab 落入全局 `app.mode.cycle` 后被弹窗忽略；修复只限 Settings context，不改根 `/permission` 或其他 modal Tab。组标题/空白为 inert chrome，pin-only press 显式 `render:false`；parent App 断言 enum click 只有 release 的一帧，native metadata 同帧只读一次。列表/picker 用已有 bracketed-paste filter 拒绝粘贴控制字节，未完成粘贴期间鼠标不能改换输入目标。
- **本轮 CLI/PTY 12/12**：单页 Settings 两模式 **2/2**（全组/搜索/Tab/Shift+Tab/左右/短 viewport/Keyboard 返回；fullscreen 4 次真实 SGR picker 往返且 press 零输出）、键位编辑/resize **2/2**、取消/退出/Settings 中断 **8/8**（SIGINT 场景预期 exit 130，其余 exit 0），全部 terminal restored、临时 home/workspace、无模型请求。`.cache/settings-single-page/pty-settings.log`、`pty-cli-keyboard.log`、`pty-cancel.log`。旧 busy-Settings PTY 改为先关覆盖层再检查 ready，避免用被弹窗遮住的底栏判断状态，同时断言未自然完成回合。
- **本轮 native Settings 2/2**：临时原生 DSH composition 的两 renderer 均显示连续单页，Tab/Shift+Tab/左右正常，不发 user message，原生 auto-title 保持 disabled/read-only，会话与草稿保留，profile patch 逐字节不变。`.cache/settings-single-page/native-settings.log`。没有真实 provider 请求。
- **性能证据限度**：旧离线 fixture 分类鼠标手势是两次重绘、方向键一次；未复现用户真机的严重延迟。新的真实 PTY 4 次鼠标 release 到首个重绘字节 **2.13–2.92ms**，不包含终端实际 GPU 显示延迟，不冒充用户终端现场确认。
- **legacy auto-title 告警跟进**：旧 `settings.json.autoTitle` 静默忽略，不再在启动或 `/reload` 输出兼容告警；下次正常保存清理旧键。未知键与有效配置错误仍可见，启动／reload 保持文件逐字节不变，也不修改 native title 状态。build＋strict TypeScript 与 config／App／配置验收相关 **103/103** 通过（`.cache/legacy-auto-title/after.log`），两 renderer CLI/PTY **2/2** 验证无告警、exit 0、terminal restored、零 model calls（`.cache/legacy-auto-title/pty.log`）；当时未重跑全量，现已包含在上面的 1646/1646 内。
- **并行优化阶段完整 `pnpm check`：1624/1624**，119 个测试文件，vendor/src build＋strict TypeScript 通过，0 fail/cancel/skip/todo，tests **275724ms**；最终日志 `.cache/dialog-implementation/full-check-optimization.log`（并行优化、父级收口与新增几何回归后的最终构建与全量测试）。
- **共享 ModalFrame**：统一标题／边框／关闭／实际裁剪后的 action 与键位提示、measure-first body、正文鼠标坐标、ownerKey 目标守卫和 press 失效保护；正常终端保留状态栏可见的页边距，极矮终端降级为紧凑标题＋可操作 footer。没有新增 renderer、rgba backdrop、第二输入系统或竞品代码。
- **单一 Editor**：Settings／Model／Resume／Help／Decision 等不再替换 prompt slot，而是在冻结的主 Editor 之上打开 overlay。两类 renderer 的 App 测试验证草稿、图片 registry、undo、focus、关闭后恢复同一 Editor；迟到模型／preset／effort 结果不能替换新 surface。
- **Settings 完整入口**：General / Thinking / Tools & Diff / Agents / Images / DSH / Keyboard；15 个原有本地键 + 6 个新展示键，auto-title 移到 DSH 只读原生状态行。布尔／枚举／数字与自定义数字编辑分开，单项 reset，保存失败只回退该键可见，`captureView` 恢复分组位置／行／查询／滚动；Settings → Keyboard → Back 不再回 General。
- **Agents 解耦**：`groupSubagentMessages` 独立于 `groupTools`，旧配置首次读取按当时 Tools 值迁移；迁移后 reset 使用 Agents 自身默认。Agents overlay 搜索／Active-All／稳定原生 id／返回状态；Child 错误在当前 surface 显示。进度保持两行与实际活动，新增隐藏开关；hover／选择不 follow、不 stop，不新增调度。
- **Inspector／图片／队列**：Tools wide frame、I/O 查找、可选调用列表、wrap、真实源 copy；Image wide frame、`auto`／`text`（text 零 `readImage`）、`p` 切换、abort 旧读、迟到结果不绘制；Queue 弹窗按原生 message id 操作，失败留在当前弹窗，图片编辑 fail-closed。Help 增加按需搜索且只读 Skills 语义不变；Resume/Model/Select/Decision 有 loading／empty／no-match／error。
- **模型实际缺陷修复**：异步 model roster 首次到达时，旧的空 picker 会错误选择名册第一项而不是 session 当前 provider；现在先尊重显式 `currentProvider`／`currentModel`，仅在 provider 不存在时回退。旧 `/effort` 结果在 attachment 已切换后仍可打开窗口的问题也改为关闭并返回 Settings。
- **审查修复**：`/new` 现在把 app 已 staged 的 preset 传给 native pending session；`queue-send-now` 先完成附件 admission 再移除旧 native entry，失败不再丢队列；Queue 弹窗状态行纳入同一 measure，body hitbox 不再落入 chrome；窄 QueueList 行严格限宽且裁掉的 chip 没有 hitbox；图片队列行禁止直接 Edit；Select/Decision/Model 的 press 不再提前移动窗口；Settings 粘贴中的 Ctrl+C 不触发回合中断、所有 cancel action 禁用时物理 Esc 仍可退出、短 picker 自动滚到选中项；Keybindings 保存中仍可 Esc 返回；Agents 滚轮不再每帧回弹；Tools 查找字段优先拥有按键/chord。均有专项回归。
- **并行优化已收口**：Settings/Keybindings 迁移到共享 `ModalListSurface`＋`windowList`，删除重复窗口与 mouse 管线；新增短 frame 状态行测量、超高聚焦行回填回归。auto-title 不再调用 Loader entry update，也不再保存/应用本地 on/off；旧 key 只读忽略并在下次无关 TUI 写入时清理。Resume backend 保留 `sessionQuery` 原生顺序，删除逐条 stat/mtime 排序；picker 只过滤不重排。connect 前 Esc 的 positional prompt 通过延迟连接回归验证只发送一次；嵌套 Settings `[×]` 先返回上一级。
- **前一阶段离线 CLI/PTY 23/23**：Tools 2、Help 2、Model 2、Subagent progress/links/retirement 6、Skills 2、Images 4、Theme 2、Thinking 3，全部 exit 0／terminal restore、临时 home/workspace；日志在 `.cache/dialog-implementation/pty-optimization-*.log`。
- **真实 DSH 入口**：native model picker **2/2**＋native Skills CLI/PTY **2/2** 单独复跑通过，`.cache/dialog-implementation/native-optimization.log`。另有 auto-title native 探针：disabled provider 的开启请求 fail-closed、状态保持 disabled、profile patch 逐字节不变，生产 Settings 显示 `Off · read-only`，`.cache/dialog-implementation/native-auto-title-smoke.log`。没有真实 provider／vision／GPU／IME 请求，也不以 demo PTY 冒充 native profile。
- **范围**：原生 model／tool／permission／preset／Skills／session／credential ownership 不变；没有通用 profile schema 自动表单、credential 读取、本地队列／调度器或第二持久化。`/permission` 与 `/plan` 仍独立；用户现场的真实 profile 行为仍需用户实际使用确认。

## 前次工作树：Enter 直接提交选中 slash／skill（未发布）

用户已确认 Skills 目录能显示，随后报告 `/skill-stu` 必须先 Tab 才能使用，Enter 不能直接使用选中项。复现并确认：Enter 外层提前捕获 `CcSubmitPayload`，补全虽然改了 Editor，但 App 的 `onSubmitContent` 收到的仍是旧前缀；旧 text-only 测试与先 Tab 的流程掩盖了这一点。

- **完整 `pnpm check`：1408/1408**，112 个测试文件，build＋strict TypeScript 通过，0 fail/cancel/skip/todo，tests **270023ms**；`.cache/autocomplete-enter/full-check.log`。版本仍 `0.1.3/private`，没有提交／推送／发布或改全局安装。
- **正确提交边界**：同一个 Editor 先应用当前选中项，之后通过 submit callback 捕获完整 payload／snapshot，再清空并交给 App。`/skill-stu` 单次 Enter 发送 `/skill-studio`；普通 native/UI 命令同样发送完整名字。Tab 和文件候选 Enter 仍只编辑，不提交／验证图片内容；没有第二 Editor 或外层 setText。
- **真实 DSH 回归 14/14**：保留目录／scope／user-only／命令优先 10 条；新增每 renderer 单次 Enter skill 与 native `/plan` 各一条。非 demo 生产 CLI/PTY 两模式不先 Tab，只有原生 canonical `skill-studio` 注入存在时 fixture 才返回专用 marker，因此不能拿旧的截断文字／普通模型响应冒充成功。`native-after.log`，也包含在完整检查里。
- **修复前实证**：新 direct-Enter native 测试在旧编译代码两模式 **0/2**，错误明确是 content-aware submit 未携带完整名字；修复后两模式通过。`native-before.log` 保留旧失败，不删／弱化断言。
- **输入／App 273/273**：全 input 套件 212、App Skills 29、native-boundary 7、图片 25。新用例覆盖 `onSubmitContent` 而非仅 legacy `onSubmit`、非首项、native command／UI Settings、单次消费、completed 图片内容／拒绝 snapshot 恢复、文件填入不提交、remap／undo／草稿。图片 registry 与 token/paste state 保留，native business/persistence 不改。
- **范围**：只修提交捕获时序与 app-specific private Pi seam callback；没有变更 DSH registry／provider／模型／权限／业务模式、依赖／lock／bundle、vendor source 或全局程序。全部使用合成图像／技能与临时 home/workspace、hermetic model stream，无真实 provider 请求；用户实例的 Enter 行为仍待这次重启后复测。

## 前次工作树：用户反馈后的 Skills 桌面对齐修正（未发布，目录显示已由用户确认）

用户确认 TUI 已重启且发送过消息、preset 为 standard，但 `/` 没有技能且 `/help` 没有 Skills；桌面截图可补全 `skill-studio`。只读核对文件名确认原生用户目录有 6 个技能且包含该项，没有读取正文或真实配置／凭据。源码对照确认初版错误地把人类目录绑定到 `tools.get('skill')`，又漏用了公开 preset scope lease；这些与桌面端不同。具体用户 profile 的运行结果仍需用户复测，不能以测试数字代替现场确认。

- **完整 `pnpm check`：1389/1389**，112 个测试文件，build＋strict TypeScript 通过，0 fail/cancel/skip/todo，tests **257233ms**；`.cache/skills-followup/full-check.log`。版本仍 `0.1.3/private`，无提交／tag／push／publish，依赖／lock／bundle／vendor source 未改。
- **原生 Skills 验收 10/10**：保留 canonical 注入／user-only／命令优先 4 条；新增用户目录普通首条消息后直接 `/skill-stu` 2 条，以及未发消息／无 Agent 时直接菜单 2 条（不经 Help 或手工 query 预热）；另有 **非 demo 生产插件／ProcessTerminal／输出 lease CLI/PTY 2 条**，临时用户目录 6 个合成技能，验证启动菜单、普通消息后的同前缀、Help／草稿／exit 0／恢复。全部在完整检查里通过，LLM 仅使用 hermetic fixture，不请求真实 provider。
- **修复前后证据**：新“未发消息菜单”验收对旧编译代码两模式 **0/2**，确实复现缺目录；新代码同场景 **2/2**。`startup-before.log` 保留旧失败，不删断言。普通消息场景在标准隔离组合原本能通过，不能由此断言用户实例的全部触发原因已确认。
- **Backend／input／App 加固**：目录只依赖 metadata registry（snapshot／list），不用模型工具门槛；live 优先 preset registry，pending 使用 DSH `acquireScope` 并 finally 释放；未响应 acquire 的 late lease 也释放。Unavailable／incomplete 不作为永久空缓存，相同前缀可再次查询，仍单飞／无 timer／不自动应用。Help 在缺 capability 时也保留 unavailable 区。focused Backend **26**、input **21**、App **21**；实际 VT／旧 Help／设置／异步模型时序专项 **75/75**。
- **额外 offline CLI/PTY 2/2**：原有 skills demo 再跑两模式成功，仍只是 frozen metadata／明确离线 acknowledgement，不能冒充真实目录；`demo-pty.log`。
- **架构／数据边界**：使用 DSH 公开已拥有的 preset revision lease，不新建 Agent、私有 Context／Loader／provider、目录扫描器、profile 镜像或模型 transport。没有复制 Skills 正文／实际 provider／凭据／会话。真实远程模型、vision／GPU／IME 和用户现场 profile 未作自动验收；退出卡住问题仍未在本轮修复。

## 前次工作树：原生 Skills 初版（未发布，目录门槛与启动语义已修正）

在 `86061ba`／`v0.1.3` 发布基线上接入 Skills 元数据、原生 `/name` 输入路由和只读 Help。应用版本仍为 **0.1.3/private**；本轮没有提交／tag／push／registry publish，也未修改真实 profile、凭据、技能正文、会话或全局安装。生产仍是 native DSH bundle＋同进程薄适配，Agent／provider／工具／权限／注入归 DSH。

- **完整 `pnpm check`：1370/1370**，110 个测试文件，vendor/src build＋strict TypeScript 通过，0 fail/cancel/skip/todo，tests **248335ms**；`.cache/skills/full-check.log`。初次全量发现 UI-owned 命令被额外 async classification 延迟、以及旧 Help End 断言未覆盖新增 Skills section；保留原生 `/model`／`/effort`／`/settings` 即时调用时序后复跑通过，Help 改为确实检查 End／Home／PageDown 的命令与技能可达性，不删断言。初次日志保留为 `full-check-first.log`。
- **新增专项 79 条**：backend 19、input 17、App／真实 VT 19、Skills Help 12、demo contract 7、原生 Skills 4、原有 Help omission-regression 1。覆盖 metadata whitelist／无正文 get、resolved user-only／model-only、scope／cwd／不完整与不可用、首次命令优先／部分服务 fail-closed、native invalidation／close／旧读、Tab／Enter／文件参数／undo／图片草稿、Esc tombstone／同 attachment preset／replacement／child 回复范围。
- **真实 DSH＋hermetic stream 4/4**：两 renderer 各验证首条 literal `/name` 由 DSH pre-step 加载并注入一次 canonical body、user-only 技能原生可用／model-only 不进用户目录、实际 Cordis `skills/change` 传播与候选更新／删除；另各验证 pending global 目录缺 `/plan` 时首条 `/plan off` 仍走 scoped native command、产生日志但不送模型。使用临时 HOME／workspace／合成 SKILL.md，真实 provider 从未调用。脚本为 `test/acceptance-skills.test.ts`＋`test/fixtures/skills-stream.mjs`，也在完整检查内通过。
- **单独 CLI/PTY 6/6**：新 `pty-skills-smoke.py` inline/fullscreen **2/2**（native-name 补全、Tab 不提交、literal offline skill acknowledgement、user-only、Help readonly／草稿／resize／同名 command／exit 0／终端恢复，私有 home/workspace）；原有 Help 与 model picker 两模式 **4/4** 回归（readonly、query kill／yank／undo、空结果 Enter、草稿、provider keys／resize、退出恢复）。证据 `pty-skills.log`、`pty-regressions.log`、`pty/*.ansi`。
- **本地编译归档 304 entries**：解压后 App／backend／Skills helper／NativeAutocompleteProvider／Help 导入、private Pi Editor seam 的 `ccRefreshAutocomplete`、native `/name`／user-only／同名 command priority smoke 通过。archive 不含 src/test/cache/runtime/node_modules，依赖只链接已安装项目依赖，不冒充 clean install。`package/import-smoke.log`；归档是未发布工作树产物，不替换 v0.1.3 release artifact/tag。
- **明确边界**：全新 pending 会话不为填菜单建立 Agent，返回 unavailable；首次可手打 `/name`，目录在原生 Agent 建立后可用。`minimal` 不挂 skill tool；根目录不假冒 child scope。没有新目录扫描器、正文展开器、model transport、timer／Agent loop、配置层或依赖。真实远程模型／vision／GPU／IME 未在本轮验收；之前的用户退出卡住问题仍未修复。

## 前次：v0.1.3 发布验收

用户明确确认按 `0.1.3/private` 提交当前已验收改动，并推送 `main` 与 annotated `v0.1.3` tag；不发布 registry、不改全局安装。版本统一来自 `package.json` 与 `src/version.ts`，功能范围为 Subagent 启动／退场、动态进度、记录分组与名字-only 导航。**用户退出卡住仍未解决**：下面的正向 native 退出场景与 fault probe 只是调查／回归，不是现场修复声明。正式 release 证据集中在 `.cache/release-v0.1.3/`。

- **发布源码完整 `pnpm check`：1291/1291**，104 个测试文件，build＋strict TypeScript 通过，0 fail/cancel/skip/todo，tests 236398ms；`full-check.log`。其中的 real DSH 模型流使用 hermetic fixtures，不调用真实 provider。
- **版本一致性**：package metadata、`src/version.ts`／`lib/version.js`、CLI `--version` 和 welcome 为 `0.1.3`；`private:true`，依赖与 lockfile 不变，vendored Pi 版本不改。
- **Subagent CLI/PTY 10/10**：record-links、progress、links、retirement、controls × inline/fullscreen。所有 case exit 0／restore，名字-only 两类消息／group 控制、共享 Working 帧／root-ready、退场与 `/agent` 历史、原生形状的 Reply/Stop/follow-up、复制／草稿／resize 都通过；private copy packets 不碰真实 clipboard。`pty-records.log`、`pty-progress.log`、`pty-links.log`、`pty-retirement.log`、`pty-controls.log`。
- **启动 identity CLI/PTY 6/6**：两模式 × Kitty/none 静态 logo 共 4 case 验证可见 `v0.1.3`、idle／draft／resize／exit 0，另 2 external SIGINT case 验证 exit 130 与终端恢复；没有 GPU 像素或真实模型声明。`pty-identity.log`。native live-child 的 6 个正向退出场景仍在完整测试里通过，不等于用户退出问题已解决。
- **编译归档 300 entries**：本地 `dsh-tui-0.1.3.tgz` 导入 App/backend/Progress/Group/Link/Child，metadata／CLI／welcome 0.1.3，动态帧／两行活动／退场／facts group／展开／sender name-only click smoke 通过。仅链接现有依赖，不冒充 clean install；`package/entries.txt`、`package/import-smoke.log`。
- **Git／数据边界**：发布前 main 与本地基线 `fd29693` 一致、v0.1.3 不存在；本次只推 main＋annotated tag、不 force、不替换旧 tag。源码／测试／文档／manifest 进入提交，lib／vendor dist／缓存／运行状态／凭据不进入 Git，不修改真实配置或全局可执行文件、不发布 registry。

## 发布前：Working 动画、Subagent 分组与名字导航（基于 v0.1.2）

本节保留发布前的工作树状态：当时包为 `0.1.2/private`，HEAD／原 `v0.1.2` tag 为 `fd29693`，尚未 commit/push/tag/publish；这些功能现在纳入 v0.1.3。

- **完整 `pnpm check`：1291/1291**，104 个测试文件，build＋strict TypeScript 通过，0 fail/cancel/skip/todo，tests 约 238 秒；`.cache/subagent-ui-followup/full-check.log`。版本／welcome／private import seam／原生插件与既有控制回归保留。
- **动态进度**：Editor Working 与 above-editor native running／initializing 共享原有 App 的 100ms 时钟和 `· / ✻ / ✶ / ✳` 帧；组件只接收 `spinnerFrame`，没有独立 timer／listener。root-ready 时 child 仍转，但不改 root busy、OS progress、退出确认、原生时间／tokens 或模型调度。两行摘要＋活动不变，全结算即退场并停止空闲动画；历史 transcript 不动画。
- **连续记录分组**：view 层纯 fold 将相邻 catalog 状态行、subagent-settled／agent-message facts 组成 Tools 风格组，保留各记录身份／seq／sender／原文，真实 user／assistant／tool／attempt／notice 等边界终止分组。不创建持久化 group fact，也不查新 catalog/session。共用 `groupTools` 与 Ctrl+O；组标题是 disclosure，展开正文纯选择／复制，绝不作为 child 导航或折叠区域。
- **名字限定全面覆盖**：progress、原始 transcript child 状态行、两类 durable 消息、折叠／展开 group members 都只有可见名字是品牌蓝＋粗体＋下划线内部链接。sender 显示已有 native catalog label，未知／external 则普通标识不伪造链接；正文、归属标题、glyph、guide、模式／状态／hint 和空白不导航。最终 clip／CJK／ZWJ 列几何正确；motion／drag unclaimed，outside press→label growth/catalog arrival 与 claimed press→消失再出现不能复活导航。没有 OSC8／浏览器 URL。expanded prefix／childWidth／mouse offset 统一 2 columns，不二次过裁正文。
- **父级 App／独立 VT**：`test/app-subagent-records.test.ts` **15/15**，progress／动画 **25/25**；两类 durable message 的 collapsed／expanded／groupTools=false、真实 underline／bold／CJK 边界、所有非名字点击、原始 catalog 行、header／Ctrl+O、native selection/copy、hover 后 first drag、late catalog 与消失重现、图片草稿、child/store 隔离均覆盖。动画测试无需第二 backend event 即看到帧变化，root stays ready，root 和 child glyph 同帧，全结算不再 repaint，空 root exit confirmation 不被动画拦截。证据 `app-records.log`、`app-records-progress.log`、`app-progress-startup.log`。
- **frontend 专项 127/127**：Subagents 72、Progress 55，包含纯 grouping boundary／stable facts／shared disclosure、link 生命周期／partial clip／多行 label flatten、prefix 重基准，以及 one-cell spinner fallback／pinning；完整运行还有全部 UI 与 input 旧回归。formatter 只 flatten paint，不改 native text。
- **离线 CLI/PTY 10/10**：record-links／progress／progress-links／retirement／controls × 两 renderer，全 exit 0／terminal restore。新 record-links case 覆盖两类消息与目录分组，fullscreen 10 个非名字点击不导航、两个实际名字都进入对应子会话，header／Ctrl+O 折叠展开，原草稿返回。progress case 验证 root-ready 的真实动画帧；既有 name-only selection／16 negatives／overflow、Stop→Reply→follow-up／target exit、`/agent` 历史与结算退场回归通过。所有 OSC52 包只在私有 PTY 捕获，不接触真实剪贴板。证据 `pty-record-links.log`、`pty-progress.log`、`pty-links.log`、`pty-retirement.log`、`pty-controls.log`。
- **真实 native exit 的正向对照 6 场景**：`test/acceptance-subagent-exit.test.ts` 在临时 profile／hermetic stream 里验证 genuinely root-ready＋live continuable child 的 Ctrl+C-confirm、`/exit`、external SIGINT，两 renderer 共 6，全部正常结束／恢复。此测试在完整 check 内；不宣称已复现用户现场不能退出。原本的 parallel／approval／follow／continuation／interrupt native 4/4 也仍通过。
- **编译归档 300 entries**：App/backend/Progress/Group/Link/Child imports、0.1.2 CLI/private metadata、同款帧／两行活动／退场、原生 facts 分组／展开、compiled sender name-only click smoke 通过；只链接已有本地依赖，不是 clean install、不发布 registry。证据 `package/entries.txt`、`package/import-smoke.log`。
- **退出调查的边界**：子 agent 排查证明 native root `appExit` 会取消 child，且非协作 task 也受 native launcher 5s 保底；不能因此给 adapter 加 child drain。隔离 fault probe 复现 App 先恢复终端、后续 flush／drain／dispose 令 `app.exited` 永不结算的故障类型，native exit 因未被请求而无法启动。用户具体触发（清理等待／挂起／fiber unload／fatal restore 等）仍未确证；本轮未改变生产退出策略。报告／probes：`.cache/subagent-exit/`、`.cache/exit-hang/`。
- **范围**：没有真实 provider、profile／凭据／durable-user-session／clipboard 读写、服务器操作、全局安装或 Git 发布；native DSH lifecycle／models／tools／permissions／persistence 仍归宿主，单 Editor、private `#pi-tui` seam、两行布局、显式会话恢复都不变。日志／构建／归档保持 ignored，`git diff --check` 通过。

## 前次工作树：Subagent 启动响应与结算退场（未发布）

包保持 `0.1.2/private`，HEAD 与已发布 `v0.1.2` tag 仍为 `fd29693`；以下是发布后的本地修复，尚未 commit/push/tag/publish，不代表远程 tag 已包含这些改动。

- **原因与改动**：原来的名字点击已经发出 `subagent-follow`／`subagent-session`，但 App 等两次原生读取结束后才打开视图，中间没有加载反馈。新的同一个 `ChildSessionView` 立即显示 `Loading child session…`；之后用原生 snapshot＋最多 1024 帧缓冲更新同一个 store/view，没有占位 SessionInfo、第二 Editor 或新 Agent。backend 的初始 `local:true + initializing` 成员本来就可读，不需要驻留 child Agent，也不增加启动状态门槛。
- **完成项退场**：进度仅包含 native `running`／`initializing`；结算后立即从主进度区隐藏，全结算则释放整个 widget。header／overflow 仅统计已知活动项，完整目录、durable transcript、continuable 会话和显式回复目的地不删除；idle 回复目的地只显示在 Editor 提示，不把它当正在工作。根会话 `/agent` 仅导航已有 Agents 历史；手动打开的详情不强制关闭。保留摘要＋当前活动两行、名字-only 内部链接和非链接拖选／复制。
- **完整 `pnpm check`：1253/1253**，102 个测试文件，build＋strict TypeScript 通过，0 fail/skip/cancel/todo，tests 约 216 秒；`.cache/subagent-startup-research/full-check.log`。包括真实 DSH＋hermetic stream 的并行 child／审批／follow／continuation／interrupt **4/4**，没有真实 provider 请求。
- **父级 App 接入 54/54**：startup 15、progress 21、原有 controls 9、Help 9；`.cache/subagent-startup-research/app-targeted-expanded.log`。覆盖读取前可见加载、初始化无需等 running、加载时 Esc 不取消根回合、图片草稿、实时缓冲、失败可重开、同 id 旧 read／ack 不能 unfollow 新 owner、membership removal／新 attachment 的迟到拒绝，以及完成后的历史与再次激活。
- **CLI/PTY 8/8**：两 renderer × retirement／名字链接／上方进度／Stop-Reply。新的 retirement 场景证明原生 fixture 停止／继续／idle 结算后进度收起，显式 idle 回复目标不钉住进度，`/agent` 仍能看 durable follow-up，并恢复原草稿。fullscreen 仍验证实际名字点击、16 个非链接位置、hover 后 native drag/copy、header／overflow 字符范围；`subagent-many` 是明确的离线并行活动 fixture，不是生产模式。所有 case exit 0 与终端恢复；copy packet 只在私有 PTY 捕获，图片由 App 回归覆盖。证据：`pty-retirement.log`、`pty-links.log`、`pty-progress.log`、`pty-controls.log`。
- **原生 follow 加固**：`follow:true` 对 external／非本地成员 fail closed，与 child-session 读取一致；标准参数／能力校验后的释放不重查 membership。backend 专项验证首个 initializing catalog、无 child Agent 的 follow/read、已知 catalog follow 不等待 child transcript observation；没有新 wire／query、tree 并发优化、调度或持久化。
- **只读 Pi 对照**：`@tintinweb/pi-subagents` 0.23.1 `src/ui/agent-widget.ts` 的完成项按父回合年龄清理（正常 1 回合，错误 2 回合）；4 秒 linger 属于独立 `fleet-list.ts`，手动 `conversation-viewer` 不在完成时关闭。`pi-cc-extensions` 安装版 1.0.15／工作树 1.0.8 没有对应 Subagent widget。本项目按本次要求立即依 DSH 结算退场，不复制 Pi timer/runtime。
- **编译归档 296 entries**：本地 pack 的 CLI／welcome 仍是 0.1.2；解压后 App/backend/Progress/Agents/Child/actions 导入、initializing 名字链接、加载 shell 无假 SessionInfo、idle/truncated/回复目标退场、重新激活及两行活动 smoke 通过。仅链接已有本地依赖，不是 clean install、不发布 registry。证据：`package/entries.txt`、`package/import-smoke.log`。
- **范围**：Node 26.13.0／pnpm 12.6.0／macOS，仍是原生 DSH 同进程插件＋单 Editor。工程测试使用临时 home/workspace 与离线 fixture；没有真实模型／vision／GPU／IME 手感新声明，没有真实 profile／credentials／sessions／clipboard 或全局可执行文件改动。`git diff --check` 通过，源码改动未暂存；构建、归档与日志留在 ignored 目录。

## 已发布：v0.1.2 发布验收

按用户授权，本轮完整 Subagent 功能以 `0.1.2/private` 形成 release commit，并推送 GitHub `main` 与 `v0.1.2` tag；不发布 registry、不改装全局程序。版本号统一来自 `package.json` 与 `src/version.ts`，CLI／welcome 使用同一个值。

- **发布源码完整 `pnpm check`：1228/1228**，101 个测试文件，build／strict TypeScript 通过，0 fail/skip/cancel/todo，tests 阶段约 206 秒；`.cache/release-v0.1.2/full-check.log`。
- **CLI 与编译版本**：`node bin/dsh-tui.mjs --version` 返回 `0.1.2`；包 metadata、`lib/version.js`、解压后的 CLI 与 welcome 都为 `0.1.2`，`private:true` 保持。
- **Subagent CLI/PTY 6/6**：名字链接、上方进度、Stop/Reply 三组 × inline/fullscreen，全部 exit 0 与终端恢复；name-only 点击、原生拖选复制、草稿与键位路径不变，图片草稿由完整 App 回归覆盖。工程验收未调用真实 provider／模型、未触及真实剪贴板。
- **启动身份 CLI/PTY 6/6**：两 renderer × kitty/none 静态 logo＋外部 SIGINT；静态 logo 场景验证 `v0.1.2`，正常退出／SIGINT 130、resize、草稿和终端恢复通过。全部为离线 fixture 与临时配置。
- **编译归档 296 entries**：`dsh-tui-0.1.2.tgz` 解压后 App/backend/Progress/Agents/Child/actions 导入通过，CLI／welcome 版本与名字-only internal-link smoke 成功；仅链接已有本地 dependencies，不冒充 clean install。
- **Git/数据边界**：只提交源码／测试／文档／manifest，不提交 `lib/`、vendor dist、缓存、运行状态或凭据。发布前远程 main 与本地基线一致，`v0.1.2` 不存在；不 force、不替换旧 tag，分支和 tag 原子推送。

证据集中在 `.cache/release-v0.1.2/`；发布前的功能阶段验收保留如下。

## 发布前：Subagent 名字限定内部导航链接（基于 v0.1.1）

- **完整 `pnpm check`：1228/1228**，101 个测试文件，build＋strict TypeScript 通过，0 fail/skip/cancel/todo；tests 阶段约 210 秒。证据：`.cache/subagent-links/full-check.log`。
- **仅名字进入 child**：进度区可打开的 agent 名字为加粗、品牌蓝、下划线，hover 提亮；命中区来自最终 paint／clip 后的实际显示列。图标、导线、间隔、状态、时间、tokens、route、活动次行和空白不触发跳转。仅 `Agents`／`+N more` 文字进入完整树，计数和 chord 不可点。External／不可打开／无 callback 名字不显示伪链接。不使用 OSC8、浏览器或自定义 URL 协议。
- **选字／复制与手势**：所有 move/drag 与非链接 press 不抢占；原生拖选和 copy-on-select 保留，包括从 hovered link 离开后第一次 drag，以及跨名字链接的拖选。名字 press 以 child id 锁定；非名字 press 的 tombstone 经 reflow／同 id reattachment／temporary blocking 保留，之后移到该坐标的名字不能接受旧 click。drag 不变成跳转。Esc 返回同一个 Editor，草稿／图片保留；R/S、queue/steer 和原始 transcript／Agents 列表行为不变。
- **进度／链接专项 68/68**：组件 50、父级 App 18（本次比上一轮新增 19 条回归），覆盖真实 VT underline／bold、精确 first/last/end-exclusive 边界、CJK／ZWJ 显示列、external、header／overflow 文字命中区、native selection/copy、outside-press reflow/reattach、blocked gesture、图标／指标／活动不可点；`.cache/subagent-links/app-ui.log`。
- **Subagent 全链 195/195**：backend 22＋14、frontend 55＋50、input 23、App 9＋18、真实 DSH 4；`.cache/subagent-links/targeted.log`。真实 DSH 回归仍为临时 home/workspace＋hermetic model stream，没有真实 provider 请求。
- **真实 CLI/PTY 6/6**：新名字链接两 renderer 2/2（fullscreen 实际点击名字、16 个非链接坐标不跳转、hover 后原生 drag/copy、header／overflow 文字边界、external 非链接、18 行 resize、Esc／草稿／exit 0／恢复）；原有进度 2/2 和 Stop/Reply 2/2 均回归通过。inline 保持相同样式和原 keyboard path。copy packet 只留在私有 PTY／headless VT，不写真实剪贴板。证据：`pty-links.log`、`pty-progress.log`、`pty-controls.log`。
- **产物**：296 entries 的本地编译归档，App/backend/Progress/Overlay/actions 解压导入与名字-only internal-link smoke 通过；只链接已有本地 dependencies，不冒充 clean install。`git diff --check` 通过。详细报告与归档：`.cache/subagent-links/`。
- **范围**：只改变编辑框上方进度区的链接外观／命中区和相关回归。仍为 DSH 原生同进程插件，业务／数据／Agent／模型／权限／持久化归 DSH；没有新 Editor、listener、timer、scheduler、credential subsystem 或模型调用。版本仍 **0.1.1/private**，HEAD `18f9440`，未 commit/push/tag/publish，未修改真实配置／凭据／会话／全局安装。

## 前次：Pi 风格编辑框上方 Subagent 进度（未发布）

- **完整 `pnpm check`：1209 tests / 1209 pass / 0 fail**，0 skip/cancel/todo，vendor/src 构建、strict TypeScript 与 **101 个测试文件**通过；tests 阶段约 **203 秒**。证据：`.cache/subagent-progress/full-check.log`。
- **样式按用户的 Pi 截图**：蓝色 `● Agents` 标题、dim 树形导线、cyan live marker、bold agent 标签、原生状态／可用 session 累计指标，以及下一行原生当前活动。以本机 `@tintinweb/pi-subagents` 的 aboveEditor widget 为只读视觉参考，不导入其 Agent/runtime、timer、turn/tool/context/cost 计数。
- **交互按 Grok**：fullscreen 点击进度行直接进入对应 child；Esc 回到同一个主 Editor，保留草稿／图片。标题和 `+N more` 打开完整 Agents 树；inline 保持同一布局并使用原键位。关闭浮层后 mouse owner 用 live getter 立即解锁，不等下一次输入或 native frame；审批、details／Agents／child 浮层阻断底层 hitbox。原有 transcript 状态行仍可点击，Reply/Stop 控制不变。
- **进度不挤占编辑框**：回复目标、活跃 child＋活动次行优先；总预算最多八行，并在每次 renderer paint 按实际 Editor/dialog/queue/hint/footer 高度重算。窄／矮屏降级摘要、标题或隐藏，空 catalog 不占行且不进行额外 sibling 高度测量。多行 native label/route 在 paint 前折成单行，不改变原生事实；CJK／emoji／ANSI 宽度安全。无新的 Editor、input listener、child read、polling 或 timer。
- **新增进度专项 49/49**：纯组件 **37**、父级 App **12**，覆盖默认／remap／disable、active detail priority、overflow、原始 transcript 点击、两 renderer、scroll pinning、真实 press/release、图片草稿、Esc 后立即再点、decision blocking、removed／reappeared／same-id-new-attachment 失效手势及多行／高度／宽度预算。
- **完整 Subagent 专项 176/176**：backend 只读 **22**、原生控制 **14**、frontend **55＋37**、input **23**、App **9＋12**、真实 DSH **4**；`.cache/subagent-progress/targeted.log`。原生场景继续使用真实 DSH 和 hermetic model stream，未调用真实 provider。
- **真实 CLI/PTY 4/4**：新增进度两模式 **2/2** 验证可见位置、Pi 树形样式、fullscreen 实际进度行点击、Esc／草稿返回、标题列表点击、resize、exit 0 和终端恢复；原有 Stop → Reply → follow-up → target exit 两模式 **2/2** 回归通过，fullscreen 实际点击 R/S chips。证据：`.cache/subagent-progress/pty-progress.log`、`pty-controls.log`。
- **编译归档 296 entries**：解压后的 App/backend/Progress/Overlay/actions 导入成功，新增 compiled progress 的空／活跃／dispose 与单行安全 smoke 通过。只链接已有本地 dependencies，不冒充 clean install。证据：`.cache/subagent-progress/package/entries.txt`、`import-smoke.log`。
- **边界**：版本仍 **0.1.1/private**，HEAD 仍 `18f9440`，未 commit/push/tag/publish／改装全局程序。生产仍是 native DSH 同进程插件与唯一主 Editor；没有 sidebar、第二任务系统／scheduler／persistence、per-run usage、child `/resume` 或自动 retry。所有工程验收使用临时 home/workspace／离线 fixture，不读取真实凭据／会话，不发起真实 DSH 模型请求。操作文档见 `docs/SUBAGENTS.md`，完整报告见 `.cache/subagent-progress/REPORT.md`。

## 前次：基于 v0.1.1 的原生 Subagent TUI（未发布）

- **完整 `pnpm check`：1160 tests / 1160 pass / 0 fail**，0 skip/cancel/todo，vendor/src 构建、strict TypeScript 与 **99 个测试文件**通过，约 **197 秒**。证据：`.cache/subagent-controls/full-check.log`。
- **三层只读事实面**：主对话每个 direct child 一条不可展开状态行；`Ctrl+X Ctrl+A` 打开原生 Agents 树；Enter/点击进入全屏只读子 transcript。continuable、one-shot、external、failed/stopped/max-tokens/refusal/unknown 分开；token/timing 为 child session 累计值。`subagent-settled` 与 `agent-message` 以 durable seq 投影；子审批／问题带精确来源，follow＋1024 帧有界缓冲和独立 child store 保持父子隔离。
- **第二阶段原生干预已落地**：`subagent-interrupt` 经当前 root tree 证明后调用 core `ctx.subagents.interrupt`，使用真实 direct parent，支持 one-shot/continuable；`subagent-prompt` 仅接受 local continuable，原生 queue/steer、文本／图片和 request/message receipt 均保留。out-of-tree/root/不合法目标 fail closed；nested 不误用 root，读取时不 create/resume child，只有用户明确 prompt 才让 DSH 决定冷恢复。
- **主 Editor 目标与输入**：R 只回复 continuable，S 只停止 running/initializing local row，均有可配置键和真实鼠标 chips；窄屏不保留不可见 hitbox。Reply 关闭浮层并复用唯一主 Editor，保留草稿/图片，Enter=queue、Ctrl+X Ctrl+S=steer；child 目标下 `/...` 不当根命令，send-now 不冒充 steer，Esc 只退出目标。活动目标 Ctrl+C 只中断 child。accepted 不伪造 stopped/completed，失败恢复草稿，continuable 完成后回到 idle＋原生 stop reason。
- **第三阶段加固**：能力按真实 method 分别探测；延迟出现的 native 控制服务只补发同 session/attachment 的 capabilities ready，不重放 transcript。prompt carrier 纳入 active-command abort/close/reload 生命周期；Receipt 接受后的 abort 不错误改判未接受。frontend/App 共用 mode/local/status gating，session/attachment/target 失效 fail closed。
- **专项 127/127**：backend 只读桥 22、控制 14、frontend 55、input 23、App 9、真实 DSH 4，全部通过（`.cache/subagent-controls/targeted.log`）。真实 DSH 两模式各验证并行 child、原生审批、冷读/follow live chunk、durable continuable reply，以及 running child interrupt；子消息不进入根 user/assistant/attempt，delayed answer 在中断后不提交。
- **真实 CLI/PTY 2/2**：inline 键盘与 fullscreen 实际鼠标 chips 完成 Stop → Reply → 子会话 follow-up → Esc 返回目标，resize、草稿保留、exit 0 和终端恢复通过（`.cache/subagent-controls/pty.log`）。编译归档 **294 entries**，App/backend/Overlay/actions 解压导入成功，控制标记存在；只链接已有本地 dependencies，不冒充 clean install。
- **边界**：子 transcript 仍只读，但表面提供原生控制；没有 per-run usage、常驻侧栏、第二 scheduler/persistence、child `/resume` 或 UI 自动 retry。所有原生验收使用临时 home/workspace 与 hermetic model stream，没有真实 provider 调用。版本仍 **0.1.1/private**，本轮没有 commit/push/tag/publish。

## 此前：v0.1.1 原生 compaction reasoning 修复

- **完整 `pnpm check`：1033 tests / 1033 pass / 0 fail**，0 skip/cancel/todo，vendor/src 构建、strict TypeScript 与 **93 个测试文件**通过，测试约 **188 秒**。证据为 `.cache/compaction-fix/full-check.log`；版本号调整为 v0.1.1 后对发布源码再次完整执行仍为 **1033/1033**，见 `.cache/compaction-fix/release-v0.1.1-check.log`。
- **真实失败原因已核验**：用户指定当前目录最新会话后，只提取 compaction 生命周期和安全路由字段。两次 `compaction/start → compaction/end` 分别为 1698/1605ms，均为 provider `400 InvalidParameter: enable_thinking restricted to True`，没有 `compaction/summary`；正常最近路由为 `cloudagent/glm-5.3`、`reasoningEffort:max`。未读取对话正文或凭据。
- **修复仍在原生接缝**：`src/plugin/compaction.ts` 通过公开 `llm/stream` waterfall，仅对 `purpose:compaction` 且 provider/model 与最新 durable request header 完全相同的请求继承其 effort。不同摘要目标、已有显式 effort、无历史 effort 与普通回合保持原语义；不重写压缩算法、不改全局 DSH、不硬编码模型，消息/tools/toolHistory/maxTokens/sessionId/signal 保留。
- **真实 DSH＋假 provider 两模式通过**：`test/acceptance-compaction.test.ts` 在 inline/fullscreen 先完成正常回合，再执行 `/compact`。fixture 对缺失 `high` effort 的摘要请求抛出同一 400；修复后 provider 仅调用一次、native `maxTokens:65536` 不变、成功显示 Compacted 并写入 `compaction/summary`，无失败 end。backend seam/diagnostic 23 项与 UI notice 10 项同步通过。
- **错误不再只剩笼统提示**：backend 以 session＋sourceCommandId 关联实时 `compaction/end.error`，保留原生 generic 并在下一行追加 `Native cause`；32 项/单项存储有界，展示 400 字符，凭据脱敏并清理 ANSI/OSC/C0/C1。成功、其他命令与无 cause 的结果不变。UI 仍只有一个 notice 平面，宽窄/两模式换行与控制字节回归通过。
- **范围**：本轮工程与原生集成验收不发起真实模型请求，也未擅自压缩或改写用户现有会话。真实 `cloudagent/glm-5.3` 仍需用户重启加载新代码后通过显式 `/resume` 验收；不把 hermetic 成功冒充真实 provider/缓存命中率证明。用户明确确认版本号回退为 **0.1.1/private**，发布范围为 GitHub `main` 与 `v0.1.1` tag，不发布 registry。

## 此前：v0.2.0 原生运行诊断隔离修复

- **完整 `pnpm check`：993 tests / 993 pass / 0 fail**，0 skip/cancel/todo，vendor/src 构建、strict TypeScript 和 **89 个测试文件**均通过，测试约 **184 秒**。HOME/DSH_HOME 隔离，TMPDIR 为仓库外的临时目录，避免临时测试 workspace 意外继承本仓库 Git 状态。
- **日志与终端 writer 分离**：前端 attachment 生命周期内捕获原生同进程 JS stdout/stderr/console 写入，Pi renderer 和键盘/光标/图像/标题/progress 协议走原始 writer。DSH 的目录刷新/provider/凭据/Agent 逻辑未改，正常 listing 成功既不进入编辑草稿也不进入 transcript。未知 stdout 留日志；真正警告/失败走既有 notice（每窗口预算、有限去重），fatal 不当作 notice。
- **有边界而非静默丢弃**：日志创建为 0600，目录为 0700，拒绝危险目标，不随意 chmod 已有文件；一代 1 MiB、一个轮换副本，内存队列/行长度有限。分片 UTF-8 和凭据在整行重组后脱敏，超长行连同后续尾部一起丢弃并记标记；存储失败发一个真实警告。
- **致命错误保留**：原生 fatal 标记触发同步恢复终端，然后将同一次写入的多行错误/上下文脱敏后输出，Native DSH 仍决定退出。不同 lease 不能套叠；renderer 写错误不被吞掉。正常关闭、外部编辑/挂起、HMR 卸载/再启均由原生命周期管理，不建立第二个后端或私有 profile。
- **新增专项**：backend capture 31、frontend notice 14、ProcessTerminal writer 3、真实 App/草稿/队列/历史平面 2，全部保留既有断言。
- **新增原生 PTY 6/6**：inline/fullscreen × 正常（含挂起恢复）/HMR 重挂/fatal，真实 native ModelListingCache 只用 fake loader/credential，无网络；验证刷新/普通 stdout 不上屏、私有日志收到、分片敏感值不泄露、警告可见、草稿重绘不变、fatal 在终端恢复后可见且 exit 1。原有 46 场景保留，9 个 demo PTY 脚本同步复跑全通过。
- **编译归档通过**：280 entries，包含新诊断隔离/notice 编译 JS 和唯一 vendor dist。归档自身的 8 个 native 生命周期、首次自动挂载及两个模式的诊断/挂起恢复通过；依赖仅链接已有本地 runtime packages，不冒充全新安装。
- **明确范围**：这是 JS write 隔离，不是 OS descriptor 隔离；native addon、缓存旧 writer、子进程直接继承 fd、fs.writeSync 或 /dev/tty 可绕过。没有真实 provider/vision/GPU/IME 请求或桌面控制，不改真实 profile/凭据/global 安装，无 commit/tag/push/publish，版本仍 0.2.0/private。
- 证据：`.cache/diagnostic-fix/full-check.log`、`native-diagnostics.tap.log`、`native-pty/*.json`、`pty-*.log`、`package/manifest-report.json`、`package-smoke-report.json`。过程中的仓库内 TMPDIR 误配日志保留；更正为仓库外后全量 993/993，不修改原断言掩盖问题。

## 此前：v0.2.0 统一命名、原生资源解析与自动挂载

- **完整 `pnpm check`：937 tests / 937 pass / 0 fail**，0 skipped/cancelled/todo，包含 vendor 构建、src → lib、strict TypeScript 与全部 **84 个测试文件**，测试约 **161 秒**。HOME/DSH_HOME/TMPDIR 全部隔离，无 TERM_PROGRAM/COLORTERM、真实凭据或真实模型请求。
- **应用身份统一为 `dsh-tui`**：package、唯一 bin、Cordis row/module/effect、`dshTuiStartup`/`dshTui` 服务、`DSH_TUI_CONFIG_DIR`、源码模块名、fixtures、脚本和文档已统一。独立全项目/frontend/input identity guards 保护这些名称；上游 Pi TUI 的包名、许可与 `#pi-tui` seam 保持不变。
- **原生 preset 资源修复**：YAML 和原生 `AgentPreset` 类从宿主 `profileContext.installAnchor`（或公开 `pluginPackages` lookup）解析，不再依赖本包目录能解析可选的 `@deepseek-ai/dsh-web-app` peer；不新增 Web 前端、不复制 preset/tool YAML。4 个新专项验证安装锚点、类 identity、嵌入宿主 lookup、已注册跳过与缺锚点明确失败。
- **首次自动挂载**：别名仅通过所选 DSH 安装的公开 `resolveDshHome`/profile/package APIs 检查元数据，由 native `runPluginCommand` 完成安装、锁、兼容检查、回滚和取消；随后交给 native launcher。缺 profile/缺本应用无需手动操作，已挂载时不重复安装。只有与当前本地包同源的旧别名会被升级，先 add 成功再 remove；其余前端/同名其他来源/明确禁用 bundle 均不被覆盖，用户 patch、模型和凭据不迁移。
- **缺整个前端也失败可见**：别名带一层原生 launcher-activation assertion，两个应用 row 均被禁用时仍明确 exit 1，而不是留一个零输出的 profile。它不重组/镜像配置，也不在 HMR 前端卸载时退出 root。
- **自动挂载原生 PTY 7/7**：无参数首启、全新 profile、已挂载再启、同源旧名称升级、包操作失败、外部 SIGINT 130、两条应用 row 全禁用。正常场景约 1.5–2.7 秒 ready/fullscreen；失败不进入 raw/alternate screen。用户 patch 和无关 manifest 字段保持不变。取消期间持续注册 signal handler，避免 `signal-exit` 在 once handler 被移除后重发 SIGINT；native 包操作先完成取消/清理再退出。
- **当前 CLI/PTY 共 46 个不同场景通过**：原有 31 个离线输入/Settings/cancel/Thinking/Tools/images/Help/model-picker/theme/static-logo 场景，原生生命周期 8，以及上述自动挂载 7。均在临时 home/workspace；没有控制真实 Rex/Ghostty 桌面或剪贴板。
- **编译归档通过**：`dsh-tui-0.2.0.tgz`，**276 entries**，仅一个 bin、compiled JS exports、native assertion、vendor dist/许可与 assets；无源测试/旧 runtime/cache/凭据。解压后 private Editor identity、App/plugin、help/version/non-TTY、8 个原生生命周期和归档自身无参数首次自动挂载均通过。只链接本地已有 runtime dependencies，不冒充空 cache 全新安装。
- **边界**：开发验收没有代为运行真实 profile 的挂载/迁移。用户之后执行 `dsh-tui` 才会触发上述已授权自动挂载规则。Node 最低要求与原生 DSH 对齐为 24.9，实际验收仍是 macOS/Node 26.13.0；无 Node 24/Windows/Linux、真实模型/vision/GPU/IME 新声明，无 commit/tag/push/publish，版本仍 **0.2.0 / private:true**。
- 当前证据：`.cache/rename-attach/full-check.log`、`native-attachment.tap.log`、`pty-*.log`、`package/manifest-report.json`、`package-smoke-report.json`。初始 package refresh/类型修正/取消故障日志保留为过程记录，不能当作当前失败状态。

## 此前：v0.2.0 恢复、测试隔离与默认 fullscreen 修复

> 下方 901 个测试与 39 个 PTY 场景属于自动挂载/统一命名之前的验收阶段，保留当时证据；现行结果以上节为准。

- **干净环境完整检查：901 tests / 901 pass / 0 fail**，0 skipped/cancelled/todo；真实执行一次 `pnpm check`，含 vendor 构建、src → lib 编译、strict TypeScript 与全部 78 个测试文件，测试约 151 秒。临时 HOME/DSH_HOME、TERM=xterm-256color、无 TERM_PROGRAM/COLORTERM，不借宿主图形终端变量通过。
- **默认 fullscreen**：无 screen flag、无显式 screen 偏好时，直接 `dsh-tui`/`dsh --profile dsh-tui` 进入 alternate screen；显式 `--inline` 与已保存的 screen 选择仍生效，不读取/改写真实用户设置。App 终端序列回归覆盖 5 种默认/偏好/CLI 优先级，native PTY 的 4 个 fullscreen 场景不带 screen flag。
- **当前 id 恢复遵循原生 ownership**：DSH 一个会话只有一个 Agent/写入 owner，重复恢复当前 live/staged id 保留已有 attachment，不先释放再重新打开，也不克隆业务状态或自动选新会话。不同 id 仍 prepare → commit → retire previous，失败保留旧可用连接。
- `test/acceptance-resume.test.ts` **10/10 原生集成回归**：两种 renderer 下验证 staging/live 幂等、部分流式与两个 inbox 不被重复 resume 中断、待审批保持打开；真正切换另一个持久 id 的 resume-entry / after-setup 故障确实注入到了 native 边界，稳定错误/脱敏、旧 Agent/草稿保留、候选 writer claim 清理与再次恢复均通过。没有要求原生不允许的两个同 id writer 并存。
- **错误与测试隔离修复**：native create/resume/setup 异常归入稳定分类；取消/过期代码保留；未知错误对象不序列化 stack/cause/credential fields，quoted/escaped key diagnostics 脱敏。图片序列生成前显式注入 Kitty capability，afterEach 恢复 renderer/capability/cell geometry；原来的 8 个干净环境失败已解决，生产终端能力探测不变。
- **长路径与版本**：footer/权限/颜色按实际逻辑行换行验收；长 HOME 的会话 cwd 先安全缩写再应用 300 字符预算，live 状态提示不再因 home 前缀截断而被挤掉，native DTO/id 不变。CLI/欢迎页共用 `src/version.ts`，manifest/CLI/native launcher/欢迎页一致为 0.2.0。
- **CLI/PTy 共 39 个场景通过**：native 8、输入/Settings 2、cancel 8、Thinking 3、Tools 2、images 4、theme 2、static-logo/SIGINT 6、Help 2、model picker 2；退出 0/SIGINT 130、挂起恢复、raw/cursor/paste/alt-screen 恢复、插件两次卸载重挂均覆盖。图片为有效 PNG/JPEG 转码与协议/重绘证据，不是 GPU 像素验收。
- **v0.2.0 本地归档核验通过**：272 个 entry，编译 JS exports、vendor dist/LICENSE、bundle/bin 与版本均正确，无 src/tests/helpers/runtime/cache/credentials。归档解压后 App/plugin/唯一 vendored Editor identity、alias/native help/version/non-TTY 通过；由临时原生 profile 加载归档再复跑 8 个 native PTY 场景通过（重复场景不重新计入 39）。依赖只链接已经安装的本地 runtime packages，不是全新 dependency install。
- **离线 clean-install 补充明确未通过**：脚本已换用现行 `#pi-tui`，验证 source/compiled App/version、隔离 HOME/DSH_HOME 且 ignore install scripts；本轮空临时 pnpm cache 缺 `@deepseek-ai/dsh-util-values` 公共元数据，`ERR_PNPM_NO_OFFLINE_META` 在 install 阶段中止。没有绕过 offline、读取真实 npm 凭据或为它改全局 cache，也不声称全新安装已验收。
- 工程验收只用临时 home/workspace 与 fake/native llm-stream fixture；不读真实 profile/credential values，不向真实模型 provider 请求，不改其他 workspace/global 安装，无 commit/tag/push/publish。包为 **0.2.0 / private:true**，默认 profile 仍 dsh-tui，既有本地 bin symlink 未替换。真实模型/vision/GPU/IME 及 Node 22/24/Windows/Linux 未建立本轮证据。
- 当前日志：`.cache/v020-acceptance/full-check-default-screen-final.log`、`screen-targeted.tap.log`、`native-resume.tap.log`、`pty-*.log`、`parent-package-report.json`、`package/manifest-report.json`、`clean-install.log`。之前独立批次 867 分片/8 图像测试失败的报告保留为修复前历史，不代表 v0.2.0 状态。

## 历史：v0.1.1 原生同进程插件化验收

> 本节与下方更早记录保留当时结果；其中“本轮/最新/当前”均指该历史阶段，现行状态以 v0.2.0 小节为准。

- **完整检查：867 tests / 867 pass / 0 fail**，0 skipped/cancelled/todo；`pnpm check` 包含 vendored TUI 构建、src → lib 编译、strict TypeScript 与全量测试，最新运行约 144 秒。
- 原生应用 bundle 与 Cordis startup/TUI 插件已落地；生产由真实 `dsh --profile dsh-tui` 装配，使用宿主 Context，取消旧 bridge/NDJSON、独立后端进程、临时 DSH_HOME/profile 镜像与自动替换其他前端。
- 模型采用用户选择的方案 A：直接消费 `ctx.llm.listProviders/listModels/resolveModelInfo` 与 native default-model。选择目标时查询原生 reasoning 元数据；保留目标支持的显式 effort，否则省略显式值交 DSH 默认。无目录导入、凭据/路由规则或完整 SessionController 新组合。
- 原生 DSH 临时 profile 同进程验收覆盖：懒 Agent 创建、真实 transient stream / durable settlement、原生命令/权限/队列、approval 与 question 取消区别、模型选择器草稿/搜索/provider/effort、默认保存如实报告、HMR 配置重组及原生图片准入/引用读取。
- `test/plugin-pty.test.ts` 内 **8 个原生 CLI/PTy 场景通过**：inline/fullscreen、normal/demo、退出 0、外部 SIGINT 130、Ctrl+Z/SIGCONT、两次前端卸载/重新挂载；恢复终端且不因单独卸载前端而退出 DSH。原生非交互启动明确拒绝；help/version 不占用终端。
- 既有 CLI/PTy 本轮复跑通过：Thinking 3、Tools 2、图片 4、取消 8、Help 2、模型选择 2、主题 2、静态 logo/SIGINT 6 场景。图片检查完整 PNG、JPEG 转码、重绘、草稿与恢复，不代表真机 GPU 像素或真实模型 vision 验收。
- 编译后的包归档包含 `lib/plugin/*.js`、private vendored `#pi-tui` dist、bundle patch 与两个兼容 bin；无生产 TS stripping 依赖。归档解压后由真实原生 profile 读取通过（非原生依赖使用本地已安装包）。未发布包。空的临时 pnpm cache 下 `--offline` 包安装因缺公开包元数据被拒绝，这是测试 cache 限制，未作为安装成功证据。
- 原始图片阶段的 1021 个测试包含已删除的 IPC/discovery/profile 镜像专属测试；本轮移除那些过时契约，并以同进程原生语义/生命周期测试替换。输入、显示、图片与声明事实相关回归保留，不能直接用两个总数比较功能覆盖。
- 本轮只在临时 home/workspace 安装和验收；不读取真实配置/凭据，不向真实 provider 发模型请求，也未改全局安装或真实 profile。默认 profile 按用户选择仍为 `dsh-tui`；正式安装/清理旧前端由用户通过 DSH 完成。版本仍 0.1.1 / private，无 commit/tag/push/publish。

## 历史记录：插件化之前的分阶段验收

> 下方保留当时版本的结果与调查。其中“当前/最新”指该历史阶段；旧文件和脚本可能已经移除，不表示现行架构。现行结果以本节上方为准。

本轮图片能力与验收边界见 [图片说明](IMAGES.md)；Tools 分组/I/O/Inspector 结论见 [Tools 验收](TOOLS.md)；review 修复/取消语义的完整记录见 [最终验收](REVIEW-ACCEPTANCE-2026-11-03.md)。下方实网与分阶段记录保留历史上下文，不能当作本轮额外实网复测。

## 环境与范围

- 本地 Node 26.13.0 / pnpm 12.6.0 / macOS。
- DSH `0.2.2-rc.1`（精确版本闸）；Pi TUI `1.5.0` vendored 源码。
- Pi TUI 1.5.0 源码 vendored 到 `vendor/pi-tui/`，由本地构建编译；原 Editor/SelectList patch 与 `patchedDependencies` 已删除。未修改全局 Pi/DSH、原模型配置或认证文件，未 commit/publish。
- 历史开发：分组开发遇到 Go 上游 `429 Allocated quota exceeded` 后，按用户选择切换 CloudAgent；中断组剩余部分由主 Agent 完成。主 Agent 独立检查实际文件并验收，不以子代理摘要代替结果。

## 最新检查

- **图片能力（当前开发版）**：DSH native attachment read/prompt-content、保序 canonical refs、CC 原子图片输入、只读 viewer 与 Ghostty/Rex Kitty 清屏缓存修复均落地。父级完整 `pnpm check` **1021/1021**；图片 CLI/PTy **4/4**（Rex/Ghostty identity × inline/fullscreen）验证完整 PNG/JPEG 转码、导航、resize、草稿/终端恢复，现有 Thinking/Tools/Settings/取消/Help/模型/主题/logo PTY 回归通过。这里不宣称真机 GPU 像素或真实模型 vision 验收，临时 Rex 页已清理并恢复原工作会话/server window 焦点。版本仍 v0.1.1，无 commit/tag/push/publish、用户配置/凭据或全局安装变更。
- **Tools 展示升级**：所有开发/返工 subagent 调用的 model 参数均指定 `cloudagent/deepseek-v4.1-flash-1017`；父级独立验收。连续/混合工具组、五态计数、真实调用墙钟时长、Input/Output 各自预览、原生 Diff 与只读 Inspector 均落地；Tools tab 11 项统一使用现有 settings.json，快捷键仍是一张分组列表。没有新增 backend harness、模型/认证配置层或工具执行覆盖。
- 父级 `test/app-tools.test.ts` **17 项**实际 App/native SGR/独立 VT、`test/tool-config.test.ts` **25 项**、`test/tool-proposals.test.ts` **4 项**通过，覆盖同点开关/离屏正文收起/第一条 drag、流式与设置重绘之间的按压目标、非末项 Output、全调用导航、完整文本复制回调、主草稿/焦点、原生审批抢占、Ctrl+C 及旧 target 清理。构建/strict TypeScript/业务-native 回归完整通过，工具实现验收时版号为 v0.1.0；随后按用户选择仅更新本地标记为 v0.1.1。
- `python3 scripts/pty-tools-smoke.py` **2/2**（fullscreen / inline）通过：屏幕单元解码验证同点两次往返、真实正文选区与收起、组内 Output 详情、所有调用的键盘路径、resize/草稿与终端恢复。Copy 用父级注入回调验收；PTY 不操作系统剪贴板，选区 OSC52 只被捕获。没有额外真实模型调用、用户配置/凭据改写、提交/tag/push/publish。详细边界及许可见 [Tools](TOOLS.md)。
- 当前完整 `pnpm check`：**1021 tests / 1021 pass / 0 fail**，0 skipped/cancelled，vendored build 与严格 TypeScript 通过。错误提示改为 CC 版式（`● API Error` 标题行 + 缩进详情行，红色），仅展示映射不改写错误内容；工具卡按 CC/pi-cc-extensions 口径统一为单 `⎿` 对齐（首个正文行带标记，其余行对齐其列，标题内容列固定），不再出现重复 `⎿` 或标题双空格。启动区按用户要求改为**静态字符块** DeepSeek logo：不再有原生图片、Braille 或启动动画，业务/native 回归未削减。
- 静态 logo：直接使用用户提供的参考图采样成 `assets/logo/grid.json`（32×12 个象限样本），显示为 **16 列 × 6 终端行**。每个终端单元带 2×2 象限，使用 `▘▝▖▗▌▐▀▄▚▞▙▛▜▟█` 等块字符，因此每个像素只有旧半字符像素的**一半面积**（半单元格宽、半单元格高；旧方案为整格宽、半格高）。蓝色为 DeepSeek 资产蓝 `#335DE0`（仅定义于 `src/ui/logo.ts`，独立于品牌蓝双档）；logo 内部负空间显式填白（48 个样本），外部保持透明/默认背景。单个渲染路径覆盖所有终端（含 Rex），不使用 `Image`、Kitty/iTerm2 上传、Braille、终端专门分支或直接终端写入；真彩与 256 色仅颜色编码不同、几何一致。`scripts/generate-logo-assets.py` 可从 `assets/logo/reference/deepseek-logo.png` 复现同一 grid，并拒绝需要三色同格的样本。参考图头顶接近平顶，因此在采样后对最上方的头顶做一次确定性的轻微顶弧修圆：按整格边界把头顶中间抬高一档，避免半格斜切在左上角留下缺口；只增加顶行的蓝色样本，保留出气孔/喷口，不触碰任何白色内区样本。
- `test/ui-welcome.test.ts` 7 项按真实终端单元独立解码全部 384 个象限样本（蓝/白/透明、48 个白色内部样本），验证三种 image capability 输出一致、真彩/256 色几何一致、header 身份/resize/cache、1–160 列宽度安全与无图片/帧/计时器源码审计。父级 `test/app-logo.test.ts` 两种 renderer 强制 Kitty capability 后仍只出现字符块、无图片上传/放置、无启动 interval 或帧 timeout，空闲画面稳定，草稿/Help/resize/退出保持；`test/app-theme.test.ts` 10 项继续检查蓝色主题与真实 logo 单元。
- 启动动画已**整体删除**而不是关闭：无动画序列/资产、无 `setAnimationFrame`、无帧状态/welcome timer，App 也没有启动/暂停/恢复/退出的 logo hook。Working 的 spinner/耗时属于正常业务状态，未受影响。
- `python3 scripts/pty-static-logo-smoke.py`：inline/fullscreen × Kitty hint/none hint 与实际 SIGINT，**6/6** 通过；检查蓝/白转义、块字符、无图像协议、无 Braille、空闲不重绘、草稿/resize 与终端恢复。`pty-theme`、`pty-help`、`pty-model-picker`、`pty-cancel`、`pty-smoke` 也全部复跑通过。所有配置均为临时目录，无远程模型请求、真实配置/凭据修改，也没有 Rex 桌面会话或 GPU 截图声明。
- `python3 scripts/pty-thinking-smoke.py`：fullscreen 的 preview=0/3 和 inline 三场景通过。使用独立 xterm VT 解码实际绘制的屏幕单元，不再靠 repaint 字符串或逐行扫描推断命中：真实提示文字列同点展开/收起往返、正文拖动保留选区反显、标题确实滚出屏幕后单击正文收起、inline 无鼠标提示、终端恢复均通过。`test/ui-thinking.test.ts` 36 项与 `test/ui-settings.test.ts` 15 项覆盖渲染/设置；`test/ui-mouse.test.ts` 19 项覆盖可复用 hitbox 的 click-only 正文策略、按下目标锁定及原生拖拽放行。父级 `test/app-thinking-mouse.test.ts` 5 项独立覆盖视口底行/真实提示列、正文收起与选区、按下到释放间流式重绘漂移、多 run 跟随恢复、被按下组件退出/会话替换后的旧点击失效。
- 设置反馈：`test/app-settings-feedback.test.ts` 14 项覆盖命令/选择器/Shift+Tab、两种 renderer、runtime 保存静默、失败/不可用/未知保存警告、状态查询静默/查询失败可见、staged preset 与自动标题。`test/acceptance-permission.test.ts` 新增两种 renderer 的真实 DSH 模型/effort/ptc/权限切换验收；只用临时 home、显式模型与 synthetic key/loopback，未产生模型回合。成功切换只更新底栏（标题开关在 Settings）；`/preset status`、`/effort status` 和 bare `/permission` 的状态/可用列表也不追加对话提示。两模式原生验收确认查询不改变 pending、权限/effort/preset 仍显示在底栏，权限查询保留 native command 审计；原生执行、审批上下文与持久化范围不变。
- 只读 Help：`test/ui-help.test.ts` 14 项组件回归、`test/app-help.test.ts` 9 项父级接入回归、`test/acceptance-help.test.ts` 两模式真实 DSH 目录验收。验证两列/窄屏分区、元数据分组/输入 hint、Enter/数字键无动作、草稿/焦点保留、忙时全局取消、迟到目录不覆盖新面板/attachment/route，以及不执行命令或发起模型回合。命令来源不改，MCP 工具不虚构成 slash command；`definitionId` 命名空间仅用于展示分组，不是 SDK 提供的权威归属。
- `python3 scripts/pty-help-smoke.py`：inline/fullscreen 的 F1 打开、只读按键、宽窄 resize/浏览、Esc 关闭、原草稿保留与终端恢复通过。取消脚本改用空白 prompt 抑制 CLI 的自动 Demo 工具回放，不再用会打开面板的 `/help` 作为起始 prompt；原 8 项取消与 Settings 两模式 PTY 继续通过。
- Reload 反馈：正常成功只输出 `Reloaded settings, keybindings and DSH configuration.`；新增 native warnings/不可用/失败和坏本地配置回归，原两模式 native reload 也校验精确单行结果。pending/restart、未应用 settings/keybindings、screen 下次启动生效等提示保留；相关 46 项回归和严格 TypeScript 通过，不改变 native HMR 或会话状态。
- Provider 模型面板：`test/input-model-picker.test.ts` 18 项、`test/ui-model-picker.test.ts` 23 项、`test/app-model-picker.test.ts` 10 项、`test/acceptance-model-picker.test.ts` 两模式 native 验收。只按原生 provider 字段分组，ID 原样交给 native model setter；当前 provider/model、查询跨 provider 保留、字母/数字文本优先、空结果不选隐藏模型、光标/kill/yank/undo/粘贴和重绑定均验证。父级独立发现长列表挤掉 footer，退回子代理修正并验证 80×22 的选中行/搜索/状态栏均可见。native 保存使用临时命名 profile，未绕过 home override 正确产生的保存异常。
- `python3 scripts/pty-model-picker-smoke.py`：两模式 Alt+P、搜索/无结果 Enter、Ctrl+W/yank/undo、resize、主草稿保留和终端恢复通过；原 Help、取消 8 项、Settings/resize PTY 同步复跑通过。新动作继续由同一 `/settings` 分组键位列表和 `keybindings.json` 管理，未改模型配置/凭据来源、未新增键位层级。
- `pnpm build:pi-tui`：vendored TUI 构建通过；没有 pnpm patch。
- Pi TUI 使用 `workspace:*` / `link:vendor/pi-tui`；此前 Review 的干净源码快照离线 frozen install → 完整 340 项检查 → workspace realpath/App import/help 均通过。本次后续修复未重新执行 clean install；不复制或提交生成的 dist，没有新增 SDK/模型客户端依赖。
- Esc/Ctrl+C、原生 keepInbox 两队列保留并暂停、坏 resume 保留旧 Agent、外部 SIGINT 130/终端先恢复、shared recall/坏设置/迟到 UI、HMR 安全同步与 truthful restart、原生凭据路径、标题开关和展示修复均有回归。
- 实际 PTY：Settings/输入/resize 两模式与取消脚本 **8/8** 后续复跑通过，外部 SIGINT 两模式退出 130 且恢复 cursor/paste/alternate screen。取消脚本等待空 editor 的 Pi inverse caret 与退出确认渲染，避免把 `read(timeout)` 当作延迟而合并 Esc/Ctrl+C。
- Shift+Tab 原生回归：空白会话两种 renderer 各切换 15 次，权限立即生效且 `queued` 为 0；原生 `user-approval` 通知保留到下一次请求。真实 followup 的排队、取消保留与 Up recall 继续正常；空闲 reload 可保留审批通知，其他待处理输入/命令/决策仍被拒绝。
- `--help` 正常；没有模型迁移入口，模型目录/默认模型/凭据只来自 DSH 原生 profile 与 home 配置。
- 自动恢复入口 `--continue` / `-c` 已移除，同时删除 AppOptions.continueLatest 和自动选会话逻辑。只保留 `--resume <id>` / `-r <id>` 及界面内 `/resume`；新增 5 项 CLI 回归验证帮助、旧参数拒绝与指定 ID 参数仍被接受，测试通过 `--help` 提前退出，不启动 TUI/DSH。

## TUI 源码 vendoring

- `@earendil-works/pi-tui` 1.5.0 从发布包 source map 提取完整 TypeScript 源码到 `vendor/pi-tui/src`，保留 MIT LICENSE 和上游说明；它只是终端组件库，没有 provider、认证、Agent 或会话代码可删。
- 本地构建 `pnpm build:pi-tui` 生成 `vendor/pi-tui/dist`；根因是 Node 不允许直接对 `node_modules` 内的 `.ts` 做类型擦除，编译后入口稳定。
- 原 `patches/`、`patchedDependencies` 和 harness 的复制/重定向逻辑已删除。CC 专用 Editor/SelectList 入口集中在 `src/input/pi-tui-seam.js`，安装到 vendored 公共类上；模型/provider 仍完全由 DSH 提供。
- 全量 210 tests 通过；实际 CLI PTY inline 57 帧 / fullscreen 77 帧，终端恢复通过；vendored TUI 下原生 CloudAgent 实网复测 215 个文本 chunk、153 个不同正文画面，正常结算、无工具请求。

- **Demo 工具调用**：`dsh-tui --demo --fullscreen` 无 prompt 时自动运行 `tools` 场景，展示 `bash(pwd)` 的原生 terminal call/result、exit code，以及 `edit` diff；`tools` 关键字可重放，普通文字仍展示 edit diff。

- **问题取消对齐 CC**:`/questions` 与隐藏待答状态已移除,Esc 即以 `{cancelled:true}` 结算原生问题(ASK_CANCELLED),回合继续;Ctrl+C 仍为整轮中止(ASK_ABORTED)。
- **品牌蓝单色（2026-11-05 用户定义）**：全站所有蓝字统一为 `#79c0ff`，唯一真相在 `src/ui/brand.ts`（`BRAND_BLUE`）；`theme.ts` 的 accent/accentBright 两角色同值（将来分档只改那两行赋值），logo `LOGO_BLUE`、编辑框边框、`❯`、状态栏、markdown 标题/链接/列表符号全部派生。退役蓝 `#335de0`/`#4d6bfe`/`#4f9eff` 由源码守卫测试封禁；深蓝表面（规则线 `#2a4060`、底色 `#1a4480`）与内容色（行内代码 `#a5d6ff`、语法高亮）刻意不随品牌派生。PTY 冒烟脚本的颜色镜像集中在 `scripts/pty-common.py`，由 `test/app-theme.test.ts` 守卫同步。所有终端同一字符路径，无原生图片、Braille 或动画。启动页版本统一为 `v0.1.1`，正常6行/窄屏仅身份文字。详见 [主题说明](THEME.md)。
- **Working 状态**：不再占编辑框上方独立行，而是嵌入编辑框上边框；流式期间显示 `↓ N tokens · 耗时 · tok/s`，token 由 delta 估算并在 provider `usage.outputTokens` 到达后修正，跨同一 turn 的多个 step 累加。

## 本轮原生 DSH 配置改造

- 删除了 Pi `models.json`/`auth.json` 导入、`modelsFile`、provider 拆分/凭据迁移和 TUI 请求认证 shim。旧的 Pi 目录与凭据导入环境入口不再读取；`--models-file` 直接失败，不回退。
- 新增 `--profile <name>`：由 DSH 公共 `resolveProfileDir`/`readProfileManifest`/`resolveBundleDir` 解析，真实 `dsh --profile <name>` 组合。默认模型、provider 路由、home-vs-profile 优先级、`agent-default-model` 全部由 DSH 决定。
- profile 的 manifest、依赖、patch 行保留；只替换已识别的前端组合包（`PROFILE_TEMPLATES` 应用与旧版 TUI），普通插件的 utility `bin` 不再被误判。被替换会 warning，不静默启动第二个前端。
- profile patch 与其 `./` 相对插件资源实体化到 scratch profile，避免 Node realpath 逃出 scratch 的模块解析树；home patch 同样处理。compatibility、node_modules 等仍通过只读镜像。用户 profile/config/凭据未被写入。
- 独立父验收 `test/backend-dsh-config.test.ts` 覆盖：选中 profile 的默认模型/目录/相对插件、home 覆盖 profile 的原生优先级、错误 Pi 指针无影响、CLI 拒绝旧 flag、生产无 importer。
- 原生 profile+真实 `dsh-llm-pi-ai` loopback Messages/Responses/Chat Completions 的 held-SSE 测试保留未削弱：结束事件未释放时已上屏、可编辑草稿、可取消、最终去重；profile 默认模型与 home 优先级通过。
- 真实本机 `--profile dsh-tui` 已验证可连接：该 profile 的旧 TUI patch 行只在 scratch overlay 中禁用，原生目录仍包含 `opencode-go`、`cloudagent`、`cloudagent-openai` 等路由；默认模型仍是该 profile 原生决定的 `deepseek-official/deepseek-flash`。
- 原生 `cloudagent/deepseek-v4.1-flash-1017` 实网复测：235 个文本 chunk、1115 字符、结束前 171 个不同正文画面，首段文本约 1 秒出现，正常结算、未请求工具、无错误。单条 `live-smoke` 返回 `dsh-tui-ok`。
- 两种实际 CLI PTY 均通过；验证用 native profile，不读取真实 Pi 文件。

## 最新快捷键设置验收

- 独立 `/hotkeys` UI 命令已移除。入口为 `/settings` → Keyboard shortcuts；同一页面按导航、编辑、应用、补全、列表/对话框、历史搜索分组展示生效键位与用途，包括未绑定项，无配置 ID/兼容状态列或冗余层级。
- Enter 打开单个 CC 编辑框；每行一个绑定，空格组合 chord。支持多个可选键、禁用和恢复该项默认；恢复默认只删除对应 override。无效输入或 keymap 新报告的冲突留在原处提示，不自动覆盖其他动作。
- 复用现有 keymap、JSON override 文件和原子写入。拒绝覆盖坏文件，串行写入时重新读取以保留无关配置。保存即时生效，实际 App 重启后已验证新绑定加载并执行。
- inline/fullscreen 都由真实按键路径验证修改、禁用/还原、主编辑器实例/光标/paste 草稿不丢失。该配置面板单独保留方向键/Enter/Esc 与列表态 d/r 为恢复控制，普通编辑器及其他列表仍遵守自定义/禁用。
- 全量检查暴露了原先组合键 timer 在精确到期时刻不结算的边界；已统一在 deadline 到期、计时器向上取整留 1ms 精度余量，并补充精确边界断言，未放宽旧 timer 测试。
- 两种实际 CLI PTY 都完成 Settings 内编辑与保存，并返回继续发送新消息、缩放、退出恢复；所有配置在临时目录。该设置回归本身没有远程模型调用；本轮原生配置验收随后单独做了 CloudAgent 实网复测。

快捷键设置新增回归；当前全量日志 `.cache/native-dsh-config-full-check.log`，PTY `.cache/native-dsh-config-pty.log`，原生配置验收 `.cache/native-dsh-config-parent-test.log`。

## 原生 UI 概念收敛

- 本机 DSH `0.2.2-rc.1` 的 base 原生挂载 `dsh-plan-mode` 并注册 `/plan`。真实临时 runtime 已验证 `/plan` / `/plan off` 的原生状态事件，且全程没有模型请求。
- `/plan` 的规划引导/评审与 `/permission` 的沙箱/审批预设独立：进入 plan 不改权限，Shift+Tab 切权限不切 plan。快捷键通过 native execute 保留命令审计；不再有 `/mode` 包装或伪造的 Plan 权限选项。
- 只读 `permissions` 控制返回原生目录/当前值；实时 selection 直接来自 native projection change feed。私有 wire 升级为 v2，不镜像权限算法。
- 快捷键查看/修改已收进 Settings，不再提供独立 `/hotkeys`。`/reload` 重新读取 TUI settings/keybindings，并同步真实 profile/home patch 后调用 DSH HMR；当前会话、transcript、草稿和缓存不重建，busy/待决策时拒绝，错误不假报成功。
- inline/fullscreen 的正常流式都没有 `Streaming attempt…` 占位；首 chunk 前只有工作区状态，正文增量直接显示且可编辑草稿。live/committing/settled 三阶段显示布局一致；未完成/未确认仍明确提示，未伪装为已提交回复。

此前新增 6 个回归覆盖这些原生边界；当前强 pre-finish 和原生服务回归仍全量通过。上一轮记录保留在 `.cache/ui-concepts-check.log` 与 `artifacts/ui-concepts-acceptance.json`。

## 原生服务与语义验收

1. **原生命令**：`/compact` 参数校验与无历史结果来自 `ctx.commands.execute`；有成对 `command/run/command/done` 与原生 command ID。无效参数不会触发压缩/模型；未使用的 compact 兼容控制别名已删除，只走原生 execute。
2. **取消/超时**：原生 fixture command 的 AbortSignal 被 Esc/Agent.cancel 或按 request ID 的 timeout abort 正确触发；命令结算为 error、审计配对、运行时继续可用。超时不假装动作已回滚。
3. **原生 codecs**：真实 DSH BlockAssembler 显示尚未闭合的文本并忽略 block-end 后迟到 delta；durable stream 使用 native 验证/装配；缺少 public helper 时拒绝启动，不回退到生产镜像。dt/时间戳的合法性由 native decoder 决定。
4. **原生文件工具/presenter/裁剪**：临时 workspace 内执行真实 DSH read。测试在原生 open turn 内调用已挂载的 `toolResultPruner.pruneSession`，生成真正的 model-only tool/result replacement。桥接保留 `surfaceOp/sourceEventSeqs`；UI 保留 append-origin 原文和 native read card。删除原文件后恢复会话仍按日志展示，证明不重跑工具/不读当前文件猜结果。
5. **标题/快照**：原生 `sessionTitle.rename` 产生日志标题，query 返回层级被正确读取。快照使用 `sessionQuery.readSession`，不调用已弃用的 snapshotEvents；UTF-8 字节预算不篡改内容。
6. **Agent 附着生命周期**：相同 session ID 重新附着产生不同 process-local attachment epoch；旧流不留作 active，新 attachment 可从 revision 1 正常输出。目标在原生准备成功后才替换；坏 resume/preset 后原 Agent 仍可 state/send，不靠新建会话掩盖旧上下文不可用。
7. **审批 FIFO**：inline/fullscreen 都验证多个请求按原始 ID 排队；第一个请求迟到的确认不会隐藏第二个；排队请求提前关闭、会话切换和过期请求不会错配。
8. **UI/native 分工**：help/autocomplete 来自 native descriptors；compact/自定义命令的完整空白/多行参数被原样转交，原生结果/错误不被重解释。工具 proposal 不冒充运行，未观察到结果不冒充成功/失败；同附件元数据更新不擦除 live output。
9. **输入/配置**：CC word/whitespace kill、undo、paste、history/stash、上下文 keymap、禁用/remap、外部编辑器和正常退出原有回归仍通过。
10. **`/reload` 热更新**：Home/profile patch 同步到 scratch 后由原生 HMR 重组；新增命令在运行中生效，当前 session/info 和 transcript 不变；无效 patch 报错且旧组合继续可用；真实 profile 文件不被写入。TUI settings 合法编辑立即重载，坏文件保留旧值并拒绝覆盖。
11. **Agent preset / effort**：私有 overlay 插入原生 `agent-preset-registry`，从已安装 `dsh-web-app/presets/*.patch.yml` 注册 standard/ptc/minimal/cordis，不复制工具集；host-plane 工具行按官方组合禁用。空白会话 `/preset` 通过 `agentPresets.select` 原地切换，已开始会话返回 locked 并由 UI 留到下一次 `/new`；`/effort` 读取 `llm.resolveModelInfo().reasoning`，`/model` 保留仍受支持的显式等级或退回目标模型默认。离线 native fixture 验证 roster、锁定、`/new` 携带 preset、effort 选择与 minimal 命令集差异。

以上常规测试使用临时 home/workspace、纯模拟或 loopback SSE，没有真实凭据或远程模型调用。

## 强流式检查（不是最终文本计数）

- 真实 DSH Agent + 慢流 fixture 在 inline/fullscreen 必须在未 idle、未 durable assistant settlement、未输出最后一块时已经显示部分正文；此时可继续编辑草稿并取消。
- 实际 DeepSeek provider/原生 pi-ai 三种协议（Messages、Completions、Responses）指向 loopback SSE。服务器只有在测试确认 prefix 已上屏后才释放结束帧；整段缓冲无法通过。
- 验证 stream:true、认证/兼容参数、逐帧递增 revision、durable-before-end、草稿保存与最终去重。Go loopback 自定义目录现在明确使用 `opencode-go-custom`，不替换 native Go catalog。

## 实际 CLI PTY

`python3 scripts/pty-smoke.py` 两模式都完成输入、kill/yank、stash、Settings 内键位编辑与保存、返回后继续发送、连续输出、resize、取消、退出：

| 模式 | exit | synchronized frames | 输入/resize | 终端恢复 |
| --- | ---: | ---: | --- | --- |
| inline | 0 | 65 | 通过 | 通过 |
| fullscreen | 0 | 85 | 通过 | 通过 |

这是实际进程/ANSI 协议验证，不是 FPS、GPU 或 IME 主观体验测量。

## 历史实网记录（旧迁移入口，已删除，未重跑）

下表是上一轮通过已删除的 Pi `modelsFile` 迁移入口得到的记录，保留作历史证据。当前实现没有该入口；这些路由只有在 DSH 原生 profile/home 中声明并认证后才可用。上面的原生 `dsh-tui` profile 实网复测与 loopback/held SSE 回归是当前证据，不把下表当作当前原生路由健康证明。

父 Agent 当时通过显式 `modelsFile`，只读原配置/认证，使用临时 DSH home/workspace；不调用工具：

| 路由 | text chunks | 首 token | 首末文本跨度 | 结束前不同正文画面 | 错误 |
| --- | ---: | ---: | ---: | ---: | --- |
| cloudagent/deepseek-v4.1-flash-1017 | 120 | 6804 ms | 2225 ms | 108 | 无 |
| opencode-go/deepseek-v4.1-flash | 111 | 9308 ms | 1618 ms | 15 | 无 |
| cloudagent-gpt/gpt-5.6-sol | 87 | 2838 ms | 5841 ms | 57 | 无 |

三条均有多次 partial paint、正常结算、输出符合编号提示、未请求工具。这不等于目录内全部模型逐项健康检查，也不说明大上下文子代理的上游配额问题已经消失。

## 历史与仍存边界

- 最初非流式 bug 是 TUI 错把 revision 当 attempt 内固定值；现已接受 native 逐帧递增版本。原单测/Demo 曾错误地固定 revision，本轮进一步使用 native codecs 和强 pre-finish 检查避免再次镜像错语义。
- 之前 DeepSeek account 复测遇到 HTTP 402 / ACCOUNT_QUOTA / Insufficient Balance；未修改余额、认证或路由，也未再用该账户冒烟。
- 没有 Pi 模型/认证导入入口；测试与使用都直接读取 DSH profile/home 的原生目录。旧导入环境变量只提示、不读取。
- 单根 DSH_HOME 没有安全的 native overlay-home seam，仍保留 minimal link/profile isolation glue。通过 native settings 写到私有 profile 的配置不会成为永久命名 profile 编辑器。
- 网关自定义 header 走原生 `llm-pi-ai` provider `headers`；TUI 不维护另一套请求认证或凭据迁移。
- 不宣称完整 CC/GNU Readline；图片、子 Agent/todo/goal 面板、fork/rewind、timed-question 补答 UI 仍未实现。多进程 recall 已补共享 store/文件锁/目标 cwd 原子写入和独立进程回归，不是第二份 DSH 会话事实存储。
- Rex 的字体、输入法候选窗和 GPU 主观流畅性仍需用户实际体验；不能由 VT/PTY 代替。

运行入口见 README；协议与原生边界见 BACKEND.md；原生 profile/模型配置与限制见 PROVIDERS.md；机器报告见 `artifacts/native-dsh-config-acceptance.json`。
