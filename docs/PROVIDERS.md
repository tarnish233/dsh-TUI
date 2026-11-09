# 模型与 provider：DSH 原生投影

本 TUI 不拥有模型目录、provider、凭据、默认策略或路由。所有内容来自 DSH 宿主已挂载的原生服务，本层只把结果投影成界面行。

## 数据来源

- `ctx.llm.listProviders()`：原生 provider 列表。
- `ctx.llm.listModels(provider)`：该 provider 的原生模型条目。
- `ctx.llm.resolveModelInfo(provider, model)`：目标模型的原生 metadata（包括 reasoning 等级）。
- `agentDefaultModel.currentSelection()`：原生默认 provider/model，仅用于标记默认行。
- 实时切换走当前 Agent 的 `agent.model.select({provider, model, reasoningEffort?})`；默认保存走 `agentDefaultModel.saveSelection()`。

`src/backend/model-view.ts` 是纯函数投影，只重命名字段：`id`（UI 关联键）、`provider`、`model`、`label`、`description`、`reasoning`、`isDefault`。原生 provider/model 值原样传给模型选择槽，不做别名、路由或能力推断。

原生服务未挂载或调用失败时：

- 只有 `listProviders` 与 `listModels` 真正可用时才声明支持 `models`；
- 单个 provider 失败保留原生错误文本（已脱敏），不隐藏成功的行；
- 不读取外部/Pi 目录，不提供凭据策略、router 或第二套默认策略。

## 推理等级（effort）

DSH `0.2.2` 的模型列表 DTO 可能不包含 `reasoning`。因此选中模型时，适配器只对该**目标模型**调用 `resolveModelInfo(provider, model)`：

- 目标仍声明当前显式等级时，才继续携带该等级；
- 目标的默认等级不会被提升为显式设置，省略则由 DSH 适配器默认值生效；
- 不存在的 resolver 意味着无法携带等级，但模型选择本身仍然可用。

metadata 返回后会重新校验 pending/live 路由与 attachment identity，迟到的结果不会覆盖新选择。`/effort` 的可用项与默认值直接来自原生 metadata。

## 默认模型与持久化边界

- profile 的 `agent-default-model` 原生生效；home 级配置按 DSH 自己的优先级覆盖。TUI 不猜“第一个 provider”或“第一个 profile”。
- 保存默认选择的目标是宿主挂载的真实 native ConfigEditor。适配器无法从 public getter 证明配置已落盘，因此命令结果固定报告 `defaultsPersisted:false`、`defaultPersistence:'native'`。
- 正常成功只更新底栏/返回元数据，不向对话追加确认；保存失败、不可用、未知或无效结果仍以 warning 显示。不会手工合并或回写 YAML。
- 需要永久保存时，请通过 DSH 自己的配置界面/ConfigEditor 操作真实 profile；本层不备份、迁移或重建凭据。

## profile 与前端组合

默认 profile 仍是 `dsh-tui`。生产启动由 native DSH launcher 完成，本插件只是该 profile 组合的一部分：

```bash
# 首次安装（用户自行执行；本轮未改真实安装）
dsh plugin --profile dsh-tui add /Users/fulei/workspace/dsh-tui

# 启动
dsh --profile dsh-tui --fullscreen

# 兼容别名：转交 native dsh，默认 --profile dsh-tui
dsh-tui --fullscreen
```

- 一个 profile 只能选择一个前端。若同一 profile 还挂载 web/headless/旧 TUI 等已知应用前端，本插件明确报错；请用 DSH 原生插件命令移除或禁用旧前端。本插件不剪裁别人的 patch、不重建 profile、不禁用竞品。
- `--profile <name>` 要求该 profile 同样组合本插件，否则不会出现这个 TUI。
- 模型目录、凭据、权限、工具与会话都由该 profile 的原生组合决定；TUI 不创建 profile、不镜像 profile/home、不维护 scratch runtime。
- 本应用 bundle 明确挂载 DSH 的 canonical `file-reference-local` Host provider，供终端 `@path` 候选使用；用户的后置 profile patch 仍可禁用或替换该行。候选、effective cwd、索引失效与模型侧 `read` 指引均归 DSH，TUI 不另扫文件系统，也不挂载 Web `ui-reference` frontend。
- `--models-file` 已移除，会明确失败；旧的 Pi 目录/凭据导入环境入口不再读取。Pi 的 `models.json` / `auth.json` 永不被导入。

原生配置示例（示意字段，实际以 DSH 格式为准）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      example:
        displayName: Example
        api: anthropic-messages
        baseURL: https://gateway.example/v1
        apiKeyEnv: EXAMPLE_API_KEY      # 凭据引用，不写密钥
        models:
          - id: example-model
            contextWindow: 262144
            maxTokens: 32768
- id: agent-default-model
  config:
    provider: example
    model: example-model
```

说明：

- 路由键就是 `provider/model` 中的 provider；只有原生配置声明的路由才会出现在 `/model`。
- `headers` 不应保存真实密钥；使用 `apiKeyEnv` 或 DSH 原生凭据引用。本层不提取、迁移或打印凭据。
- 自动标题在 `/settings` 选择 inherit/on/off，切换的是原生标题插件；启用后由 DSH 决定是否产生模型请求，TUI 不另建 LLM 客户端。

## 错误路径

明确失败、不会静默降级的情况：

- 原生 `listProviders` / `listModels` 未挂载：不声明模型目录；
- provider 查询失败：显示脱敏后的原生错误，成功行照常显示；
- 目标模型 metadata 缺失：不携带显式 effort，模型选择仍完成；
- 默认保存无法证明落盘：返回 `defaultsPersisted:false`，不宣称永久生效；
- profile 未组合本插件、组合了第二个前端或模型路由不存在：由 DSH/插件报错，不自动创建 profile 或借用其他凭据。

## 测试与真实请求

- 离线测试使用 fake Cordis 宿主，只验证公开服务的投影、选择、effort 携带、默认元数据与错误路径；不访问真实 provider、不读真实 profile/凭据/会话日志。
- `scripts/live-providers-smoke.ts` 已删除。只保留明确 opt-in 的 `scripts/live-smoke.ts`：它通过原生 CLI 启动完整 TUI 并发送一个小 prompt，手动运行、不推荐自动执行：

```bash
DSH_TUI_LIVE=1 DSH_TUI_LIVE_PROFILE=dsh-tui node scripts/live-smoke.ts
```

- 历史 CloudAgent 实网数字（chunk 数、首段延迟等）只记录当时的路由状态，不是当前健康证明。当前完整验收范围与结果见 [验收记录](ACCEPTANCE.md)。