# Review 修复与 Esc/Ctrl+C 最终验收

历史审查见 [REVIEW-2026-11-03.md](REVIEW-2026-11-03.md)，基线为 `6871d69`。本轮按用户要求由 `cloudagent/deepseek-v4.1-flash-1017` 子代理分组开发，父 Agent 独立检查实际 diff、补充回归并完成整体验收；不以子代理摘要代替结果。

## 结论

以下 340 项记录是 Review 结束时的验收基线；后续配置目录、权限队列、CLI 默认 profile、设置反馈、只读 Help、状态查询静默、reload 精简、provider 模型搜索、DeepSeek 蓝主题、启动动画、开源原图复用/等比例缩小、2px 原生图片，以及当前**静态字符块（象限像素、内部白填充、无动画）logo、CC 版式错误提示与工具卡单 `⎿` 对齐的最新 479 项结果**见后续修复章节。

- 全量 `pnpm check`：**340 tests / 340 pass / 0 fail / 0 skipped / 0 cancelled**，vendored build 与严格 TypeScript 检查通过。
- 无旧 `node_modules`/dist 的 Git 源码快照：离线冻结锁文件安装、完整 340 项检查、workspace 链接验证、App import 与 CLI help 全通过。
- 实际 CLI PTY：原 Settings/输入/resize 两模式通过；新增取消场景 **8/8** 通过，外部 SIGINT 均退出 130 且恢复终端。
- DSH 仍拥有 Agent、模型、工具、权限、队列、会话、配置、凭据与 HMR。未增加 Pi AgentSession、第二 LLM 客户端、Agent scheduler、YAML merge engine 或插件热加载器。
- 确认的 review 缺陷已修复，或改为明确的 SDK/支持范围提示，不把“必须重启”伪装为“已热更新”。真实 profile 永久默认保存仍受 SDK 限制，详见下文。

## 后续修复：配置目录与权限队列计数

- 默认 TUI 偏好、键位和 recall 改为 `~/.dsh-tui/`；保留 `--config-dir` / `DSH_TUI_CONFIG_DIR` 的显式覆盖，`XDG_CONFIG_HOME` 不再改变默认位置。旧目录未自动迁移或删除，DSH 原生数据位置不变。
- 已独立复现空白会话第一次 Shift+Tab 后 `queued: 1` 的错误。权限实际立即切换；审批策略变化时 DSH 注入 `source.kind: 'user-approval'` 的下一步上下文，每三次标准权限循环产生两条，15 次恰好误显示为 10。
- `state.pending` 保留原生全部 inbox 计数，新增 `state.queued` 只统计 `dequeue` 可以取回的人类纯文本；计数与取回使用同一谓词。不绕过原生 `/permission`，不删除通知，不增加调度器。
- 空闲 reload 允许下一步 inbox 中保留原生非唤醒审批通知。仅这一已核验来源被豁免；运行中的 Agent、命令、决策、所有下一回合输入及其他下一步输入（包括附件/后台反馈）仍拒绝 reload。
- 该阶段正式回归：`test/backend-permission-queue.test.ts` 两项原生计数/取回测试；`test/acceptance-permission.test.ts` 四项独立 gate/两 renderer/真实 followup 验收；App 增加显式零队列与混合上下文回归；配置增加三项默认目录测试。
- 该阶段完整 `pnpm check` **350/350**，0 fail/skip/cancel，build/typecheck 通过（约 95s）。Settings 两模式与取消 PTY **8/8** 复跑通过；PTY 测试改为等待真实焦点/确认渲染，避免 Esc 与下一次 Ctrl+C 的时序误合并。本次未重新执行 clean-install，下面 340 项干净安装证据保留原 Review 范围。
- 权限队列完整检查日志：`artifacts/review/permission-queue-check.log`。测试全用临时 home/workspace 与离线 stream fixture，不访问真实模型或凭据。
- 后续 CLI 默认选择已有原生 `dsh-tui` profile，等同省略时自动传入 `--profile dsh-tui`；显式 `--profile <name>` 仍可覆盖，Demo 不加载 DSH。新增三项真实 main/parser 构造参数回归，未修改 programmatic backend 的 base-only fixture 路径。该阶段完整检查 **353/353**，0 fail/skip/cancel，日志：`artifacts/review/default-profile-check.log`。

## 后续修复：设置成功切换只更新状态

- 模型、effort、权限和 Agent preset 成功切换不再向对话区追加确认；锁定会话的下次 preset 仍由底栏 `next preset` 显示。自动标题成功切换只显示在 Settings，模型请求说明保留在设置项描述。
- 原生返回的 `defaultPersistence:'runtime'` 保存范围说明不再逐次回显；失败、不可用、未知保存警告及其他原生 note 保留。显式 `/preset status`、`/effort status`、`/permission` 查询和其它原生命令输出不受影响。
- 只改 `src/app.ts` 的反馈展示；没有删除 DSH 命令/审计/审批上下文、改变保存服务或写入真实配置。正常 runtime 保存仍不是跨重启的永久默认。
- `test/app-settings-feedback.test.ts` 13 项界面回归；原生验收新增两模式模型/effort/ptc/权限切换，验证状态即时更新、无对话提示、无模型回合。原有两模式各 15 次 Shift+Tab 也断言不新增对话项，同时保留原生审计和 inbox 上下文。
- 该阶段完整 `pnpm check` **368/368**，0 fail/skip/cancel，build/typecheck 通过（约 106s）；日志：`artifacts/review/settings-feedback-check.log`。全部使用临时 home/workspace、synthetic credential、loopback 与离线 stream fixture；本次未重跑 clean-install，也没有真实模型请求。

## 后续修复：只读 Help 面板

- 按用户最终要求，放弃 CC General/Commands 标签页和命令选择逻辑：`/help` / F1 打开 `/model` 风格的只读 Commands / Custom commands 面板，宽屏两列、窄屏分区，只滚动和关闭；Enter/数字不执行、不填入草稿，也不追加 transcript notice。
- `cloudagent/deepseek-v4.1-flash-1017` 前端子代理负责 `src/ui/help.ts` 和 14 项组件测试；同模型后端子代理只读核验原生 descriptor/MCP 边界。父级接入 App、检查实际源码，并补 9 项 App 与两模式真实 DSH 验收，不使用子代理的旧全量计数作为最终结果。
- 只复用原生 `definitionId/name/description/input.hint`；DSH 没有 builtin/owner 标志，按原生命名空间分组只是展示约定，缺身份也归到 Custom。MCP 工具不虚构成命令，不复制官方命令清单，不新增 backend/协议字段。
- 验收确认当前原生目录与 custom 注册可见、输入 hint 保留、无 command/run/done/turn/start、无 marker 副作用；草稿/粘贴/焦点、全局取消、异步新面板与 attachment/route 守卫正常。原 `/help` 文本断言改为面板/滚动断言，原生命令交互在明确关闭 Help 后继续验收。
- 该阶段完整 `pnpm check` **393/393**，0 fail/skip/cancel，build/typecheck 通过（约 111s）；日志 `artifacts/review/help-panel/check.log`。新 Help 两模式 PTY、原取消 **8/8** 与 Settings/输入/resize 两模式均通过。PTY 起始用空白 prompt 抑制自动 Demo 工具回放，而不是打开 `/help` 面板；未重跑 clean-install、无额外真实模型验收测试、未修改真实配置/全局安装、未 commit/push/publish。

## 后续修复：状态查询也不回显

- 按用户要求，`/preset status`、`/effort status` 和无参数 `/permission` 的成功查询不再向对话区追加当前值/可用列表，底栏已有状态保持不变；无参数 `/preset`、`/effort` 仍打开选择器。
- 原生查询仍执行，权限查询的 native command/run/done 审计保留；只移除界面回显，查询失败、校验错误和其它原生命令结果继续显示，不改变 DSH 权限/模型/会话行为。
- 父级相关 38 项回归与严格 TypeScript 通过；两 renderer 的真实 DSH 验收确认静默查询不改 pending、不启动模型回合，权限查询和 setter 均保留原生审计。新增查询失败回归，设置反馈文件为 14 项。
- 该阶段完整 `pnpm check` **394/394**，0 fail/skip/cancel，build/typecheck 通过（约 109s）；日志 `artifacts/review/status-query-check.log`。全部使用临时环境；本次未额外重跑 PTY/clean-install、未测试真实远程模型、未改用户配置或全局安装。

## 后续修复：正常 reload 单行反馈

- 正常完整成功仅显示 `Reloaded settings, keybindings and DSH configuration.`，移除重复的 session/transcript/cache 和当前 model/preset 说明。
- native warnings、pending/restart、不可用/失败、screen 下次启动生效、未应用本地配置等结果保留；坏 settings/keybindings 不会得到完整成功的单行声明。只改反馈展示，HMR admission/lock/reconcile、会话与缓存保持逻辑不变。
- 相关 46 项回归与严格 TypeScript 通过；两模式真实 native reload 校验精确单行，并继续验证保留审批上下文/attachment，原外部模块重复 reload 的 restart 提示验收仍通过。
- 该阶段完整 `pnpm check` **396/396**，0 fail/skip/cancel，build/typecheck 通过（约 112s）；日志 `artifacts/review/reload-feedback-check.log`。临时环境/离线 fixture；本次未额外重跑 PTY/clean-install、未发远程模型请求、未改真实配置或全局安装。

## 后续修复：provider 分组与 readline 模型搜索

- 按用户要求，`/model` 按 native provider 分组，Tab/Shift+Tab 双向切换；浏览箭头切 provider，搜索箭头编辑查询。查询按当前 provider 的 ID/型号/名称/描述过滤，切组保留；初始化定位当前 route，Enter 才调用 native model setter，数字/j/k 是搜索文本。
- 两个 `cloudagent/deepseek-v4.1-flash-1017` 子代理分别负责 input 和 UI。Input 在同一动作注册表/keymap 添加两个上下文与四个 provider 动作，沿用单个 CcEditor query state；没有第二 keyboard/profile hierarchy。printable 优先、modifier chord、Ctrl+B/F/Alt+B/F、Ctrl+W vs word kill、kill/yank/undo、paste/interrupt/禁用/重绑定有回归，原 GNU 未实现范围不因本面板宣称全部完成。
- 父级接入 App 的 native DTO 校验/opaque ID 原样传递、晚到 attachment/route/surface 守卫和活动 query paste 的全局中断保护；补 10 项 App 与两模式 native 验收。早期 native fixture 把默认模型放在 home override，DSH 正确拒绝保存；移到临时 native profile 让正常保存可验收，没有隐藏实际保存异常。
- 父级另外复现 100 模型、80×22 时 footer 被挤掉，交回 UI 子代理保留 App chrome 空间，直接组件及真实 App 选中行/查询/状态栏回归转绿。Input 18 项、UI 23 项正式测试；所有关键 keyboard/native 结果经父级实际检查与复跑。
- 该阶段完整 `pnpm check` **449/449**，0 fail/skip/cancel，build/typecheck 通过（约 118s）；日志 `artifacts/review/model-picker/check.log`。模型搜索两模式 PTY（readline/无结果 Enter/resize/草稿/恢复）、原 Help、取消 **8/8**、Settings 两模式均通过；没有额外真实远程模型验收测试、SDK/协议/模型/凭据体系改造、global install 或 commit/push/publish。

