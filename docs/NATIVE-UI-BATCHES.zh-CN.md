# 原生 UI 两批功能、Todo 固定区与共享配色

基于当前未提交的 `0.1.4/private` 工作树、DSH `0.2.2-rc.1`。两批并行开发；父级负责共享契约、App／原生宿主集成及最终验收。版本、依赖、旧 tag 和真实用户配置不变。

## 第一批：原生能力的用户入口

| 能力 | 入口／实现 | 原生所有权 |
| --- | --- | --- |
| Jobs | `/jobs` 和 Settings 的只读任务列表；按 id 查看 stdout/stderr、终态、丢失／截断提示，Ctrl+L 显式刷新 | `jobs.list/get/readAt/events.subscribe`。不调用消费式 `read`，不增加任务 supervisor／轮询／自动 kill |
| Goal | 编辑器上方有限高度的目标／phase／rounds／activation 展示 | `goals.get` 和公开 `goal` snapshot。创建、编辑、恢复仍走原生 `/goal`，没有新目标循环或 `/mode` |
| 显式标题 | `/rename [title]`／Settings 的标题项；无参数时复用已有文本问卷 | `sessionTitle.rename` 的已规范化标题、user source 与 seq。显式动作才物化 pending root，不创建标题生成器 |
| 安全默认设置 | 现有 Settings 中 Default agent preset／Default permission preset；原生选项、确认、revision conflict 可见 | `settings.describe({redactSecrets:true})`＋`mutate` 一个 allowlisted path；namespace 来自公开 Loader，不写文件／通用表单／凭据 |
| 能力摘要 | `/inspect`／Settings；插件 entry/module/enabled/phase、当前 Agent tools 的只读摘要 | `readPluginInventory`、`tools.definitions/executable(exactAgent)`；不显示 schema、config、secret、condition 或原始异常 |

菜单只按实际 mounted capability 开放。已读到的同名原生命令优先，Settings 的直接只读入口仍可使用。首次打开只读面板不创建 Agent。失败／不完整／未读取／真正为空是不同状态。

## 第二批：交互补齐

| 能力 | 最终实现 |
| --- | --- |
| 原生命令图片 | 按原生 `input.attachments` 把 encoded images 交给 `commands.execute`，原生执行器负责准入和拒绝；不套模型 vision 或本地权限规则。拒绝保留完整草稿 |
| 一般文件输入 | `/attach [local-path]`，无参数时复用已有路径文本字段。显式读一个 regular local file，交给原生 `attachments.admitEncodedFile`／`saveFile`，Editor 仅持有 `FileAttachmentRef` |
| 延迟问答 | `/questions`／Settings；读 `userQuestions`＋`inbox` 一次 public snapshot，`continued` 且未 queued 的 call 使用原生 `userQuestions.answer`；不走 blocking `respond` |
| 有效目录 | footer 单独标注 native effective cwd；workspace/header 和 OSC7 保持原语义，不自动 set 目录 |
| 显式 root fork | `/fork` 确认当前 durable boundary；完整 public `Session.snapshotEvents()`＋native `buildForkSeed`＋`agents.create`／preset setup，再切换到可继续输入的 native root |

### 文件输入和队列

- 同进程 prompt file 是 `{type:'file', attachment:FileAttachmentRef}`，**不是** Web 的 `{receiptId}`。Dsh store 返回身份／name／bytes，TUI 不造 id、仓库或 receipt。
- `/attach` 不运行 shell／glob，不把普通路径／剪贴板文字自动上传；相对路径属于本地 frontend workspace，不假设等于 native sandbox/effective cwd。Ctrl+V 继续沿用图片／文本语义。
- 单次本地读取有 **32 MiB frontend transfer-memory budget**，不是 DSH 的文件大小／权限规则；空文件合法。native provider 不支持 verbatim storage 时明确 unavailable。
- `[File #N]` 与 `[Image #N]` 是同一 Editor 内的两种原子 marker。undo、kill/yank、history、stash、external editor、snapshot 和 high-water ids 一起保留；无 payload 的手打 marker 不会被以后 attach 错绑。
- 所有提交入口，包括直接 `ccSubmit()`，走同一个 capture／multipart consumer；不得把 marker 当普通文字发送。
- queue 的 file refs 已 durable，取回即 ready，不调用 `readImage` 或重新读取 bytes。修改排队文本保留原生 non-text 顺序／refs，文件-only row 显示 file count 而非 `(empty)`。
- 图片准入失败、命令 settled error、旧 attachment 或竞争草稿都不会静默退化为 text-only，也不自动重发。

### Fork 不是给 `SessionStore.fork` 结果直接接 Agent

原生 `SessionStore.fork` 只产生 session-only artifact；它占用 live store id 但没有 Agent／持久日志，直接 create/resume 会碰到 id collision／not-found。交互式路径复用原生控制器实际采用的公开 seed＋Agent create，不先调用 session-only fork，不手抄 seed／header fold／persistence，也不从截断 transcript tail 构建。

原始日志不改写。只切到用户确认的 root，不把 child 独立恢复，不引入 newest-session auto-selection；新 root 的 logged model／permission／preset 事实仍由 DSH 解释。

## Todo 与配色

