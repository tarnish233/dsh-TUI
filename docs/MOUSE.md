# 鼠标抽象层（`src/ui/mouse.ts`）

一条可复用的 hitbox 层：任何以纯文本行渲染的可点击/可悬停区域都走它，
**任何功能不得自建 SGR 鼠标解析或私有分发**。thinking 摘要行是第一个
消费者；当前工具卡、工具组、Input/Output 详情入口、Inspector 控件与回到底部按钮也复用同一层；链接等未来继续复用。

该层刻意保持「哑」：只认识行、列和 pi-tui 事件语义，不认识 thinking、
工具或主题。hover 提示的着色是消费组件的事，本层只报告进出。

## API

```ts
new HitboxRegistry()

reg.sync(hitboxes)          // 每次 render 之后调用，替换本帧 hitbox 集
reg.handleMouse(event)      // 接到 Component.handleMouse 的适配器
reg.hoverTarget()           // 当前悬停的 hitbox（无则 undefined）
reg.clear()                 // 不可交互帧 / 组件删除时全清；普通重绘不清 pin
```

`MouseHitbox`：`{ id, startRow, endRow, startCol?, endCol?, claimPress?, onClick?, onHover? }`
（行列为 0-based 组件局部坐标，行闭区间；省略列区间 = 整行）。

`MouseHit`（传给 `onClick`）：`{ row, col, clickCount, button, shift, alt, ctrl }`。

`MouseHoverChanges`（`sync` 返回值）：`{ entered, exited }`。

## 事件语义（对照 `vendor/pi-tui/src/tui-alt-screen.ts`）

| 事件 | 行为 |
|---|---|
| 左键 `press` 命中 | 认领 `claimPress !== false` 的区域：返回 `{ handled: true }`，无副作用，并锁定该 hitbox 供随后的 click 使用——不认领则 TuiAltScreen 不登记 press target；`claimPress: false` 的区域返回 `undefined`，保持原生选区 |
| `click` 命中 | 跑 `onClick`，返回 `{ handled: true, render: true }` |
| `move`/`drag` | 悬停转移：旧 hitbox `onHover(false)`、新 hitbox `onHover(true)`，变化时 `render: true`；指针移出全部 hitbox 视为退出；仍在同一 hitbox（同 id）返回 handled 不重渲染；**无命中且原本无悬停 → `undefined` 完全放行** |
| 未命中任何 hitbox | `undefined`（文本选区、滚动条拖拽、滚轮路由原样工作） |
| 非左键 / `release` / `wheel` | `undefined`（右键粘贴、选区扩展、滚动归 TuiAltScreen） |
| hitbox 重叠 | 按声明顺序取第一个命中——具体区域声明在全宽兜底之前 |

## `sync` 的帧 diff 规则

- 悬停中的 id 在新帧消失 → 报告 `exited`（`sync` 本身不跑 `onHover` 回调，
  调用时机由消费方决定）
- id 存活且 rect 未变 → 悬停保持；rect 变化 → 报告同 id 的 exit + enter
- 新出现的 id 绝不凭空产生 `enter`：指针没动就没有转移

## 消费指南

1. 组件持有 `HitboxRegistry`，`render(width)` 完成后用**本帧渲染出的行号**
   调 `sync([...])`（渲染宽度变化、内容折叠/展开都会改变行号，所以必须
   每帧重报）。
2. 组件实现 pi-tui 的 `Component.handleMouse`，直接 `return
   this.registry.handleMouse(event)`。TuiAltScreen 分发时已把 `x`/`y` 换算
   成组件局部坐标，单组件无需再平移。
3. **父组件托管多个子块时**（如 TranscriptView）：父的 `handleMouse` 按行
   找到覆盖该行的子块，把 `event.y` 减去子块起始行后通过 `dispatchToChild` 委托；
   返回它的结果，保留子块 target 与按下时的原点，不能只返回裸 `handled`。
4. hover 高亮：`onHover(entering)` 里改组件内部状态并让父级重渲染
   （只请求父级/renderer 重绘；不得直接 write/console 输出到可见终端）。

