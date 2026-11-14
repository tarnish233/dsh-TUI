# 版本记录

## v0.1.10：修复 npm prebuild 打包

- **问题**：0.1.8 已于 2026-11-14T08:16:27Z 公开发布，但检查 registry tarball 发现 391 files 中没有六个 native prebuilds。`files: "vendor/pi-tui/native/*/prebuilds"` 在 `pnpm pack` 中生效，在 npm 的 publish packlist 中不匹配嵌套 `.node`；0.1.8 因此缺少 native clipboard 预构建。早期 registry 传播延迟造成 404/409，期间暂存的 0.1.9 候选有同样缺陷，未公开并作废。
- **修复**：`files` 改为 `vendor/pi-tui/native/{darwin,linux,win32}/prebuilds` 三个显式目录；仍只发布预构建 `.node`，不包含 native 源码、头文件或构建脚本。
- **回归**：`test/package-pack.test.ts` 保留 source-only `pnpm pack` 构建检查，并新增 `npm pack --ignore-scripts` 对实际 publish packlist 的检查；临时恢复旧 glob 时新断言失败，修复后通过。
- **发布身份**：包版本 `0.1.10`，npm 包 `@tarnish233/dsh-tui`（public）；bundle patch／launcher assertion 与 package 名一致；默认 profile、命令名与服务名仍为 `dsh-tui`。已通过 staged publish + 2FA approve 发布，npm `latest` 指向 `0.1.10`。
- **发布核验**：registry tarball 为 397 files，1,280,039 B / 5,218,910 B unpacked，包含六个 native prebuilds、`bin/dsh-tui.mjs` 与 `lib/version.js=0.1.10`；临时 DSH profile 执行 `dsh plugin --profile smoke add @tarnish233/dsh-tui@0.1.10` 成功，安装后的应用 `--version` 为 `0.1.10`，prebuild 数量为 6。
- **验证**：完整冻结 `pnpm check` **2905/2905**（227 文件，build＋strict TypeScript，0 fail/cancel/skip/todo，576161ms，EXIT 0）；547 个 tracked/untracked 输入前后一致。证据 `.cache/release-v0.1.10/{before.sha256,full-check.log,after.sha256}`。
- **边界**：没有运行时行为变更；不发布到 `@deepseek-ai` scope、不替换全局可执行文件、不修改用户 profile/credentials/session。0.1.8 的 prebuild 缺失在 0.1.10 修复；旧版本不再作为推荐安装。

## v0.1.9：未公开的暂存候选

- 0.1.8 registry 传播延迟期间按 phantom-stage 误判提升的候选；stage id `e55612ac-1522-4aff-a7af-22a144456144`，391 files，同样缺少 native prebuilds，README 记录也已被 0.1.10 取代。没有 approve、没有 GitHub tag/release，不构成公开版本。

## v0.1.8：npm 公开发布（prebuild 缺失）

- **npm 状态**：0.1.8 于 2026-11-14T08:16:27Z 公开，初始 `latest` 指向它；registry 读路径曾短暂 404，随后可见。npm 同时保留 staged-publishing 的 `0.0.0-stage` 占位版本。
- **发布身份**：npm 包改为 `@tarnish233/dsh-tui`（原 `dsh-tui` 已被另一项目占用），移除 `private`，bundle patch 与 launcher assertion 同步 scoped package name；默认 profile、命令名与服务名仍为 `dsh-tui`。
- **分发**：GitHub 仓库标记 `dsh-plugin` topic，并创建与 0.1.8 对应的 release/tag。DSH 官方插件市场截至 2026-11-14 尚未上线，当前按官方 bundle 规范以 npm 公开包 + topic 作为发现与安装路径。
- **打包缺陷**：发布 tarball 为 391 files、约 1.25 MB，但未包含六个 native prebuilds；`test/package-pack.test.ts` 当时只走 `pnpm pack`，没有覆盖 npm 的 publish packlist。0.1.10 修复并补回归。
- **验证**：完整冻结 `pnpm check` **2905/2905**（227 文件，build＋strict TypeScript，0 fail/cancel/skip/todo，598290ms，EXIT 0）；547 个 tracked/untracked 输入前后一致。首轮 2904/2905 仅 `test/app.test.ts` 的 `/reload` 旧文案断言未匹配稳定输出 “Keybindings were not applied”，修正断言后复跑通过。证据 `.cache/publish/{before2.sha256,full-check.log,after2.sha256}`。
- **边界**：不发布到 `@deepseek-ai` scope、不替换全局可执行文件、不修改用户 profile/credentials/session；npm 发布使用用户明确授权的账号与公开包。

## v0.1.7：Settings 默认模型、Review 修复与简化优化

