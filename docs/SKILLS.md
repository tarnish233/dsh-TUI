# Skills：与 DSH 桌面端一致的原生目录与输入

本层只接入技能元数据发现和输入路由。注册、发现根、优先级、invocation policy、正文加载、注入、模型工具与持久化全部由 DSH 负责。核验版本为 `@deepseek-ai/dsh@0.2.2-rc.1`；Pi TUI 仅提供终端／输入。

## 使用

```text
/skill-studio 要完成的任务
```

示例名称必须是当前 DSH 已发现的用户可调用技能。输入 `/` 或名字前缀，例如 `/skill-stu`，即可补全；**Enter 接受当前选中项并立即提交完整 `/skill-studio`，不必先按 Tab**。Tab 只补入 `/name `，保留在草稿中。内容提交在接受候选之后、清空同一个 Editor 之前捕获 payload 与 snapshot，不能把旧的截断前缀送给 DSH；普通命令也遵循这一时序。候选有 `Skill` 或 `Skill (user-only)` 标识。没有 Pi `skill:` 别名，也不另造 `/skill`／`/skills` 管理命令。

同名界面／原生命令优先。技能也可以出现在普通句子中：

```text
请使用 /skill-studio 完成这个任务
```

DSH 原生 pre-step 扫描直接用户消息的空白分隔 `/name`，加载用户可调用技能的 canonical instructions。未知／用户禁用名称不伪造成技能执行；它们遵循原生普通文字语义。TUI 不读／拼接／缓存技能正文。

文字／图片、followup／steer／send-now 复用正常用户消息准入，错误保留完整草稿。child 回复仍是 child 普通消息，但不展示根目录来假冒 child 的技能范围。

## 启动即读目录，不创建 Agent

桌面端的人类目录查询与模型 `skill` 工具 schema 是否可见无关。TUI 按同一原生能力边界读取：

- **pending 新会话**：调用 `ctx.agentPresets.acquireScope(stagedPreset)`（未显式选择时交给原生默认），保留已经由 DSH 管理的 preset revision；以 `lease.key`／当前 cwd 读取原生 registry，finally 释放 lease。
- **live 会话**：优先 `agentPresets.serviceFor(agent,'skills')`，未提供时使用宿主 registry；scope 是当前 native Agent。
- 默认 preset、provider、作用域层、发现根仍由 DSH 决定。没有私有 Context／Loader、临时 provider、手工目录扫描、第二 Agent 或 profile 镜像。
- 没有 lease API 的小宿主只能读 global registry，明确标为不完整，不能假冒完整 preset 目录。
- `minimal` 等 preset 没有 provider 时自然返回空目录；不把“模型工具不可见”当作“人类技能不可用”。

首次真正提交 `/name` 后，原有 native Agent materialization 路径建立当前会话，并用 native command lookup 判定同名 scoped 命令。菜单读取不走创建路径，因此启动可补全，也仍没有空会话或模型调用的副作用。

## 元数据接缝

`src/backend/types.ts` 的中性契约：

```ts
interface SkillCatalogEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
}
interface SkillCatalogSnapshot {
  readonly entries: readonly SkillCatalogEntry[]
  readonly available: boolean
  readonly complete: boolean
}
interface InputRoute {
  readonly kind: 'command' | 'prompt'
  readonly sessionId: string
  readonly attachmentId?: string
}
```

