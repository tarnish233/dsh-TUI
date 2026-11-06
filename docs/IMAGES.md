# 图片：显示投影与只读查看

DSH 拥有图片的持久事实：`ImageAttachmentRef` 是唯一 durable 引用，`Backend.readImage(ref, signal)` 是界面按需读取字节的入口。在同进程插件里，它直接调用 `ctx.attachments.readImage` 并校验返回的 identity/mediaType/字节长度。

本层只做**显示投影**：不实现模型 vision、准入、格式策略或附件存储，不把 base64 写回 transcript/history/copy，也不自行下载路径或 URL。

## 同进程边界

- 不再有前端/后端 IPC，因此没有 8 MiB IPC 帧或 6 MiB 图像传输上限；图片只受 DSH 存储/准入限制和本层**显示**预算约束。
- `src/ui/image-codec.ts` 的 encoded/decoded bytes、source/decoded pixels、max edge 预算是 renderer 预算，不是 DSH 的模型限制，也不改写 canonical 字节。
- `readImage` 只读、与会话解耦：不创建 Agent、不重跑工具、不推导文件路径。取消只 abort 该次读取，不取消回合。
- 模型 vision 的准入、媒体/数量/像素限制、canonical 存储与 durable promotion 仍由 DSH 负责。被 DSH 拒绝的附件不会被本层绕过。

## 日常使用与输入

- `Ctrl+V` 先尝试原生剪贴板图片，没有图片时回退到原子文本粘贴；Windows/WSL 另有 `Alt+V`。远程 shell 无法读取本机图片剪贴板时明确说明失败，不静默发送假附件。
- 图片插在当前光标位置为 `[Image #N]`，字节只保留在单个 Editor 的临时 registry / undo / stash / 本会话 recall 中；`history.json` 不保存 binary 或 base64。
- 跨启动的孤立 marker 会阻止发送并要求重新附图。
- 单 Editor 的删除、词删除、kill/yank、撤销与快照共同保护图片身份；重复 marker 保留每个原位置的 image part，不偷偷去重或重写段内空白。资源预算不足时拒绝新 paste，不破坏仍可 undo 的旧图。
- 发送走 `Backend.sendContent` 和 DSH 原生 `admitPromptContent`、消息工厂与 inbox；失败时恢复提交前的完整 draft（有新草稿或附件变化则不覆盖）。纯图提示允许提交；slash command 不接受附件并保留草稿。
- 原生 queued image prompt 的显式 Up 取回保留 canonical refs，再按张读取字节恢复。读取失败或新草稿竞争时保留 ref-only transfer receipt，允许空提示 Up 重试；不会当 image-less text 发送，也不会自动重入 DSH queue，不新增调度器。receipt 仅内存、最多八个会话，退出释放。

## 数据投影

`src/state/transcript.ts` 为带图消息保留原始 block 顺序：

- `UserTranscriptItem` / `AssistantTranscriptItem` / `AttemptTranscriptItem` 的 `content?: DisplayContentPart[]` 按声明顺序保存 `text` / `image`；纯图片 user/assistant/attempt 不会被丢。
- `ToolTranscriptItem.resultContentParts?: DisplayContentPart[]` 保留工具结果的 text/image 顺序；原始 `resultContent` / `rawResult` 不动。
- `imageCount` / `resultImages` 继续计数所有 image block，包括没有可用 ref 的 legacy 数据；这类块只显示不可点击的 `attachment unavailable` 占位。
- live stream 优先使用 `StreamPresentation.content`；只有旧式 `images` 时才把 refs 追加到 text 之后（fixture codec 遵守同一形状）。

`src/ui/image-data.ts` 是纯函数投影：

```ts
getTranscriptImages(items) -> ImageViewItem[]       // 父 App 的导航序列
transcriptImageOccurrences(items) -> ImageOccurrence[]
```

