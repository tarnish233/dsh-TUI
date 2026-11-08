# Tools 展示与详情

本层只展示 DSH 的工具事实。分组、折叠、预览和键位参考实际安装的
`pi-cc-extensions 1.0.14`；不导入 Pi AgentSession、组件原型补丁或 Write
执行覆盖。模型、工具执行、权限、取消、持久会话和输出裁剪仍由 DSH 管理。

## 展示层次

### 连续工具组

```text
● Bash: 2 done · click to show more
├ ✓ Bash npm test · 2.1s
└ ✓ Bash git status · 217ms
```

- 至少两个相邻工具组成显示组；同名显示工具标题，混合组显示
  `Multiple Tools` 和名称计数。
- 只按当前 transcript 的声明顺序，不按完成时间重排、不宣称并行执行。
- 用户消息、正文、Thinking（包括隐藏占位）、notice、todo 与 Diff 卡断开组。
  完全不绘制的 assistant/attempt 可以跨过；已知不同 turn 必须断开。
- `edit` / `write` / `apply_patch` 以及携带原生 Diff 的工具保留独立卡片。
- 折叠组每调用一行，不设虚构的“最大预览工具数”；展开后显示真实子卡。
- `proposed / running / done / error / unknown` 分开统计。没有结果的历史卡不会
  永远显示 Running。`done` 表示 DSH 无失败标记地结算，Bash 非零退出码仍应
  从原生输出/详情查看，不能把它等同于命令 exit 0。

### 原位展开

普通工具展开为 Input / Output，两段各有独立的折行预算：

```text
├ Input
│ command: ...
│ … 8 more lines · click to show details
│
└ Output
  ...
  … 20 more lines · click to show details
```

fullscreen：标题点击展开/收起；展开正文单击收起，拖动仍是原生选字。
组内普通正文收起整个组，而 Input/Output 的详情提示打开对应段，不收起组。
折叠成员行是普通文本，不冒充单次详情入口。

鼠标展开采用工具内部的 single-expand：打开一个工具/组会关掉其他工具/组，
不会隐式关闭 Thinking。`Ctrl+O` 则是全局工具展开开关，清掉所有本地覆盖。

## 详情 Inspector

两种 renderer 共用共享 `ModalFrame` 与公共 `TUI.showOverlay`（wide），不另起编辑器。标题为
`Tools`，副标题保留当前调用／总数；body 先按实测尺寸布局，再绘制调用栏、Input/Output、图片 chip 与正文窗口。

| 默认键 | 行为 |
| --- | --- |
| Ctrl+X Ctrl+O | 打开当前会话的工具 Inspector，初始定位最后一项 |
| [ / ]、Alt+Left / Alt+Right | 前一个 / 后一个调用；边界不循环 |
| Tab / Shift+Tab、Right / Left | Input / Output 切换 |
| Up / Down、Ctrl+P / Ctrl+N | 滚动当前段 |
| PageUp / PageDown、Home / End | 分页、首尾 |
| Ctrl+F | 在当前 Input/Output 内查找；Esc 先清查询再关闭 |
| Ctrl+L | 宽屏显示／隐藏调用列表（需真实多调用与父级导航） |
| Ctrl+W | 浏览态切换长行 wrap；复制始终使用原始完整源 |
| c | 复制当前段的原始可得内容 |
| Esc | 关闭；返回同一个主编辑器和原草稿 |
| Ctrl+C | 忙碌时交给 DSH 取消；空闲时只关闭 Inspector，不清主草稿 |

以上均在现有 `/settings → Keyboard` 中重绑定/禁用；没有写死的旧提示。调用列表选择只传递稳定
`callId` 给父级 `setTool`，不重跑工具、不读路径、不从当前文件猜测 diff。Input/Output 各自保留查询，
切换调用时活动 section 与滚动尽量保留；嵌套 Image viewer 返回同一个 Tool Inspector 的原 section／scroll。
禁用 section 绑定后，Shift+Tab 等全局 fallback 不会切 DSH 权限。
Inspector 使用只读 `toolDetails` context，不穿透编辑器词移动/kill/undo；
禁用 section 绑定后，Shift+Tab 等全局 fallback 不会切 DSH 权限。

inline 不启用额外 SGR 鼠标解析。其溢出提示为真实键位 + `to inspect tools`，
不是假装该键能直接定位任意旧卡；进入 Inspector 后可浏览全部调用。

fullscreen 的 Copy / Close / Prev / Next / section 按钮和溢出入口统一使用
`HitboxRegistry`。正文选区、滚轮和点击合成由 vendored Pi TUI 负责。

## `/settings → Tools & Diff`

Settings 是统一的分类搜索弹窗；Tools & Diff 分类保留下列 11 个键，原 General 的 Tool
details 已移入此分类，复用既有 `expandTools` 键，不迁移或创建第二层配置。搜索、布尔开关、
枚举／数字选择与单项 reset 使用同一设置文件；即时生效与核心源码仍需重启的边界不变。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `groupTools` | true | 连续工具分组 |
| `expandTools` | false | 默认展开工具详情 |
| `expandedInputMaxLines` | 5 | Input 折行预览预算 |
| `expandedOutputMaxLines` | 10 | Output 折行预览预算 |
| `toolLabelClip` | 0 | 摘要额外长度限制；0 跟随宽度 |
| `diffViewMode` | auto | auto / split / unified |
| `diffIndicatorMode` | bars | bars / classic / none |
| `diffSplitMinWidth` | 120 | 双栏布局阈值，仍须实际内容宽度可用 |
| `editDiffCollapsedLines` | 24 | Edit 折叠 Diff 行数 |
| `writeDiffCollapsedLines` | 0 | Write 默认只显示摘要 |
| `diffWordWrap` | true | Diff 长行折行 |

