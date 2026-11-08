# Rex / Ghostty 支持

DSH TUI 是原生 DSH 同进程应用。这里适配的是**终端展示协议**，不是另一套 Agent、权限、通知服务或会话管理器。模型、工具、审批、问卷、会话标题生成和持久化仍由 DSH 拥有。

版本保持 `0.1.3/private`；这些是当前未发布工作树改动，没有提交、推送、发布或替换全局程序。构建后重启本地 TUI 即可使用。

## 1. 开箱行为

- **Rex**：自动协商通用 **OSC 7501 Program Status Protocol**。按用户明确选择，Rex 状态记录使用 `app=terminal`，让左侧／pane 头部显示内置 `>_` 通用终端图标；DSH 本体／进程名、标题和直接通知名称仍为 dsh-tui。Rex 收到原生工作／待审批／待回答／完成／失败状态后，自行决定 tab 指示、session picker、Dock 和系统通知的呈现。默认不叠加 OSC 777 通知。
- **Ghostty**：复用 Kitty 键盘协议、同步输出、鼠标、图片和粘贴支持；保留 OSC 9;4 不确定进度。自动通知只在收到确切的“未聚焦”报告后，发送一次隐私安全的 OSC 777 请求。
- **标题**：原生 DSH 标题存在时为 `<native title> — dsh-tui`，否则为 `dsh-tui · <workspace basename>`。Rex 只前加静态 `🐳`，不再加星号／工作符号，也不接收动画时钟；工作、审批和结算不改标题。Terminal title Off 不发送。其它终端不加前缀，不生成或改写 DSH 会话标题。
- **目录**：OSC 7 报告当前 DSH workspace 的编码 `file://host/path`。这是工作区信息，不冒充 shell prompt，也不改变进程 cwd 或 DSH 的目录策略。
- **子代理**：当前 native child tree 中的活动项有自己的有界状态记录。根会话可以 idle/done，同时 child working；子代理不会把根会话改成 busy。恢复的历史完成／失败项不制造新提醒。

## 2. Settings → General

仍是一张连续的设置页，没有 Terminal profile、独立配置树或新的 tab。

| 设置 | 默认 | 含义 |
| --- | --- | --- |
| Terminal status | On | 发布终端原生状态与兼容进度；Off 清除本应用的已发布记录，不改变 DSH 工作 |
| Terminal title | On | 更新 window/tab 的程序标题；不是 DSH Auto title 的启用开关 |
| Terminal notifications | Automatic | 下表所述的一次性通知策略 |

| 通知策略 | 行为 |
| --- | --- |
| Automatic | Rex 的原生状态开启时由 Rex Program Activity 决定；Ghostty 在确切未聚焦时请求通知；Rex 若关闭原生状态，也可在确切未聚焦时用 OSC 777 兜底 |
| Off | 不发一次性通知；**仍发布的原生状态可能由 Rex 独立产生提醒**，要关闭这种报告另关 Terminal status，或在 Rex 自己的 Program Activity 设置中选择呈现 |
| Always | 显式请求每个新 attention transition 的通知，不依赖焦点；可能与终端自己的原生提醒重复 |

每项继续使用现有稀疏 `settings.json`，Ctrl+R 只删除选中项的 override。无效文件拒绝覆盖；保存失败保留最后有效值。目录报告独立于标题开关。DSH Auto title 仍是只读 native composition 状态，已废弃的本地 `autoTitle` 不会恢复生效。

## 3. 支持矩阵与证据层级

| 能力 | 当前 Rex | Ghostty 1.4.0 |
| --- | --- | --- |
| OSC 7501 根／子记录、state/kind/msg/title | **真实 Rex 2 renderer 验证** | library 解析器存在；匹配版本源码的 GUI handler 不实现，不能以二进制字符串证明 GUI 会回复或显示 |
| 审批／问卷状态 | 原生 `blocked:permission/question` | TUI 对话和隐私安全的 OSC 777 fallback |
| OSC 0/2 程序标题、OSC 7 workspace | 真实 Rex 验证 | 源码支持；CLI/PTY 协议仿真通过，真实 GUI 未取得有效窗口 |
| OSC 777 通知 | Rex API 支持；Automatic 不重复请求 | 源码支持、协议请求验证；系统弹窗还取决于 Ghostty/OS 权限与勿扰模式 |
| OSC 9;4 不确定进度 | rich status 协商后停用，避免覆盖更丰富的状态 | 保留 1s 有界 keepalive，适配其进度指示过期机制 |
| Kitty keyboard / Shift+Enter | 既有单输入链协商 | 匹配版本源码支持；既有及新增输入/PTY 回归 |
| DEC 2026 synchronized output、鼠标、paste、图片／OSC 8／用户触发 OSC 52 | 复用私有 `#pi-tui` | 同一 Pi TUI 能力，不新增 renderer 或 clipboard policy |
| 原始自定义标题恢复 | **当前版本不支持 CSI 21 查询／22、23 栈恢复，真实 owned probe 已确认** | 匹配版本 GUI 源码忽略标题栈，标题查询默认禁用；真实 GUI 未核验 |

