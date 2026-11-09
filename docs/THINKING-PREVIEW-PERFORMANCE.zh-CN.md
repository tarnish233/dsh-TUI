# Thinking 精确尾窗缓存性能优化

本轮只改变 Thinking 展示测量，不修改模型调用、原生文本、durable id／seq、工具 admission、计时事实或输入/终端运行时。沿用现有 `ThinkingBlock` 和上一轮的 disclosure handoff／hover 修复。

## 精确语义优先

基准保持原来的 `wrap(sanitize(text).replace(/\s+$/, ''), bodyWidth)`：隐藏行数是实际 word-wrap 行数，尾部文本与展开正文必须逐字一致。只读 pi-cc-extensions 提供尾窗／未着色 cache／expanded wrap reuse 思路，但它的 `ceil(visibleWidth/width)` 计数是估算，本项目不照搬。

新增 `src/ui/thinking-preview-cache.ts`，每个 ThinkingBlock 自己持有缓存：

- 同 source／width：直接复用计数／尾部／已构建的展开行，timer／hover／preview-policy 重绘不再 sanitize 或 wrap 全文。
- 合法普通追加：只 sanitize 新 delta，将上次最后一条可变 wrap line 与追加文本交给原共享 wrap；前面的行只累计计数，保留有上限的尾部行。长 paragraph 与无空格长 token 同样保持旧语义。
- 末尾 whitespace 保留为 pending；之后拼回，避免 `a b `＋`c` 变成 `a bc`。每段 literal newline／空段仍是准确行数，不丢空行。
- 展开正文只在需要时构造，未变文本复用；append 时替换最后一行。缓存未着色字符串，颜色／italic／hover 在输出时处理。
- 新 width、rewrite／shorten、没有可用 retained state，或有 sanitizer 边界风险时完整重建，宁可少复用，也不返回近似行数。

## 保守边界与资源

CRLF 可能跨追加边界；ESC／CSI／OSC 处理是多次 regex pass，后面消掉 OSC 可能暴露更早的未完成 CSI。因此保留文本含 ESC 时拒绝下一次 append fast-path；同文本 hit 仍可复用，普通文本追加不受影响。这不是重新实现 ANSI parser，也不会为了性能保留终端控制字节。

每块默认最多 16 个 run state、24 条尾部行、262,144 个 UTF-16 code unit 的 retained budget（source＋tail＋expanded；不是DSH原文大小规则）。LRU／prune 清掉消失的 run。超大 state 放弃 source／expanded reuse、只保留有界 accounting/tail，后续走旧精确路径；这属于明确的性能 fallback，不是丢原文。无全局增长、设置项、计时器或 backend cache。

淘汰用不可与合法 source 混淆的 sentinel。若用 `''` 表示丢弃，紧接着真正清空文本会错命中旧内容；这一边界已由独立 oracle 验证并修复。非 finite cache-limit 参数回到 finite 默认值，不能形成无限 cache。

`ThinkingBlock.clear()` 仍只清交互 hitbox／hover，普通 repaint 不因它失去测量缓存；实例随原 item cache 释放。上一轮 expandedThinking identity 迁移不变，新 durable block 可以一次 cold index，但不会改变 native 展示身份或折回预览。

## 验证与基准

Parent 冻结优化前编译模块作为 oracle：`.cache/thinking-preview-performance/old-thinking-block.mjs`。`bench.mjs` 对旧／新最终 paint 和累计行输出逐字／结构比较，再交替顺序测三轮中位数，避免将一边的 width-cache warmup冒称优化收益。

独立 `differential-fuzz.mjs` 对固定随机 seed 的 append／rewrite／truncate／width／preview／expand、tabs／CRLF／trailing spaces、CJK／emoji／combining／ZWJ、control／CSI／OSC 与预算淘汰做旧公式对照。专项测试还统计实际 wrap/sanitize work，不能只凭墙钟断言。

Parent独立精确差分 **800场景／87,016对照**通过。最终本机中位数：

| 场景 | 重绘数 | 旧测量 ms | 新测量 ms | 比率 |
| --- | ---: | ---: | ---: | ---: |
| 1400硬行＋逐次追加 | 160 | 866.73 | 14.11 | 61.4x |
| 无换行长paragraph追加 | 100 | 139.80 | 5.57 | 25.1x |
| 无空格长token追加 | 50 | 55.26 | 2.13 | 25.9x |
| 1400行只变化计时 | 300 | 1590.98 | 0.443 | — |
| 展开后未变原文 | 70 | 370.22 | 4.24 | 87.4x |

微基准只测 renderer 的 append／redraw，排除初次 indexing；不是 API 模型速度、真实网络或主观 GPU/terminal latency。prefix验证仍检查source是否真正append，不冒称总CPU在所有输入下严格constant-time；超budget／unsafecontrol路径保守重建。

Parent最终完整 **2323/2323**，190文件、0 fail/cancel/skip/todo，tests503378ms。cache/native/handoff/hover/PTy专项70/70与整仓同时通过。日志／benchmark／fixed随机seed位于 `.cache/thinking-preview-performance/`，详见 [ACCEPTANCE](ACCEPTANCE.md)。

外部项目和全局安装只读；所有文本均为测试 fixture。没有真实 Provider／profile／credentials 操作，未提交、新 tag、推送或发布。