## 后续修复：DeepSeek 蓝主题与像素鲸鱼

- `cloudagent/deepseek-v4.1-flash-1017` 前端子代理统一 `src/ui/theme.ts`：品牌蓝 `#4D6BFE` 用于鲸鱼；可读文字/标题蓝 `#6D86FF` / `#9FB3FF` 与 chip 蓝色背景共享同一主题。CC 橙色/紫色的普通界面强调不再保留，错误/警告/成功、代码语法、diff 和原用户蓝色背景带仍具有语义区分；没有第二主题或配置系统。
- 新 `WelcomeHeader` 是原创终端 block 字符像素鲸鱼与产品身份的静态组合：普通宽度 13×5 鲸鱼、30–38 列小图案、更窄时只保留身份文字；Demo 标记明确。无动画/计时器/输入捕获、无直接终端输出，不重复模型/状态或虚构活动，名称和 `v0.1 prototype` 保留。
- 父级接入 App header，并把 prompt/Working/滚动提示与历史搜索（包括原硬编码 CC 橙色匹配高亮）接入统一 `t.accent`。检查实际源码后补 10 项 App 黑盒单元格 RGB 验收，覆盖两模式、40×22/80×22、完整草稿/粘贴/光标、Help/模型/Settings、取消和红色启动失败；UI 8 项主题 + 9 项启动区测试验证 1–160 列、对比度/语义颜色、缓存/无输出。
- 该阶段完整 `pnpm check` **476/476**，0 fail/skip/cancel，build/typecheck 通过（约 121s）；日志 `artifacts/review/deepseek-theme/check.log`。新增主题两模式 PTY、原模型搜索/Help/Settings 两模式与取消 **8/8** 全部通过，正常退出和外部 SIGINT 130 均恢复 terminal；Settings 本次 67/83 synchronized frames 不是 FPS。
- 离线 xterm 单元格投影截图与各组 PTY 证据在 `artifacts/review/deepseek-theme/`（raw ANSI 在 `artifacts/`）。没有重新做 clean-install、真实远程模型/CC 版本界面或 Rex IME/GPU 验收，没有读取/写入真实配置或凭据，未新增 SDK/模型依赖、未 global install/commit/push/publish。主题源码变化需重启，不由 `/reload` 替换已加载 JS。

## 后续修复：鲸鱼启动动画

- `cloudagent/deepseek-v4.1-flash-1017` 前端子代理提供 `WelcomeHeader.setAnimationFrame` 和四个确定性姿势：原图、半格下沉、半格上移、一格跳起/水花。预计算半格位图，不增加渲染引擎；组件无计时器、终端写入或输入捕获。所有姿势的宽高、标题/tagline/Demo chip 位置一致，仍使用原品牌蓝；11 项组件动画回归验证宽窄布局/颜色/缓存/真实轮廓变化。
- 父级只在 App 空白/空闲/完整可见的启动区创建一个 unref 的 220ms interval，最多 6 周期（5.28s）。只调用 pose setter + Pi requestRender，不新增 FPS 调度器；输入/粘贴/chord、应用动作/提交/面板、已有对话/工作/失败、缩到不可见、终端暂停/退出后永久冻结。冻结不重建编辑器，不重启已停止的动画；停止清 timer、陈旧 callback 不得触碰已恢复 TUI。
- 17 项独立 App 回归通过真实 xterm/真实渲染队列验证 pose 差异、固定 metadata/footer、完整草稿/kill/yank/undo/paste、启动连接/失败、旧 transcript、帧上限、真实 unref、清理后的 callback 和模拟 SIGTSTP/SIGCONT 暂停恢复。未 mock Pi 绘制调度，也没有模型请求；SIGTSTP 在测试内拦截，不冒充实际 OS 挂起验证。
- 该阶段完整 `pnpm check` **504/504**，0 fail/skip/cancel，build/typecheck 通过（约 126s），日志 `artifacts/review/whale-animation/check.log`。动画 CLI PTY **4/4**（两模式跳动/无清屏/输入停止/清空不重启/resize/退出，以及动画中真实 SIGINT 130）通过；原主题/模型/Help/Settings 两模式与取消 **8/8** 同步通过。本次 Settings 64/82 synchronized frames，不是 FPS。
- 真实 PTY 检查排除了动画清 screen/scrollback。Fullscreen 的原生 afterTerminalStop 会把最后静止文档复制到主屏，因此恢复后的帧检查以最终光标交接为界；没有为错误的早期“paste mode disabled”断言改 renderer 或删除原生恢复快照。四帧单元格投影截图、日志在 `artifacts/review/whale-animation/`，raw ANSI 在 `artifacts/`。
- 没有新增 DSH/输入/权限/模型/凭据业务或依赖，没有真实远程模型/CC 版本/Rex IME/GPU 或 clean-install 重跑，没有修改真实配置/凭据/全局安装、未 commit/push/publish。新源码需重启加载，/reload 不重新播放或替换当前 TUI JS。

## 后续修复：直接复用开源鲸鱼并等比例缩小

- 用户否定自绘造型后，完整替换为 `ccch1mneyyy/dsh-TUI` @ `149a4162a0ec648ef077ac3f030ca728287b8305` 的原始 22 帧/配色/half-block 编码/分层算法，不再保留 WIDE_SPRITE/COMPACT_SPRITE/shiftHalfCells。原始艺术与分层来自 `lhh010/dsh-ui-whale`（BSD-3-Clause ©2026 lhh010），dsh-TUI adaptation 为 MIT ©2026 chimney；两份完整许可与来源均保留，未引入 React/Ink/Yoga 或 upstream app/settings/companion。
- 原始图 40×25 字母网格逐帧不变，frame table SHA256 `5cf824bc74a24f6f0bc2177e8194022da82e28e3ebb159e7685363ce70bedec7`；native encoder 与源代码 fg/bg/透明度逐像素一致。只省掉全透明最后一对像素行及 Pi 已负责的 `ESC[K` 清除，不裁尾巴/重画形状。
- 原尺寸阶段全量 **520/520**（约 131s），两模式真实 PTY 能匹配原始 standard/blink/spout1–6/tail1–4 像素 hash；用户随后要求等比例缩小。最终显示为 **20 列 ×6 行**（40×24 可见源像素 →20×12 显示像素），原数据/native helpers 不改。用自动 2×2 面积/透明度采样，对 D/B-only tile 保留深色 D 以保持双眼/描边，不手改像素坐标或创造新图；独立源 fixture 生成 native 与缩放 hash。
- 时间不再使用旧四帧/220ms/6 cycles：原始 classic 18步/3480ms，每步一个 unref timeout，结束或输入/面板/工作/旧对话/失败/缩窄/暂停/退出后回 standard，不重新播放。父级 17 项真实 App/xterm/计时器/模拟暂停恢复与10项品牌回归通过；眨眼是颜色而非 glyph 变化，inline 旧标题允许留在原生 scrollback，不为错误的位置断言清屏。
- 该阶段完整 `pnpm check` **527/527**，0 fail/skip/cancel，build/typecheck 通过（约 131s），日志 `artifacts/review/upstream-whale-scaled/check.log`。UI welcome/native/缩放/主题 **51/51**；两模式 source/hash PTY **6/6**（原始序列、输入/清空/resize、intro 中实际 SIGINT 130）通过，所有显示帧匹配独立缩放源 hash，无动画清屏或清 scrollback。原主题/模型/Help/Settings 两模式与取消 **8/8** 继续通过。
- 原尺寸证据在 `artifacts/review/upstream-whale/`，半尺寸 source fixture/截图/日志在 `artifacts/review/upstream-whale-scaled/`；都是临时配置/offline demo 与逻辑单元格投影，不冒充 Rex GPU/IME/CC 实例视觉验收。没有新 SDK/模型/provider/credential/input 业务，没有真实配置/凭据/全局安装变动、remote model/clean install 重跑或 commit/push/publish。

## 历史阶段：2px 原生图片 logo（已退役）

> 用户随后要求“不针对 Rex 使用原生图片、仍用字符块拼图；中间空白填白；动画直接删除”。下方 498 项阶段的 PNG/Image/Braille/动画实现全部退役，不再被 runtime、脚本或测试引用，只保留为历史记录。

- 用户认为半字符像素仍太粗，改为从其参考图直接提取蓝色logo、去掉灰圆背景，生成2px与3px真实PNG预览；用户明确选择2px原生图片方案。当前主体64×48透明PNG，每个像素块2×2；动画透明canvas64×64，logo整体仅上下移2px。旧字符鲸鱼/源码frame runtime、对应fixture/测试/PTY probe已退役，不再叠加另一套头像渲染路径。
- `src/ui/logo.ts` 直接复用 Pi TUI public Image（Rex自动detect为Kitty），不改vendor/全局Pi、不开第二renderer。固定image id，变换数据时重新注册/上传，避免回到cached pose却显示旧图；不支持图片时投影同源Braille2×4细点。`welcome.ts` 使用public compositor先metadata后image，修正image-first会丢标题的组合顺序；没有直接console/terminal输出或新settings。
- PNG尺寸/RGBA/2px重复/透明度/精确2px平移、Image控件数据/id、metadata/width/fallback等12项UI；实际Pi native renderer两模式App图像/输入/paste/Help/resize/恢复2项；原startup lifecycle17项、branding10项与全部native业务回归保留。当前完整 `pnpm check` **498/498**，0 fail/skip/cancel，build/typecheck通过（约130s），日志 `artifacts/review/logo-pixel/check.log`。计数减少是替换已删除asset的专属测试，不是削弱后台或输入边界。
- 两模式native PNG/细点阵/动画中SIGINT130共6项PTY，原主题/Help/模型/Settings两模式和取消8/8全部通过；Settings本次69/77 synchronized frames不是FPS。实际Rex临时两个后台tab验证header/Help/输入/退出并自动清理，保留用户活动tab，session label调整为dsh-tui-logo。Rex text/HTML不带raster，不能拿它假称GPU或最终屏幕图片测量。
- 资产、预览与测试证据在 `assets/logo/`、`artifacts/review/logo-pixel/`；无新运行时依赖、模型/配置/凭据业务，无remote model/clean-install/全局安装或commit/push/publish。只有UI源码改变；需重启加载，/reload不替换当前JS。