- 顺序 = 声明顺序（user/assistant/attempt/tool 交错）；同一 `attachmentId` 的重复出现是**不同 occurrence**，各自有 key。
- occurrence key = `<itemId>#image-<i>`，不是 attachmentId，也不合并重复项。
- 只返回形状合法的 canonical refs，不读取、不 decode、不访问 backend。
- tool 优先使用 `resultContentParts`，也可从保留的 `resultContent` / `rawResult` 投影 canonical refs；未结算的调用没有可查看图片。

## transcript marker

- 每个 occurrence 一行紧凑标记：`[Image #n] name · PNG · 1024×768 · 128KB`。`n` 是 **item 内**序号，不是全局编号；viewer 顶部的 `Image i of n` 使用父 App 的全局导航计数，两个 scope 不互相改写内容。
- text/image 顺序由 `ImageContentBody` 保持；user 用 plain wrap，assistant 用按 text-run 缓存的 Markdown。
- 窄宽度先裁 name/字节，再裁 hint；inline 模式预留 effective binding 的 hint，不会出现“有 hint 但键被裁掉”。
- fullscreen 只有真实 handler 与真实 ref 同时存在时才可点击；legacy 占位不建立 hitbox，不显示假的 click/mouse 提示。
- 渲染 marker 不读字节：折叠组、流式 token、思考/折叠重绘都不会触发 `readImage`。

## ImageDetailsDialog

父 App 用公开 `tui.showOverlay` 打开，保留底层 ToolDetails overlay，关闭后回到原 section/scroll。

```ts
new ImageDetailsDialog(tui, {
  image: ImageViewItem, keymap, readImage, maxHeight?,
  onClose, onInterrupt?, onRenderRequest?,
  getImageNavigation?, onPreviousImage?, onNextImage?,
})
dialog.setImage(next)   // 同一 key 但 ref/data 变化会重新加载
dialog.invalidate()     // 让保留的 Image 实例按新 cell 几何重算
dialog.dispose()        // abort + inert，不调用 onClose
```

- 构建时发起且只发起一次 `readImage`；`setImage` abort 旧请求并递增 generation，迟到结果不解码、不缓存、不绘制。
- 图片区域是独立全宽区域：Pi TUI `Image` 产出的 APC/占位空行原样输出，不经过 tool 树缩进、通用 wrap 或 sanitize；其余 metadata 全部 sanitize。
- 每个 occurrence 使用自己的 `Image` 实例；CSI 16t 几何变化时调用 `invalidate()`。行预算随 live `maxHeight` 变化；预算不足走文字 fallback，绝不截断 APC 后继续声称旧高度。极矮 viewport 显示紧凑文字并保留 close 提示。
- 只有 DSH 已校验的 native ref 才走 PNG 头直通（仍执行全部 encoded/decoded/pixel/edge 预算）；upload/默认导出始终经 sharp 真实解码，截断/坏 chunk 的 PNG 不会被当成 Ready。JPEG/GIF/WebP 及超预算 PNG 在加载阶段经 sharp 公共异步 API `rotate()+resize()+png()`，不在 render 热路径。
- `src/ui/image-cache.ts`：以完整 ref identity（attachmentId + mediaType + bytes + dimensions）为 key 的 LRU，按字节/条目限量（默认约 48 MiB / 24 项）。abort/dispose 的结果不入缓存；cache hit 必须重新通过**当前请求**的预算，否则丢弃并重新读取/解码。
- decode 有并发上限；abort 后不再启动压缩 ladder/排队工作。已在 native sharp 中执行的当前解码会自然完成并由调用方丢弃（sharp 不可瞬时中断）。
- fallback：无 inline-image 协议时由 Pi `Image` 输出文字占位，dialog 同时显示 `terminal cannot display inline images`，metadata/close 仍可用；解码失败显示清洗后的原因，不伪造图片。
- 键盘走 `keymap.resolve(raw, 'imageDetails')`：共享 chord 状态、`app.interrupt` 优先、未知 global action 在 viewer 内 inert。`image.details.previous-image` / `next-image` / `close` 与 hint 都读 effective binding；边界处按钮/动作禁用。header 的 Prev/Next/Close 使用既有 `HitboxRegistry`，不新增 SGR 解析。
- Ctrl+C 只调用 `onInterrupt`；父 App 决定 busy 时中断一次、idle 时仅关 viewer（草稿不变）。