- Todo 放入固定 bottom stack，不进入 transcript scroll host；native replacement／clear 原位更新，完整托盘最多五项，与 Goal/Subagent 共用动态高度池，保留唯一 Editor。后续共存修复使一行预算显示 native counts／首个未完成项，已结束 child 不再占预留高度；短屏先收缩明细，在可用空间内保留 Todo → Goal → Subagent 三行摘要。详见 [共存规则与负向对照](TODO-UX.md#todogoalsubagent-共存)。
- Ctrl+T show/hide，不再往历史追加摘要。空／全部完成时安静收起；隐藏后的更新不自动展开；root/attachment 更换清空旧事实。
- CC 官方状态区／显隐／五项约定已对照；精确当前版本 glyph／默认展开未现场核验。全部完成收起来自版本注明的公开观察。详见 [Todo 调研](TODO-UX.md)。
- 原来的 modal 私有 `bg('#111113')` 是黑板原因。现在 `surfaces.canvas/dialog/overlay` 继承终端背景；raised/selected 派生自统一 palette，brand／semantic／syntax 色不混在一层。
- 统一 `Surface.fill/style` 处理 display-column clipping／padding，以及 full reset／background close／组合 SGR 的嵌套；不把零 RGB channel 当 reset，不丢 caller foreground close。truecolor／256-color 使用同一语义角色。
- 不改变终端主题，不加主题配置层级或 debug panel；静态 `🐳`、Rex `>_`、现有蓝色品牌和普通 Working animation 保持。详见 [Theme](THEME.md)。

## 验收发现并补修的跨层问题

1. 生产 App 同时安装 plain／multipart consumers，直接 `ccSubmit()` 曾绕过 capture，文件被发送为 `[File #1]` 文字。输入层新增统一 direct-submit 入口；双 consumer、image/file/mixed／无 consumer／unresolved／undo 回归补齐。
2. 原生 volatile form 的 `plainSchema` **移除** `meta.volatile`，且默认字段常常 unset。adapter 改证明字段属于公开 describe 的 projected form，native `mutate/isVolatilePath` 仍最终决定合法性；保留 namespace、allowlist、revision 与非-schema／decoy 拒绝。
3. Help 的 body 在 frame body width 换行，scroll/status 却用 frame width，长命令名册使最后的 Skill 看不到而 footer 声称到尾。三处统一使用实际 body geometry；原始 native Skills 两 renderer 重新验证。
4. App queue DTO 与两个 queue views 补齐 file counts，file-only 不再被误标为空；byte/reference 所有权仍归 DSH。

## 永久 composition／SDK 边界

- 当前 composition **没有** native file-upload receipt owner，原生命令文件输入保持 unavailable；不自动装 Web connection plane，不 fake UUID／resolver。普通文件 prompt 与命令图片均可用。
- 默认 ask-user tool 为 legacy blocking；continued UI 消费原生 timed profile／replay 的事实，不自动把工具改成 timed。不存在 native continued cancel API，关闭只关闭 UI；foreground `attachWait` 不被这个补充入口抢占。
- 缺 actual Agent 时，scoped tools／Goal／effective cwd 暂不可读；面板／metadata 不为了读取创建 Agent。
- public `readPluginInventory` 等无 signal 的读取只能限时放弃 UI request，不能声称停止原生 I/O。native root 生命周期与 deadline 仍归 DSH。
- 以前的 native listing row/depth 参数、runtime preset direct registration 无专门通知等边界保持，不造 polling／registry／遍历器。

## 验收证据

- 两批功能完成时完整 `pnpm check` **2170/2170**，174 测试文件；build＋strict TypeScript，0 fail/cancel/skip/todo，tests **442677ms**。`.cache/native-ui-expansion/full-check-third.log`。前两轮失败的真实 Help 漏行／旧 fixture 预期／时钟测试波动已逐项修复，原始日志保留。
- 父级原生 **10 cases**：两 renderer × 四组两批能力（jobs/Goal/cwd/inventory、safe defaults/conflict、rename/promptable fork/resume、file-only/cold recovery/native command image admission/refusal）共 8；加两 renderer 原生 continued projection/inbox/answer 共 2。精确分组与全量计数见 [ACCEPTANCE](ACCEPTANCE.md)。
- 新 PTY：生产 App／input／renderer 配 explicit fixture-only backend，两 renderer 验证 fixed Todo、Ctrl+T、update、resize、Settings canvas、file multipart、terminal restore；不是 GUI／native API 冒名验收。
- 修复前 Todo 主屏／全屏长历史不可见的 negative control，native full-check 首轮失败、fixture corrections 和最终回归均保留在 `.cache/native-ui-expansion/`。
- 后续 Todo／Goal／Subagent 共存复现与回归位于 `.cache/task-dock-coexist/`：112 组布局的 Todo child-start 消失数由 8 降到 0；新增 App 可见性断言与双模式 PTY 补上原总高度测试的缺口。最新完整 source/build／strict TypeScript／全量结果见 `ACCEPTANCE.md`；本节 2170 和以前的 1761／1833／1861／1910 均为各阶段的独立验收。

没有真实 Provider 请求、真实配置／凭据／会话读写、服务器操作、全局 executable replacement、提交／新 tag／推送或发布。只读外部 SDK／MIT UI 参考，所有 native 写入和 fixture streams 都在测试拥有的临时 homes/workspaces。