Rex 核验版本：`0.0.1793890641-gaf0c20`，API revision 11。Ghostty 安装版本：`1.4.0`。不把静态源码、协议仿真或 server record 等同于 GPU、窗口实际视觉或 OS 通知权限验收。

### 程序图标与活动指示符是两件事

本包提供 [DSH TUI 图标资产](APP-ICON.md)（SVG／PNG），但当前 Rex 按终端侧程序标识映射 artwork；OSC 7501 的 `app` 是映射键，不是图片载荷。没有发现公开的项目级 SVG／PNG 注册接口，因此**仅把图标放进本包不会使 Rex 的原生 tab／pane 图标位显示它**。自定义鲸鱼 SVG／PNG 仍不上传。用户另行明确接受了 Rex 的通用终端活动分类 `app=terminal`，实机 sidebar／pane-header 已从绿色 Node 图标换为内置 `>_`；其它终端仍上报 `app=dsh-tui`，DSH 本体／进程名／标题／通知名称不改，也不修改 Rex 资源／用户配置。Terminal status Off 或协议不可用时，Rex 会重新按真实前台进程显示图标；这不是独立图片替换接口。标题现在只保留静态 `🐳`，属于 OSC 0 文字，不读取／上传 SVG／PNG。working／blocked 等原生活动指示符仍走 OSC 7501；重复绘制不重发标题、状态或通知。

### 标题恢复的明确限制

发送 `CSI 22;0t` / `CSI 23;0t` 的保存／恢复是 best effort。当前 Rex 和匹配版本 Ghostty 路径忽略它们，且不能查询原自定义标题，**因此无法保证 TUI 退出或关闭标题展示后恢复原自定义标题**。最后设置的标题可能保留到 shell integration 重设它。不会调用 Rex CLI、猜一个标题、打开标题查询权限或改终端配置来掩盖这个限制；启动前关闭 Terminal title 则不会主动改标题。

## 4. 原生事实如何映射

| DSH 事实 | 终端展示 |
| --- | --- |
| native root `running` 或仍在执行的原生命令 | working |
| 未结算的原生 approval / question | blocked，分别为 permission / question |
| live durable `turn/end.reason.kind=completed` | done，Turn complete |
| live durable `turn/end.reason.kind=error` | error，Turn failed |
| aborted / pre-step blocked / interrupted / forked | idle，不报成功 |
| max-tokens | idle，Output limit reached，不把输出上限伪装成成功或普通失败 |
| 匹配原生 commandId 的 command/done success / error | Command complete / Command failed，**不是模型 turn 完成** |
| 非零 native close / fatal | 一次 Session unavailable，清理展示；正常 close 不冒充失败 |

命令是否仍在工作来自 App 已有的 native activity map，不能因一个小的展示 correlation cache 淘汰而提前宣告完成。还有命令或模型 turn 在工作时，不把另一个工作项结算误报成整个根工作完成。

**不能作为完成依据**：chunk、committed/abandoned stream_end、一次尝试的 retry、非致命诊断、任意 notice、打开 Settings/Help/Model picker。恢复的 log 是历史，不产生新通知。真正的 native ready 会重新启用展示，不在关闭后重放迟到完成。

## 5. 协议、安全与生命周期

