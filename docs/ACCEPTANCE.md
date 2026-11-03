# v0.1.0 原生 DSH 边界与交互语义验收

## 环境与范围

- 本地 Node 26.13.0 / pnpm 12.6.0 / macOS。
- DSH `0.2.1-rc.5`（精确版本闸）；Pi TUI `1.5.0` vendored 源码。
- Pi TUI 1.5.0 源码 vendored 到 `vendor/pi-tui/`，由本地构建编译；原 Editor/SelectList patch 与 `patchedDependencies` 已删除。未修改全局 Pi/DSH、原模型配置或认证文件，未 commit/publish。
- 分组开发遇到 Go 上游 `429 Allocated quota exceeded` 后，按用户选择切换 CloudAgent；中断组剩余部分由主 Agent 完成。主 Agent 独立检查实际文件并验收，不以子代理摘要代替结果。

## 最新检查

- `pnpm check`：TypeScript 无错误；**210 tests / 210 pass / 0 fail**，0 skipped/cancelled。
- `pnpm build:pi-tui`：vendored TUI 构建通过；没有 pnpm patch。
- `package.json`/lockfile 只改为 `@earendil-works/pi-tui: file:vendor/pi-tui` 及 TUI 自身的三个纯终端依赖；没有新增 SDK/模型客户端依赖。输入行为与旧 patch 版本一致，组合键 deadline 边界修复保留。
- `--help` 正常；没有模型迁移入口，模型目录/默认模型/凭据只来自 DSH 原生 profile 与 home 配置。

## TUI 源码 vendoring

- `@earendil-works/pi-tui` 1.5.0 从发布包 source map 提取完整 TypeScript 源码到 `vendor/pi-tui/src`，保留 MIT LICENSE 和上游说明；它只是终端组件库，没有 provider、认证、Agent 或会话代码可删。
- 本地构建 `pnpm build:pi-tui` 生成 `vendor/pi-tui/dist`；根因是 Node 不允许直接对 `node_modules` 内的 `.ts` 做类型擦除，编译后入口稳定。
- 原 `patches/`、`patchedDependencies` 和 harness 的复制/重定向逻辑已删除。CC 专用 Editor/SelectList 入口集中在 `src/input/pi-tui-seam.js`，安装到 vendored 公共类上；模型/provider 仍完全由 DSH 提供。
- 全量 210 tests 通过；实际 CLI PTY inline 57 帧 / fullscreen 77 帧，终端恢复通过；vendored TUI 下原生 CloudAgent 实网复测 215 个文本 chunk、153 个不同正文画面，正常结算、无工具请求。

- **Demo 工具调用**：`dsh-tui --demo --fullscreen` 无 prompt 时自动运行 `tools` 场景，展示 `bash(pwd)` 的原生 terminal call/result、exit code，以及 `edit` diff；`tools` 关键字可重放，普通文字仍展示 edit diff。

- **DSH 主题配色**：用户 query 使用 DSH dark `selectionBg` `#3B4A66` 的整行 mist-blue 背景带；启动标题、输入前缀和工作状态强调改用 DSH mist accent `#7DA1DE`，不再是 CC 橙色。
- **Working 状态**：不再占编辑框上方独立行，而是嵌入编辑框上边框；流式期间显示 `↓ N tokens · 耗时 · tok/s`，token 由 delta 估算并在 provider `usage.outputTokens` 到达后修正，跨同一 turn 的多个 step 累加。

## 本轮原生 DSH 配置改造

- 删除了 Pi `models.json`/`auth.json` 导入、`modelsFile`、provider 拆分/凭据迁移和 TUI 请求认证 shim。旧 `DSH_PI_TUI_MODELS_FILE` / `DSH_PI_TUI_IMPORT_MODELS` 不再读取，只给升级提示；`--models-file` 直接失败，不回退。
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

- 本机 DSH `0.2.1-rc.5` 的 base 原生挂载 `dsh-plan-mode` 并注册 `/plan`。真实临时 runtime 已验证 `/plan` / `/plan off` 的原生状态事件，且全程没有模型请求。
- `/plan` 的规划引导/评审与 `/permission` 的沙箱/审批预设独立：进入 plan 不改权限，Shift+Tab 切权限不切 plan。快捷键通过 native execute 保留命令审计；不再有 `/mode` 包装或伪造的 Plan 权限选项。
- 只读 `permissions` 控制返回原生目录/当前值；实时 selection 直接来自 native projection change feed。私有 wire 升级为 v2，不镜像权限算法。
- 快捷键查看/修改已收进 Settings，不再提供独立 `/hotkeys`。`/reload` 重新读取 TUI settings/keybindings，并同步真实 profile/home patch 后调用 DSH HMR；当前会话、transcript、草稿和缓存不重建，busy/待决策时拒绝，错误不假报成功。
- inline/fullscreen 的正常流式都没有 `Streaming attempt…` 占位；首 chunk 前只有工作区状态，正文增量直接显示且可编辑草稿。live/committing/settled 三阶段显示布局一致；未完成/未确认仍明确提示，未伪装为已提交回复。

此前新增 6 个回归覆盖这些原生边界；当前强 pre-finish 和原生服务回归仍全量通过。上一轮记录保留在 `.cache/ui-concepts-check.log` 与 `artifacts/ui-concepts-acceptance.json`。

## 原生服务与语义验收

1. **原生命令**：`/compact` 参数校验与无历史结果来自 `ctx.commands.execute`；有成对 `command/run/command/done` 与原生 command ID。无效参数不会触发压缩/模型。旧 compact 控制名仅为 native execute 的兼容别名，不丢弃尾部参数。
2. **取消/超时**：原生 fixture command 的 AbortSignal 被 Esc/Agent.cancel 或按 request ID 的 timeout abort 正确触发；命令结算为 error、审计配对、运行时继续可用。超时不假装动作已回滚。
3. **原生 codecs**：真实 DSH BlockAssembler 显示尚未闭合的文本并忽略 block-end 后迟到 delta；durable stream 使用 native 验证/装配；缺少 public helper 时拒绝启动，不回退到生产镜像。dt/时间戳的合法性由 native decoder 决定。
4. **原生文件工具/presenter/裁剪**：临时 workspace 内执行真实 DSH read。测试在原生 open turn 内调用已挂载的 `toolResultPruner.pruneSession`，生成真正的 model-only tool/result replacement。桥接保留 `surfaceOp/sourceEventSeqs`；UI 保留 append-origin 原文和 native read card。删除原文件后恢复会话仍按日志展示，证明不重跑工具/不读当前文件猜结果。
5. **标题/快照**：原生 `sessionTitle.rename` 产生日志标题，query 返回层级被正确读取。快照使用 `sessionQuery.readSession`，不调用已弃用的 snapshotEvents；UTF-8 字节预算不篡改内容。
6. **Agent 附着生命周期**：相同 session ID 重新附着产生不同 process-local attachment epoch；旧流不留作 active，新 attachment 可从 revision 1 正常输出。坏 resume 后可新建会话恢复使用。
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
| inline | 0 | 57 | 通过 | 通过 |
| fullscreen | 0 | 77 | 通过 | 通过 |

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
- 不宣称完整 CC/GNU Readline；图片、子 Agent/todo/goal 面板、fork/rewind、timed-question 补答 UI、多进程 recall-history 合并仍未实现。
- Rex 的字体、输入法候选窗和 GPU 主观流畅性仍需用户实际体验；不能由 VT/PTY 代替。

运行入口见 README；协议与原生边界见 BACKEND.md；原生 profile/模型配置与限制见 PROVIDERS.md；机器报告见 `artifacts/native-dsh-config-acceptance.json`。