- **入口**：现有 `/settings → DSH` 新增 `Default model`／`Default model effort`，保留连续单页、同一主 Editor、搜索／滚动返回状态与原有当前模型／effort 操作。
- **原生所有权**：两行对应同一个 `agent-default-model` 原生选择，通过 Settings 的 namespace／volatile field／revision 守卫一次修改 provider/model/effort；不写本地 `settings.json`，不读 Pi models/auth，不造每模型默认表或第二配置层。
- **effort**：只列保存的默认模型实际支持的 native IDs；`Default` 执行 native unset，不把有效默认值存成显式 override。换模型只保留新模型仍支持的已存 effort，否则原生移除。思考文本显示偏好独立。
- **行为与安全**：`/model`／`/effort` 继续沿用 DSH 同时选当前与提交默认的行为；新默认入口不选择 logged／CLI-pinned 会话。坏的旧 reasoning metadata 禁用 effort，但可通过原生模型名册修复默认；namespace／write path／runtime owner 不可证明时不假称可写。读取失败、冲突、被 overlay 拒绝和 read-back 不一致在原界面可见，不重试或写入本地替代值。
- **呈现与竞态**：复用 ModelPicker 的可定制标题／`default` 标记和 SelectDialog，不加键位。刷新／错误期间不能选旧名册，旧 press、旧 attachment 与迟到 metadata 不可复活；成功反馈留在 Settings，不追加对话消息。
- **验收**：新 App／native restart／Backend 专项 **43/43**；3 个原生场景通过真实临时 profile 保存 → 新 DSH 进程读取 → 原生 reset → 再次重启，并验证坏默认修复，正式文件每次运行包含 7 次原生启动且不创建 Agent／发送模型请求。新增正式回归 **59** 项，最终完整冻结 `pnpm check` **2831/2831**（227 文件，build＋strict TypeScript，0 fail/cancel/skip/todo），全部 545 个 tracked/untracked 输入在运行前后相同；首轮旧权限导航 offset 的 2 项失败只修测试为稳定行 ID，原确认／不执行断言保留。详见 `docs/ACCEPTANCE.md`。
- **P1 Review 修复**：裸 LF（Ctrl+J/`return`）不再在补全、列表、审批和 Tools find 字段中冒充 Enter；DecisionDialog／详情覆盖层的原生文本（含多选 label/description、proposal 路径）统一净化终端控制序列；`/effort` 空名册结束 loading；preset 默认写入对 roster 读取增加取消／超时 fence。新增回归后最终完整 `pnpm check` **2842/2842**（227 文件），首轮 2838/2838 与最终轮均冻结输入一致。
- **P2 Review 修复**：tarball 补 `vendor/pi-tui/native`；App 缓冲 pre-ready session 事件、清理 Settings 返回态、去重 keybinding 警告、模型刷新进入 loading；SelectDialog/ModelPicker 在旧 roster + loading 时显示 `Refreshing…` 并禁用 Select，error 状态同样不留下死 chip；Settings 鼠标命中使用稳定 row id；历史 browsing 空 Ctrl+W/Ctrl+U/Backspace/Delete 不再退出；分片 paste 超时不再吞前缀，合成 Escape 不会中断 busy turn；默认模型 catalog failures 保留 native 文本，revision 在昂贵读取前提前检查。P2 首轮 **2860/2860**，review 补漏后 **2863/2863**，再补历史空删除与 synthetic Escape 后最终 **2865/2865**；各轮 545 输入冻结一致。
- **简化与优化**：keymap context 绑定预编译并删除 44 项 `APP_FALLBACK_ACTIONS`；`TranscriptStore.items` 按 list/projection/session 记忆化，subagent 锚点改为一次遍历二分；`OutputTracker` 增量 total 与窗口索引；native-codec 每流增量 fold/join；12 处 `CLOSE_ACTIONS` 收敛；keybinding labels 去漂移；死 seam/boundaries/UI 导出与未使用 helper 清理；tsconfig 启用 `erasableSyntaxOnly`/`verbatimModuleSyntax`。最终完整 `pnpm check` **2881/2881**（227 文件，546 输入冻结一致）。
- **整体 review 修复**：synthetic Escape 在 input 层消费；ModelPicker error 不再产生死 chip；pre-ready 只重放增量帧/decision 配额优先；坏 keybindings 错误签名去重；Settings 失败不再双写；catalog 读有界超时；坏旧 effort + 新模型 metadata 不可读时 unset 修复；重选当前默认模型成功无变化（`unchanged`）；compaction/execve/prebuild 收尾。启动 connect 提前的“优化”因 native acceptance 挂起已回退。最终完整 `pnpm check` **2905/2905**（227 文件，547 输入冻结一致）。
- **版本边界**：版本/identity 更新为 `0.1.7`；按用户授权创建本地 release commit 和 annotated `v0.1.7` tag，并 push 到 `origin` main/tag；不发布 registry、不更换全局程序、不改依赖／lock／vendor 源。`v0.1.6` 历史保持不变。Schedule 继续暂缓。

## v0.1.6（本地 annotated tag）

- **版本范围**：收录 v0.1.5 之后已验收的输入、原生能力、性能与 Review 修复；按用户授权创建本地版本提交与 `v0.1.6` tag，保持 `private:true`，不 push、不发布 registry、不更换全局程序。
- **交互**：问卷／审批／搜索／短选择靠近编辑框，浏览／管理保留独立页；完整 native detail／Proposal 只读查看并保留原问卷状态。
- **Pi Ctrl+C**：主输入一次清空并保留可恢复草稿，后台继续；500ms 内再按安全退出。局部 Ctrl+C 只取消／拒绝当前交互，Esc 与显式原生中断保留。
- **原生能力与修复**：历史大纲／窗口、Workspace summary/diff、Proposal；原生 seq/index/path 与 attachment 身份守卫、只读 disclosure 隔离、显示列／快捷键诊断、渲染／高亮／测量缓存。Schedule 继续暂缓。
- **验收**：功能源码完整 `pnpm check` **2772/2772**（224 文件）；标记版本前再次核验全部 541 个输入与已验收工作树完全一致。版本调整仅涉及版本标识与文档；重新 build＋strict TypeScript，CLI／welcome／真实 source-only pack／native Pi clear／App／composer／局部取消专项 **106/106**，源码、编译产物、manifest 与既有软链 CLI 一致为 **0.1.6**。专项期间工作树指纹一致，详见 `docs/ACCEPTANCE.md` 与 `.cache/release-v0.1.6/verification.log`。