- OSC 7501 使用公开 rev 0.4；支持 states/kinds 子集，未知能力保守降级，不把无法表达的状态变成虚假成功。
- 每次 report 是完整记录替换。id 最多 8 层／128 字节／每段 32 字节，title 192 UTF-8 字节，msg 2048 字节，整条 4096 字节；无效 id 不得落到 root。TUI 预算 root + 最多 63 个 child，旧 id **先清再增**，防止瞬时超预算淘汰 root。
- 状态按变化发送，不用 heartbeat。Rex 标题已移除动画 tick／工作帧，只在原生 title／workspace 变化时更新；工作状态变化不更新标题。只有 Ghostty 等兼容进度路径保留单个受控定时器。取消、切换 context、pause、外部编辑器、SIGCONT、退出和 emergency restore 清理对应记录／模式；handoff 后没有迟到标题、进度、状态写入。
- capability、focus 和其它终端回复由现有 `ProcessTerminal` / `StdinBuffer` 单输入链消费。完整、分片、超长和停滞回复有界；已经识别的回复和其 quarantine 尾部不会作为 Editor 文本或 Enter。粘贴中的控制字节不会切换焦点／回答问题／提交。
- 显示 text 清理 C0/C1、方向覆盖字符和转义；保留合法 emoji/language joiner。通知只用固定短语，**不含提示词、工具参数、原始模型错误、凭据、完整答案或私有路径**。原生标题和 child 标签是用户可见的原生名称，不由 TUI 生成。
- 元数据通过 renderer 的同一 terminal writer；没有生产 `rex` 子进程、socket 客户端、桌面通知守护进程、第二 stdin reader、profile 镜像或模型 transport。

## 6. SSH / tmux / screen

- 直接 SSH 的协议可以通过现有 PTY，但远程 TERM/TERM_PROGRAM 不一定包含本地终端品牌。OSC 7501 始终按回复协商，**不依赖 REX_SESSION 存在**；Ghostty 自动通知在没有品牌或焦点证据时保守静默。
- 显式 TERM_PROGRAM / TERM 优先于继承的 REX_* / GHOSTTY_*。从 Rex 启动 Ghostty 不会被旧 REX_SESSION 误判为 Rex。
- tmux 3.8 的默认 `extended-keys`、`focus-events`、`allow-passthrough` 都是 off。打开 passthrough 也不会自动转发裸 OSC 7501，实验证明需要 DCS 包装。DSH TUI **不自动包装、不改 tmux 配置、不强制穿透**，与实际连接的终端协商后安全降级。
- 不向交互式 TUI 注入 OSC 133 shell prompt 来“修复状态”；它会让 Rex 清除 working/blocked。Pi 主屏的语义 prompt marker 继续仅供内部导航处理。

## 7. 验收与明早手测

静态标题收口：当前 build＋strict TypeScript＋专项 **111/111**、实际 Rex 静态标题／状态 **2/2**、CLI/PTY **8/8**、native DSH fixtures **2/2** 通过。原生 `>_` 图标 GUI 对照和上一阶段完整 **1761/1761**（131 文件）记录保留；本次未重跑全量。自动验收与日志见 [ACCEPTANCE](ACCEPTANCE.md)。没有真实 provider、用户 profile／凭据读取或配置改写。

手测建议：

1. 重启本地已构建的 `dsh-tui`，保持 Terminal status On，Rex 左侧／pane 头部应为通用 `>_`，标题只前加 `🐳`，鲸鱼前不应出现星号／工作符号；长任务、审批和结算时标题保持静态。另一个 tab 可观察原生 working/done 和待审批／回答状态。通知强度在 Rex 自己的 Program Activity 设置中决定。
2. 在 Ghostty 中开长任务、切到另一个窗口，再检查完成／需要输入通知。若没有弹窗，先确认 OS/Ghostty 通知权限；本项目没有替用户授予权限。
3. 在 Settings → General 切换三个偏好；Terminal title 不改变原生 Auto title，关闭直接通知不改变权限／plan；关闭/返回仍保留同一草稿。

## 8. 研究与实现索引

- [Rex / Grok Build / Claude Code 比较与来源](TERMINAL-RESEARCH.zh-CN.md)
- [Ghostty 匹配版本源码审计](GHOSTTY-COMPATIBILITY.md)
- [DSH 原生事件／标题映射](TERMINAL-NATIVE-MAPPING.md)
- [实现与并行契约](TERMINAL-INTEGRATION-CONTRACT.md)
- `src/ui/terminal-integration.ts`、`src/app.ts`、`src/backend/context.ts`
- `vendor/pi-tui/src/program-status.ts`、`terminal.ts`、`stdin-buffer.ts`
- `scripts/rex-terminal-smoke.py`（只创建自己的测试 session）
- `scripts/pty-terminal-integration-smoke.py`（协议仿真，不冒充 GUI）
