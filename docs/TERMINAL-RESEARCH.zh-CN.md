# 终端集成研究：Rex / Claude Code / Grok Build 的协议事实与 dsh-tui 的最小适配

> 状态：调研、基线与决策记录；当前实现和验收见 [终端支持](TERMINALS.md) / [ACCEPTANCE](ACCEPTANCE.md)。研究阶段没有修改外部安装或用户配置；本轮版本保持 0.1.3/private，不提交或发布。
> 采集时间：**本地 2026-11-08 02:0x–02:2x = UTC 2026-11-07 18:0x–18:2x**（文档与二进制快照均按此时间戳）。所有结论按 **V（已验证）** / **U（未核验或推断）** 标注，V 必须能在本文 §2 的来源或 §4 的复现步骤中还原。
>
> **本文的定位（2026-11-08 修订）**：§1–§5 是研究当时的**基线事实与历史建议**；§6 的“最小改造建议”已被 `docs/TERMINAL-INTEGRATION-CONTRACT.md` 取代，实际实现见 `src/ui/terminal-integration.ts`（§6.0 说明差异）。文中“已验证”只覆盖文档/线格式/静态二进制支持证据或可复现的 pty/tmux 实验，**不**覆盖任何 emulator GUI 的运行时呈现。

---

## 0. 结论摘要（供决策，不必读完全文）

1. **生产不需要新桥接协议，也不需要调用 `rex` CLI。** Rex 的通用 OSC 7501 是正确接缝。基线 Pi TUI 已会探测/编码根记录，但 App 未接入；本轮复用并扩展 id/title/progress、capability 子集和有界生命周期，接入 DSH 原生事实。（基线源码 V；当前代码/真实 Rex 记录验收另见 ACCEPTANCE）
2. **本轮选择 renderer-owned 薄投影，而不是竞品的业务模式或后台服务。** native turn/command/decision/child/title 是状态依据；正常流式、取消、重试和历史恢复不被猜成成功。标题与 workspace 使用原生事实，不新增 title 模型或 profile；细则见当前契约，§6 仅保留历史方案。
3. **Rex 默认由终端自己的 Program Activity 决定提醒。** 只发布状态，避免默认再叠加一次 OSC 777；其 tab/picker/Dock/声音/系统通知受 Rex 设置控制。Always 是显式重复风险 opt-in；原生报告关闭后，Automatic 可在确切未聚焦时使用直接通知兜底。OS 呈现/授权仍未冒充实测。（官方协议/设置 V；真实 server records V；OS popup U）
4. **Ghostty 1.4.0 与 Rex 不同：解析器会回复探测，但 GUI 不消费该记录。** 依据是 1.4.0 源码中 `src/termio/stream_handler.zig` 把 `.program_status` 放在 **unimplemented 分支**（输入负责人审计）；配置参考里也没有对应选项。静态字符串只能证明“含解析器/回复代码”，**不能证明运行期或 GUI 行为**。（源码级 V；运行期/GUI **未验证**，见 §4.2）
   → 因此在 Ghostty 下“协议原生提醒”目前视为静默，需要一次性 OSC 777 兜底；是否真的弹出取决于 OS/Ghostty 权限，**未实测**。
5. **tmux 是独立的实际协议断点，且比竞品文档说的更严格。** 实测 tmux 3.8：`allow-passthrough on` 对**裸 OSC 7501 无效**，必须 DCS 包装（`ESC P tmux; ESC <osc> ESC \`）才会到达外层终端，包装后外层回复也能回传到 pane。（V，§4.3）
   → 在 tmux 里当前实现会**自动静默**（Pi TUI 拿不到探测回复就不输出），这是安全的降级，无需额外处理；包装属于后续可选工作。
6. **对离开/焦点不复制竞品启发式。** CC 官方通知说明给出按输入空闲的 6s/60s 时序；本机无 CC binary，是否另用焦点/1004 不可凭文档缺项断言。Grok 打包文档用 1004 与 3s 门限；Rex 知道自身可见性。本轮只消费精确焦点事件，不自建输入空闲计时器。（CC 文档级、Grok 打包文档级；实现详见契约）
7. **隐私**：DSH 本体／标题／直接通知名称保持 dsh-tui；用户后续明确接受 Rex 状态的通用终端分类 `app=terminal`（其它终端仍 `app=dsh-tui`），直接通知只有固定短语，不含提示词/工具参数/原始错误/凭据/完整答案。状态动作短语可区分 native child 标签，标题与子记录消费原生名称并清理控制/方向覆盖字符；不是从文本生成本地标题。原始自定义标题恢复的限制明确，不通过查询权限或用户配置写入绕过。

---

## 1. 证据基线（版本 / 日期 / 位置）

| 对象 | 版本 | 位置 | 核验方式 |
| --- | --- | --- | --- |
| Rex server（用户实际运行） | `0.0.1793890641-gaf0c20`，api revision 11，built `2026-11-05T14:57:21Z` | `/Users/fulei/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex` | `rex version`（本地，只读）（V） |
| 当前终端环境 | `TERM_PROGRAM=rex`、`TERM=xterm-rex`、`REX_SESSION`、`REX_BLOCK` 存在 | 本会话 env | `env`（V；值不落盘） |
| Rex 协议文档 | Program Status Protocol **rev 0.4（2026-10-10）** | `https://www.superlogical.com/rex/docs/build/program-status.md` | 下载快照 `rex-program-status.md`（V） |
| Rex 全站文档 | llms.txt 索引 + llms-full | `.../rex/docs/llms.txt`、`.../llms-full.txt` | 快照 `rex-llms.txt`、`rex-llms-full.txt`（V） |
| Rex API 结构（含 7501 记录字段） | api revision 11 | 本仓库缓存 `rex-probe/inspect.json`（并行研究运行从 Rex 自描述 API 导出） | JSON 结构阅读（V） |
| Claude Code | **未安装在本机 PATH** → 只做文档对照 | `https://code.claude.com/docs/en/terminal-config.md` 等 | 文档快照 `cc-*.md`（V；行为 U） |
| Grok Build | `1.0.77 (50ca579fa996)`；`@xai-official/grok` 1.0.77 | `/opt/homebrew/bin/grok` → `/opt/homebrew/lib/node_modules/@xai-official/grok/bin/grok-native`（185 MB 原生二进制） | `grok --version`（私有 `HOME`）、内嵌文档与字符串（V） |
| Ghostty | `1.4.0` | `/Applications/Ghostty.app` | `CFBundleShortVersionString`、`+show-config --default`、二进制字符串、`ghostty.org` 配置参考（V） |
| tmux | `3.8` | `/opt/homebrew/bin/tmux` | `tmux -V` + 私有 socket/配置实测（V） |
| Pi TUI（vendored） | 1.5.0 | `vendor/pi-tui/src/{program-status.ts,terminal.ts}` | 源码阅读（V） |
| dsh-tui 现状 | 本工作树 | `src/app.ts:627,1868,3277` | 源码阅读（V） |