## 与 TuiAltScreen 的关系

本层不解析转义序列。SGR/X10 解析、press-target 登记、拖拽抑制、click
合成（双击/三击计数）、文本选区、滚动条与滚轮路由全部由 vendored
pi-tui 的 `TuiAltScreen` 完成；本层只消费它归一化后的 `TuiMouseEvent`。
`TuiMainScreen`（inline 模式）不产生鼠标事件，inline 下点击类交互退化为
键位提示（各消费组件自理文案）。

## 点击认领策略：`claimPress`

`MouseHitbox.claimPress`（默认 `true`）决定该区域是否从原生渲染层「认领」左键按下：

| 取值 | press | move / drag | click | 适用 |
|---|---|---|---|---|
| `true`（默认） | 认领并锁定按下的 hitbox id，返回 `{ handled: true }` | 走悬停转移 | 跑锁定区域（或当前行命中的区域）的 `onClick` | 小控件：thinking 摘要行、链接、chip |
| `false` | `undefined`，交给原生层开始文本选区 | `undefined`，选区/拖拽/复制保持原生 | 原生层在「未拖拽」时合成的 click 仍归本层处理 | 大块文本：展开后的 reasoning 正文 |

`claimPress: false` 依赖 vendored `TuiAltScreen.handleSelectionMouseEvent`：按下未被认领时它启动原生选区，
松开时若指针未移动（`selectionDragged === false`）就合成 `click` 并走 layout 分发，本层照常 `onClick`；
一旦发生拖拽就不合成 click，选区与 `copyOnSelect` 完全保留。因此「点正文折叠、拖正文选字」不需要
自建 SGR 手势，也不改 vendor。即使刚从已悬停的摘要行进入正文，退出 hover 的回调也不能
吞掉正文的第一条 drag；`claimPress: false` 的具体区域也不会被后声明的全宽认领区域覆盖。

## press 锁定（防止两帧之间行号漂移丢点击）

TuiAltScreen 在**松开时**才合成 click，并且是把 click 重新交给按下时的 target，用**按下时的 origin**
（`retargetMouseEvent`）换算局部坐标；而 hitbox 表由每个新帧 `sync` 覆盖。流式输出、follow-end 滚动、
250ms 思考计时器和悬停重绘都会在两帧之间移动行号，于是「按下的行」和「click 时命中的行」可能不是同一行。

本层的对策是把 press 与随后的 click 绑定：

1. 认领 press 时记录 `{ box, x, y }`——**按下的那个 hitbox**；
2. 合成 click 的坐标与按下点相同（pi-tui 的保证）时，优先跑该 id 的 `onClick`，即使它的行号已经移动；
3. 清理时机：`click`（消费后）、新的 press、`drag`（原生层不会再合成 click）、`sync` 里该 id 消失、`clear()`；
   **`release` 故意不清**——松开发生在合成 click 之前。

托管多个子块的父组件还必须让 target 指向子块本身，否则 click 会回到父组件、用父组件重新算行。
`dispatchToChild(component, event)` 与 pi-tui 内部 `dispatchMouseEvent` / `Container` 的形状一致
（`target = { component, originX, originY, width, height }`，origin 取按下时），pi-tui 随后对
`release` 和合成 click 都按这个 origin 重新定位，行号漂移因此不再把点击送给别的块。

## 消费组件何时清空

渲染出「没有任何可点区域」的帧（例如 `showThinking=false` 时只剩一行 `✻ Thought (hidden)`）必须调用
`ThinkingBlock.clear()` / `registry.clear()`：残留 hitbox 会吞掉本该用于选区的点击，还会把一次不可见的
展开状态翻转（并触发 viewport anchor）。`sync([])` 同时会丢弃 press 锁定。
从 TranscriptView 删除 item 或切换会话时调用该 item 的 `clearMouse()`，取消原生 renderer
可能仍持有的旧组件 target；普通缓存 invalidate/流式重绘不清 press pin。