> 下方“未发布／未提交”等描述保留各实施阶段的当时状态，不表示本地 v0.1.6 tag 缺少这些修复；旧阶段的测试数字不是当前完整门禁。

## 未发布：输入邻近弹窗分层与 Pi 式 Ctrl+C

- **呈现分层**：原生问卷／审批、继续问题的实际回答、Ctrl+R 搜索、快速 preset／permission／effort 和 `/attach`／主命令短表单进入编辑框上方；Settings 子操作继承父工作页。Model／Resume／Help／历史／Workspace／Queue／Jobs／检查／Tool／Image／Agents／子会话详情保留独立面板。
- **单 Editor 与高度预算**：新 `ComposerInteractionHost` 只承载呈现；纯 `measureRows` 与绘制同一几何，短内容不撑满最大 cap。状态 dock／队列摘要／frozen 主输入／footer 与 transcript 共用真实行预算，保留原 Editor、undo、marker、cursor；不是简单把居中 overlay 改成 bottom。
- **原生完整详情**：`dialog.details`（默认 Ctrl+O）打开 supplied native question.detail／pure Proposal 的只读全内容，返回保留原问卷实例、选中项和自定义回答；请求关闭／attachment 更换同步退休，不能显示 Applied、执行工具、调用 presentResult 或读文件。
- **Pi 清空／中断分工**：`app.clear` 默认 Ctrl+C，无 busy 分支，清空并保存可撤销草稿，不取消原生 Agent／工具／子 Agent；500ms 内再按退出。Esc 保留局部优先与原生中断；`app.interrupt` 默认未绑定，显式用户绑定仍可中断，旧绑定冲突可见而不改用户文件。其余 CC/readline／Ctrl+D 不改。局部 Ctrl+C 只取消／拒绝当前面板或请求，取消键禁用／移走时不伪造 fallback。
- **恢复与隔离**：分片粘贴的 Ctrl+C 是内容，扩展协议 release/repeat 不产生第二次退出；清空退休 clipboard／file／queue-read 结果而不取消后台执行。无 native human inbox 时 busy Up 恢复清空前草稿，不被空 dequeue 覆盖。
- **最终验收**：四个 `cloudagent/glm-5.3` 分域完成，新增正式回归 **94** 项；完整冻结 `pnpm check` **2772/2772**（224 测试文件，build＋strict TypeScript，0 fail/cancel/skip/todo，553357ms，EXIT 0），`.cache/composer-full-check-final.log`，运行前后完整工作树指纹一致。Parent 原生 composition 19/19；Ctrl+C／Esc／退出／恢复 PTY 10/10，通用 CLI／Settings PTY 2/2；22/22 实际变异断言 red、立即恢复/hash。首轮唯一真实时钟测试差异以固定 store＋renderer clock 修正，原画面全等断言保留，20/20 重复通过。
- **边界**：无真实模型／Provider、凭据或用户 profile/session 操作；服务器仅只读确认 CC 2.1.318 并在隔离 namespace 空 HOME 跑 `--version`，未做模型探针。没有第二 Harness／模式／配置层／Schedule、全局替换、commit/tag/push/publish。

## 未发布：全面 Review 修复闭环（8 项 P2、3 项 P3）

- **最终完整门禁**：`pnpm check` **2678/2678**（216 测试文件，build＋strict TypeScript，0 fail/cancel/skip/todo，541365ms，EXIT 0），`.cache/review-fix-full-check-final.log`；运行前后整个 source/test/doc 工作树指纹一致，之后只补本验收数字。
- **工作区身份**：卡片与 details request 捕获 exact session/attachment；App 验证来源、当前 turn/seq 和 file path，并向原生 diff 命令传入 captured scope。切换立即退休 pointer targets；稳定 turn 卡片替换或 affordance 消失后，旧 press 的 generation 不能在重绘后被重新解释成另一文件／snapshot 的点击。
- **原生文件索引与 latest-turn**：不再过滤后重编号 `files`；合法空白文件名保留原始 native index、显示为安全引号标签；任何 unusable row 整体 fail closed，text/binary/oversized diff 都交叉验证 native path。同 turn 的 higher seq 替换原卡片并更新 diff seq，lower late seq 不复活旧汇总，latest zero-files 是真实原生事实。
- **只读历史**：`readonlyDisclosure` 隔离详情投影的 Tool／Thinking／group 展开读取与所有 clear/retain/transfer/toggle；包括自定义 `createView`。不 backup/restore 全局状态，主 transcript 的展开与唯一 editor/draft 始终保留。
- **输入**：保留跨 CJK／emoji／ZWJ clamp 的 unrounded display goal；goal 带实际 layout width stamp，resize／不同宽度的 snapshot 恢复不重放旧视觉列。快捷键按完整 chord 与真实 resolver 优先级分析新增冲突，sibling suffix 不误报，Settings 拒绝偷走默认 chord 的保存；prefix 单键诊断改为 unreachable／timeout drops prefix，不改变原取消语义。
- **原生读取与降级**：每侧 TUI cap 仍为 50；仅接受官方 `SESSION_QUERY_INVALID_WINDOW` 的 exact bounded lower-limit 证明，至多一次 narrowing retry，共享原 5 秒 signal/deadline，按 native service/method identity 缓存，严格校验实际 dispatched bounds。成功适配不 warning、不污染主 transcript；native max=0 无法前进时显示真实 partial marker，而非假称完成。Workspace diff 缺 capability 时卡片保持纯汇总，history 需要两条能力才广告；同 attachment 失去能力关闭旧 dialog，恢复后重新启用。
- **Hover／时序**：Activity/Subagent header hover 先失效 cache；无变化帧仍复用。校正原生时序：durable `tool/call` 是 dispatch admission，早于 prepare／approval，却不证明工具已执行；真实验收确认 pending Proposal 时 owned 文件仍不存在。
- **回归与变异**：新增正式回归 **61** 项。四域加 Parent 共 **24/24** 定向变异变红、恢复并核对源文件 hash，含重绘后 press retirement、zero-window partial、静默 bound 和 resize scope。Parent 全部 Backend／Input／UI＋App native 复验 **1966/1966**（`.cache/review-fix-final-focused.log`），native **9/9**＋Help **2/2**＋source-only pack **1/1**（`.cache/review-fix-final-native-pack.log`），build／strict TypeScript clean。完整冻结门禁已获本批 2678/2678，不用旧 2617/2617 替代。
- **边界**：只用 owned HOME/workspace、hermetic stream／fake host；不调用真实 Provider，不改用户 profile／凭据／session，不引入新 Harness／IPC／Pi AgentSession／auth 或 schedule 子系统。Schedule 继续暂缓；未 commit／tag／push／publish／全局安装。