**没有做过的事**（重要，避免误读结论）：没有在用户正在使用的 Rex pane 里注入任何转义序列；没有读取用户 `~/.claude`、`~/.grok`、Rex `init.lua` 或任何凭据；没有运行 `rex capture`、`rex events`、`rex api` 对用户会话的调用；没有发起任何模型调用；没有改动任何外部项目或全局安装。Grok 只做了 `--version`/`--help`（私有 `HOME=/tmp/grok-research-home`）与对打包二进制的 `strings` 只读抽取。

---

## 2. OSC 7501 事实清单（转述规格，只列实现必须遵守的点）

来源：`rex-program-status.md`（rev 0.4）+ Rex API 结构快照。

| 规则 | 内容 | 对 dsh-tui 的含义 |
| --- | --- | --- |
| 语法 | `OSC 7501 ; key=value(:key=value)* ST`，`ST` = `ESC \` 或 `BEL` | Pi TUI 用 `ESC \`，无需改 |
| 整体上限 | 整条 ≤ 4096 字节；`msg` 编码 ≤ 2732 / 解码 ≤ 2048；`app` ≤ 32 | Pi TUI 已截断 `msg` 到 2048 字节并校验 `app` |
| 记录语义 | **每次上报完整替换该 id 的记录**；缺省 `id` = root 记录 | 每条都必须带 `app`（Pi 的 `formatProgramStatus` 每次都写） |
| 状态 | `idle` `working` `done` `blocked` `error`；`clear` 删除记录（无 `id` 时删除整台终端的所有记录） | 程序侧不需要自己发 `clear`，Pi 在 `stop()` 处理 |
| `kind` | 仅 `blocked` 有效：`permission` / `question` / `auth` | 对应 DSH 的审批与 ask-user 问卷 |
| `progress` | 仅 `working`/`blocked`，整数 0–100；缺省=不确定进度 | **Pi TUI 目前无法发送该键**（缺口，见 §5.5） |
| `app` | `[A-Za-z0-9_.+-]{1,32}`，程序稳定标识（分组/图标/过滤用），子记录可从祖先继承 | 固定 `dsh-tui` |
| `title` / `msg` | base64 UTF-8；不得含控制字符；终端不得当 markup 解析、可截断 | 只用固定短语 |
| 生命周期（终端必须） | 进程退出或 OSC 133 `A` 新提示符 → 丢弃 `working`/`blocked`；`done`/`error` 存活；`RIS` 全清，`DECSTR` 不清 | 崩溃/被杀不会残留“working” |
| 能力探测 | `OSC 7501 ; ? ST` → 支持者回 `OSC 7501 ; ? [:states=…][:kinds=…] ST`；无回复即不支持；建议紧跟 `CSI c`（DA1）作哨兵 | Pi TUI 完全按此实现 |
| 安全 | 终端拒绝含控制字符的 `msg`/`title`，不回传任何记录内容；程序可任意快速改动，终端应限流对外副作用 | 程序侧也应节流（见 §6） |
| 上限 | 每终端 ≥64、最多 256 条记录；超出按最近最少更新淘汰（`reason=evicted`） | 只发 root 时无压力 |

Rex 侧落库字段（V，`inspect.json`）：`id`、`state`、`kind`、`progress`(0–255)、`app`、`effective_app`、`title`、`msg`、`updated_at`、`owner{pid,name}`；移除事件带 `reason ∈ {clear, child_exited, reset, prompt, foreground, evicted}` —— 其中 `foreground`（例如 Ctrl+C 后前台进程变了）是 Rex 独有的清理触发，说明“用户已离开该程序”由终端判断，程序无需操心。

---

## 3. 竞品行为矩阵（事实与出处）

### 3.1 程序状态（OSC 7501）

| 维度 | Rex（宿主） | Claude Code | Grok Build | Ghostty 1.4.0（宿主） |
| --- | --- | --- | --- | --- |
| 实现 | 原生（libghostty 解析 + Rex 自己的记录层与 UI） | 文档声明支持，**需 ≥ v2.1.295**；本机未安装，未实测 | 原生，`[ui.notifications] program_status` | 解析器存在并会回探测回复（静态字符串 + 源码），但 **GUI 将其列入 unimplemented 分支**；运行期未验证 |
| 开关 | 无（终端侧；通知/指示由 Settings > Notifications > Program Activity 控制） | 无需开启；`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` 会**同时**关掉状态上报 | `auto`（默认，需探测成功或靠 `REX_SESSION`/`REX_BLOCK`、Herdr2 `HC_TERMINAL_ID`）/ `on` / `off`；可关 `query`、`children` | 无（不可关） |
| 记录结构 | 支持 root + 子记录（`build/test`），≤256 条 | 文档未描述子记录（U：按 root 记录使用） | root + 每个 session / subagent 子记录，最多 63 条，按“等待用户 > 失败 > 运行 > 完成 > 空闲”优先级淘汰 | 解析后存放，呈现未核验 |
| `progress` | 支持，且用于标签页的“进度饼” | 文档未提及 | 文档未提及（其进度走 OSC 9;4） | 解析（U：呈现） |
| 生命周期 | `working/blocked` 在进程退出 / 新提示符 / 前台变化时自动丢弃；`done/error` 留存到用户回来 | 文档未细化（U） | 退出时删除自己的记录；后台命令/子代理仍在跑时继续报 `working`，仅剩长期任务时才转 `idle` | 解析器遵循规格 |
| 特殊排除 | — | **tmux 内检查 tmux 而非终端**；**background session 不上报**；`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` | tmux/screen/zellij/herdr 内只报主记录；`auto` 在 screen/zellij 完全不报 | — |

### 3.2 一次性通知（OSC 9 / 99 / 777 / BEL）

| 维度 | Rex | Claude Code | Grok Build | Ghostty |
| --- | --- | --- | --- | --- |
| 通道 | OSC 9 / OSC 777（`Settings > Notifications > System Notifications > Terminal notifications` 可关） | `preferredNotifChannel`: `auto`/`terminal_bell`/`iterm2`(+`_with_bell`)/`kitty`/`ghostty`/`notifications_disabled`，默认 `auto` | `method`: `auto`/`osc9`/`osc99`/`osc777`/`bel`/`none`，`auto` 按终端品牌选（Ghostty→777、iTerm2/WezTerm/Warp→9、Kitty→99、Alacritty/VS Code/Apple Terminal/未知→BEL、Rex→777） | `desktop-notifications`（默认 true，OSC 9/777）；`notify-on-command-finish` 默认 `never`（基于 OSC 133，非本场景） |
| 与 7501 的关系 | 7501 是主通道；一次性通知是补充 | 文档未说明“已获 7501 支持时”是否仍发通知（U：两节独立成文，按默认仍按 `preferredNotifChannel` 行为设计更安全） | 文档把 7501 与通知并列实现，`program_status` 与 `method` 独立配置（V） | 二者独立（V） |
| 去重风险 | 若 dsh-tui 同时发 7501 + 777，用户会看到两次提醒 | — | — | — |

### 3.3 标题（OSC 0 / 2）

| 维度 | Rex | Claude Code | Grok Build | Ghostty |
| --- | --- | --- | --- | --- |
| 内容 | 程序自定；`terminal.title_changed` 事件带 `title` + `owner` | 会话/对话标题；**当终端声明支持 7501 时，标题里不再加状态字形**（“The tab title doesn't start with a status glyph in a terminal that reports support”） | 可配置：`title.enabled`（默认 true）+ `title.items ∈ {action-required, spinner, activity, session-name, cwd, model, turn-timer, grok}` | 尊重程序 OSC 0/2；`title-report`（CSI 21 t）默认关闭（安全）；标题栈 `CSI 22/23` 在 1.4.0 路径上未验证/可能被忽略 → 恢复原自定义标题**不可保证** |
| 去重原则 | 终端自己显示状态，程序不必在标题里重复 | 同左（显式规则） | 无显式规则，但 `action-required`/`spinner` 是可选开关 | — |

**dsh-tui 现状（研究时点）**：`src/app.ts:627` 启动时一次性设置标题；§6.0 保留当时的原生标题方案。**后续用户曾选择 `🐳` 与工作符号，现又明确删除鲸鱼前的动态符号**：当前 Rex 仅用静态 `🐳` 前缀，星号、工作帧、标题时钟接缝和标题专用 Reduced-motion 分支均移除；其它终端仍是原生/fallback 标题，见 [TERMINALS](TERMINALS.md)。

**另一开源 dsh-TUI 的实际做法（公共源码复核）**：`@deepseek-harness-tui/dsh-tui` 0.18.0 与 0.19.0 的 [`ChatTitle.js`](https://unpkg.com/@deepseek-harness-tui/dsh-tui@0.18.0/lib/types/components/ChatTitle.js) 都拼 `✦/工作帧 + 🐋 + title`，由 [`use-terminal-title.js`](https://unpkg.com/@deepseek-harness-tui/dsh-tui@0.19.0/lib/types/ink/hooks/use-terminal-title.js) 用 OSC 0 发出。其 [`use-program-status.js`](https://unpkg.com/@deepseek-harness-tui/dsh-tui@0.19.0/lib/types/ink/hooks/use-program-status.js) 同样用 `app=dsh-tui`。这是标题 Unicode 字符，不是上传 package `plugin-icon.svg`，不能把“无自定义图片上传接口”误解为“标题里不能有鲸鱼标记”。

**后续原生通用图标实测**：用户拒绝 Docker 分类后明确接受 `app=terminal`。隔离的同一 Node.js 进程仅切换 OSC 7501 app 字段，Rex 实际 sidebar／pane-header 从 Node 绿色图标变为内置 `>_`，窗口截图已对照，不只是推断字段；DSH 本体／进程名／标题不改。现已限定 Rex 使用此通用活动分类，其它终端仍 `app=dsh-tui`；关掉状态报告会恢复终端自己的进程图标。自定义 SVG/PNG 上传仍没有公开入口，不能把这两种能力混为一谈。当前证据见 [ACCEPTANCE](ACCEPTANCE.md) 的通用终端图标节。

**标题恢复的诚实上限**：`saveTitle()`/`restoreTitle()` 依赖终端的标题栈（xterm `CSI 22/23`）。部分 emulator（含 Ghostty 1.4.0 路径）**忽略标题栈**，也普遍**禁用标题查询**（Ghostty 的 `title-report` 默认关闭）。因此：
- 无法读回用户原来的自定义标题；
- 忽略标题栈的终端上，我们的标题会保留到程序退出后（由 shell 集成/提示符重设）；
- 这是**文档化的限制**，不是可以“猜回来”的状态；不据此伪造恢复成功。

### 3.4 工作目录

- Rex 自己就有 `terminal.pwd_changed`（OSC 7 / OSC 9 / OSC 1337 都能触发），并由**壳层**上报（V）。
- CC 文档未描述用 OSC 7 报告 cwd（U：不作为依据，也不建议模仿）。
- Grok 把 `cwd` 作为一个可选的**标题项**。
- **建议**：dsh-tui 不发 OSC 7。TUI 的 cwd 变化不是壳层 cd，冒充会污染 Rex 的目录跟踪与会话标签；现有标题里已包含 `basename(cwd)`。

### 3.5 进度

| 维度 | 事实 |
| --- | --- |
| Pi TUI 现状 | `setProgress(active)` → `OSC 9;4;3`（不确定进度）+ 每秒 keepalive，停止时 `OSC 9;4;0`（V，`vendor/pi-tui/src/terminal.ts:15-17,648-662`） |
| Rex | 把 OSC 9;4 解析成 `terminal.progress_report` 事件（`state ∈ set/indeterminate/pause/error/remove`），并可显示进度条；**更精确的进度来自 7501 的 `progress=`，用于标签页进度饼**（V：事件结构 + 设置项文案；U：具体渲染细节） |
| Grok | `progress_bar = true` → OSC 9;4；自己的矩阵称 Rex “不支持进度条” —— **与 Rex 的 `progress_report` 事件和“progress pies”设置文案冲突，判为 Grok 的呈现假设，不采信**（U） |
| Ghostty | `progress-style`（默认 true）按官方配置参考渲染 OSC 9;4（文档级 V；GUI 未实测） |
| CC | 文档未描述 OSC 9;4 |

### 3.6 焦点 / 离开规则（三家三种）

| 方案 | 机制 | 触发门限 | 备注 |
| --- | --- | --- | --- |
| Claude Code | **官方通知文档的按键空闲时序**（是否另用焦点/1004 未核验） | `permission_prompt` ≈ 6s 无输入；`idle_prompt` ≈ 60s 且期间无输入、无后台 subagent | 每次按键都会推迟计时；"appear to be away from the terminal" 的实际含义就是“没在打字” |
| Grok Build | **DECSET 1004 焦点跟踪**（`\E[?1004h`/`\E[?1004l`）+ 空闲门限 | `condition = unfocused`（默认）、`idle_threshold_secs = 3`、`events = [turn_complete, approval_required, ...]` | 终端不报焦点时会给出专用诊断（`focus-tracking-unavailable` / “This terminal may not report focus changes…”），可切 `always` |
| Rex | 终端自己知道标签/窗口是否可见 | 无程序侧门限 | 设置项：标签指示、后台时的系统通知、Dock 角标、声音，按 `working/blocked/error/done` 分别开关 |
| Pi TUI 现状 | 主屏**不**启用焦点上报；alt-screen 只在开启鼠标时把 `?1004h` 打进鼠标 bundle | — | dsh-tui 目前拿不到焦点信息 |

Rex 的 terminfo 提供 `fe`/`fd`（`\E[?1004h` / `\E[?1004l`）与 `kxIN=\E[I` / `kxOUT=\E[O`，即 Rex 支持标准焦点上报（V，见 §4.1 的服务端 terminfo 源）。是否启用属于输入层决策。

### 3.7 多路复用器

| 维度 | 事实 |
| --- | --- |
| CC | 文档明确：**tmux 内改为检查 tmux 的支持**，`allow-passthrough` 对它没有帮助；因此 tmux 内基本不会有状态 |
| Grok | tmux 内需要 tmux ≥3.3 + `allow-passthrough on`（`all` 覆盖后台窗口）；所有 pane 共享一个 Rex 记录，最后上报者胜；screen/zellij 下 `auto` 完全不报，需 `program_status = "on"` |
| 实测（本机 tmux 3.8，私有 socket/配置） | tmux **自己**只回答 DA1（`\x1b[?1;2;4c`），不回答 7501；`allow-passthrough` **off** → 裸 OSC 7501 被丢弃；**on + 裸 OSC** → 仍被丢弃；**on + DCS 包装** → 到达外层终端，外层回复也能回传进 pane（V，§4.3） |
| 结论 | Grok 的“需要 passthrough”说法**不完整**：裸 OSC 即使开了 passthrough 也过不去，必须 DCS 包装。CC 的“tmux 不支持 → 不上报”与本机实测一致 |

### 3.8 清理与生命周期

| 事件 | Rex 行为（规范强制） | Pi TUI 已做 | dsh-tui 需要做 |
| --- | --- | --- | --- |
| 正常退出 | 程序退出即丢弃 `working`/`blocked` | `stop()` 发 `state=clear`（无 `id` → 清整台终端记录） | 无 |
| 挂起 / SIGTSTP → SIGCONT | 终端侧无规定 | `stop()` 清、`start()` 重新上报最新状态并重新探测 | 无（`src/app.ts:3269+` 已走这条路） |
| 崩溃 / 被 kill | `working`/`blocked` 自动丢弃 | — | 无 |
| 用户 Ctrl+C 中断程序 | Rex 额外以 `reason=foreground` 清记录 | — | 中断后应回到 `idle` 或下一次 `working`，不要留 `blocked` |
| 终端 reset | `RIS` 清空所有记录 | `stop()` 的 `clear` 已足够 | 无 |
| 探测失败 | 程序不应上报 | 不支持时完全不写（`programStatusSupported=false`） | 无 |

注意：Pi TUI 的 `clear` 是“整台终端全清”。在本 pane 只有 dsh-tui 一个前台程序的前提下正确；不要在自己的业务代码里再发 `clear`，否则会连自己上一帧的 `done` 一起抹掉，也会影响同 pty 内后续程序（例如启动的子进程若也实现该协议）。

---

## 4. 本机实测与可复现证据

### 4.1 Rex 支持 7501 与焦点上报（V）

- 服务端二进制内嵌 terminfo 源包含：`Pst=\E]7501;%p1%s\E\\`（Rex 专有 capability，注释说明“值即上报序列，只表示终端支持该协议，想确认仍应发查询”）、`fe=\E[?1004h`、`fd=\E[?1004l`、`kxIN=\E[I`、`kxOUT=\E[O`、`Sync=\E[?2026…`、`Ms=\E]52;…`。
- 服务端与 Ghostty 1.4.0 的探测回复串一致：`\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth`。
- **重要陷阱**：用户 `~/.terminfo/78/xterm-rex` 里安装的编译条目**是旧版**（无 `Pst`、无 `fe/fd/kxIN/kxOUT`，见 `rex-terminfo-xterm-rex.txt`）。所以 **不能**用 `tput Pst` / terminfo 作为能力判据；必须用运行时 `OSC 7501 ; ?` 探测（Pi TUI 正是如此）。Rex 文档也把 `rex terminfo setup` 描述为需要用户手动执行。

### 4.2 Ghostty 1.4.0：库解析/回复 ≠ GUI 呈现（源码级证据，运行期未验证）

- 静态二进制字符串含 `osc_program_status`、`terminal.osc.parsers.program_status.Report`、探测回复串等 → 只能证明**该版本含有解析器与回复代码**，属于“静态支持证据”，**不是**运行期或 GUI 行为的证明。
- 输入负责人审计的 1.4.0 源码证据（`src/termio/stream_handler.zig`）显示 `.program_status` 落在 **unimplemented 分支**，即 `StreamTerminal` 的解析器会回复探测，但 **GUI 不消费**该记录。因此“Ghostty 会像 Rex 一样显示工作/阻塞/完成”**没有证据**，不能从“缺少某个配置项”反推，也不能从字符串反推。
- `ghostty +show-config --default` 与 `ghostty.org/docs/config/reference` 只有 `desktop-notifications`、`progress-style`、`notify-on-command-finish*`、`title-report`；这**不足以证明**“一定不显示”，只是与源码证据方向一致。
- 父级曾尝试以独立窗口做实机验证，但未能获得可观测的自有窗口（超时，未重试、未触碰用户输入）。**故本文不声称任何 Ghostty 实际 GUI 行为**；dsh-tui 的策略按“Ghostty 不显示 7501、显示 OSC 9;4、接受 OSC 777”设计，并在实现中保持与 `programStatusSupported` 无关（见 §6.0）。

### 4.3 tmux 3.8（V，私有 socket/配置，未触碰用户 tmux）

复现脚本：`.cache/terminal-integration/research-rex-tmux-osc7501-probe.py`（用 `pty.openpty()` 冒充外层终端，`tmux -L dshtui-probe3 -f /tmp/probe-tmux3.conf`）。

```
passthrough=off wrapped=False: outer_saw_query=False reply_in_pane=False
passthrough=off wrapped=True : outer_saw_query=False reply_in_pane=False
passthrough=on  wrapped=False: outer_saw_query=False reply_in_pane=False
passthrough=on  wrapped=True : outer_saw_query=True  reply_in_pane=True reply="\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\"
```

分离会话（无 client）实测：pane 只收到 DA1 回复 `\x1b[?1;2;4c`，无 7501 回复 → tmux 自身不实现该协议。

### 4.4 没有做的实测及其原因

- **没有在用户真实 Rex pane 里跑探测**：写入 `OSC 7501;?` 会在用户屏幕/标签页留下可见副作用，回复字节还会进入上层 agent 的 stdin。已用“服务端二进制 + 自描述 API 快照 + 文档”三条独立证据替代。
- **没有实测 `claude`**：不在 PATH，且本机 `~/.claude` 存在但未读取（可能有用户 hooks/凭据）。所有 CC 结论均为文档级。
- **没有实测 Ghostty GUI**：见 §4.2；打包源码与字符串只是静态证据，GUI 呈现与标题栈效果均未验证。

---

## 5. dsh-tui 现状与准确缺口

### 5.1 基线能力（V，2026-11-08 研究时点）

- `vendor/pi-tui/src/program-status.ts`：`ProgramStatus` 类型（基线**仅 root 记录**，无 `id`/`title`/`progress`）、`formatProgramStatus`、`PROGRAM_STATUS_QUERY`、`isProgramStatusReply`、`msg` 2048 字节截断、控制字符替换、`app` 正则校验。
- `vendor/pi-tui/src/terminal.ts`：
  - `start()` 时把 `KITTY_KEYBOARD_PROTOCOL_QUERY + PROGRAM_STATUS_QUERY + DEVICE_ATTRIBUTES_QUERY` 一次写出；DA1 作为“不支持”的哨兵；`PI_PROGRAM_STATUS=1/0` 可强制开/关并跳过探测。
  - 探测成功 → 立即补发最近一次状态；`stop()` → `state=clear` 并从 `programStatusSupported=false` 重新开始；`start()` 后重发。
  - **`setProgramStatus()` 不是幂等的**：每次调用都会（在支持时）写出一次；不支持时只保留最新值，等支持确认后补发。去重必须由调用方完成。
  - **回复中广告的 `states`/`kinds` 子集当时被忽略**：`isProgramStatusReply` 只接受形如 `OSC 7501 ; ? …` 的回复，不解析能力列表。因此“终端不支持的 state”不会被提前规避（由调用方保证只用基础集合）。
- 当时的 `src/app.ts` 只在状态刷新处调用 `setProgress(this.isBusy)`，从未调用 `setProgramStatus`（该行号属历史基线；当前实现已迁移到 `src/ui/terminal-integration.ts`）。
- 主屏/alt 屏共用同一 `ProcessTerminal`，两条渲染路径都能用。

### 5.2 研究时点的缺口与当前状态

| 研究时点的缺口 | 当前状态（2026-11-08 实现后） |
| --- | --- |
| 从未调用 `setProgramStatus` | **已实现**：`src/ui/terminal-integration.ts` 由 App 的 `update()`/`observe()` 驱动，根记录 + 子记录 |
| 基线 `ProgramStatus` 只有 root、无 `id`/`title`/`progress` | 输入负责人已扩展 seam（`id`/`title`/`progress`、能力 getter、焦点事件、标题栈、进度 fallback）；控制器在“仅 root”的旧 seam 上自动只发根记录 |
| 无 tmux DCS 包装 | 仍是已知限制：tmux 内静默（安全降级），未在实现中包装 |
| 无焦点上报（主屏） | 输入层已提供 `onFocusChange`/`terminalFocused`；控制器订阅事件，仅在自定义终端上保留精确 `CSI I`/`CSI O` 回退 |

### 5.3 与 DSH 事实的对应（建议映射，实现归父级）

| DSH 事实（dsh-tui 已有信号） | `state` | `kind` | `msg`（固定短语，隐私安全） |
| --- | --- | --- | --- |
| 回合流式输出 / 工具运行 / `activeCommands>0`（`isBusy`） | `working` | — | `Working` |
| 权限审批待决（`decisionId` + `request.kind==='approval'`，DSH 的原生值是 **approval**） | `blocked` | `permission` | `Waiting for approval` |
| ask-user 问卷待决（`request.kind==='question'`） | `blocked` | `question` | `Waiting for your answer` |
| DSH 明确暴露的凭据/登录缺失（当前未接线，U） | `blocked` | `auth` | `Waiting for sign-in` |
| 回合成功结算、用户尚未回到输入 | `done` | — | `Turn complete` |
| 持久 `turn/end` 且 `reason.kind==='error'` | `error` | — | `Turn failed` |
| 已连接、空闲、无待决（启动后/上一轮已看过） | `idle` | — | 省略 `msg` |
| 退出/挂起 | 由 Pi TUI `clear` | — | — |

**原生结局词表（后端审计，权威）**

| `turn/end.reason.kind` | 终端状态 | 通知 |
| --- | --- | --- |
| `completed` | `done` | 一次完成通知 |
| `error`（`error:LlmFailure`） | `error` | 一次失败通知（通用文案） |
| `max-tokens` | `idle` + `Output limit reached` 元数据 | 无（不伪造失败） |
| `aborted`（`user`/`parent`/`disposed`/`hook`/`legacy`）、`interrupted`、`forked` | `idle` | 无 |
| `blocked`（agent/pre-step 拒绝或归档门控，**不是待审批权限**） | `idle` | 无 |
| 未知/未来值 | 不改状态 | 无 |

其它明确不算结局的事实：tentative `stream_end`（`abandoned` 是暂定/重试，**绝不是错误**）、`agent/error`（诊断，先于 `turn/end`）、`warning`、原生 `command/done` 结算、任意 notice、以及恢复出来的历史 `turn/end`。

关键约束：
- **上报顺序必须是“替换”语义**：审批结束回到 `working` 时要重发完整记录（含 `app`），不能只发 `kind`。
- **`done` 不要紧跟 `idle`**：`done` 会被覆盖掉；让终端的“用户已回来”逻辑清理（Rex 在用户按键/回前台时处理）。
- **只在状态变化时调用**（避免每帧/每 token 写 OSC）。`isBusy` 与 `decisionId` 的组合已在 `src/app.ts` 单点可读，适合派生。

### 5.4 用户场景核对（“用户睡着，完成要能通知”）

| 宿主 | 只发 7501 时的结果 | 建议 |
| --- | --- | --- |
| Rex（当前） | `done` 记录 → 标签页完成点、Dock 角标、可选声音/后台系统通知（用户设置决定） | **只发 7501**，不额外发 OSC 777/9，避免重复；也避免与 Rex 的“Terminal notifications”开关冲突 |
| Ghostty 1.4.0 | 静默（解析但不显示） | 默认静默；**可选**一次性的 OSC 777（通用文案），默认关闭 |
| tmux | 静默（无探测回复） | 静默；后续可选 DCS 包装 |
| 其他/未知终端 | 静默（探测无回复） | 静默；不猜测、不发 BEL |

---

## 6. 历史建议（已被当前实现取代）

> **本节是研究当时的最小改造建议，仅作历史记录。** 父级已选定更完整的契约
> （`docs/TERMINAL-INTEGRATION-CONTRACT.md`），并由 `src/ui/terminal-integration.ts`
> 实现。下面 §6.0 记录“当时的建议 → 现在的实现”差异，§6.1–§6.3 保留原文。

### 6.0 建议 vs 当前实现（2026-11-08）

| 研究当时的建议 | 当前契约与实现 |
| --- | --- |
| 标题保持固定 `dsh-tui · <basename(cwd)>`，不加字形 | **原生标题**：`<native title> — dsh-tui`，无标题时 `dsh-tui · <workspace basename>`；仍不加 spinner/状态字形（状态由协议承载）。自定义标题通过可选 `saveTitle()`/`restoreTitle()` 保存/恢复 |
| 不发 OSC 7（属壳层职责） | **发 OSC 7**：上报**当前原生 DSH workspace** 的 `file://host/path`，不伪造 shell 提示符；交接时若当前目录不同则恢复进程 cwd |
| 子记录（subagent）留到 Phase B | **已实现**：root + ≤63 条原生 child/decision 记录，稳定哈希 id、原生标签/状态；旧“仅 root”seam 上自动只发根记录 |
| 焦点/离开交给终端，不自建启发式 | **保持**：不自建计时器；订阅输入层的精确焦点事件（自定义终端保留 `CSI I`/`CSI O` 回退，paste 不消费）。`auto` 仅在**有**“失焦”正向证据时通知，且只对 Ghostty（其 GUI 不显示 7501）；Rex 等能显示状态的终端抑制重复通知 |
| Ghostty 默认静默 | **Ghostty 走 OSC 777**（`auto` 需失焦证据；`always` 强制；`off` 关闭显式通知）。是否真的弹出由操作系统/Ghostty 权限决定，**未实测** |
| 不发一次性通知 | `terminalNotifications: auto/off/always` 三态；`Off` 只关闭本应用的一次性通知，不关闭终端自身对已发布状态的展示 |
| 只接根记录，不做“错误/致命”呈现 | 原生 fatal/closed 会先发一次**通用** `error`（无原始错误文本）再停止写入；`terminalStatus` 关闭只清除记录，**不**影响显式通知策略（两者独立） |

### Phase A（历史）：只接 7501 根记录

1. **入口**：在 `src/app.ts:1868` 所在的状态刷新函数里，紧接着 `setProgress(this.isBusy)` 之后派生并调用 `this.tui.terminal.setProgramStatus(derived)`；`derived` 变化才写入（保留上一次 derived 做比较）。
2. **派生**：`blocked(permission|question)` 优先于 `working`，`working` 优先于 `done/error`，其余 `idle`。
3. **文案**：严格使用 §5.3 的固定英文短语（与 CC/Grok 的 UI 语言一致，且天然隐私安全）；`app: 'dsh-tui'`。
4. **不做**：不改标题、不发 OSC 9/777/BEL、不发 OSC 7、不加 tmux 包装、不调用 `rex` CLI、不写子记录、不发 `clear`。
5. **验收（可离线、无模型调用）**：
   - 用 `ProcessTerminal({ write })` 采集字节：`PI_PROGRAM_STATUS=1` → 断言出现 `\x1b]7501;state=working:app=dsh-tui:msg=V29ya2luZw==\x1b\\` 形态与变化序列；`PI_PROGRAM_STATUS=0` → 全程零 7501 字节；默认（无回复）→ 探测串恰好一次且之后无上报。
   - 断言 `blocked` 携带 `kind`，`working/blocked` 携带完整 `app`，任何 `msg` 解码后不含路径/提示词（用白名单断言编码值）。
   - `tui.stop()`（退出/挂起）→ 一次 `\x1b]7501;state=clear\x1b\\`；`SIGCONT` → 重新探测并重发当前状态。
   - 主屏与 alt 屏各跑一遍；`reducedMotion`、无 TTY、non-tty stdout 下不崩。
6. **节流**：状态派生本身是边沿触发即可；若未来按 token 驱动，务必 ≥250ms 合并（规范要求终端限流，程序侧不应逼近上限）。

### Phase B（历史，已由输入负责人落地 seam 扩展）

- `progress?: number`（0–100）加入 `formatProgramStatus` + `ProgramStatus`：Rex 的标签页进度饼就是吃这个键（`inspect.json` 里 `progress` 与设置项“progress pies”）。
- `id`/`title` 支持：为 DSH subagent 建 `id=dsh/sub/<slug>` 子记录（语法 `[A-Za-z0-9_.+-]{1,32}`，≤8 层，≤63 条）。**必须先有 Phase A 的稳定文案与淘汰策略**，否则会重演 Grok 的“优先级淘汰 + 共享记录”复杂度。

### Phase C（历史；tmux 仍未实现，Ghostty 通知已落地）

- **tmux DCS 包装**：探测与上报都需包装（`\x1bPtmux;\x1b` + OSC + `\x1b\\`），且 DA1 哨兵逻辑要相应调整；已实测包装后外层回复能回传到 pane。属输入路径改动，需输入负责人评审与 PTY 回归。
- **Ghostty/其他终端的可选一次性通知**：仅当“探测失败 + 用户显式开启配置”时发 OSC 777（Ghostty `desktop-notifications` 默认 true）或 `preferredNotifChannel` 风格的 `bell`。文案固定为 `dsh-tui: turn finished` / `dsh-tui: waiting for approval`，不含任何内容。**默认关闭**，并在文档中说明“Rex 用户不需要开启，否则会重复提醒”。

### 明确不建议

| 建议 | 理由 |
| --- | --- |
| 用 `rex` CLI（`rex send`/`rex events`/`rex api program_status`）做生产通知 | 子进程 + Unix socket 依赖；只在 Rex 内有意义；`rex capture`/事件流会读屏内容（隐私）；用户可能在无 Rex 的终端里跑 dsh-tui；协议层已能完成同样的事，CLI 仅适合测试/诊断 |
| 抄 CC 的 6s/60s 空闲计时 | 那是“没在打字”的代理指标；在 Rex 里由终端判断更准，且会造成与 Rex 提示重复 |
| 抄 Grok 的 `?1004h` | 会改变输入解析面（焦点序列进入 stdin 缓冲区），属输入负责人范围，且当前无需求 |
| 在标题里加状态字形 / spinner | CC 的显式规则是“协议支持时不加字形”；Rex 自己显示状态；只会造成抖动与隐私泄漏（标题进屏幕共享/窗口列表） |
| 发 OSC 7 改 cwd | 那是壳层职责，会污染 Rex 的目录跟踪 |
| 自建子记录（subagent）先行 | 需要 `id`/`title` 与淘汰策略，收益低于 Phase A；Rex 的 `reason=evicted` 说明记录上限是真实约束 |

---

## 7. 需要父级 / 输入负责人决定的事

1. `app` 最终取值：`dsh-tui`（与 AGENTS 的应用身份一致，推荐）还是更短的 `dsh`（Rex 图标/分组更通用）。规格要求稳定不复用他人名字。
2. `done`/`error` 的清理口径：是否在用户下一次输入时立刻改发 `working`（推荐），还是先发 `idle` 再 `working`（多一次写入，无收益）。
3. 是否接受 Phase A 的“Ghostty 下静默”：若不接受，需要 Phase C 的 opt-in 通知（新增配置项 + 文案 + 隐私评审）。
4. Phase B 的 `progress` 是否进入下一版 `vendor/pi-tui`（影响输入负责人工作量与 ANSI 回放回归）。
5. `docs/TERMINAL*.md` 之外的对外文档（README/ACCEPTANCE）由父级撰写，本文不改。

---

## 8. 来源与快照

| 来源 | URL | 快照 |
| --- | --- | --- |
| Rex：Program Status Protocol（rev 0.4） | https://www.superlogical.com/rex/docs/build/program-status.md | `.cache/terminal-integration/rex-program-status.md` |
| Rex：文档索引 / 全量 | https://www.superlogical.com/rex/docs/llms.txt · `/llms-full.txt` | `rex-llms.txt` · `rex-llms-full.txt` |
| Rex：Events / Lua events / Server API / CLI | `.../reference/events.md`、`.../automate/lua-events.md`、`.../reference/api.md`、`.../reference/cli.md` | `rex-reference-events.md`、`rex-automate-lua-events.md`、`rex-reference-api.md`、`rex-reference-cli.md` |
| Rex：Mac Settings（Program Activity / System Notifications） | https://www.superlogical.com/rex/docs/reference/mac-settings | `rex-llms-full.txt` §Mac Settings |
| Rex：Agents（skill/hook、`REX_SESSION`/`REX_BLOCK`） | https://www.superlogical.com/rex/docs/automate/agent-skill.md | `rex-automate-agent-skill.md` |
| Rex：self-documenting API 结构（含 7501 记录/移除字段） | 本机 server，api revision 11 | `rex-probe/inspect.json` |
| Rex：用户安装的 terminfo（旧条目，无 `Pst`） | `infocmp xterm-rex` | `rex-terminfo-xterm-rex.txt` |
| CC：终端配置（7501、标题字形、tmux、通知、`preferredNotifChannel`） | https://code.claude.com/docs/en/terminal-config.md | `cc-terminal-config.md` |
| CC：settings reference / env vars / hooks（通知计时） | `.../settings-reference.md`、`.../env-vars.md`、`.../hooks.md`、`.../fullscreen.md` | `cc-*.md` |
| Grok Build：内嵌文档（`[ui.notifications]`、7501、终端矩阵、tmux、标题项） | `grok-native` 字符串快照 | `grok-native.strings.txt`（第 30441–30510、38544、38825 行附近） |
| Grok Build：CLI 帮助/版本 | `/opt/homebrew/bin/grok --help` / `--version`（私有 `HOME`） | 本文 §1 |
| Ghostty：配置参考（`desktop-notifications`、`progress-style`、`notify-on-command-finish`、`title-report`） | https://ghostty.org/docs/config/reference | 本文 §4.2 |
| tmux：实测脚本 | 本地 | `research-rex-tmux-osc7501-probe.py`、`research-rex-osc7501-reply-probe.py` |

**证据边界**：Grok/Ghostty/Rex 的结论来自“打包文档 + 二进制/源码中的协议串 + 可复现的 pty/tmux 实验”。**静态字符串与 schema 只证明“该版本包含相应代码/线格式”，不证明运行时行为，也不证明 GUI 呈现**；Ghostty 的 GUI 呈现由源码中 `.program_status` 落在 unimplemented 分支佐证，但**没有实机验证**（父级尝试的自有窗口启动超时，未重试、未触碰用户输入）。本文不含反编译或实现代码复制，只转述行为与线格式。CC 全部为官方文档级结论，本机无对应版本可实测（文档要求 ≥2.1.295）。在实现层面，所有能力判断都走运行时 `OSC 7501 ; ?` 协商，**不依赖品牌或静态证据**。