预设在页面内循环；JSON 自定义值由同一 `SettingsStore` 验证。I/O 行数接受
1–5000，摘要限制为 0 或 8–500，split 阈值 40–300，折叠 Diff 行数 0–500。
无效磁盘编辑保留最后的合法显示值并拒绝覆盖；并发保存保留其他设置。
工具设置即时生效，核心源码更新仍需退出并重启，不由 `/reload` 替换 JavaScript。

## 事实与性能边界

- 输入保留 DSH 原始 arguments 字符串；结果保留原始 content/envelope、原生
  presenter、meta/error 与 call/result 时间。显示预算不截断这些源数据。
- 详情与复制不使用上游的 8k 输入 / 16k 输出字符上限。文本复制优先保留原始可得文本；
  结构化 read/search/web、Diff 或混合内容另外保留原生源内容及可用引用/元数据。
- 图像/文件/自定义块如实显示可用引用；未做图像渲染、文件读取或下载。
  明确的 inline binary/base64 只标注省略，不自动倾倒系统剪贴板；普通 JSON
  `data` 文本不被当成 binary 丢掉。这里不承诺无损 binary 预览。
- DSH 自身的 `truncated/capped` 与“还有 N 行未展开”分别显示，前者不能靠
  打开详情恢复；快照窗口缺失的 call/time 也不伪造补齐。
- 调用耗时按真实 `tool/result.time - tool/call.time`（与 native toolMs 同口径），
  包含审批/策略/结算等待，不是纯命令 body 执行耗时。明确测到 0ms 可以显示；
  缺时间不填本地 `Date.now()`，也不凭时间重叠声称真实并行。
- DSH 目前没有公开的逐行工具输出流接缝；运行中显示状态/可得计时，最终输出
  来自结算事实，不另做进程抓取、工具重跑或 Agent loop。
- Applied Diff 只来自结果/presentation/meta，不用 call proposal 宣称已修改。
  Error 不等于副作用回滚。Read 保留 native 行号；DSH hunk 没有绝对文件坐标，
  Diff 不编造行号。零命中/空 read/web 和非法 Diff 也不生成虚假内容。
- 超过 `DIFF_LCS_CHAR_LIMIT=150000` 字符的 hunk 不再做昂贵 LCS；精确计数不可得
  时明确提示，详情和复制仍可取得完整 Before/After 源。没有原版的 400 行
  展开截断，也不把预算失败说成“没有变更”。
- 实际系统 Copy 走原生 clipboard；不可用/失败在面板内报告，不写 console。
  自动化 Copy 验收注入回调，未操作用户的真实剪贴板。

## 接缝与验收

- `src/state/transcript.ts`：工具事实投影、原始源/时间/turn/step；不持久化 UI 展开态。
- `src/ui/tool-view.ts`、`tool-expansion.ts`：共享显示契约和临时展开覆盖。
- `src/ui/tool-io.ts`、`tool-block.ts`、`tool-diff.ts`：源数据格式化、单卡和 Diff。
- `src/ui/tool-group.ts`、`transcript.ts`：纯分组投影、稳定组件、命中坐标和清理。
- `src/ui/tool-details.ts`：只读 Inspector；App 负责 Overlay、源更新、剪贴板和原生决策优先级。
- `src/input/`：共享键位/context；不修改 vendor 或全局 Pi。

最新完整 `pnpm check`：**898/898**，构建、strict TypeScript、业务/native
回归均通过。父级 `test/app-tools.test.ts` **17 项**用真实 SGR press/release
和独立 VT 覆盖同点开关、标题离屏后正文收起、第一条 drag、按住期间流式
重绘/设置改变、非末项 Output、所有调用导航、复制源、草稿/焦点、审批抢占、
Ctrl+C 和移除/替换旧 target；另有 **25 项**配置及 **4 项**proposal 边界测试。

`python3 scripts/pty-tools-smoke.py`：fullscreen 与 inline **2/2** 通过，
真实 CLI/PTy、独立 xterm 屏幕单元解码，同点往返、正文选区/收起、组内 Output
详情、跨调用键盘导航、resize/草稿及终端恢复均通过。
Thinking preview=0/3 + inline、Settings、取消 8 项、Help、模型选择、主题、静态
logo/SIGINT 全部同期复跑。均为临时配置/离线或 localhost fixture；不是实网
模型或用户 Rex 字体/GPU/IME 的人工验收。

```bash
dsh-tui --demo --fullscreen tools-group
python3 scripts/pty-tools-smoke.py
```

版权/复用说明见 [第三方许可](../THIRD_PARTY_LICENSES.md) 与
[Diff 上游 Attribution](TOOLS-DIFF-ATTRIBUTION.md)。