## Tool 图片

- `src/ui/tool-io.ts` 从 block 的 nested `attachment` 读取 name/mediaType/dimensions/bytes/id（兼容旧扁平 ref）；top-level mime/name 不再误当真实 ref。
- `toolOutputText(item, { imageRefs: 'omit' })` 供卡片避免重复元数据；`toolCopyText` 始终保留完整 reference metadata，且不输出 base64。
- ToolBlock expanded Output 为每个真实 ref 渲染可点击 marker。
- ToolDetails Output tab 渲染 `[Image #n]` 按钮（共享 hitbox），并可用 `app.images.details` 打开该工具自己的第一张图；普通 group header/body 的展开/折叠语义不变。

## demo

`--demo` 输入 `images` / `图片` 走纯 fixture 流程：canonical PNG/JPEG refs、同一 PNG 重复出现、纯图 assistant、纯图工具结果，以及与长 terminal 输出/原生 diff 相邻的工具组；`DemoBackend.readImage` 从内存 map 提供字节，未知 id 报错。没有真实工具、模型、文件或终端操作，也不需要 DSH。

## 终端兼容与验收边界

- 目标共同路径为 Kitty PNG direct/chunked 传输。Pi TUI 静态识别 `TERM_PROGRAM=rex` 和 Ghostty；这不等于每个真机像素路径已获验证。
- vendored fullscreen renderer 在清屏/full redraw 后丢弃旧 upload cache 并重传；普通非清屏帧仍复用 placement。height-only resize、强制重绘与 cell geometry 更新有独立测试，避免 Ghostty/Rex 清屏回收后的旧 ID 复放。
- iTerm2 inline 按 Pi 公共实现显示；fullscreen 保守降级文字。tmux/screen 默认不强行发送未经确认的图片协议。
- `scripts/native-image-acceptance.ts` 是无模型的色块样例，可在独立测试页手动查看。
- 历史阶段：`scripts/pty-images-smoke.py` 曾以 CLI/PTy 4/4（Rex/Ghostty × inline/fullscreen）验证完整 PNG CRC/raster、JPEG 转 PNG、七个 occurrence 导航、resize/draft/退出恢复。该结果只作为历史记录，不是当前健康证明。
- 本轮没有对真实 DSH model 发图验收，也没有通过截图确认 Rex/Ghostty 实际 GPU 像素绘制；`pixelRenderingTested:false` 是明确边界。当前完整验收范围见 [验收记录](ACCEPTANCE.md)。

## 测试

- `test/ui-images.test.ts`：refs/order/重复 key、纯图 user/assistant、legacy 占位、marker 顺序与 inline hint、tool nested metadata/copy 无 base64、ToolDetails 按钮与键盘、group header 语义、demo images 流程与 fake `readImage`。
- `test/ui-image-viewer.test.ts`：真实 Kitty APC/blank rows 与宽度、无能力 fallback、动态 maxHeight/极矮 fallback/CSI 16t invalidate、loading Esc、未知 global inert、导航边界与 chord、同 key 换 ref 重载、abort/late/dispose 不缓存、LRU/预算/已验证 PNG 直通与 JPEG 转码/invalid bytes、错误响应。
- `test/plugin-images.test.ts`：同进程原生图片提示保留 durable canonical refs、不把 inline bytes 写入会话事件、`readImage` 经 DSH 读取、发送后草稿清空且不产生幻影 marker 文本。
- 所有测试使用临时目录/内存 fixture，不读取真实 profile、凭据或会话日志，不访问真实 provider。