## 当前结论：静态字符块 logo（更小像素、内部白填充、无动画）

- 用户最终明确三点：Rex 不特殊使用原生图片、仍用字符块拼图；logo 中间空白用白色填充；动画直接删除。当前实现完全遵循这三点，未保留任何“关闭但仍存在”的旧路径。
- 资产：`assets/logo/reference/deepseek-logo.png` 为用户提供的参考图；`scripts/generate-logo-assets.py` 去灰圆背景、提取蓝色主体、重采样为 32×12、外边界 flood fill 找外部透明区、其余非蓝区域记为白色，并拒绝需要三色同格的样本。输出 `assets/logo/grid.json`（32 列 × 12 行、palette B/W）可由该参考图逐字复现。
- 头顶按用户要求做了轻微顶弧修圆：参考图头顶接近平顶，生成器按整格边界把最上方头顶 run 的中间三分之一抬高一档（只加顶行蓝色样本），避免半格斜切在左上角留下缺口；保留出气孔/喷口与白色内区，不做其它手绘或重画。
- 渲染：16 列 × 6 终端行，每个单元 2×2 象限；块字符 `▘▝▖▗▌▐▀▄▚▞▙▛▜▟█` 让每个像素只有旧半字符像素的一半面积（半格宽、半格高），采样网格因此按 2:1 各向异性，保持原图在终端单元中的比例。蓝色 `#335DE0`，内部 48 个白色样本，外部保持透明/默认背景。所有终端（含 Rex）共用同一字符路径；`Image`、Kitty/iTerm2 上传、Braille、image id、终端专门分支和直接终端写入全部不存在。
- 动画：资产帧、`setAnimationFrame`、frame setter/state、welcome timer、App 的启动/暂停/恢复/退出 hook 均已删除，组件与 App 不再有相关字段或方法；静态缓存只在 resize 或颜色模式变化时失效。Working 的 spinner/耗时属于正常业务状态，未受影响。
- 验收：`test/ui-welcome.test.ts` 7 项按真实终端单元解码全部 384 个象限样本（含 48 个白色内部样本），验证三种 image capability 输出一致、真彩/256 色几何一致、header/宽度/cache 与源码审计；`test/app-logo.test.ts` 两模式强制 Kitty capability 仍只出现字符块、无图片上传/放置、无启动 interval/帧 timeout、空闲不重绘并保持草稿/Help/resize/退出；`test/app-theme.test.ts` 10 项继续检查蓝色主题。`scripts/pty-static-logo-smoke.py` 两模式 × Kitty hint/none hint 与实际 SIGINT 共 **6/6**；theme/Help/model/cancel/Settings 的原有 PTY 组全部复跑通过。完整 `pnpm check` **479/479**，0 fail/skip/cancel，build/typecheck 通过，日志 `artifacts/review/static-logo/check-elbow.log`。工具卡对齐修复：标题内容列固定（名称型 `⏺ Bash(cmd)` 与标题型 `⏺ Read /path (1-50)` 同列，无双空格）；每个工具卡正文只有一个 `⎿`（描述/首个正文行持有，输出/摘要/exit code 等全部对齐其列），`markSingleElbow` 统一归一，与 pi-cc-extensions「首行 ↳、其余对齐空格」及 CC 单 `⎿` 口径一致；diff 行维持 CC 的 5/7 列约定。
- 边界：临时配置/离线 demo/PTY，没有远程模型请求、真实凭据或配置写入、Rex 桌面截图/GPU 断言、clean-install 重跑或 commit/push/publish。源码改动需重启 dsh-tui 生效；`/reload` 不替换已加载的 TUI JavaScript。

## 最终按键语义

| 场景 | Esc | Ctrl+C |
| --- | --- | --- |
| 补全、历史浏览、普通面板 | 当前局部层先消费，不能附带中断 | 有前台操作时全局中断 |
| 模型响应 / 前台工具 / 原生命令 | 没有局部层时中断前台 | 中断前台 |
| 审批 | 返回请求的原生 `rejected` 值，只拒绝该工具 | 中断整个回合，原生信号结算为 `cancelled` |
| 用户问题 | 隐藏，不回答、不取消；`/questions` 重开同一个编辑状态 | 中断整个回合，产生原生 `ASK_ABORTED` |
| 忙碌时未提交草稿 | 保留 | 保留 |
| DSH inbox 已提交消息 | 保留并暂停 | 保留并暂停 |
| 空闲有草稿 | 双 Esc 清空 | 第一次清空并保存，第二次确认退出；Up 找回并解除退出确认 |
| 后台 job / subagent | 不隐式终止 | 不隐式终止 |

真正取消调用 `Agent.cancel({kind:'user'}, {keepInbox:true})`。Agent 与原生命令的 abort 信号先发出，再等待有界结算；不再先等待命令 drain 才取消 Agent。中断不是回滚：部分 assistant 输出作为 interrupted 事实保存，已完成工具副作用保留。

取消本身不会主动续发保留的 nextTurn/nextStep，原生 driver 可回到 idle/parked。TUI 展示计数，空输入 Up/Ctrl+P 可以显式取回可编辑的人类文本；新的用户发送或原生后台任务反馈等 waking input 仍由 DSH 按自身语义处理，不加“冻结所有来源”的暂停器，也不通过删除/重新投递模拟 CC 自动续发。取回多个消息仍会合并成草稿，不是完整队列编辑器；注入上下文和附件不会被取回操作删除。

外部 OS SIGINT 与 raw Ctrl+C 是两条路径：前者恢复 Pi 终端再有界关闭 DSH，退出码 130；后者不杀 runtime。

## Review 闭环

以下编号对应历史审查，而不是当前代码行号。

| 编号 | 结果 |
| --- | --- |
| R01 | Pi TUI 改为真正的 `workspace:*` 包，build 与 import 使用同一份 vendor；不提交 dist。 |
| R02 | 先前已删除 `--continue`/`-c`；保留指定 ID 的 `--resume`/`-r` 与 `/resume`，5 项 CLI 回归继续通过。 |
| R03 | 原生 target Agent/preset 成功准备后才替换旧 handle；坏 resume/preset 不破坏旧会话，后续 state/send 可用。 |
| R04 | 显式 SIGINT 处理、终端先恢复、退出 130、有界关闭；重复退出和 external-editor 生命周期有保护。 |
| R05 | 无 profile 也扫描 home patch；正确遍历原生 `group:true/config` 与 insert，隔离前端并保留模块锚点。 |
| R06 | home 相对与 profile 外源码变化显式报告 pending/restart，重复 reload 也保留未生效提示；只有真正新 runtime 或源码恢复到已加载基线才清除，不做 ESM cache 驱逐。 |
| R07 | 原生 keepInbox；两个队列保留并暂停；Agent/命令即时通知 abort，决策统一结算。 |
| R08 | 真正 no-op 不调用 Pi setText，不丢 paste registry/undo/cursor；transpose 使用 marker-aware Pi seam。 |
| R09 | chord pending/timer/hint 统一；render 不改输入状态，粘贴和焦点切换正确隔离；销毁 inactive editor 不影响当前 chord。 |
| R10 | 非空 Ctrl+D 不能因 delete 改绑/禁用而落入退出。 |
| R11 | jump 只消费真实目标字符，控制键/DEL 返回共享 CC keymap，词删除和改绑不退回 Pi defaults。 |
| R12 | Esc 恢复历史草稿后就消费，不再附带取消 Agent。 |
| R13 | Settings 保存执行时重新读盘并验证；外部坏文件不被覆盖，最后有效状态保留。 |
| R14 | 每路径共享 recall store/写队列及跨进程文件锁；只更新目标 cwd，保留时间顺序和非连续重复；保存失败可见。 |
| R15 | session/attachment/editor/route/request/surface 身份守卫；迟到 send、catalog、picker 和 setter 不覆盖新上下文。原生 setter 的迟到 metadata 也不能恢复旧 route。 |
| R16 | 原生 HMR exclusive 锁覆盖 prepare → client sync → commit/abort；权威 busy 检查在写 scratch 前；未变来源不抹掉原生 runtime 编辑。 |
| R17 | credentials-local 使用原生有效配置，只把默认 dshHome 指向真实 home；显式 path/home、watch/debounce 保留，原生服务自己原子写，不由 TUI 读/复制/回写秘密。 |
| R18 | 超大/不可解码 IPC 帧 fatal fail-closed，立即拒绝 pending 并退役 child，不继续显示 ready 等超时。 |
| R19 | snapshotUnavailable 保留并警告，历史读取失败不再被当作空会话。 |
| R20 | thinking/tool 提示来自真实 keymap；多文件 diff 文件/行数正确，已展开仍有 cap 时明确 truncated。 |
| R21 | 问卷确认的 custom text 可见、可重访；单/多选草稿规则一致，仍允许 DSH 的空答案。 |
| R22 | Demo 取消不再记为 deny/unexpected answer，保留暂停队列与 native-shaped state；等待 idle 不被 paused inbox 永久阻塞。 |

本轮也完成原生 `buildModelCatalog` 复用、删除 compact 兼容控制别名、统一 decision listener 清理、删除未使用 text helpers/prepare option/owned/resolve bindings、避免有效安装后再同步查询 npm root、去掉重复 fit。

父级验收曾发现共享 chord 销毁、same-attachment 迟到 setter、旧 catalog 抢占新 Settings、Demo paused-queue、第二次 reload 错误清掉重启提示等回归，均退回子代理修正并补正式测试。最后还用原生 currentSelection 核验可选编辑器下的 fulfilled no-op，防止把 promise 成功当成默认已保存；并把目录泄漏回归隔离到测试自己的 temp root，避免与并发验收的 scratch 清理互相干扰。中途失败/挂起日志是开发证据，不是最终结果；挂起的测试进程已清理。没有靠放宽主流式断言消除失败：原生标题恢复继承后产生的额外请求，只在临时前台 SSE fixture 中明确关闭标题以隔离场景，生产 overlay 不含强制标题开关。