## 未发布：DSH 原生历史、工作区变更与审批 Proposal

- **最终完整门禁**：`pnpm check` **2617/2617**（214 测试文件，build＋strict TypeScript，0 fail/cancel/skip/todo，532824ms，EXIT 0），`.cache/native-capabilities-full-check-final.log`。首轮 **2615/2617** 仅两项 Help 首屏假设失败：新增 `/history` 后 `/permission` 移到次页；改用现有只读搜索后双模式 **2/2**，再获完整全绿，生产命令路由未改。

- **历史**：挂载官方 `session-turn-outline`，`/history` 通过 `sessionProjections.snapshot(session,['turnOutline'])` 读取整段大纲，并以 `sessionQuery.readEvent` 的每侧最多 50 条窗口打开独立只读 transcript；合并按原生 seq 去重，页数／事件／字节有界，live transcript 不被修改。pending 会话不因只读历史创建 Agent，close／switch／late page 均有身份守卫。
- **Workspace**：挂载官方 `workspace-changes`，只在 live `workspace/changes` 事件上展示原生汇总，并通过 `workspace-change-diff {seq,index}` 读取原生 text/binary/oversized/coarse 比较；不读文件、不跑 git、不解析宿主机路径，resumed history 不伪造变更。修复官方 recorder 先 append 事件、后发布 summary 的时序：一个 microtask 屏障保持后续事件顺序，close／switch 不发送迟到旧投影。
- **审批 Proposal**：assistant proposal 阶段只调用 `ctx.tools.get(name, exactAgent).presentCall(parsedArgs)` 并有界缓存，审批显示 **Proposal · not run yet** 原生 diff；不执行工具、不调用 `presentResult`，带 result 或 malformed view 均回退原审批 UI。
- **验收**：Backend＋三个 UI＋App 合并聚焦 **500/500**，strict TypeScript clean；真实临时 native composition inline＋fullscreen **2/2**，实际覆盖 read-only 沙箱升级审批、Proposed diff、允许一次后 owned 文件写入、live summary/diff、两页 history 与 `/history`。空大纲原生 cursor `-1` 的 App 复验也有独立回归。append 时序变异被新增回归抓住并恢复。日志 `.cache/native-final-parent.log`、`.cache/native-history-workspace-acceptance.log`、`.cache/native-workspace-barrier-mutation.log`。
- **边界**：未挂 Web frontend、Schedule 或 SessionController，未新增 `/schedule`；Schedule 按用户决定暂缓。全部 native 验收使用 owned HOME/workspace 与 hermetic stream，无真实 Provider／profile／凭据／session 操作，未提交／tag／push／publish。

## 未发布：渲染缓存、懒加载与测量性能

- **最终完整门禁**：`pnpm check` **2513/2513**（206 测试文件，0 fail/cancel/skip/todo，536345ms，EXIT 0），`.cache/performance-full-check-final.log`。
- **稳定块复用**：CachedBlock／ToolBlock／group 在无 live clock、宽度及 disclosure generation 不变时直接复用已绘 lines，不再每帧组装 viewKey。hover、cwd、Settings、child catalog、session、工具／Thinking disclosure 和 expanded child paint revision 都有显式失效；800 item 未变帧从 800 次 key build 降为 0，毫秒仅作诊断不作测试阈值。
- **highlight.js 懒加载**：`theme` 导入不再加载 core／20 个 grammar；首次代码块同步返回 byte-identical plain fallback，并只发起一个动态 import，ready 后清 LRU 并通知。Transcript／ImageContentBody 与 DecisionDialog 两类直接 Markdown owner 都使自身 `(text,width)` 缓存失效并退订，failed 保持静默纯文本，无 stale plain cache 或 disposed repaint。
- **流式 Markdown**：新增 `StreamingMarkdown`，强引用已封存 prefix，只重排 tail；非 append 重置、宽度切换双侧重绘、重复帧数组复用。段落／heading／闭合 fence／math 可 seal；list／quote／table／HTML／reference 等 barrier 清除既有 seal 并终态整文回退。后到 link reference（包括普通 barrier 之后）不会让旧链接文本滞留，fence 内同名文本仍是代码。18 项专项含 5000+ 次逐前缀 differential rendering；父级另跑 4 个定向文档逐字符全等。基准 40-section 流式消息中位 0.0132ms vs 0.3033ms，非门禁阈值。
- **Dock 测量**：`CcEditor.measureRows()` 通过 seam 复用 vendored `layoutText`／`SelectList` 几何并 memoize，不调用 Editor.paint、不写 scroll／cursor／undo；`DockPromptEditor` 委托 super，App 直接测量 `Prompt` 而非 Container fallback。9 项矩阵覆盖 CJK／emoji／150 行／marker／completion／scroll，重复测量 0 次额外 layout。
- **验收**：UI 全部 **1061/1061**；Input 全部 **351/351**；父级性能组合 **115/115**，build／strict TypeScript 通过。hover、highlight ready、dialog 退订、unsafe seal、late reference 和测量副作用均做过定向变异并恢复。证据 `.cache/performance-parent.log`、`.cache/render-cache-performance/RESULTS.md`。

