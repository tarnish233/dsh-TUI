# 展示层整体收敛：固定区编排与混合活动组

用户确认范围：固定区布局与活动分组一起改；不是给 Goal 临时加空行，也不是把 Subtask 通知伪装成工具。DSH 的业务、原生事件／顺序／持久化仍为权威。

## 一、内容与编排分离

- **内容块**：TodoBoard、GoalProgress、SubagentProgress、ToolBlock、SubagentMessageBlock 只根据已有原生事实绘制内容，不负责跨区域布局或更改业务状态。
- **固定区编排**：StatusDockStack 统一可见性、固定顺序、总预算、紧凑态、间距与实际鼠标行区间。
- **对话编排**：原工具分组、纯 Subagent 记录分组和新的混合活动分组都是对原 store.items 的只读投影，复用真实成员块与共享 disclosure／cache。
- **表面与终端**：继续使用现有 semantic palette、surfaces、宽度工具和 Pi TUI renderer；不另建主题、输入、终端输出或业务运行时。

## 二、固定区只由一个容器分配

```text
Todo 内容
[统一间距]
Goal 内容
[统一间距]
Agents 内容
──────────────────
❯ 唯一编辑器
```

`src/ui/status-dock-stack.ts` 的 StatusDockStack 接收三个实际组件、一个动态 maxRows 总预算（包含间距）和既有 Agents enable flag。内容上限为 Todo 6 行（标题＋最多五项）、Goal 3 行、Agents 8 行；生产父级总池最多 15 行。

- 实际可见区域先获得一个紧凑行；不足时按固定顺序保护 Todo，不虚增终端高度。
- 内容优先：在所有可见区域能保留 comfortable 内容之前，不购买空白。Todo 至少标题＋一项，Goal 有目标时保留目标，Agents 保留第一条名字。
- 间距 **all-or-none**：有余量时每两个可见区域之间都留一行，否则全部零间距。不会只在 Todo／Goal 之间空一行而 Goal／Agents 紧贴。
- 最后一个区域后没有尾部空行，Editor border 已负责分隔。空／隐藏／完成 Todo、无 Goal、settled-only／关闭 Agents 不占高度，也不留下占位空白。
- 三个组件提供纯 preferredRows／comfortableRows／compactRows，不再通过反复调用 render() 来测高。每帧先计划，后分别绘制一次，避免测量搅动 live hitbox／hover／gesture。
- Parent 只测量 editor／queue／hint／footer，并保留普通四行／短屏至少一行 transcript。删除原 App 的三套 per-component 预算回调。

Standalone Todo／Agents 的 trailingSeparator 默认保持兼容；生产 Root 显式传 false，所有跨面板间距由 Stack 管理。Stack 还会防御性去掉尾部空白。这个参数不是新的 settings／profile 层。

Stack.spans 只记录实际内容行，间距没有 hitbox。鼠标事件按当前 span 变换坐标并交给原组件；成员消失或按下期间起始位置变化会失效旧手势。成员生命周期仍归 Parent，Stack.dispose() 不代替成员释放。

## 三、相邻工具与纯状态通知共享展示组

```text
● Activities: 1 tool · 1 update · Ctrl+O expand
├ ✓ List Agents children
└ ⏺ Subtask status updated · 测试 agent
```

`src/ui/activity-group.ts` 只组合真实 tool／已有 tool-group 与纯 `subagent-settled` 通知，不生成工具调用／结果／id，不修改原事件、sender、seq、summary 或 text。

- 同时启用 groupTools 和 groupSubagentMessages 才形成混合组；任一关闭就恢复既有独立行为，没有第三个开关。
- 至少一个真实可分组工具＋一条纯通知。分类只读 native source.kind 和 source.form：`subagent-settled`＋`notice`，缺失／未知 form 保持独立，不猜标题或正文。
- Header 分开统计 tools 和 updates。真实 proposed／running／failed／unknown 工具状态保留；通知不贡献成功次数，也不会让整组冒充绿色成功。
- 纯工具继续交给 ToolGroupBlock，纯 Subagent 记录继续原 SubagentGroupBlock。
- 原生 agent-message、实际结果消息、目录行、用户输入、可见 assistant／thinking、todo／普通 notice、diff／写入工具及已知 turn 边界不被越过。只跨已有规则认定真正无显示内容的 assistant／attempt。
- Root suppressLiveTodos 仅抑制重复显示，原 todos 节点仍是分组边界。
- 展开时使用真实 ToolBlock／SubagentMessageBlock 原文；树形前缀的宽度与委派坐标一致，不复制 Tool I/O／Diff renderer。状态通知的 sender 只有已知且 openable 的名字可导航，未知／external 为普通文本。
- 复用共享 Ctrl+O、single-expand、viewport anchor 和临时 disclosure map；成员变化／组消失释放旧 context 与鼠标 pin，不新增计时器或持久状态。

“真正子任务消息保持边界”特指不混入这个 tools/status 组；原有纯 Subagent 分组偏好和行为保持不变。

## 四、验收边界

- Parent 的 actual native Session／codec before-control：合法 synthetic tool/result＋settlement notice 仍分别存在但展示未混合；修复后的同组两 renderer 验证 1 tool＋1 update、原文／source 完整、Ctrl+O、真实 agent-message 可见。没有宣称该 synthetic 工具或 child 实际执行。
- App 验证统一／紧凑间距、空／隐藏／settled 释放、两设置独立、单 Editor、多行／resize、store 中原生工具和通知计数不变。
- 真实 PTY 使用生产 App 配 explicit offline fixture。全屏验证实际 SGR mouse 经 Stack span 的坐标；legacy main-screen 仍是原生 scrollback／既有键盘导航，不冒充新 mouse 实现。
- PTY decoder 等待完整 DEC 2026 同步输出帧；不能把半次终端写入中 Editor／Goal 的临时空白当作完整画面。Resize 等待目标布局出现后再断言。
- 原两批功能、任务 Demo、输入、permissions／Plan、native default-follow、Subagent continuation／Stop／Reply 和退出恢复全量防回归由 Parent 完成。

最终 Parent 完整 `pnpm check` **2265/2265**，184 测试文件，0 fail/cancel/skip/todo，tests 492448ms。日志 `.cache/presentation-convergence/full-check-final.log`；组件／App／native／PTY 专项和 before-control 同目录保留。原工具／Subagent／输入／Demo／原生接入与退出回归同时通过。

全部开发限于本仓库；外部 SDK 与安装只读。测试使用 owned temporary homes/workspaces，零真实 Provider／用户 profile／credentials 操作；无提交、新 tag、推送、发布或全局替换。验收计数只采纳 Parent 自己的门禁；详见 [ACCEPTANCE](ACCEPTANCE.md)。
