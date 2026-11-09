# 离线交互 Demo

## Todo／Goal／Subagent 任务区

在项目目录运行：

```bash
pnpm build
pnpm demo tasks
# 主屏／原生终端 scrollback：
pnpm demo --inline tasks
```

已有本地 `dsh-tui` 入口也可直接用 `dsh-tui --demo tasks`，或 `dsh-tui --demo --inline tasks`。不改变裸 `--demo` 原有 tools 默认场景。

启动后的有限流式说明结束，根会话即回到 ready；Todo／Goal／多个 Subagent 的离线数据留在固定区，便于慢慢输入、缩放和查看。不会自动播放到所有内容消失。

```text
● Activities: 1 tool · 1 update
├ ✓ List Agents children
└ ⏺ Subtask status updated · 已结束的示例 child

⏺ Task message received · 已结束的示例 child
  ⎿ DEMO CHILD MESSAGE · 这条消息保持独立可见

Todos · 完成数/总数 · Ctrl+T hide
  未完成步骤…

Goal · active · rounds…
  演示目标…

Agents · 3 个活动 child
  名字、状态、当前活动…
──────────────────────────────
❯ 在同一个编辑器里输入
```

启动即可看到“1 工具＋1 纯状态通知”的混合组，以及一条独立的 relay 消息作对照。Ctrl+O 展开 `DEMO STATUS NOTICE BODY` 原文，再按收起；`DEMO CHILD MESSAGE` 不跟着被隐藏。工具／通知／消息全是明确的 fixture，不表示真实工具或 Agent 执行。

完整清单至少六项，用于展示最多五项及溢出；三个活动 child 使用既有离线快照／Stop／Reply 接缝，另一个已结束的本地 fixture 作为通知 sender，避免把运行中的 child 假称为已结束。小屏先收缩明细，再保留紧凑行；宽裕时区域间统一留白。使用生产 App 的共享编排，不是专门的 demo renderer。屏幕较小时可放大到约 100×36，或向上查看示例活动组。

### 在输入框提交这些文字

| 输入 | 演示效果 |
| --- | --- |
| `tasks` | 重新开始任务区演示 |
| `tasks next` | 推进一个有限阶段：Todo 原位更新、Goal 轮数变化、部分 child 结算／活动变化 |
| `tasks done` | Todo 6/6，child 为原生 `completed` 并退场；Goal 保留原生 `complete` 状态 |
| `tasks clear` | 清空三个任务区投影 |
| `tasks history` | 添加有上限的离线历史，不推进当前任务状态；用于验证固定位置 |

这些是显式离线 prompt trigger，不是注册到 DSH 的 `/tasks` 命令。一般文字或其他 `/...` 不会因为包含 task 字样就触发这个场景。

### 交互检查

- Ctrl+T 隐藏／显示 Todo；隐藏后 `tasks next` 不自动展开。
- Ctrl+J 输入多行，缩到约 80×16／40×18 再放大，观察三者共存及草稿保持。
- `/agent` 或 Ctrl+X Ctrl+A 打开既有 Agents 目录；名字可进入离线 child 快照。所有内容都是 fixture。
- `/settings` 查看同一共享颜色的设置页，Esc 返回同一个编辑器。
- `/exit` 正常退出并恢复终端。

## 隔离与边界

Demo 只在显式 `--demo` 时构造 `DemoBackend`。不加载 native DSH、不读取 DSH profile／credentials、不调用模型、不运行列表中的真实工具，也不把失败的真实连接切成 demo。Goal／Todo／child 的状态与统计均为确定性的演示数据，不表示项目里的任务实际执行过。

默认仍使用已有 TUI 偏好目录。若连终端偏好和日志也希望隔离，可以用：

```bash
demo_dir=$(mktemp -d)
pnpm demo --config-dir "$demo_dir/config" --cwd "$demo_dir" tasks
```

不建立新的主题／快捷键／profile 层级。没有新的自动播放计时器、Agent、调度器或模型 transport；有限说明流复用现有 demo pause/cancel/close 管理，任务状态由上述显式输入推进。

## 其他既有场景

`tools`、`tools-group`、`images`、`skills`、`subagent`、`subagent-many` 保持原来的显式离线行为。运行说明与范围见 [README](../README.md)，最终回归见 [ACCEPTANCE](ACCEPTANCE.md)。

## 新增展示样例验收

最新 fixture 补齐了初始混合活动组、独立 relay、已结束且可查看的 sender，并让 repeated tasks 使用 turn-scoped id。最终 build／strict TypeScript＋专项 **139/139**，包括实际 public CLI 的 inline／fullscreen 展示对照。日志 `.cache/demo-presentation/final-scoped.log`。本次没有复跑整仓；此前展示层完整 **2265/2265** 是独立历史门禁，不把新增样例专项冒称 full check。

## 初版 Demo 验收（历史）

完整 `pnpm check` **2208/2208**，179 测试文件；新增 Demo 9/9、生产 App 6/6，以及实际 public CLI 入口的 inline／fullscreen PTY。测试使用临时 home／workspace／TUI config，并给不可执行的 native DSH 路径验证离线入口。没有真实模型、工具、profile／credentials 读写或全局安装替换。日志与 ANSI 在 `.cache/demo-tasks/`。