## 未发布：Input P2 显示列与跨上下文诊断

- **最终完整门禁**：`pnpm check` **2462/2462**（202 测试文件，0 fail/cancel/skip/todo，512449ms，EXIT 0），`.cache/input-p2-full-check.log`。
- **竖向移动**：vendored Pi Editor 不再把 UTF-16 偏移当终端显示列。source／target／sticky column 统一使用现有 `visibleWidth`，最终只在字素边界换回 UTF-16 cursor；CJK、emoji／ZWJ、variation selector、combining mark、混合软换行和短宽行保持目标视觉列。补丁及退出条件记录在 `vendor/pi-tui/SOURCE.md` deviation #10。
- **快捷键诊断**：新增 `cross-context-shadow`，覆盖 fallback layer 死绑定、抢占默认键、chord-prefix 吞键和 modal interrupt priority（后续 Review 校正了原“超时后执行”的错误提示）。只报告相对声明 baseline 新增的问题；同上下文冲突、既定 local-over-global 优先级和 no-op 重保存不重复报告。App 将自带 `modeBindings` 同时传给 live／save-preview 的 `baselineBindings`，不会把产品预设误报为用户冲突。
- **验收**：新增 `test/input-vertical-columns.test.ts` 5 项与 `test/input-keymap-shadow.test.ts` 6 项；竖向补丁变异使 4/5 测试变红，删除跨上下文检测使 6/6 变红，误报过滤器变异使 5/6 变红，恢复后全绿。Parent 独立 Input＋App＋Keyboard UI **369/369**，build／strict TypeScript 通过；`.cache/input-p2-parent.log`。未新增 `/hotkeys`、配置层级或第二编辑器状态。

## 未发布：源码打包与 Backend P2 修复（基于 v0.1.5）

- **最终完整门禁**：`pnpm check` **2451/2451**（200 测试文件，build＋strict TypeScript，0 fail/cancel/skip/todo，513316ms，EXIT 0），证据 `.cache/p2-full-check.log`。
- **源码打包**：新增 `prepack: pnpm build`，`pnpm pack` 不再依赖工作区里预先存在的 `lib`／`vendor/pi-tui/dist`。`test/package-pack.test.ts` 从无两套构建产物的临时源码副本实际打包，检查应用／native 插件／vendored TUI 的 JS 与声明文件，再解包执行公开 CLI 的 `--version`。旧 manifest 下该测试因缺少 `package/lib/cli.js` 失败，修复后通过；证据 `.cache/package-pack-before.log`、`.cache/package-pack-after.log`。
- **Wire／DTO**：`surfaceOp.replace`、事件 seq／`sourceEventSeqs` 只接受非负安全整数，不再强转出 `NaN`；会话列表跳过无原生 id 的行而不是制造 `"undefined"`；preset 列表改为显式字段白名单，不再透传整个原生 roster row。
- **读取与快照**：根 `readSession`／`listSessions`／`readTitleSnapshots` 统一 5 秒 adapter bound 与 close／attachment guard；DSH 不接受 signal 的读取只放弃自身等待，不冒充原生取消。`snapshotForRoot` 的 join 分支返回当前 root 的新投影；冷子会话读取改为最多 8 个并发、保持原生顺序并释放 lease，200 行最坏为 25 个读取窗口而非 200 个。
- **生命周期与写入**：`stageFile`／`native-default-update` 进入 active-command／reload idle 契约；`ensureCurrent` 在异步物化和 ready 前复检 closed／ownership，失败回滚并只释放自己的 Agent；每个 Subagent 事件不再执行完整 Loader capabilities 枚举，动态能力仍在正式 announcement 重读。
- **附件 admission**：`sendContent` 通过唯一 8 秒 `nativeUiRead` bound 与 active-command carrier 调用原生 admission；Esc／close／切换会停止 adapter 等待并禁止迟到发送。已核实 DSH `admitPromptContent(content)` 不接受 signal，因此不虚构原生取消或增加第二个 timeout。
- **Fork 收敛**：删除无生产调用方、会产生不可接 Agent 的 session-only artifact 的 `NativeManagement.forkCurrent()` 及专属 DTO／测试；生产 `/fork` 仍唯一走完整 durable seed＋native `agents.create` 的原子切换路径。
- **专项验收**：新增 `test/backend-context-regressions.test.ts` 22 项、`test/backend-subagent-refresh-guards.test.ts` 9 项与打包 1 项；context 的 12 个定向变异全部被抓取并恢复正式实现。Parent 独立 Backend **389/389**、Subagent **73/73**、management **29/29**、打包＋附件 **18/18**，strict TypeScript 通过；证据 `.cache/backend-all-parent.log`、`.cache/p2-typecheck-parent.log`。

## 未发布：P0/P1 缺陷修复（基于 v0.1.5）

两轮并行只读审计（9 个 Agent）之后，按 P0/P1 修复并逐条加回归测试；backend 与 ui 的每项都做过「临时撤掉修复必须变红」的变异验证。最终完整 `pnpm check` **2421/2421**（197 测试文件，build＋strict TypeScript，0 fail/cancel/skip/todo，508142ms），证据 `.cache/p01-check.log`。

