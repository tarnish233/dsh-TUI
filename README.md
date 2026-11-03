# DSH TUI（体验版）

这是 **DeepSeek Harness 的终端前端**。Agent、模型、认证、配置、工具、权限和会话归 DSH；Pi TUI 只提供终端/输入组件，CC 只作为交互体验参考。版本 `0.1.0`，不是 Pi Agent 或 CC 后端。

## 直接体验

使用当前安装的 DSH 原生配置。需要 Node >=22.19；实际验收版本线为 DSH `0.2.1-rc.5`。本机已将 `dsh-tui` 软链到本项目入口；项目目录移动后需要重新建链接。

首次 clone 或更新 vendored TUI 后执行 `pnpm install --ignore-scripts && pnpm build:pi-tui`；之后直接运行。

```bash
cd /Users/fulei/workspace/dsh-tui

# 本机已移除旧全局 dsh-TUI；dsh-tui 软链到本项目
# 采用 DSH 原生默认配置
dsh-tui

# 复用 DSH 原生 profile 的 provider / 默认模型 / 凭据
dsh-tui --profile your-profile

# 从该 profile 的原生目录选择模型；不读取 Pi 模型或认证文件
dsh-tui --profile dsh-tui --model cloudagent/deepseek-v4.1-flash-1017

# 同一 DSH 后端，全屏固定输入区
dsh-tui --fullscreen --profile your-profile

# 离线界面演示，零模型调用
dsh-tui --demo --fullscreen
```

**模型和凭据必须在 DSH 中配置。** TUI 直接消费运行时原生目录；不会从 `~/.pi/agent/models.json` 或 `auth.json` 导入、拆分 provider、迁移密钥或提供另一套模型配置。原 `--models-file` 路径已撤销，旧导入环境变量不再触发读取。

CloudAgent / OpenCode Go 是否可选，以当前 DSH profile 实际声明和认证的路由为准。已经原生配置好时，可直接传对应 `--model`，或者按 `Alt+P` / `/model` 选择；未配置时不会悄悄借用 Pi 凭据。`--profile dsh-tui` 可复用已有 profile 的 CloudAgent / OpenCode Go 配置；如果该 profile 的 patch 还插入旧 TUI，本应用只会在私有 overlay 中禁用那一行，不修改你的 patch。配置接缝与原生路由说明见 [模型说明](docs/PROVIDERS.md)。

从其他项目启动：

```bash
cd /path/to/your/project
/Users/fulei/workspace/dsh-tui/bin/dsh-tui.mjs --profile your-profile
```

`bin/dsh-pi-tui.mjs` 保留为旧源码入口别名，不再代表 Pi 模型导入。TUI 键位/显示偏好的原配置目录保持兼容，避免丢失已有设置。

`--demo` 始终标注 DEMO，不会在真实连接失败时自动启用。直接运行 `dsh-tui --demo --fullscreen` 会自动展示 `tools` 场景：安全 `bash(pwd)` terminal 卡、输出和 exit code，以及 `edit` diff；也可输入 `tools` 重放。普通文字展示 Markdown / diff；`question`、`approval`、`abort` / `fail` 展示问卷、审批、中断与失败。

## 原生 DSH 边界

Pi TUI 是选择性复用的输入/渲染底座，不是业务逻辑的权威，也没有引入 Pi AgentSession。

