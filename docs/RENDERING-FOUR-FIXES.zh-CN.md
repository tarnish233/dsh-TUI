# 四项现场渲染问题修复

基于现有 v0.1.4/private 未提交工作树。DSH 业务、工具 admission、原生会话顺序和终端 lifecycle 不变；只修精确诊断分类、展示身份／hover 和标题组成。

## 1. Native warning：Node PTC API 提醒，不是工具失败

已在 Node v26.13.0＋DSH 0.2.2-rc.1 确認：`@deepseek-ai/dsh-ptc-runtime-node` 的 host-side stripTypes 调用公开 `node:module.stripTypeScriptTypes`。Node 首次调用会在稍后 tick 向 stderr 写实验性提醒和 trace hint；原 transport 将未知 stderr 分类 warning，UI 因而显示两个 Native warning notices。

`src/backend/terminal-output.ts` 只将这个**精确文本**降为 routine/log-only；第二行 trace hint 只在同一 stderr 紧邻它时配对。文字仍写入原有 bounded private log，不修改 stderr/日志保存、fatal 恢复、redaction 或关闭策略。没有 NODE_NO_WARNINGS、全局 warning listener、凭据或 profile 改动。

其他 experimental API／不同措辞、独立 hint、intervening provider failure、deprecation／fatal 保持原行为；未来 Node 改措辞会 fail-visible。`--trace-warnings` 的 stack 不视作这条 companion hint，仍可见。JavaScript write isolation 的 native-addon／inherited-fd 边界保持。

## 2. Thinking → Tool：保留展示身份，不换掉原生事实

只读参考 `/Users/fulei/workspace/pi_extensions/pi-cc-extensions`，commit b8530b9、v1.0.8：compact-thinking 的 run key 用 message timestamp／runStartIndex，streaming／settled 维持展开状态；compact-mode 为 assistant-update 到 tool component 的时隙保留 missingTool/pendingLiveTool 概念。没有移植其 Pi Agent prototype 或主屏 monkeypatch。

原 DSH 顺序是先 durable assistant/message，再 stream_end committed，再 tool/call/result。问题并非正常路径工具记录重复，而是 live item 被 `assistant:<seq>`／`attempt:<seq>` 替换后，Thinking disclosure key 随 item.id 改变，长展开内容突然折回预览，工具位置因此大幅重排。

修复：
- `src/state/transcript.ts` 在真实 live settlement 时携带 UI-only `thinkingKey`；所有 native durable id／seq／callSeq／resultSeq／状态／顺序保持。
- `src/ui/thinking-block.ts` 的 adoptThinkingExpansion 只迁移临时展开 key；blocks 构造时采用，replay 不 invent live key。
- `TranscriptView.expandedDisclosureCount` 同时识别待采用的 key，避免 event→首次 render 的短间隙让 viewport anchor 读到假折叠。
- retry／abandoned／unknown／用户中断保持原生结果语义。实际 call/result 才确定 admission／状态，不从文字猜工具已执行。

1400 行展开 live Thinking 在合法 native settlement 与工具 handoff 后保留相同正文；hidden 思考仍只有原有占位，未泄漏正文。该四项修复阶段没有引入大型预览尾窗／计数缓存；后续已单独完成 [精确尾窗性能优化](THINKING-PREVIEW-PERFORMANCE.zh-CN.md)，不采用参考中的近似行数。

## 3. Hover：一个当前 owner，旧提示退出

截图里多条历史 click-to-expand 同时蓝色，原因是各卡片／group 独立存 hover，而 pointer routing 只给当前命中块事件；离开的旧块没收到 exit。新增狭窄 HoverOwnership（component＋实际 placement），只发送 synthetic out-of-rect **move**，不改 press pin／drag／selection／focus。

Transcript 与 group 同时管理 header／child 交接、gap／width／re-base／disclosure／session／dispose；Assistant/Attempt 内 Thinking 与 image registry 只保留一个赢得 motion 的 owner。Group helper 先清旧 owner、释放，再采用新 owner，避免 nested exit 把刚采用的 child 又清掉。

Parent 边界：Bottom／Welcome、viewport scrollTop 变化、overlay 入口调用 releaseHover。Terminal 焦点通过既有公开 onFocusChange 观察，focus-out 阻止背景 mouse hints 再进入；回到窗口再启用。全屏 Pi 先消费 CSI O，不能只依赖普通 input listener；custom terminal 才使用输入 fallback。没有 vendor／raw-reader／新快捷键改动。

保持原来 Agent-name brand-blue 链接和错误／状态语义色；变化只针对 disclosure hint。真正命中的 hint 才 bright；鼠标移到编辑框、空白或窗口外后旧提示恢复中性色。

## 4. Read Image 标题：直接组成，不再反向切字符串

原 ToolBlock 用大小写敏感 startsWith(label) 从已合成 summary.text 重新拆 header；native `Read image ...` 与 label `Read Image` 不同，拆分失败后还无空格地连接。

`ToolSummaryInfo.detail` 是明确 payload，header 使用 label＋一个空格＋detail，再按最终 paint 计算 fit 和 hitboxes。只归一化精确、case-insensitive、whole-word 的重复 label/name prefix；其他 native 描述保持 verbatim。`Read image /path` 显示为 `Read Image /path`，不再出现 `Read ImageRead image`。ANSI／OSC／CJK／emoji／无描述／窄宽度都经同一 sanitizer/width seam。

## 验收

- Parent actual native 2 场景：owned profiles、hermetic llm/stream，1400-line reasoning 控制 handoff、PTC 真正执行 `return 42`，原生工具结果／ID与展开保持；首个 strip warning＋hint 捕获为 routine，日志保留且对话区无重复 notices。没有远程模型／真实用户 profile 操作。
- Parent App 3 场景：两 renderer 原生标题，fullscreen 实际 SGR tool→thinking→group→editor 单 owner，focus/overlay 草稿保持。focus API 路径重复十轮通过。
- 新双模式 PTY：生产 App／真实 ProcessTerminal 配 offline fixture，标题正确；fullscreen FG-cell evidence 验证唯一 hint 与 editor／focus 边界，中断／正常退出恢复。main-screen 不冒称 fullscreen SGR 支持。
- 最终 Parent 完整 `pnpm check` **2303/2303**，189文件，0 fail/cancel/skip/todo，tests496805ms，日志 `.cache/rendering-four-fixes/full-check-final.log`。最初 full-check 2303中2302pass／1focus-out断言失败，已修为 public observer，并保留失败对照。详见 [ACCEPTANCE](ACCEPTANCE.md)。

外部源码只读，旧工作树保留；无提交、新 tag、推送、发布、全局替换或真实 credentials／配置读写。