- **输入 P0**：`exitHistoryBrowsing()` 把草稿的 `[Image #N]`/`[File #N]` payload 合并回 live registry，而不是在 18 条编辑路径上丢弃——此前 `↑` 召回历史后打字/undo 会让附件不可恢复、`getPromptContent()` 抛 `CcUnresolvedImageMarkerError`。`wordWrapLine()` 只对可分的多字素段再切分，1–3 列终端的 CJK/emoji/ZWJ 不再 `RangeError`。
- **输入 P1**：历史召回光标落在条目末尾（readline/CC 语义，打字追加而非前置）；`insertImage()` 与 `insertFile()` 对称预留手打标记 id（手打 `[Image #N]`/`[paste #n]` 不再被下一次上传/大粘贴静默"升级"）；分片粘贴前缀有 50 ms 上限（`pasteHoldTimeoutMs`，unref 定时器，`dispose()`/flush 清理），held 字节也算 `isPasting()`，不再吞掉下一个按键；提交载荷 `text` 与 `content` 来自同一次裁剪。
- **Backend P0**：`queue-send-now` 变成事务——`followup` 被拒时两个 inbox lane 的 id 序列完整回填；`close()` 缓存第一次清理 promise，重复调用 join，`closed` 只在 `sessions.flush` 之后发一次。
- **Backend P1**：`COMMAND_DECLARATIONS` 单一声明表取代四处并行清单，`permissions`／`queue-remove`／`efforts` 真正 session-less（表驱动测试直接从 `docs/BACKEND.md` 解析清单校验，文档与代码不再漂移）；`readImage`／`commands.execute` 的原生拒绝统一走 coded + redacted 分类；pending decision 记录 owner，根 `cancel()` 不再越界结算子 Agent 的问题，`close()` 结算全部；`/reload` 在 pending 会话可用且仍拒绝 unsettled command/decision；会话切换 abort 并 drain 自己的原生命令，`/reload` 不会被永久拒绝。
- **App P0**：安装 `uncaughtException`／`unhandledRejection` 恢复——画出脱敏原因、交还终端、非零退出，而不是把栈画进 alt-screen + raw mode。native 插件显式传 `installCrashHandlers: true`（launcher 拥有信号，但本进程拥有终端）。
- **App P1**：一个后端事件只画一帧（`store.onChange` 在事件处理期间不重绘，`stream_start` 由两次变一次）；底部 dock 改用 `measureRows` 测量，不再为量高度重绘成员；`SIGTSTP` 被忽略时 500 ms 后回滚 UI 并提示（`setImmediate` 让真实 SIGCONT 赢得竞争，避免误报；回滚后的迟到 SIGCONT 不会二次 `start()`）；重复中断走 `interruptShutdown()`——停止等待有界清理但保留首次退出码，普通重入仍 join。
- **UI P1**：折叠 group 只在 header 行声明 hover owner（tool/activity/subagent 三处统一，现有 hover 契约测试未改）；删除 `ModalListSurface.bodyMouse` 的不可达回退（同时恢复 body 尺寸重标定契约）；图文混排 run 之间至多一个空行（原空 `if` 分支从未实现）；`TranscriptView` 按 item 身份 + 投影偏好缓存整帧投影，未变更的重绘不再重跑三次折叠、不再重建 key 集合。
- 新增 55 条专项回归：`test/input-regressions.test.ts` 17、backend 17（`backend-context`／`backend-subagents`）、`test/ui-rendering-hardening.test.ts` 16、`test/app-lifecycle-hardening.test.ts` 5。
- 版本漂移修复：`src/version.ts` 从 `0.1.4` 同步到 `0.1.5`；`test/cli.test.ts` 与 `test/ui-identity.test.ts` 改为从 `package.json` 派生期望值（此前硬编码，任何 bump 都会红）。
- 边界未变：`@path` 仍是纯路径 mention，`/attach` 仍是唯一 FileBlock 输入；无第二 Harness、私有进程、IPC、Pi AgentSession 后端或 TUI 自有 provider／凭据／调度。全部场景使用 owned HOME/workspace 与 hermetic fake host，无真实 Provider／用户 profile／凭据／session 操作，未提交／tag／push／publish。

## 未发布：DSH 原生 `@file` 补全（基于 v0.1.4）

- 修复输入 `@` 只有普通字符、看不到工作区候选：删除对未配置 Pi `fdPath` 的伪委托，改为可取消地调用当前 attachment／真实 Agent 的 `ctx.fileReferences.list`；DSH provider 保留 effective cwd、排序、排除、索引失效与模型侧 `read` 指引所有权。
- 应用 bundle 声明 canonical `file-reference-local` Host provider，用户后置 profile patch 仍可禁用／替换；不挂 Web `ui-reference` frontend，不读取 Pi 安装的 `fd`，不另扫文件系统或维护第二目录缓存。
- 输入直接复用 DSH 公共 `activeAtToken`／`formatFileMention` grammar；文件／目录、空格引号和目录下钻沿用唯一 Pi Editor 的菜单、undo 与光标。Tab／Enter 接受候选但不发送，第二次 Enter 才提交；失败／取消／旧 attachment 结果静默丢弃。
- `@path` 始终是普通路径 mention，接受候选不读取／stage 字节，也不生成 `[File #N]`；显式 `/attach` 的 native FileBlock 语义与预算保持独立。首个 `@` 查询只在 provider 已挂载时通过现有 lazy path 物化同一个 DSH Agent，不发模型 turn。
- Parent 最终完整 `pnpm check` **2370/2370**（194 测试文件，build＋strict TypeScript，0 fail/cancel/skip/todo，510467ms）；独立专项 Backend＋邻接 **52/52**、Input **63/63**、App **5/5**、真实临时 native profile **3/3**（inline／fullscreen＋用户禁用 provider）。证据 `.cache/native-file-references/`。无真实 Provider、用户 profile／凭据或全局安装修改，未提交、打 tag、推送或发布。