- `command('skills')`：优先原生 `snapshot({cwd,scope,signal})`；只有 `list` 的 registry 也能列技能，但 `complete:false` 表示完整性未知。仅投影名字／描述／whenToUse／原生已 resolved invocation booleans，过滤 `userInvocable:false`。没有 path／locator／resourceBase／正文。
- live cwd 使用 `workingDirectory.ensure`，服务缺失才回落 session header／配置 cwd；pending cwd 是本层已校验的启动 cwd。
- `command('input-route',{name})` 只用于已提交的 native lower-kebab 名称，校验在 Agent 创建前。原生 `commands.find(agent,name)`／list 优先，命令查询失败不误送模型。没有命令且原生技能 registry 可读时返回普通 prompt；这不是对技能存在或正文执行的保证。
- `skills`／`input-route` capabilities 依赖可读的原生 metadata API，不依赖 `tools.get('skill')`。tool schema 只影响 DSH 模型工具／模型目录，不是人类目录门槛。
- `skills_changed` 是无载荷的原生失效，带当前 root session／attachment。pending provider 注册也能失效；commit 后 ready 之后补发需要的通知，避免首次注册事件被永久丢弃。
- 在途读取和迟到取得的 lease 受 pending 对象／preset id、live Agent 身份、attachment、reload、close 保护。late lease 仍会释放；close 不等待不响应的 provider 或 lease acquire，不中断模型 turn。

## 菜单、Help 与缓存

`/help` 始终包含只读 Skills 区：即使没有 capability，也明确显示 metadata unavailable，而不是整个区消失。只有 available＋complete＋空列表才说没有用户技能；未知／查询失败不被伪造成空目录。名字、描述与 whenToUse 清理终端控制字节并有界显示，Enter／数字／点击不执行或填草稿。

App 的单飞／dirty／revision 是显示缓存，不是技能注册表。unavailable／incomplete 留为可重试状态；下一次真正的菜单查询可以重取相同前缀，不能把首次不可用记成永久空目录。`NativeAutocompleteProvider` 只限制同时一个 refresh，不再永久缓存 query 字符串；新鲜缓存由 App 决定，不设轮询。

迟到 metadata 通过 `ccRefreshAutocomplete()` seam（内部使用 Pi 原生 `explicitTab:false` 请求）重读候选，不应用唯一项、不移动 cursor、不更改 undo／图片／草稿或提交。刷新意图绑定 input generation、原文、Editor、surface、attachment；Esc 或焦点转移后不能复活旧菜单。

UI-owned `/model`／`/effort`／`/settings` 等不经过额外技能 classification await，保持原有立即调用时序。文件／`@`／参数／forced completion 仍委托 Pi。

## 验收

- Backend：metadata whitelist／无 body get、原生 preset lease／scope/cwd／释放／无 create/send、隔离 registry／list-only、无工具门槛、坏元数据／错误脱敏／旧读与 late lease、命令优先／部分服务 fail-closed。
- Input／App／Help：同前缀失败后重试、单飞／无循环、user-only、Tab／Enter、undo／图片／草稿、Esc／preset／attachment／child scope、没有 capability 也显示 unavailable。
- `test/acceptance-skills-menu.test.ts`：真实 DSH 进程＋临时用户技能目录，**未发消息时**及普通首条消息后直接输入 `/skill-stu`，不经 Help 或手工 backend query 预热。菜单不创建 Agent／durable facts、不调用模型。
- `test/acceptance-skills-pty.test.ts`＋`scripts/pty-skills-native-smoke.py`：非 demo **生产插件与 ProcessTerminal／日志 lease**，临时 native profile／HOME 内 6 个合成原生技能，两模式验证启动菜单、普通消息后的同前缀菜单、**不先 Tab 的单次 Enter 提交完整名字并由原生注入正文**、Tab 仍只填草稿、Help 和退出恢复。模型流使用 hermetic fixture，不请求真实 provider。
- 原有 `test/acceptance-skills.test.ts` 继续证明原文／canonical body 注入一次、user-only 策略、原生失效与首条 scoped 命令优先。`test/acceptance-skills-menu.test.ts` 另外覆盖单次 Enter 的内容提交通道与 native `/plan` 执行；不是仅验证 text-only `onSubmit` 回调。

早前“必须先有 Agent，或必须可见 skill 工具才有目录”的实现与桌面端不一致，已撤回。当前数字见 [ACCEPTANCE](ACCEPTANCE.md)。没有读／改真实技能正文、profile／凭据／会话或全局安装；用户目录只做过文件名／数量的只读核对。未提交／推送／发布。