## 必须保留的 SDK/功能边界

1. **永久模型/effort 默认尚不可安全保存到原始 profile。** 当前调用 DSH 原生 `agentDefaultModel.saveSelection`，其 ConfigEditor 指向私有 profile；返回 `defaultsPersisted:false/defaultPersistence:'runtime'/defaultWarning`；保存范围保留在返回 metadata 与文档，正常 runtime 保存说明不再逐次追加到对话区，异常仍显示。当前 runtime 的 `/new` 和 `/reload` 使用新默认，重启后真实 profile 仍是权威。没有手工合并/回写 YAML 或修改 readonly profileContext。
2. **不是所有插件代码都能热更。** profile-relative 原生支持范围内可 reconcile；home-relative/外部模块源码明确提示重启。不能安全镜像的 `../` 模块锚点和非 literal credentials 配置明确拒绝，而不是悄悄改变原生解析/配置。
3. **标题设置是 TUI 偏好 + 原生 runtime 开关。** inherit/on/off 存在 Settings，默认 inherit；启动/reload 按本地偏好调用原生能力。启用可能产生原生模型请求，TUI 不生成标题、不声称编辑了真实 DSH title 配置。
4. Pi 式 extensions 热插拔、fork/rewind、后台任务停止面板、图片、timed-question 补答等继续是既有未实现范围；不在本轮擅自补业务语义。完整 CC/GNU Readline、Rex IME/font/GPU 和实网长期性能也不因单测通过而宣称完成。

补充原生核验：`AgentDefaultModelConfig.saveSelection` 本身已有 submission-order saves 队列，ConfigEditor 内部也使用原生 HMR/file lock。因此不把“默认保存可能乱序”的假设列为已确认 SDK bug，也不增加 TUI 默认保存调度器。

## 独立验收证据

| 命令/场景 | 最终结果 |
| --- | --- |
| `pnpm check` | 340/340，build/typecheck 通过，0 fail/skip/cancel，约 88s |
| `python3 scripts/clean-install-smoke.py` | 离线 frozen install；无旧 modules/dist；完整 340/340；workspace realpath/App import/help 通过 |
| `test/acceptance-review.test.ts` | 7 项真实 DSH 离线端到端：坏 resume、两 inbox、FIFO、两 renderer 的审批 Esc/Ctrl+C、问题 hide/reopen/ASK_ABORTED |
| `test/acceptance-config.test.ts` | 5 项独立磁盘/跨进程回归：坏设置、fresh dir、A-B-A、同 cwd 顺序/并发、坏 history |
| `test/acceptance-async.test.ts` | 3 项迟到 setter/旧 catalog 不覆盖新 route/Settings |
| `test/acceptance-reload.test.ts` | 2 项实际 native 插件：两次 reload 都提示重启、仍执行 v1；新 runtime 真正执行 v2 后提示清除 |
| `test/acceptance-defaults.test.ts` | 2 项原生默认 getter 核验：fulfilled no-op 不伪报保存，已应用的选择正常报告 runtime scope |
| `python3 scripts/pty-smoke.py` | inline/fullscreen：Settings 改键、返回输入、resize、退出恢复；65/85 synchronized frames |
| `python3 scripts/pty-cancel-smoke.py` | 8/8：两模式的清草稿→退出、外部 SIGINT、问题 hide/reopen、忙时 Settings 全局取消；全部终端恢复 |
| `git diff --check`（排除未改动 upstream vendor） | 通过 |

日志与 ANSI 留在忽略的 `artifacts/review/`、`artifacts/clean-install/`，正式回归在 `test/`，可复跑脚本在 `scripts/`。帧数不是 FPS/输入延迟指标。

测试使用临时 home/workspace、hermetic `llm/stream` 和 localhost SSE，没有额外对真实 DSH provider 发模型请求，也没有读取/修改真实用户凭据或全局 Pi/DSH 安装。子代理自身使用用户指定的 CloudAgent 模型；这与应用实网验收不同。

Git 仍为本地 `main`，无 remote/push/publish；本轮业务改动留在工作区，未擅自提交新 commit。先前两次用户批准的本地基线/review commit 保留。

## 后续修复：cc-dark 主题迁移、空会话与 --resume 选择器（11月4日晚）

1. **主题迁移到 pi-cc-extensions `cc-dark`（前端子代理）**：`src/ui/theme.ts` 蓝色族全部改为 cc-dark 精确值——accent `#4f9eff`（blue）、accentBright `#79c0ff`（blueBright）、accentDim `#2a4060`（mdQuoteBorder）、accentBg/userBg `#1a4480`（selection）、border `#1c2d44`、diffAddBg/diffDelBg `#0f2a24`/`#261418`；markdown 行内代码 `#a5d6ff`（mdCode）、引用边框 `#2a4060`、列表符号 blueBright。`dshBrandBlue`（#4D6BFE，已无引用）删除；`logoBlue` 保留精确像素蓝 `#335DE0`，仅用于静态 logo 与读卡标题行尾行号。启动标语改为 accent 蓝（`src/ui/welcome.ts`）。
2. **状态栏模型/路径着色（父级）**：`src/app.ts` footer 第一段 `provider/model` 与第二行 cwd 用 `t.accent`（cc-dark 蓝），状态段保持 dim；`test/app-theme.test.ts` 新增单元格 RGB 断言并把旧 DeepSeek 蓝常量更新为 cc-dark 值；`scripts/pty-theme-smoke.py` 断言同步。
3. **空会话不再持久化（后端子代理 + 父级决策）**：`runtime/bridge.mjs` 引入 pending 会话状态——`connect` 无 resume 时只登记逻辑 sessionId/attachmentId，不调用 `agents.create`；首次 `send`（或需要 Agent 的命令）才物化，物化沿用同一组 id 并发出 `ready`。`/new` 同样惰性（重置 pending，不预创建）；`/model`、`/effort`、`/preset` 在 pending 期间仅暂存路由/预设（仍是原生 saveSelection 服务），不创建会话；`state`/`commands`/`models`/`presets`/`sessions`/`auto-title`/`dequeue` 会话无关直答。closeAgent 对无回合会话跳过显式 flush（DSH 原生语义：未物化会话在句柄释放时即不存在）。A/B 实证（真实 DSH 0.2.1-rc.5、临时 home）：旧桥启动即落 1 个含 3 条策略事件的空会话；新桥“启动→退出”零会话，“启动→发一条消息→退出”恰 1 个会话。父级另做真实 home 端到端复验：`dsh-tui -r` → Esc → 退出与裸启动两场景，`~/.dsh/sessions/--…-dsh-tui--` 49→49，零新增。
4. **`--resume` 不带 id 弹选择器（父级）**：`src/cli.ts` 把裸 `-r`/`--resume`（含 `--resume=` 空值）规范化为 picker 请求，显式 id 仍直连；`src/app.ts` 启动时打开与 `/resume` 共用的选择器——按当前目录过滤（resolve 后比较）、按 createdAt 新到旧排序、显示标题/相对时间/`open elsewhere` 标记，请求 `sessions` limit=200；选择后恢复并补发位置参数 prompt，Esc 保留新会话。demo 模式忽略该请求。
5. **物化后命令面板刷新（父级）**：`applyInfo` 在 sessionId/attachmentId 不变（pending 物化、reload 收敛）时强制 `refreshCommands(true)`，补齐物化后才出现的 preset 级原生命令；修复“启动时 autocomplete 只有全局层命令”的过渡态。
6. **验收**：`pnpm check` **511/511**（0 fail/skip/cancel，较上轮 +32：主题钉死、blank/pending 会话、resume 选择器与 CLI 规范化等）；PTY：theme 2/2（cc-dark 蓝 + logo 像素蓝断言）、static-logo、help、model-picker、cancel 8/8、smoke 全过，终端恢复正常；`npx tsc --noEmit` 干净；`git diff --check` 干净。新增 `test/app-resume-picker.test.ts`（6 项）、`test/backend-pending-session.test.ts`（11 项）、`test/backend-blank-session.test.ts`（9 项）。
7. **已知边界**：pending 期间 `/reload`、`/permissions`、`/execute`、`/efforts` 会先物化会话（它们需要 live Agent）；旧代码遗留的既有空会话仍在真实存储里（本次不删，DSH 未公开删除 API）；`DshBackend.info` 客户端缓存保持 pending 形状但 id 一致，send/cancel 不受影响。空会话修复与主题改动均需重启 `dsh-tui` 生效。

## 后续修复：复用 DSH/pi-tui 前端语义（11月4日深夜）

1. **空会话修复与 DSH 官方 SDK 前端对齐（调研结论，无需改码）**：DSH 自带的 `dsh-sdk-jsonrpc-server` 前端本身就是惰性会话——`initialize` 不建任何会话，`session/prompt` 才对客户端提供的 sessionId 执行 `getOrCreateSession`。bridge 的 pending 设计与之逐点一致（客户端预铸 id、首次发送物化、失败保持可重试），且无法直接换装 SDK server（其协议面只有 initialize/prompt/resume/wait/cwd/shutdown，不含 TUI 需要的 commands/decisions/models/presets/efforts/permissions/state/auto-title/reload/sessions）。DSH 的 web 端另有"空白会话复用"语义（api-session-controller `create` 的 `reusable` 回调），属 API 层服务，同样不可为 TUI 所用。`agents.create` 本身 eager，惰性是前端组合决策——已按官方 SDK 前端的同一模式实现。
2. **resume 选择器重造为 Pi 风格组件（前端子代理 + 父级接线）**：Pi 的会话选择器不在 pi-tui 里而在 pi-coding-agent（agent harness，不可引入，会拖入 Pi Agent 栈），但其 UX 全部由 pi-tui 原语构成。新增 `src/ui/session-picker.ts` `SessionPickerDialog`：vendored pi-tui 的 `Input` 做搜索、`fuzzyFilter` 做标题/路径模糊匹配、复用本仓库 `rowBudget/windowRows/fit` 几何与共享 CcKeymap；Tab 在"当前目录 ↔ 全部"间切换（默认当前目录，与 Pi/CC 一致）、单行条目 + 右对齐相对年龄列、all 范围显示 `~/...` 缩写 cwd、live 会话标记、空态提示按 Tab 查看全部；目录过滤/排序/年龄全部为展示层投影，会话 id 原样透传。`src/app.ts` `pickSessions` 改为投递原生 DTO、不再预过滤预排序（组件拥有展示），空列表也打开选择器（空态自带指引）。
3. **验收**：`pnpm check` **529/529**（+18 项选择器单测；`test/app-resume-picker.test.ts` 更新为新空态语义）；PTY theme 2/2 复跑；真实后端 live 复验：`dsh-tui -r` 目录范围 49 条 → Tab 全部 148 条 → 输入 `tui` 模糊过滤 72 条，Esc 退出、终端恢复、会话存储 49→49 零新增；`npx tsc --noEmit` 干净。文档：README/BACKEND.md 补 pending 会话语义与 SDK 对齐说明。