## 未发布：精确 Thinking 尾窗缓存（基于 v0.1.4）

- 每ThinkingBlock有界cache：稳定prefix计数／mutablelastline＋delta／tailpreview，same-source timer/hover不再全文sanitize/wrap；展开fullbody lazy和unstyled复用。
- 隐藏行数、尾部、完整原文与旧sharedwrap逐字一致；rewrite/width/unsafeESC/CR和overbudget走精确fallback，不引入估算、全局cache、设置或timer。
- Parent旧compiledmodule微基准：1400line／160append867→14ms，longparagraph140→5.6ms，timer300frame1591→0.44ms。800场景／87016精确差分通过。
- 完整Parent `pnpm check` **2323/2323**（190文件），native/PTy/旧handoff/hover等回归通过；无business/backend/input/vendor/版本/安装变化，未提交/发布。见 [性能记录](docs/THINKING-PREVIEW-PERFORMANCE.zh-CN.md)。

## 前次未发布：四项现场渲染修复（基于 v0.1.4）

- Node PTC stripTypeScriptTypes exact experimental warning＋相邻hint只留boundedlog，meaningful/fatal仍可见；无blanketwarning屏蔽。
- expanded live Thinking在native settlement/toolhandoff后保留，durableid不变；复用稳定disclosure思路与event→paint计数，未移植PiAgentpatch。
- 单一hoverowner和Parent编辑器／viewport／overlay／publicterminalfocus边界，旧历史click-hints恢复中性色；actualhoverblue、nativechild-brandlinks、drag/selection保持。
- 标题用明确detail＋space组成，Read Image /path不再大小写导致粘连；原文/宽度/鼠标位置契约保持。
- Parent最终完整 **2303/2303**（189文件），native2、App3、双模式PTY与10轮focus重复通过。版本/依赖/vendor/旧tag不变，未提交或发布，零真实Provider／用户配置／global操作。详见 [修复记录](docs/RENDERING-FOUR-FIXES.zh-CN.md)。

## 前次未发布：Demo 展示整体编排（基于 v0.1.4）

- `--demo tasks` 启动就展示混合 `Activities: 1 tool · 1 update` 和独立子任务 relay，Ctrl+O 对照通知折叠，固定区保留统一间距／紧凑态。
- 用另一个已结束的本地 fixture 作 sender；catalog4／active3，无虚构 timing/token。重启使用 turn-scoped id，旧控制、clear/new/resume 保持。
- 最终 build＋strict TypeScript＋专项 **139/139**，actual public CLI 双模式通过；本次未复跑整仓，上一阶段2265/2265为独立门禁。仅离线 fixture与相关测试／文档，无模型／工具／UI业务改动，未提交或发布。

## 前次未发布：展示层整体收敛（基于 v0.1.4）

- `StatusDockStack` 统一 Todo／Goal／Agents 可见性、总预算、紧凑态、all-or-none 间距和鼠标 span；Root 内容块不各自补空行，Parent 不再通过重复 render 测高。
- 相邻真实工具＋纯原生 settlement notice 进入 `Activities` 展示组，tools／updates 独立计数；两现有分组设置同时开启才启用，不 fake tool、不改原生事件。真实消息、可见文本、todo、diff 等保持边界。
- 复用现有 semantic surfaces、真实成员块、Ctrl+O／single-expand／viewport／cache／context 与名字链接，不再另造展示／配置层。
- Parent 最终完整 `pnpm check` **2265/2265**（184 文件），App 8/8、native Session/codec 2/2、新双模式 PTY 和旧 tasks/UI/input/native 回归通过；无真实模型／配置／全局安装／版本标记变化，未提交或发布。见 [整体编排记录](docs/PRESENTATION-COMPOSITION.zh-CN.md)。

## 前次未发布：离线 tasks 交互 Demo（基于 v0.1.4）

- `dsh-tui --demo tasks`／`pnpm demo tasks` 同时展示六项 Todo、原生形状的只读 Goal 和三个本地 Subagent fixture；复用生产 App／Editor／renderer。
- `tasks next`／`tasks done`／`tasks clear`／`tasks history` 手动推进，`tasks` 重启；说明流快速结算，场景保持可观察，不自动播放到消失。支持 Ctrl+T、resize、既有 Agents／Settings 和离线 child 快照／Stop／Reply。
- 仅 task 场景使用 line/phrase-sized 说明流；省略未观察的 child 时间／token totals，完成脚本用 native complete／completed 词汇，正常 Stop 语义与原 demo 延迟不变。
- 完整 `pnpm check` **2208/2208**（179 文件），App 6/6、Demo 9/9 与 public CLI 双模式 PTY 通过。显式离线，不加载 DSH、读 profile、调用模型或执行真实工具；版本/依赖/旧 tag 不变，未提交或发布。见 [Demo 指南](docs/DEMO.md)。

## 前次未发布：Todo／Goal／Subagent 固定区共存修复（基于 v0.1.4）