- `/compact`、`/permission`、`/plan`、`/goal`、`/feedback` 等业务命令调用 DSH 原生命令注册表，保留校验、结果与 `command/run` / `command/done` 审计；不维护另一套压缩/权限/计划逻辑。
- `/preset` 使用 DSH 原生 `agentPresets` 名册；`/effort` 使用当前 provider/model 的 `resolveModelInfo().reasoning`。新会话按空白会话规则挂载 preset，已开始的会话只把选择留到下一次 `/new`；effort 只作用于当前会话的下一次请求。
- 实时/持久流通过 DSH 公开 `BlockAssembler`、assistant-stream 与 surface helpers 解码，不再维护生产镜像。
- 工具卡优先消费原生 `presentCall/presentResult`；模型提出调用不等于已执行，没有结果不冒充成功/失败。
- 保留原生 `surfaceOp/sourceEventSeqs`：模型上下文的裁剪副本不会覆盖人类历史。
- 审批/问卷按请求 ID 排队；同会话重新附着也会重置旧 Agent 的流式生命周期。
- 原生 SDK 未覆盖的实时事件/取消面仍用薄 IPC；仅保留必要的终端/进程隔离，不承担 provider、认证或配置规则。

## 当前支持

- CC 风格主输入、工具卡、Markdown、中文 / emoji、折叠工具输出与思考显示。
- 用户消息使用 DSH mist-blue 背景带，启动标题与交互强调使用 DSH 主题蓝色。
- Ctrl+P/N 的视觉行 / 历史边界；Ctrl+A/E/B/F；词移动与删除；Ctrl+W 的空白边界；kill/yank/yank-pop、undo、原子大段粘贴。
- Ctrl+R 反向历史搜索、草稿暂存、清空草稿找回、外部编辑器、Unix 挂起恢复。
- 独立且可热更新的编辑 / 列表 / 对话框键位；不会让 Pi 的模型切换抢 Ctrl+P。
- 真正订阅 DSH `agent/assistant-stream` 与持久 `session/event`，不把已提交记录假装实时流。
- 中断、排队 / steering、排队文本取回、会话新建 / 恢复、模型选择、原生权限预设、基础审批与问卷。
- 模型目录、provider 参数、认证、能力与默认路由全部由原生 DSH 提供；TUI 只选择和展示，不维护目录或导入算法。
- 两种 Pi renderer；stdout/stderr 都不承载后端控制协议，后端使用独立 fd3 管道。
- 原生 DSH home/profile 配置复用，不覆盖任何用户已有 profile；启动与模块解析由 DSH 负责。

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
| Ctrl+R | 历史搜索；主屏 Tab/Esc 放回编辑，Enter 发送，Ctrl+C 取消 |
| Ctrl+S | 暂存 / 恢复完整草稿 |
| Ctrl+C | 工作中中断；空闲清草稿；空输入重复确认退出 |
| Esc | 关闭当前层 / 中断；空闲非空草稿双 Esc 清空 |
| Ctrl+D | 有文本删字符，空输入重复确认退出；空 Delete 不退出 |
| Ctrl+L | 重绘，保留草稿和会话 |
| Ctrl+G / Ctrl+X Ctrl+E | 外部编辑器（VISUAL / EDITOR / nano） |
| Ctrl+O | 工具输出折叠 / 展开 |
| Alt+P | 模型选择 |
| Shift+Tab | 循环 DSH 暴露的权限预设（执行原生 `/permission`，不切换 plan） |
| Ctrl+Enter / Ctrl+X Ctrl+S | DSH steering；具体生效边界由 DSH 决定 |
| Ctrl+X Enter | 明确排队 |
| Ctrl+Z | Unix 挂起，`fg` 恢复 |
| Ctrl+V | 原生剪贴板文本；图片发送尚未接入 |

macOS Option/Alt 快捷键需要终端发送 Meta。传统终端无法区分的控制字节会标记诊断，不伪造支持。

## 命令与配置

`/help`、`/settings`、`/model [provider/model]`、`/effort [id|status]`、`/preset [id|status]`、`/resume [id]`、`/new`、`/reload`、`/exit` 属于界面或原生控制服务。快捷键入口已收进 Settings，不再单独暴露 `/hotkeys`。

`/preset` 打开原生 Agent preset 名册；空白会话可原地切换，已开始的会话会提示选择已保留给下一次 `/new`。`/effort` 打开当前模型的推理等级选择器，`default` 清除显式等级并回到模型/适配器默认；底栏显示当前 preset 和显式 effort。