## 后续修复：resume 选择器两段式提速（11月4日夜末）

1. **实测根因**：`dsh-tui -r` 到选择器可交互 ~2.6s = TUI 启动 0.3s + DSH runtime 启动 ~1.2s + `sessions` 查询 ~1.0s。查询慢是上一轮 `limit:200` 引入：DSH 原生 `readTitleSnapshots` 会对每个请求的会话解压完整 zstd 日志折算标题（~5ms/个 × 200，无缓存）；limit≤30 仅 ~100ms。
2. **两段式查询（后端子代理）**：`sessions` 支持 `{titles:false}`（header-only，零标题解压，实测真实 DSH 上 0 次 readTitleSnapshots）；新增 `titles` 命令（`{ids}` 去重、封顶 100 → `[{sessionId, title|null}]`，只读、SESSIONLESS、整读失败降级全 null）；标题折算逻辑收敛为共享 helper；`titles` 进 capabilities/命令注册/reload 只读白名单/catalog 超时组。
3. **加载态覆盖层 + 窗口化标题（前端子代理 + 父级接线）**：`SessionPickerDialog` 增加 `loading/setSessions/setTitles/onVisibleIds`——启动 ~0.3s 即渲染外壳与搜索框（“Loading sessions…”），runtime 在后台启动；行数据到达后按**可见窗口**懒取标题（合并去重、25ms 合并批、单次 ≤100 id、本启动内缓存，重开选择器直接命中缓存）。`applyInfo` 首个 info 不再拆除启动覆盖层；connect 任务先创建后开覆盖层（修复一次 NOT_CONNECTED 时序 bug）；picker 路径下 `refreshCommands` 不再阻塞列表请求。
4. **验收**：`pnpm check` **548/548**（+12 bridge 标题测试、+5 组件测试、+2 app 级两段式/加载态测试）；PTY theme/cancel/static-logo/help 全过；真实后端 live 复验 49→49 零新会话、exit 0、终端恢复。实测时序（温缓存）：选择器外壳 **0.27s**（原 2.62s）、行数据 1.3–1.7s、带标题完整行 1.4–1.8s（原 2.62s）；`/resume` 重开命中缓存即渲染。

## 后续修复：状态栏精简(11月4日深夜)

用户要求:删除 footer 的 `preset:`、`effort:`、`permission:` 段,思考强度放到模型后面。`src/app.ts` render:第一行改为 `t.accent(模型·effort) · working|ready|disconnected [· next preset: x] [· queued: n]`,第二行仍为 cwd(accent 蓝);静态 preset/permission 段移除,暂存的 next preset(待 /new 生效)与队列计数保留。`/preset status`、`/effort status` 原本依赖 footer 展示,现改为一条 muted 通知(`Agent preset: …`/`Reasoning effort: …(effective)`)。更新 app/acceptance 相关断言并钉死新布局(`model·effort` 匹配 + preset/permission 段不存在)。`pnpm check` **548/548**,PTY theme 2/2,demo 实测 `demo (offline)/deepseek-demo·max · ready`、真实后端默认路由 `deepseek-official/deepseek-flash · ready`(未设 effort 无后缀)。

**更正(同夜)**:上一条"状态栏精简"误解了需求——用户要的是删掉 `preset:`/`permission:` 标签前缀而**保留值**。最终格式:`模型·effort · working|ready · <preset 值> [· next preset: x] [· queued: n] · <权限值>` + 第二行 cwd(路由与 cwd 保持 cc-dark 蓝)。`/preset status`、`/effort status` 恢复静默(值已在 footer)。app/acceptance 断言同步:整行正则 `deepseek-official/deepseek-pro·max · ready · ptc · read-only` 钉死布局,且 footer 无 `preset: |/permission: |/effort: ` 标签。`pnpm check` 548/548,PTY theme 2/2。

## 后续修复:pi-cc-extensions 风格状态栏(11月5日)

参考 pi-cc-extensions footer(MIT,只读)为状态栏加入 context/缓存命中/速率/TTFT/git:
- **第一行**:`模型 ● effort · ready|working · 预设值 · ████░░░░░░ NN%/1.0M · 󰆼 NN% · avg N tok/s (TTFT: X) · queued/next preset 瞬态`。effort 用 pi 的填充圆标(○◎◔◕◉●);条形图 ≥80% 黄、≥95% 红;缓存命中按 meter 锚点请求 `cacheRead/(input+cacheRead+cacheWrite)`;速率/TTFT 取 OutputTracker 的墙钟平均与首 token 延迟,指令结束(settle)后定格。
- **第二行**:`cwd ·  分支 [!?⇡⇣](+N −M) · 权限值`。git 为只读本地观察(`git diff --numstat HEAD --` + `status --porcelain --branch`,2s 超时;10s 轮询 + 指令结束/启动时刷新,合并去重、只在变化时重绘,绝不 fetch/写索引)。
- **数据边界**:上下文/缓存字段由 bridge `state` 扩展暴露(token meter `baseline.usage` 防御性读取,backend 子代理);`src/state/output-stats.ts` 增加 settle/footerRate/footerTtftMs/formatTtft(frontend 子代理);`src/state/git-stats.ts` 新建(解析/刷新器/真实临时仓库测试,frontend 子代理)。
- **验收**:`pnpm check` **570/570**(+17 state 测试、+2 footer 测试等);PTY theme/cancel/logo/help 全过;真实后端实测两行布局、git 芯片(`main [!?](+5857 −1190)` 真实未提交量)、权限第二行、上下文条(0%/1.0M);速率/缓存芯片因 cloudagent 端点当时返回 400(与用户当日所见相同)未能产生成功回合,由 fixture 测试覆盖计算链路。Logo 测试放宽为"无短周期动画 interval"(允许 10s git 轮询)。

## 后续复用:状态栏速率/TTFT 改用 DSH 原生 sessionStats(11月5日)

用户要求"能复用 dsh 就复用"。调研结论:DSH 原生就有 `@deepseek-ai/dsh-session-stats` 插件(`ctx.sessionProjections` 的 `sessionStats` 投影:turns/steps/llmMs/toolMs/ttftMs/ttftSteps/decodeMs/decodeTokens——与 DSH web 客户端同一折算,官方速率为 `decodeTokens/decodeMs`、TTFT 为 `ttftMs/ttftSteps`);但它不是 profile bundle(无 `dsh.bundle` 声明,加入 bundles 会被加载器静默跳过),正确装载方式是 web 组合同款 **cordis patch 插件行**。

实施:
- `planProfile` 新增 `sessionStats: boolean`(安装内可解析该包、且用户 profile/home 层未自行组合该行时为 true;`dsh-session-stats` 在共享 profile store 中由 dsh-web-app/dsh-client-ui-chat 依赖引入)。
- bridge overlay(`writeBridgeOverlay`)按标记插入 `- id: dsh-tui-session-stats / name: @deepseek-ai/dsh-session-stats` 插件行——与 `dsh-tui-bridge` 同一 insert 块。
- bridge `state()` 新增 `stats` 字段(`stateOf(session,'sessionStats')` 防御性数值读取,失败/缺失即省略)。
- app footer 速率/TTFT **优先原生折算**(decodeTokens/decodeMs、ttftMs/ttftSteps),fixture/精简安装无投影时回退本地 OutputTracker;上下文/缓存本就来自原生 meter。

实测:真实 runtime 装载插件行后 `state.stats` 返回真实折算(`{"turns":1,"steps":1,…}`,失败回合如实计 step、无首 token 则 ttft/decode 为 0→不显示速率芯片);`pnpm check` **570/570**,PTY theme/cancel 过,live 选择器 49→49 不变。`workspaceChanges` 服务是按回合的文件变更记录器(非 footer git 状态),git 芯片维持 TUI 只读观察。

**顺序更正(同日)**:第二行顺序调整为 `路径 · 权限值 · git 芯片`(权限紧跟路径,git 随后)。footer 测试断言同步。`pnpm check` 570/570。

## 后续修复:消除本地重复实现、对齐官方口径(11月5日)

针对复用审查的五项发现(用户按严重度列出)全部处理:
1. **删除 output-stats 的本地速率/TTFT 折算**(`settle/footerRate/footerTtftMs/formatTtft/TTFT 追踪`全部移除,仅保留编辑框边框的实时流呈现;footer 只认原生 `sessionStats`)。
2. **state usage 对齐 DSH 官方口径**:上下文条改读 `contextPressure` 投影(`projectedTokens ?? pressureTokens / contextWindow`,即 web ContextMeter 的 `contextOccupancy`);缓存命中改读 `tokenUsage` 投影并在 bridge 按 web 客户端公式计算(`cacheRead/(uncachedInput+cacheRead+cacheWrite)`);删除 meter.measure 估读路径。
3. **todos/plan 原生投影接入**:`Question.detail` 与 `todos`/`plan` 事件入 wire(types/protocol 冻结契约);bridge 经 `sessionProjections.onChanged` 转发当前会话的投影变化 + attach 后发布快照;transcript 新增单一 todo 清单块(`TodosBlock`,`☐/◐/☑`,原位更新,null 移除);plan 模式切换以通知呈现(首次快照也播报,reload 不再误报);Ctrl+T 从"占位提示"变为当前清单摘要;`/plan` 评审问题现在带完整 plan markdown(`detail`),DecisionDialog 以 markdown 正文渲染并自我呈现(标题=header、两选项、自定义反馈路径不变)。
4. **session-picker 删除 `newestFirst`**:信任 DSH `compareSessions` 的新到旧原生序;仅搜索时按 fuzzy 相关度排序。app 级 fixture 同步改为原生序。
5. UI_COMMANDS 与原生命令目录合并维持现状(审查认定为可接受设计)。
- 验收:`pnpm check` **590/590**(新增 backend usage-fields 7 项、projections-events 10 项、ui-todos 6 项、app-todos 3 项等);PTY theme/cancel/logo/help 全过;live 启动/选择器/退出 49→49 零新会话;真实 DSH 探针:`/plan on` 触发 plan 事件、重连发布快照、hermetic 流不伪造 usage。backend agent 附注:attach 仅发布"非空闲"plan 快照(避免 reload 误报 off),实时变化始终转发。

