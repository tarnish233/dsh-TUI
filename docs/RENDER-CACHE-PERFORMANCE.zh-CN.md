# 渲染缓存与惰性语法高亮（P2）

本轮只做两件事：**块级渲染快路径**（`src/ui` 的 item/group 组件）与**惰性
highlight.js**。流式 Markdown 稳定前缀、整帧 ledger、fitted-lines 契约与
`DockPromptEditor` 的编辑器行测量不在本批范围（测量已由 input 侧
`CcEditor.measureRows` 提供）。

## 1. 块级快路径：什么可以复用，什么必须失效

每个 item 块（`CachedBlock` 子类）、工具卡（`ToolBlock`）与三个 group
（`ToolGroupBlock` / `ActivityGroupBlock` / `SubagentGroupBlock`）在
`render(width)` 开头先判断能否直接返回**上一次的 lines 数组本身**：

- 普通块：`clocked() === false`、存在缓存、宽度一致、两个模块级展开代际未变；
- 工具卡：额外要求自身的实时时长不再推进（`clocked() === false`，即“未结算且
  有 `startedAt`”为假）；
- group：额外要求自身 `liveStamp() === ''`，且展开态下**每个子块的
  `paintRevision` 与合成时一致**（子块自己 hover/展开/更新不能被 group 的
  缓存掩盖）；
- 命中的语义是“这一帧与上一帧逐字相同”，因此 hitbox、hover owner 与
  row span 都不需要重新声明。

**能改变绘制且不具有 item `version` 的输入，必须在快路径之前失效**。审计清单
（每条都有对应测试）：

| 输入 | 失效方式 |
| --- | --- |
| 图片 marker / subagent link 的 hover | 各块 `hoverEvent`/`onHover` 调用 `invalidate()` |
| 工具/组展开（模块级 override） | `toolExpansionRevision()` 代际；点击/按键路径另加 `TranscriptView.invalidate()` |
| Thinking 展开与 hover | `thinkingExpansionRevision()` 代际 + `thinkingBlockOptions` 包装 `onRenderRequest` |
| cwd | `setCwd()` 内部 `invalidate()` |
| 主题 / 设置 / keybinding（`options` 变化） | `TranscriptView.syncFlags()` 比较 `paintSignature()`，变化即 `invalidate()`；父级 Settings/reload 路径本就显式 invalidate |
| 子代理目录（label / openable） | `sameCatalog()` 按 entry 元素身份比较；变化即 `invalidate()` |
| 运行中的实时时长、直播 Thinking 计时 | 不做快路径（`clocked()`），每帧重组 key |
| 宽度 | 缓存记录 `width`，不等即重建 |
| 会话切换 / 淘汰 / dispose | 清空 cache、`plan`、span、hover 与展开状态 |

计数口径：`src/ui/render-counters.ts#cacheKeyBuilds()` 只在真正组装 cache key
前 `+1`。测试以**精确增量**断言（未变重绘 0，单次输入变化 1），不使用墙钟阈值。
本机诊断基准（`.cache/render-cache-performance/`）：2 399 行未变帧从
800 key/帧 降到 **0 key/帧**，中位 0.358 ms → 0.198 ms；hover 后 100 次重绘
只组 1 次 key。

## 2. 流式 Markdown 稳定前缀（`src/ui/markdown-stream.ts`）

`Markdown.setText()` 会丢弃已渲染行，因此流式正文每帧都重跑**整篇**词法；实测
300 个块（约 2 700 行）约 4.5 ms/帧，且 vendored 的块复用放在 `WeakRef` 里，GC
随时可以清掉。`ImageContentBody` 的 markdown 模式改用 `StreamingMarkdown`：
把源码切在**已封存（sealed）**边界，边界之前由独立 `Markdown` 实例渲染一次、行
被**强引用**持有；每帧只重渲染边界之后的 tail。

**只允许**在这些地方封存（保守规则，见 `stableMarkdownBoundary`）：