`/compact`、`/permission [preset]`、`/plan [off]`、`/goal`、`/feedback` 等以当前 DSH 注册表为准；`/help` / 补全动态读取原生描述，业务命令原样转交 DSH。Esc / Ctrl+C 会把取消信号传给正在运行的原生命令。

- **权限与计划分开**：本机 DSH `0.2.1-rc.5` 的 base 组合原生提供 `/plan`，它是规划引导/评审流程，不是权限预设，也不强制禁用工具。`/permission` 控制沙箱与审批；没有额外的 `/mode` 包装或伪造的 Plan 权限选项。
- **快捷键设置**：`/settings` → **Keyboard shortcuts**。按导航、编辑、应用、补全、列表/对话框、历史搜索分组显示当前“按键 → 用途”，包括未绑定项；不显示动作 ID/兼容状态列。选中后 Enter 修改，`d` 禁用，`r` 恢复该项默认，Esc 返回。编辑框每行一个可选绑定，空格组成 chord（如 `ctrl+x ctrl+e`），Shift+Enter 增加一行；Enter 保存并立即生效。复用同一个 CC keymap 的解析与诊断，不自动抢占其他绑定，不增加 profile/覆盖层级。
- **`/reload` 热更新**：重新读取 TUI `settings.json` / `keybindings.json`，把真实 profile/home patch 同步到私有 runtime，然后调用 DSH 原生 HMR 重载配置与插件。当前 Agent、会话、transcript、草稿和缓存不重建；模型回合或原生命令运行中、或有待处理 DSH 决策时会拒绝。
- **/reload 的边界**：`screen`、profile bundle/package 迁移、凭据文件变化和 TUI 核心源码变化仍需要重启；HMR 会报告 `restartReason` / pending modules。Pi 式 TUI 扩展热插拔暂未纳入。
- **正常流式没有 attempt 占位行**：正文直接增长，Working 状态（实时输出 token、耗时与速率）和取消提示嵌入编辑框上边框；流式/持久去重仍在内部。只有确实未完成或未确认的响应才显示相应提示。

```bash
./bin/dsh-pi-tui.mjs -c --model deepseek-account/deepseek-flash
./bin/dsh-pi-tui.mjs -r <session-id> --model deepseek-account/deepseek-flash
./bin/dsh-pi-tui.mjs --dsh /opt/homebrew/bin/dsh --dsh-home /path/to/data-home
```

TUI 偏好/键位默认在 `~/.config/dsh-pi-tui/`，可用 `--config-dir`、`DSH_PI_TUI_CONFIG_DIR` 或 XDG_CONFIG_HOME 隔离。这些仅是 TUI 偏好，不读取 Pi / CC 配置；模型、认证和业务配置使用 DSH 原生目录与 profile。

`keybindings.json` 使用动作 → 键，可多键 / `null` / 空数组禁用。例如：

```json
{
  "editor.move.line-up": ["up", "ctrl+p"],
  "editor.move.line-down": ["down", "ctrl+n"],
  "editor.kill.whitespace-backward": "ctrl+w",
  "editor.kill.word-backward": ["alt+backspace", "ctrl+backspace"],
  "list.next": ["down", "ctrl+n", "j"],
  "app.model.select": "alt+p",
  "app.thinking.toggle": "alt+t"
}
```

最后一项只是显示 / 隐藏思考，不改变模型的 reasoning effort；真正的推理强度用 `/effort`（DSH 模型目录），不是 CC 的 extended-thinking 开关。当前快捷键可在 `/settings` → Keyboard shortcuts 中查看和修改；完整动作 / 兼容说明见 [输入说明](docs/INPUT.md)。配置错误会显示，不能静默覆盖坏文件。

## 已知边界