## DSH 升级 0.2.1-rc.5 → 0.2.2-rc.1(11月5日)

用户要求升级并适配。升级前对所有接缝包做了新旧 diff(9 个核心 + 5 个直接依赖 + 5 个注入服务),结论:
- **破坏性变更 2 处**:`buildModelCatalog` 从 `@deepseek-ai/dsh-api-session-controller` 导出移除(改为 `sessionController` 服务的 `modelCatalog()` 方法,base 组合不挂载该服务);`DEFAULT_PROFILE_BUNDLES`/`PROFILE_TEMPLATES` 从 `dsh-app-boot` 导出移入新包 `@deepseek-ai/dsh-official-bundles`。
- 其余皆为内部现代化:插件 `apply` 异步化 + `sessionProjections.register` 返回 handle(session-stats/tool-todo/plan-mode/user-questions 等)、`turnBoundary` 投影移至 dsh-agent(v2 schema,字段名兼容,我们的 blank 检测不变)、plan 投影 v4 新增 `entered`(我们只转发裁剪字段)、权限通知措辞改写、llm 新增 badge 字段(忽略)。
适配:`TESTED_VERSION` → 0.2.2-rc.1;native-codec 从 official-bundles 读 bundle 名册(app-boot 旧拼写保留为回退,fixture 无需改动);bridge modelCatalog 增加 `sessionController.modelCatalog()` 服务路径(可用时优先,否则回退 provider 枚举,0.2.2 下实测 18 个模型条目);权限通知断言兼容新旧措辞;fixture 假安装版本号同步。升级方式:`npm install -g --allow-scripts=… @deepseek-ai/dsh@0.2.2-rc.1`(含原生模块构建)。
验收:`pnpm check` **590/590**;PTY 五套全过;真实 0.2.2-rc.1 运行时端到端探测(hello/connect 惰性会话/models/sessions/state 含 usage 全通,session-stats 插件行照常装载);live 启动→选择器(外壳 0.25s/行 1.4s/标题 1.5s)→退出零新会话。

## 会话清理 + 活动排序(11月5日)

1. **删除"只有 hi"的会话**:以 `source.kind === 'user'` 且排除注入上下文(system-reminder/runtime snapshot)为真人输入标准,当前路径 13 个会话中 6 个的全部真人消息均为 "hi"(07b27f16/26bc232d/573f433e/5a5cf5f2/867fd9e8/bc0fb16e)删除,保留 7 个含真实多轮对话。
2. **`-r` 列表按最近对话排序**:DSH 的 `sessionQuery.listSessions` 仅按创建时间排序(SessionHeader 无活动时间字段)。0.2.2 的 `sessionPersistence.list()` 快照携带 `location.path`(存储工件路径)——bridge 读取工件 mtime 作为活动时间(`activityAt`),按其降序排序;无 location 的会话以创建时间参与排序,persistence 不可用/失败时回退创建序(测试覆盖)。app 侧将 `activityAt ?? createdAt` 映射为选择器的年龄列时间——年龄显示最后对话时间。选择器仍"信任列表顺序"原则不变(排序在 bridge 侧,基于原生存储事实)。真实存储验证:列表按活动降序(15m/13h/17h/…),与创建序明显不同。
- `pnpm check` **592/592**(+2 活动排序测试);tsc/git-check 干净。

## /questions 移除 + 状态栏对齐 DSH 桌面端(11月5日,subagent 换 opencode-go/deepseek-v4.1-flash 模型)

1. **/questions 移除,Esc 对齐 CC/Pi**:问题对话框 Esc 不再"隐藏待答",而是立即以 `{cancelled:true}` 经 respond 结算原生问题。bridge 修复:question 的 respond 取消改用 DSH 官方语义 `ASK_CANCELLED`(与 web 端 dismiss 同款,回合继续、工具以错误结果落地),信号中止/关停仍 `ASK_ABORTED`(整轮中止);错误对象经 `restoreUserQuestionError` 还原为原生 `UserQuestionError`。app 侧删除 `/questions` 命令、reopenQuestion/hideQuestion、hiddenDecisions/hiddenDialogs 全部状态与提示;提示行改为 `Esc cancel`(问题)/`Esc reject`(审批);Ctrl+C 语义不变。真实 DSH 验收(acceptance-review):Esc → 持久层 `tool/result.error = {name:'UserQuestionError', code:'ASK_CANCELLED'}`、`turn/end {kind:'completed'}`。
2. **状态栏第一行对齐桌面端数据源**:`模型 effort · 状态 · 预设 · 上下文条(%/窗口) · 总tok(tokenUsage 四桶和) · 缓存命中% · N轮M步(sessionStats) · avg tok/s · TTFT: X`,顺序按用户指定;effort 去圆圈——非 max 与模型同蓝(accent),max 用粉色 #f778ba(CC 式"彩色",对比度 7.4:1);编辑框上边框 Working 状态移除 tok/s(与状态栏去重),保留 spinner/token/耗时。
3. 验收:`pnpm check` **609/609**;PTY 六套(含重写的 question-escape-cancel 场景)全过;tsc/git-check 干净;demo 视觉核验 low/max 文本式 effort。父级修复:7 处旧圆圈断言、dialogs 提示文案、PTY 场景、README/ACCEPTANCE 文档。

## max 彩色、avg 前缀与模型切换根因修复(11月5日)

1. **`max` 真彩色**:`m`/`a`/`x` 三字符逐字循环 pink #f778ba → orange #f0883e → cyan #39c5cf(静态、无定时器);非 max 仍与模型同蓝。token 速率芯片去掉 `avg ` 前缀(`14 tok/s`)。app-theme 测试逐字符断言三色。
2. **模型切换失效根因(重大)**:bridge 的 `createSelection` 以错误签名调用 `installModelSelection`(原生 API 只收 agentCtx——它是"pre-step 切换通知"钩子,不是 holder 安装),多余参数被静默忽略 ⇒ bridge 的 selection holder 是一个**死镜像**:DSH 从不读它,活会话的 `/model` 只改了 footer,后续请求仍用旧 provider(正是用户在 infuse_app 的症状:切到 opencode-go 后请求依然走 cloudagent)。修复:holder 的 `current` 改读 `agent.model.current()`、`select()` 直写 `agent.model.select()`(官方 controller 同款);`applyRoute` 原生写入失败即抛错,不再镜像假成功;路由比较改按值(DSH 返回 detached 拷贝);pending 暂存的 reasoningEffort 现在随物化传入 agentOptions(原来被丢弃)。429 不回滚已记录的 selection,重试即用新路由。真实 0.2.2 验收(零模型调用):pending 切换 deepseek-account/deepseek-flash 后 state 路由随之变化;`/model` 失败时 footer 保持原生旧路由(无乐观/实际分歧)。新增 backend-model-switch 5 项测试;遗留:从未发过消息的 resume 会话显示回退路由但首次请求报错(需要产品决策,未擅改)。
- `pnpm check` **614/614**;PTY theme/cancel/model-picker 过;tsc/git-check 干净。

## 状态栏指标实时化:metrics 推送 + 官方 wire view + 上下文零污染回落(11月5日)

1. **分析定案**(双 subagent,cloudagent 429 三杀后父级补完前端侧):指标不动=三因叠加。①结构性:指标唯一通道是前端拉一次 `state`(refreshQueue,只在启动/换会话/状态跃迁/命令边界/submit 触发),整轮冻结;bridge 的 projections.onChanged 只转发 permissions/todos/plan,`contextPressure/tokenUsage/sessionStats` 通知到达被无视,协议无 usage/stats 事件。②读法错:`usageOf` 读 deprecated `stateOf` 原始 state,`projectedTokens` 只存在于官方 wire view,`projectedTokens ?? pressureTokens` 左支真机永不生效(fixture 幻觉掩盖)。③上游语义:`pressureTokens` 是 last-wins 单槽,失败 attempt(429 带 usage 全 0)清零(用户长会话 f0321b1e 实测 pressureTokens=0,真实占用 44344 在 contextBreakdown);官方桌面同数据也显示 0%。另 applyStats 落值不 render、换会话保留 stale chips。
2. **修复(两个 subagent 并行,契约由父级冻结)**:`src/backend/types.ts` 新增 `{type:'metrics',sessionId,usage?,stats?}` + UsageSnapshot/StatsSnapshot。bridge:onChanged 分发 METRICS_KEYS 四 key(contextPressure/tokenUsage/contextBreakdown/sessionStats)→ publishMetrics 值去重门控(plan 同款,首次观测即发,unmounted 静默);`projectionValuesOf` 优先官方 `snapshot()` wire view(stateOf 整体回落,不混形状);抗零污染:used = projectedTokens ?? pressureTokens,0/undefined 时回落 contextBreakdown 三段和(纯官方数据);attach 快照并入 metrics 基线;protocol.ts 加 normalizeUsage/normalizeStats 校验。app:onEvent 接 metrics 分支;applyStats 值比较+render;applyInfo 换会话清 usage/stats;transcript 显式 no-op。state 命令 usage/stats 保留为兜底。
3. **验收**:`pnpm check` **636/636**(+17 backend/+5 frontend);PTY 三套过;tsc/git-check 干净。**真实会话只读 attach 探针**(零模型调用,临时 runtime home 镜像真实 home):resume 117ec44e → attach 即出 metrics 基线一帧 `used=33673/size=1.0M/cache 97.9%/13.1M tok + 6轮133步`,`used=33673` 恰为官方 wire view projectedTokens(原始 pressureTokens=149453)⇒ wire-view 路径实证生效;state 与事件逐字段一致。hermetic e2e(backend-metrics-events,mock stream 零 provider):fixture 完全不报 usage(即零污染场景)时 used>0 只能来自 contextBreakdown,断言通过。
4. **边界**:DSH 官方粒度=每步/每 durable 事件(provider usage 请求结束才报),流式逐 chunk 速率无官方数据、不做本地统计;tok/s、TTFT 为全日志累计均值(官方口径,长会话天然缓慢);投影 unmounted 不发"清空"帧(前端保留旧芯片);零污染回落优于桌面(桌面显示 0%),严格对齐官方口径属上游 issue。用户当前 11:38 启动的 TUI 进程跑的是旧代码,需重启后生效;492c1e39/infuse 会话被该进程持有未做 attach 探针。

