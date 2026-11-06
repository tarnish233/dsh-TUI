# v0.2.0 原生 DSH 边界与交互语义验收

## 当前：v0.2.0 原生运行诊断隔离修复

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