- 首版仍有 CC 差异，不宣称 GNU Readline 所有命令完整实现。redo、quoted insert、数字参数、case conversion 等未接入；具体未核验项见输入文档。
- 取回多条排队文本会合并到草稿，不是 CC 的逐条选择器。注入上下文与带附件的排队消息不会被取回操作删除。
- 子 Agent 面板、todo/goal 面板、fork/rewind、图片发送 / 预览尚未做；Ctrl+T 会明确提示，而不是变成 transpose。
- Pi 式 TUI 扩展热插拔（extensions 发现、卸载/重载）暂列为 TODO；当前 `/reload` 只重载内置 TUI 资源与 DSH 配置/插件。
- DSH steering、权限模式与工具安全语义由 DSH 保有，不假装等同 CC 后端。
- 历史恢复有事件数 / UTF-8 字节预算，截断会提示；完整持久日志仍在 DSH 数据 home。`--continue` 当前表示最新创建的会话，不伪造最后活动时间。
- 当前仅锁定验收 DSH `0.2.1-rc.5`。私有 profile 中通过 DSH settings 写入的配置不会永久修改用户命名 profile；home 隔离仍需要最小 link glue。
- 模型能力、上下文、推理级别与网关参数以 DSH 原生配置/目录为准；TUI 不根据其它应用的配置推断，也不另存一份模型定义。
- 主屏在 resize 或视口上方必须更新时可能全量重绘；全屏可避开原生 scrollback 的这一限制。不要把任何 TUI 写入同一终端的普通日志。
- 已做 ANSI 仿真和真实 PTY 验收，但 Rex 的实际输入法 / 字体 / GPU 手感仍需你亲手试。

## 验证与开发

```bash
pnpm install --ignore-scripts
pnpm check
python3 scripts/pty-smoke.py

# 明确 opt-in，使用你已在 DSH 原生配置好的 profile/home 发一个很小的 prompt
DSH_TUI_LIVE=1 DSH_TUI_LIVE_PROFILE=<name> node scripts/live-smoke.ts

# 明确 opt-in，验证已配置路由的 Messages/Responses/Chat Completions 持续显示
DSH_TUI_LIVE=1 DSH_TUI_LIVE_PROFILE=<name> \
  DSH_TUI_LIVE_MODELS=provider/model node scripts/live-providers-smoke.ts
```

最新 `pnpm check`：210 tests / 210 pass。vendored TUI 下原生 `dsh-tui` profile 实网复测获得 215 个文本 chunk、结束前 153 个不同正文画面；单条 smoke 返回 `dsh-tui-ok`。验收包含 Settings 内快捷键分组展示、修改/禁用/还原、冲突与坏文件保护、原草稿/paste 状态保留、原生 preset 切换/空白会话锁定、effort 目录与选择、working token/速率投影、/reload 的 TUI/DSH 配置热更新，以及原生命令参数/审计/取消/超时、真实文件读取/presenter/裁剪与恢复、同会话重附着、并发审批 ID 隔离、生成结束前上屏与最终去重。两种实际 CLI PTY 都验证了设置中修改键位、返回后继续发送、缩放和终端恢复。常规测试使用离线 `llm/stream` fixture 和原生 provider / loopback SSE，不使用真实凭据或远程模型。

Pi TUI 1.5.0 源码 vendored 在 `vendor/pi-tui/`，由 `pnpm build:pi-tui` 编译；CC Editor/SelectList 入口位于 `src/input/pi-tui-seam.js`，不再使用 pnpm patch，也不改全局 Pi。模型/provider 仍只来自 DSH。

- [总体方案](docs/PROPOSAL.zh-CN.md)
- [输入 API 与限制](docs/INPUT-API.md)
- [DSH 后端与协议](docs/BACKEND.md)
- [原生模型/profile 配置](docs/PROVIDERS.md)
- [验收记录](docs/ACCEPTANCE.md)

MIT；来源和许可见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。