## 品牌蓝 = cc-dark #4f9eff 正式定名(11月5日)

用户定义:cc-dark 蓝 `#4f9eff` 即品牌蓝、全局基准,后续需求口径只说"品牌蓝"。旧的 DeepSeek 像素蓝 `#335DE0` 全面退役:静态字符 logo(src/ui/logo.ts)、read-title 区间数字(src/ui/blocks.ts)与编辑框边框、`❯`、状态栏同用 `#4f9eff`。实现:palette/t 的 `logoBlue` 令牌删除,新增 `brandBlue: accentBlue` 别名(单一基准,无第二品牌蓝);editorTheme.borderColor 用 accent(#1c2d44 隐形、#335de0 过深,均以防回归断言永久排除)。generate-logo-assets/pty-theme/pty-static-logo 三脚本同步。docs/THEME.md 新增"品牌蓝 = cc-dark #4f9eff"一节作为口径记载。验收:pnpm test 636/636、tsc 干净、pty-theme 与 pty-static-logo(exit=0,断言新品牌蓝转义码)通过。

## 品牌蓝重定义为 #79c0ff + 主题抽象"一处真相"(11月5日,本节取代 288 行的 #4f9eff 定名)

用户重定义品牌蓝 := `#79c0ff` 并要求全站单蓝体验;同时要求主题抽象("改颜色别到处改、容易遗漏")。两轮 subagent 只读分析(pi-tui 主题能力 + 全仓蓝点审计)结论:pi-tui 只提供颜色原语与组件主题接口,无 token 语义层/主题文件/覆盖机制(pi harness 那套在 App 层,不适用);全仓 47 个蓝渲染点已在 theme 令牌后,分散风险在 logo RGB 三元组、grid.json 幽灵 palette([51,93,224] 早已过期未被读)、4 处 PTY 转义锁、14+ 处文档口径、测试 hex 锁。

实施(前端 agent + 父级并行):
- **src/ui/brand.ts 新建**:`BRAND_BLUE = '#79c0ff'`,全仓唯一品牌 hex;表面色(#2a4060 规则线、#1a4480 底色带)与内容色(inlineCode #a5d6ff、语法高亮)刻意不派生并注释;恢复分档只需改 theme.ts 里 accentBlue/accentBrightBlue 两行赋值,调用点零改动。
- **theme.ts**:accent/accentBright 两角色同值指向 BRAND_BLUE;删除死别名(dshBlue/blue/blueBright/brandBlue、ccPalette.claude);editorTheme.borderColor/markdown/selectList/ccPalette 全部自动跟随。
- **logo.ts**:LOGO_BLUE 由 colorToRgb(parseColor(BRAND_BLUE)) 派生(保持 [r,g,b] 导出形状);grid.json 删除幽灵 palette,generate-logo-assets.py 删 BLUE/palette 输出。
- **app.ts**:删本地 dim 重复实现改 import;blocks.ts brandBlue→accent。
- **防漂移守卫**:ui-theme 源码扫描(src/** 除 brand.ts/highlight.ts 不得含品牌 hex;#4f9eff/#335de0/#4d6bfe 全域封禁)、死别名不存在断言、单蓝关系断言(accent===accentBright、cc.permission/suggestion===t.accent);app-theme 期望值从 palette 派生(不再锁 hex);PTY 颜色镜像集中 scripts/pty-common.py,新增守卫测试(镜像与 palette 不一致即失败并提示同步);颜色断言测试首行 import truecolor helper(修复依赖 shell COLORTERM 的隐患)。
- 文档口径 THEME/ACCEPTANCE/README 全部改为"品牌蓝=brand.ts 一处真相"。

已知取舍:logo 蓝压白内区对比度 2.74→1.95(40% 单元,轮廓反而更亮,内区质感略降,已接受;如需回退属产品决策);标题与代码数字蓝同值(内容/ chrome 撞色,原 accentBright 本就同值,非新增);测试环境 COLORTERM 依赖已修。

验收:pnpm check **639/639**;pty-theme/pty-static-logo(exit=0,镜像常量断言);PTY 实拍单蓝:❯/边框/logo/标题全 `rgb(121,192,255)` 共 23 处,旧色(79;158;255 / 51;93;224)零残留;tsc 干净;grep 退役色 src/assets 零命中。用户需重启 dsh-tui 体验。

## 品牌蓝定案:cc-dark 复刻双档(11月5日,取代单蓝 #79c0ff 实验)

用户体验单蓝 #79c0ff 后反馈"没有现在 cc-dark 深,差别非常明显"——根因:#79c0ff 是 cc-dark 的标题/高亮档(blueBright),其主色是更深的 #4f9eff(blue);单蓝统一把亮档铺满全部 chrome,整体浅一档。用户选定"复刻 cc-dark 双蓝"。实施(父级直接执行,验证新抽象的一次真实换色):
- `src/ui/brand.ts`:`BRAND_BLUE = '#4f9eff'`(主档:❯/编辑框边框/状态栏/tagline/链接/logo 块/选定前缀)+ `BRAND_BLUE_BRIGHT = '#79c0ff'`(亮档:大标题/焦点标签/徽章/列表符号/对话框标题);两 hex 仅存于此文件。
- `theme.ts`:accent→主档、accentBright→亮档(两行赋值);logo/边框/❯/markdown 链接自动回深,标题/选定文字/列表符号自动回亮;调用点零改动——"换品牌色只动 brand.ts"承诺首次实战兑现。
- 守卫同步:ui-theme 关系断言改为双档(accent≠accentBright 且亮档更亮)、deepEqual 复原两值、退役列表收敛为 #335de0/#4d6bfe、两档品牌 hex 均不得内联在 brand.ts 之外(highlight.ts 内容语法豁免注释不变);app-theme 期望值派生自动跟随;pty-common.py 镜像恢复双转义,镜像守卫分别锁两档;PTY 双脚本经 pty-common 引用零改动。
- 文档 THEME/ACCEPTANCE/README 口径同步为双档。

验收:pnpm check **639/639**;tsc 干净;pty-theme/pty-static-logo(exit=0);PTY 实拍:❯/上下边框/logo/状态栏均 `rgb(79,158,255)` 主档(21 处),大标题 `rgb(121,192,255)` 亮档(2 处),退役 #335de0 零残留——与真实 cc-dark 的双蓝分布一致。对比度全部回到 CC 档(徽章 4.95≥4.5)。logo 蓝压白回到 2.74(优于单亮蓝的 1.95)。

## logo 回归 DeepSeek 原始像素蓝(11月5日)

用户定案:静态字符 logo 回到一开始的 DeepSeek 参考像素蓝 `#335DE0`(51,93,224),作为**资产色**独立于品牌蓝双档(与 LOGO_WHITE 同级)。实施:logo.ts 的 LOGO_BLUE 不再从 BRAND_BLUE 派生,改回字面 RGB 三元组(唯一定义点);brand/theme 头部注释同步(品牌双档不再宣称覆盖 logo)。守卫调整:`#335de0` 从全域封禁改为"仅允许出现在 src/ui/logo.ts"(资产豁免,注释写明用户复批),`#4d6bfe` 仍全域封禁;pty-common.py 新增 LOGO_BLUE 镜像,pty-static-logo 专用之,pty-theme 的启动断言改为"logo 用资产蓝 + chrome 用品牌主档"两条;app-theme 的 bluePixelCount 改按 LOGO_ASSET_BLUE 计数,镜像守卫增加 LOGO_BLUE 转义↔logo.ts 导出一致性检查。文档 THEME/ACCEPTANCE/README 同步("B 为 DeepSeek 资产蓝,独立于品牌蓝")。

验收:pnpm check **639/639**;tsc/git-check 干净;pty-theme/pty-static-logo(exit=0);PTY 实拍:logo 块 `rgb(51,93,224)`×12、❯/边框 `rgb(79,158,255)`、大标题 `rgb(121,192,255)`——三色各归其位。蓝压白对比回到 2.74。

## 思考折叠摘要 + 可复用鼠标抽象层 + /settings 分 tab(11月5日)

用户需求:think 显示不能只有开/关,要复刻 pi-cc-extensions 的折叠摘要(时长、隐藏行数、fullscreen 点击展开、独立设置项);鼠标事件单独抽象便于复用;设置项进 /settings 且 Thinking 单独 tab;subagent 分头开发父级验收。

**调研**(只读):pi-cc-extensions 的 compact-thinking(`Thought for 999ms · 7 more lines · click to show more`)核心在 `extensions/feature/compact-thinking.ts`——折叠行一行拼完、时长按 thinking 边界计时并持久化为 session entry、行数按折行计、尾部窗口预览、fullscreen 点击展开(标题行整行 hitbox)/inline 键位提示、设置 3+1 项。DSH wire 侧 `stream_chunk` 的 chunk 带 `block-start/reasoning-delta/text-delta` 类型且事件带 `time`——**TUI 可自行推导时长与 run 边界,无需 DSH 改协议**(types.ts 只补了 `time?: number` 声明)。

**实施分工**(quota 多次 429,恢复续跑):
- **鼠标抽象层**(`src/ui/mouse.ts`,可复用、无业务知识):`HitboxRegistry`——press 认领(TuiAltScreen press-target 语义)、click 分发(clickCount/修饰键透传)、move/drag hover diff、列区间命中、重叠按声明序、非左键/release/wheel 放行、空注册表 motion 放行;`test/ui-mouse.test.ts` 15 项;`docs/MOUSE.md` API/语义/消费指南。
- **thinking 显示**(src/ui/thinking-block.ts + state/transcript + blocks/transcript + demo):折叠摘要行(时长 999ms/5s/1m 20s 三分支、more lines 单复数、无假数字降级)、尾部预览(previewLines 行,截断头部行数计入隐藏)、展开全量、模块级展开表(key=itemId:runIndex,会话切换自动清)、live 时长(chunk 驱动 + 可选 timer)、resume 近似时长(仅单 run 且事件时间可得)。state 层从原始 chunk 序列推导 runs(StreamPresentation 冻结契约不动)。
- **/settings 分 tab**(src/ui/settings.ts):General/Thinking 两 tab,←/→/Tab 切换,数字快选;Thinking tab:Show thinking/Preview lines(0/1/3/5/10)/Live timer(90/250/500/off)。config.ts(parent)新增两字段+值域。
- **父级接线**(app.ts):viewOptions 传 thinkingPreviewLines/screen/thinkingLiveTimerMs/onRenderRequest;`app.thinking.toggle` 语义改为"隐藏→折叠摘要→展开/收起最近 run"(总开关进 settings);openSettings 换 tab 式 SettingsDialog;reload 同步新字段;actions/keybindings 描述更新。**实证推翻了"fullscreen 鼠标到不了 transcript"的论断**(probe:TuiAltScreen 经 ScrollView 分发正常到达,坐标为内容局部坐标)。

**PTY 验收**(`scripts/pty-thinking-smoke.py`):80 列强制折行;滚轮回顶后逐行 SGR 点击定位摘要行——折叠态首行隐藏、点击后全文出现;inline 无 click 提示;两模式终端恢复。Session 增加可选 settings 预置(fork 前写 settings.json)。

验收:pnpm check **693/693**(+54:鼠标 15+thinking 28+settings 11);tsc/git-check 干净;pty-thinking 双模式 exit=0;pty-cancel/theme/static-logo 复跑通过。测试适配:旧设置对话框交互测试改为 tab+行号交互(app.test.ts/app-settings-feedback/app-cancel-lifecycle),digit 快选补回 SettingsDialog(与 SelectDialog UX 对齐)。

### 修复:点击无法收起展开的思考(11月5日,用户实测反馈)

用户实测:点击可展开,再点无法收起。复现(probe:VirtualTerminal + TuiAltScreen + ScrollView follow:end):**follow-end 下展开使内容增高,视口被拖到底部,摘要行跳离指针位置**——用户点的"原位置"行变成正文行(无 hitbox)→ 落空。逐层验证还揪出一个接线 bug:`onViewportAnchor(expanding)` 传的是 toggle 前状态,消费方却按"即将展开"理解(语义反转,首次点击不冻结)。

修复:
1. 语义统一为"即将展开"(`onViewportAnchor?.(!expanded)`),文档注释同步。
2. **keepViewportOnExpand**(app.ts `anchorTranscriptViewport`):展开点击前若在跟随底部,先 `scrollTo(scrollTop, {disableFollow:true})` 冻结(pi-tui ScrollView 原生支持,含 followSuppressedAtEnd 防复活);收起点击时若视口仍停在冻结位(用户未手动滚动)则 `scrollToEnd()` 恢复跟随。
3. 选项链 `onViewportAnchor` 从 TranscriptView → blocks flags → ThinkingBlock 全程透传。

验证:probe 三态(点开:行不动/scrollTop 不变/follow 冻结;同行再点:收起+恢复 follow);`test/ui-thinking.test.ts` 新增锚定测试(锚定先于状态翻转、方向与翻转一致,29 项);PTY 冒烟加"同行再点收起"步骤(修复时序竞态:settle 等待渲染流沉降,避免展开字节迟到导致行归属错位)——fullscreen 含完整 点开→同行点收 往返,双模式 exit=0。

验收:pnpm check **694/694**;tsc/git-check 干净;pty-thinking 双模式复跑通过。

### 再修复：展开后仍无法点击收起（11月5日，用户二次反馈）

前次只验证了标题还可见且在固定第 4 列点击的路径，覆盖不足。本轮重新对照 pi-cc 的 `mouse/interaction.ts:455-478` / `mouse/layout.ts`，确认原实现**展开后整段思考正文均能单击收起**，不要求先滚回标题；我们此前只有标题行 hitbox。另在父级完整 App/ScrollView 中复现：preview=0、长历史、摘要位于视口底行，展开后的 centered `scrollToEndIndicator` 会覆盖原来的 show-more 提示列，第二次同点点击被回到底部浮层抢走。分组只读审计还发现按下与释放之间重绘会改变行号，裸 `handled` 委托不能保留真正被按下的子块。

本轮子代理实现前端，父级检查实际代码并补集成修正：

- `MouseHitbox.claimPress:false`：大块正文的 press/move/drag 完全交给原生选区；原生 TuiAltScreen 本来就会在未拖动的释放后合成 click，因此正文单击收起不需要重写鼠标协议或补丁 vendor。每个 expanded run 的正文 hitbox 只覆盖自身，标题显示 `click to collapse`；没有隐藏行时不再虚报 show-more。
- 认领的 press 锁定 hitbox id；release 先于 native click，所以不能提前清锁。`dispatchToChild` 保留子块与 press-time origin，流式重绘不把点击送往另一行。隐藏思考、删 item、会话替换时清掉旧 hitbox/target；键位路径同样在翻转前锚定。
- 父级把回到底部按钮移到输入框上方**原本预留的固定空行**，不增加动态布局高度，也不再覆盖正文。多个思考 run 展开时只在最后一个收起且用户未滚走后恢复 follow。
- 父级补查 hover→正文第一条 drag：hover 退出回调可以请求 repaint，但不能吞掉第一条原生拖拽；声明在前的 click-only 区域不能被后面的全宽 claiming fallback 覆盖。

验证不再只看 raw repaint 子串：`scripts/ansi-screen.ts` 用独立 xterm VT 解码屏幕与单元属性，`pty-thinking-smoke.py` 点击真正的提示列，多次同点展开/收起；对正文拖动检查实际反显选区；将标题确实滚出屏幕后，再点击正文并回顶确认已经折叠。fullscreen preview=0/3 与 inline 共三场景全部 exit=0/restored=True。父级 5 个完整 App/native-SGR/ANSI 测试覆盖底行抢点击、正文/选区、press→重绘→release 漂移、多 run 跟随、移除/替换 pressed item；鼠标 19 项、thinking 36 项、settings 11 项通过。

旧 `pty-smoke.py` 本轮发现仍在解析已经移除的 SelectDialog 数字标签，卡在 Settings 第 3 阶段；改用共享 list.last（End）选 General 最后一行再进入键位编辑，真实保存/后续输入/resize/退出两模式均通过。取消 8 场景与 Help 两模式也通过。

验收：`pnpm check` **710/710**，严格 TypeScript、vendored build、`git diff --check` 通过。全部为离线 demo/临时 home/workspace，无模型回合、真实配置/凭据写入或全局安装修改。

### Tools 展示升级：连续分组与 Input/Output Inspector

用户批准实现只读调研结论，并多次明确要求 subagent 使用
`cloudagent/deepseek-v4.1-flash-1017`。所有开发、返工和收尾复核的 Agent 调用
均显式传入该 model 参数；harness 未暴露独立 resolved 元数据，未为核验模型
读取任何 profile/Pi models/credentials。父级负责共享契约、App/设置持久化、
独立 SGR/VT/PTY 与最终全量验证。

- `tool-group.ts` / `transcript.ts` 在原始 item cache 上生成纯展示投影：同名/混合
  连续工具、五态计数、状态树行和真实 Shell 时长；用户/正文/Thinking（含隐藏
  占位）/notice/todo/Diff/已知 turn 边界隔断；不按完成时间排序或假称并行。
- 单卡折叠摘要、Input/Output 各自预览和大文本 Inspector；Edit/Write/native Diff
  独立，auto/split/unified、标记、折行/阈值与折叠预算均可配置。Tools tab 11 项
  使用原 settings.json；General 不重复 Tool details，不新增 mode/profile/hotkeys。
- 控件复用 `HitboxRegistry` / `dispatchToChild`，展开正文 click-only、drag 原生。
  父级验收发现状态图标/冒号、collapsed body 虚假入口、single-expand、旧组清理
  覆盖新组 context 与配置缓存键遗漏，已退回同模型修正。Header/IO 按下目标在
  流式/热设置重绘后依旧绑定；源文本里的外层 `│` 不再决定 Input/Output。
- 工具与 Thinking 共享可见 root disclosure 计数，组 child 不双数、工具点击不
  隐式关 Thinking；Ctrl+O 清所有本地覆盖。App 负责 Overlay、源更新、旧 target
  删除和原生审批抢占，同一个主编辑器/草稿保持。
- 补齐真正的 inline 键盘路径：Ctrl+X Ctrl+O 初始 latest，Inspector 内 [ / ] /
  Alt+Left/Right 浏览所有调用，Tab 切段、c 复制、Esc 关闭；readonly context 不
  穿透 editor，disabled Shift+Tab/global fallback 不切 DSH 权限。Busy Ctrl+C
  只调用原生取消一次；idle Ctrl+C 只关闭而不清主草稿。
- 保留 call/result 各自 seq、time、turn/step、原 content/envelope；model proposal
  保留 native turn/step 但不冒充 admission。0 epoch / 明确 0ms 不再被当作假
  sentinel；缺时间不补本地时钟，duration 与 native toolMs 同源（含审批等待）。
- 收尾复核修正了 oversized 错称无改动、call proposal 当作 applied、空/零 native
  card 丢真、部分原生正文重复/覆盖 durable caption、结构化复制丢源、普通 JSON
  data 误当 binary、error 错称回滚、双栏分隔线/窄阈值越界与重复 LCS。超预算
  使用完整 Before/After 源而非再跑 LCS；图像仅引用，不倾倒 binary、不读文件或
  下载。没有 UI 重跑工具、backend harness/模型/认证配置或 global/vendor 改造。

父级 `test/app-tools.test.ts` **17 项**完整 App/native-SGR/独立 VT 通过；另有
配置 **25 项**、proposal 边界 **4 项**，组件与输入源码回归均保持。更新旧测试
明确检查新的预览预算与完整源可达，不通过删除状态/宽度/来源断言“消除失败”。

`python3 scripts/pty-tools-smoke.py` **2/2**：fullscreen 同点两次往返、实际正文
反显选区、标题离屏后正文收起、非末项 Output 详情；inline/fullscreen 全调用
导航、resize/草稿、终端恢复。首跑发现父级 Python 脚本漏 `termios` 导入，补齐
后重跑通过，未把脚本错误当作产品验收。Copy 使用父级注入回调验收完整源；
真实 PTY 不操作系统剪贴板，选区 OSC52 仅捕获。Thinking preview0/3+inline、
Settings/输入/resize、取消8场景、Help、模型选择、主题、静态logo/SIGINT 全部
同期复跑通过。

最终：`pnpm check` **898 tests / 898 pass / 0 fail**，16 suites，0 skipped /
cancelled，build 与严格 TypeScript 通过；版本仍 **v0.1.0**。测试全部使用临时
配置/离线或 localhost fixture，未额外调用真实 DSH provider，不改真实用户
配置/凭据、不 commit/tag/push/publish/替换全局入口。不是 Rex 的人工字体/GPU/
IME 或用户实测认可；操作与边界见 [Tools 文档](TOOLS.md)。