| 区域内容 | 封存 | 说明 |
| --- | --- | --- |
| 空行结尾的普通段落 / ATX 标题 / setext 下划线 / 分隔线 | ✅ | 空行即顶层块边界 |
| **已配对闭合**的围栏代码块、`$$`、`\[ \]` 数学块 | ✅ | 合语块完整，可落在前缀内 |
| 未闭合的围栏 / 数学块 | ❌ 该处不封存 | 空行属于块内容；封存点只能在其之前 |
| 列表、引用、GFM 表格 | ❌ 出现即**清除已采用的封存点**、整篇渲染 | 松散列表/引用可跨空行，行扫描无法证明已闭合 |
| 4 空格缩进代码、HTML 块 | ❌ 同上 | 同上 |
| 任何 link reference definition（围栏/数学块之外） | ❌ 同上 | 定义是**文档全局**且**可回溯**：定义出现后，早先段落里的 `[ref]` 才变成链接，已封存的前缀会变陈旧；它也可能藏在列表/HTML 等普通 barrier 之后，所以统一规则是“任何 barrier 一律整篇渲染” |
| tail 是“只有空白行”的残缺块（`>`、```` ``` ````、`- `） | ❌ 该帧整篇渲染 | 空行分隔符会与前缀尾行合并，拼接会重复一行 |
| 候选前缀的末行不是空白行（末块为 `$$`/围栏/分隔线） | ❌ 拒绝该候选、沿用上一个封存 | 该块本身不产生分隔空行，拼接会丢一行 |
| 宽度变化 | 保留封存点，前缀与 tail 都在新宽度重渲染 | 封存点是字符下标，与宽度无关 |
| 非追加输入（编辑/缩短/替换） | 重置封存点、整篇重渲染 | 之后重新封存（新的 `freshScan`，barrier 不会粘连到新消息） |
| 主题 / 惰性语法高亮 ready | `ImageContentBody.invalidate()` → `StreamingMarkdown.invalidate()` | **必须同时丢弃 tail 渲染器与前缀强引用行**，否则前缀里的 plain 代码行永远不变色 |

**barrier 语义（保守统一规则）**：上面表中任何一类构造在围栏/数学块之外出现时，不仅
停止后续封存，还会**清掉已经采用的封存点**，从该帧起整篇渲染；此前已流式输出的每一帧
仍然是精确的（barrier 之前才可能封存）。扫描状态用显式 `documentFallback` 标记并且是
终态，因此回落之后每帧扫描成本为 O(1)（`scanChars` 不再增长）；只有非追加输入才重新
开始扫描。因此边界**不是单调的**：barrier 会把它重置为 0。

计数器（`StreamingMarkdown.stats`）：`sealAdvances`、`prefixRenders`、
`prefixChars`、`tailRenders`、`tailChars`、`fallbacks`、`scanChars`、
`documentFallbacks`、`rejectedSeals`、`resets`、`concatRows`。测试断言性质而不是耗时：追加 token 时
`prefixChars` 增量为 0、每次变化只多一次 tail 渲染、`tailChars` 增量不超过一个
段落，`prefixRenders ≤ sealAdvances + 宽度切换次数`。

本机诊断基准（`.cache/render-cache-performance/`，40 段 / 13.6 KB 的流式正文，
每 5 个 token 完成一段）：封存前缀 median **0.0132 ms/帧**，同等内容用单实例
整篇重渲染 median **0.3033 ms/帧**；每帧 tail 词法仅 54 字符（整篇每帧为 13.6 KB
量级）。

**限制（明确不承诺）**：一条消息只要出现列表/引用/表格/缩进代码/HTML/引用定义，
从该帧起就不再复用前缀（通常意味着该消息后半程整篇渲染）；每次封存推进会把**整个前缀**
重渲染一次（不是每帧），
因此单条消息的总前缀词法量约为 O(段数² × 段长/2) 的摊销；`tailChars` 超常时仍
按 vendored lexer 的常规成本增长；含列表/引用/表格/缩进代码/HTML/引用定义的消息
基本不做前缀复用（回落整篇渲染，语义优先）；`concatRows` 是每帧唯一 O(前缀) 的
指针拷贝，没有做整帧 ledger 或 fitted-lines/decorator 缓存。

## 3. 惰性 highlight.js

- `src/ui/highlight-palette.ts` 只含调色板与 `plainHighlightLines()`，位于启动
  路径；`src/ui/highlight-runtime.ts` 含 highlight.js core（CommonJS
  `require`，保持宿主共享单例）与 20 个语言定义，**只能**通过
  `src/ui/highlight.ts` 的唯一一次动态 `import()` 到达。
- 状态机：`idle → loading → ready | failed`。`idle/loading` 期间
  `highlightCode()` 返回与 `plainHighlightLines()` **逐字相同**的回退行，且
  **不写入 LRU**（缓存里的 plain 行会在 ready 后变成永久陈旧）。并发调用共享同
  一个 `inflight`，因此只有一次 import；`failed` 是终态、不抛异常、不重试风暴。
- 别名、调色板、6000 字符 / 200 行上限与 64 项 LRU 语义保持不变；`ready` 之后
  的输出与直接调用 runtime 完全一致（测试逐字比对）。
- **两层缓存**：块缓存不等于 Markdown 缓存。`Markdown` 自己按 `(text,width)`
  记忆行，所以 `ready` 时既要 `TranscriptView.invalidate()`（块），也要
  `ImageContentBody.invalidate()` → 每个 `Markdown.invalidate()`（块通过
  `invalidateOwned()` 转发）。`DecisionDialog` 自己的 `detailMarkdown` 仍在
  其 `invalidate()` 中处理。
- 直接持有 `Markdown` 的只有两处：`ImageContentBody` 与
  `DecisionDialog.detailMarkdown`（`rg "new Markdown\("` 可复核）。两者各有自己的
  ready 边，因为对话框不是 transcript 的子组件，视图的失效到不了它的行缓存：
  - `TranscriptView`：构造时订阅一次（不是每帧），`ready` 时 `invalidate()` +
    请求一次重绘，`dispose()` 退订；
  - `DecisionDialog`：构造时订阅，`ready` 时只 `detailMarkdown.invalidate()` +
    `tui.requestRender()`，幂等 `dispose()` 退订；`failed` 不改缓存。
  `highlightRuntimeSubscriberCount()` 是测试用的诊断计数，用来验证 dispose 真的
  释放订阅，而不是只有监听内部的 `disposed` 守卫。
- 正常行为只在配色上有差别：就绪前后行数、列宽、hitbox 行位置一致。

## 4. 编辑器高度测量（本批仅接线）

`src/ui/inline-editor.ts#DockPromptEditor.measureRows()` 现委托
`CcEditor.measureRows()`（input 侧的 memoized、无副作用实现），不再自己
`render()` 一次；`measureRows(width) === render(width).length` 仍由测试钉住。
父级 `Prompt`/`statusDockPool` 接线由 parent 负责，本轮未改 `src/app.ts`。