- 修复 Subagent 出现时 Todo 剩一行却直接消失；单行现在显示 native counts／首个未完成项。完整托盘、Ctrl+T、空／完成收起和原生快照语义保持。
- 按实际可见区域分配最低高度，短屏借用 transcript 预留行；三者按 Todo → Goal → Subagent → Editor 共存，先收缩明细，不挤走唯一 Editor。settled-only child catalog 不再占预留名额。
- 112 组实际 App before/after 中，Todo 被 child-start 顶掉由 8 降到 0；新增 8 个 App 可见性回归与双模式真实 PTY，覆盖多行草稿、resize、显隐、结束释放高度和退出恢复。
- 完整 `pnpm check` **2192/2192**（176 文件，0 fail/cancel/skip/todo）。没有 native 业务、输入/vendor、依赖/版本/旧 tag 或用户配置更改；未提交／推送／发布。见 [Todo 规则](docs/TODO-UX.md) 与 [验收](docs/ACCEPTANCE.md)。

## 前次未发布：两批原生 UI、Todo 固定区与统一配色（基于 v0.1.4）

- Jobs 非消费式只读列表／输出、Goal 固定状态、有效 cwd、原生 plugin/tool 摘要、显式 rename、可继续输入并恢复的 native root fork；不新建调度／目标／会话引擎。
- Settings 复用 native describe/mutate、公开 namespace 和 revision，两个 allowlisted 默认值带确认／冲突反馈；不编辑凭据或 raw profile。
- `/attach` 一般文件直接进入 native store，同一 Editor 的 File/Image 原子 markers；file-only／queue ready refs／命令图片准入和拒绝恢复。当前 composition 无 command-file receipt owner，保持明确 unavailable。
- `/questions` 读 native continued projection＋inbox，late answer 调用 native answer，不接管 blocking timeout 或伪造 cancel。
- Todo 按 CC 状态区域／Ctrl+T 显隐／五项约定，固定在 Editor 上方、原位更新／完成收起，不追加历史摘要；共享 Todo/Goal/Subagent 高度池。
- `surfaces` 统一 canvas/dialog/raised/selected/overlay；删除 modal 私有黑板，保留品牌／semantic／syntax 层级，嵌套 reset／背景 close 和 clipping/padding 统一。
- 验收补修 direct ccSubmit multipart、native projected volatile form、Help body-width tail clipping，以及 file queue DTO/count。完整 `pnpm check` **2170/2170**（174 文件，0 fail/cancel/skip/todo），原生专项 10 cases、新增双模式 PTY 通过；见 [完成记录](docs/NATIVE-UI-BATCHES.zh-CN.md)。
- 旧 64 个未提交文件保留；批准范围内仅扩大 vendor Editor 的 File marker 原子 seam，版本/manifest/lock 和旧 tag 不变。无提交／新 tag／推送／发布、真实 Provider／profile／credentials 或全局安装变化。

## 前次未发布：当前 SDK 内适配层收敛完成（基于 v0.1.4）

- unselected pending／AgentOptions 改为原生默认 live getters，selection/request/CLI/logged resume 仍由 DSH 固定；移除默认快照与不可达 fallback，异步路由前提变化拒绝旧选择。
- resident child 用 public SessionStore + 四键 snapshot，去掉额外 observation lease／全量 fold；cold/failure fallback、diagnostics、权限与取消边界保持。
- public settled config-reload/document-updated 合并失效 preset/model metadata；已有 preset picker 以 native id 保留选择，footer/current badge 跟随 native getter，不自动开窗／选模型或创建 Agent。
- 全量 **1910/1910**（151 文件），native default 4/4、preset/settings 2/2；零实际 Provider 请求。无版本/依赖/vendor/tag/提交/发布/用户配置更改。详见 [完成记录](docs/ADAPTER-CONVERGENCE-COMPLETE.zh-CN.md)。

## 前次未发布：第一轮原生适配层收敛（基于 v0.1.4）

- Subagent 改用原生 listDescendants/listChildren，保留实时投影/当前树父子守卫；metadata-only diagnostics、可用性公告与 epoch/deadline 取消；不再依赖 750ms display cooldown 处理控制。
- public snapshot/sessionTitle.get/agents.turnBoundaryOf/planMode.get 替代 raw stateOf/Plan fold；未知 blank 不造 locked，实际 preset selection 由 native select 决定。
- 模型目录四任务并行且保持 native registry 顺序；公开 LLM catalog events 只刷新已打开 picker，single-flight、保留 query/focus/draft，不新增目录/凭据系统。
- 完整 `pnpm check` **1861/1861**（143 文件）；真实 native 专项 **28/28**，临时 homes/workspaces 与 hermetic streams，零实际 Provider 请求。无版本/依赖/vendor/tag 更改、提交或发布；边界见 [收敛报告](docs/ADAPTER-CONVERGENCE.zh-CN.md)。

## 前次未发布：原生接口审计确认问题修复（基于 v0.1.4）

- 完成 A1–A10：精确 Skill 选择、native exit request/owned cleanup 分离、FileBlock 只读展示、原生非成功终态、commands/change + Help/补全刷新、default model/title/name/hint/free-text 映射，以及 compaction adapter-default effort provenance。
- DSH 仍拥有业务与 root lifecycle；不增加可选原生 UI、通用文件输入、命令图片附件或 Subagent 遍历重构。保留静态 `🐳`、Rex 原生 `>_` 和单 Editor。
- 完整 `pnpm check` **1833/1833**（139 文件，0 fail/cancel/skip/todo）；新增真实 native Skill/command、max-tokens/resume、文件 receipt 与 4 个 native plugin PTY 故障退出场景。全部临时 homes/workspaces、零真实 Provider 请求。
- **未提交／打新 tag／推送／发布**，v0.1.4 tag 仍指向 `4738db0`；version/private/dependencies/lock/vendor 不变。详见 [修复对照](docs/NATIVE-API-FIXES.zh-CN.md) 和 [当前验收](docs/ACCEPTANCE.md)。

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
