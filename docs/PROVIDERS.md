# 模型与提供方：只用 DSH 原生配置

`dsh-tui`（DSH TUI）不再导入 Pi 的 `models.json` / `auth.json`，也没有 `--models-file`、`DSH_PI_TUI_MODELS_FILE`、`DSH_PI_TUI_IMPORT_MODELS` 等迁移入口。这些旧入口不会触发任何文件读取：`--models-file` 会直接以原生配置说明失败退出，环境变量只会产生一条“已不再读取”的 warning。

模型提供方、模型目录、默认模型与凭据全部来自 DeepSeek Harness 本身，并由真实 `dsh` 启动器按原生顺序组合：

1. profile 的 `dsh.profile.bundles` 组合包层（`$DSH_HOME/profiles/<name>/package.json`）；
2. 该 profile 自己的 `cordis.patch.yml`（原生配置编辑器写入的位置）；
3. home 级 `$DSH_HOME/cordis.patch.yml`（优先级高于 profile 层）；
4. 本 TUI 的 `--patch` overlay（只插入 bridge 并关闭 HMR / LLM 标题生成）。

TUI 不复制 YAML 合并、provider 目录、模型别名、能力推断或凭据迁移逻辑。DSH 自带的 `@deepseek-ai/dsh-llm-pi-ai` 是 DSH 的适配器；请求、SSE、重试、工具、权限、会话与取消都属于 DSH。

## 选择 profile

```bash
# 复用某个真实 DSH profile 的 provider / 默认模型 / 凭据
./bin/dsh-tui.mjs --profile <name>

# 显式指定路由（例如 profile 里已配置该 route/model）
./bin/dsh-tui.mjs --profile <name> --model <provider>/<model>
```

- 不传 `--profile`：使用 DSH 自己的 `DEFAULT_PROFILE_BUNDLES`（`@deepseek-ai/dsh-base`）组合，叠加所选 home 的原生 home patch 与凭据。这是本应用自己的 profile，不会写入用户已有 profile。
- 传 `--profile <name>`：先由 DSH 公共 API（`resolveProfileDir` / `readProfileManifest` / `resolveBundleDir`）解析该 profile，再由真实启动器以 `dsh --profile <name>` 组合。该 profile 的 `cordis.patch.yml`、home patch、`compatibility.json`、profile 本地插件依赖都会被原生读取。
- 默认模型：profile 的 `agent-default-model` 配置生效；home patch 若配置同一行则按原生优先级覆盖。TUI 不猜测“第一个 provider”或“第一个 profile”。
- 凭据：`apiKeyEnv` 之类的引用由 DSH 凭据层解析（存储文件 → 启动环境 → 项目 `.env` → home `.env`）。TUI 不读取 Pi 认证、不执行凭据命令、不写凭据文件。

### 前端替换范围

DSH profile 本身描述的是一个应用界面：`web`、`desktop`、`headless`、`acp`、`sdk`，以及第三方 TUI 组合包。DSH TUI 拥有终端与根 Agent，因此会替换应用前端组合包，避免启动第二个前端、第二个根 Agent 或第二个 stdin 消费方：

- **被替换**：`PROFILE_TEMPLATES` 中出现的 DSH 随附应用组合包（例如 `@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`），以及已知的旧版 TUI 组合包 `@deepseek-harness-tui/dsh-tui`。
- **保留**：`@deepseek-ai/dsh-base` 与其余普通插件组合包；仅仅带有工具 `bin` 的普通插件不会被误判为应用前端。profile 的配置 patch 行全部保留并原生生效（provider 路由、默认模型、插件设置等）。
- 每次替换都会在启动后产生一条 warning，说明被替换的组合包与原因，不会静默丢弃。
- profile/home patch 若插入已识别前端且该行有稳定 `id`，本应用只在私有最高优先级 overlay 中 `disabled: true` 该精确行，用户 patch 原文不变；这样可复用 `dsh-tui` profile 的原生模型配置而不启动旧 TUI。
- 被替换组合包自己的 patch 行如果不再有对应条目，由原生 launcher 在诊断管道中报告（不是 TUI 的合并逻辑）。

明确失败（不会猜测或降级）的情况：

- profile 名称非法（含路径分隔符等）或不存在；
- profile 未挂载共享核心组合包（如只列 `dsh-sdk-minimal`）；
- profile patch 或 home patch **插入**了已知应用前端，但该行没有稳定 `id`，无法在 scratch overlay 中安全禁用（错误会点名 patch 文件与包名）。有 `id` 的行会自动禁用，不算失败。

## 原生配置示例

在所选 profile 的 `cordis.patch.yml` 中（这是 DSH 自己的格式，示例仅示意字段）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      cloudagent:
        displayName: CloudAgent
        api: anthropic-messages
        baseURL: https://gateway.example/v1
        apiKeyEnv: CLOUDAGENT_API_KEY   # 凭据引用，不写密钥
        headers:
          Authorization: Bearer ...     # 仅非密钥的部署头；密钥请用凭据引用
        models:
          - id: deepseek-v4.1-flash-1017
            contextWindow: 262144
            maxTokens: 32768
- id: agent-default-model
  config:
    provider: cloudagent
    model: deepseek-v4.1-flash-1017
```

说明：

- 路由键（`cloudagent` 等）就是 `provider/model` 中的 provider；只有原生配置里声明过的路由才会出现在 `/model` 目录中。
- 没有配置任何 pi-ai 路由时，`llm-pi-ai` 保持 dormant：目录里只有 DSH 自带的 `deepseek-official` / `deepseek-account` 等路由，具体模型取决于凭据与目录。
- 旧文档里的 `cloudagent/deepseek-v4.1-flash-1017` 只有在上述原生路由已配置时才可用；`dsh-tui` 不会从 Pi 文件把它“变出来”，也不会改动 DSH 原有默认模型。
- 通过 DSH settings 写入的配置落在“当前 profile 的 patch”。本 TUI 的 profile 目录是每次启动的私有 scratch（见下），因此这类写入不会持久化到你的 home；需要持久化时请在真实 profile 上配置后用 `--profile` 复用。
- profile patch 的 `headers` 里如果保存了真实 Bearer 密钥，建议改成 `apiKeyEnv` 或 DSH 原生凭据引用；TUI 不会读取、迁移或打印该值，但把密钥放在 patch 文本里不利于轮换。
- 推理级别（`reasoningEfforts`）、`compat`、`modelOverrides` 等同样是 DSH 原生字段；TUI 不投影、不推断。

## Home 隔离（必要的 glue 与限制）

DSH `0.2.1-rc.5` 对整个进程只解析一个 `DSH_HOME`，没有 overlay-home 接缝。因此后端保留最小隔离 glue：

- 每次启动创建一次性私有 home（`mkdtemp`），`DSH_HOME` 指向它；退出即删除。
- 私有 home 中以符号链接继承所选 home 的真实数据：`sessions`、`storages`、`attachments`、`cache`、`skills`、`llm-deepseek`，以及 `.credentials.yaml`、`.env`、`.anonymous-user-id`。home 的 `cordis.patch.yml` 会被复制，并实体化其相对插件资源，保证模块仍在 scratch home 内解析。
- 旧版 `settings.yaml`（若存在）**复制**到私有 home 后再由 DSH 导入，避免 DSH 的导入归档动作改写用户文件。
- `--profile` 指定的 profile 镜像到私有 home：`cordis.patch.yml` 被复制，且其 `./` 相对插件资源一并实体化，保证 Node 在 scratch profile 内解析模块；`compatibility.json`、`node_modules` 等仍以链接读取。只有启动器必然重写的 `cordis.yml` 与新 manifest 写在 scratch 里。用户 profile 目录不会被写入。
- 清理只删除私有 scratch；所选 home 与链接目标都属于用户。

**已知限制：** durable 的是所选 home 的会话数据与凭据；私有 profile 内通过 DSH settings 写入的配置不持久化。若上游提供原生 overlay-home 接缝，这段 link glue 应被替换，而不是删除继承语义（直接删除会让用户丢失凭据、会话与技能）。

## 测试与复测

离线测试（`test/backend-native-profile.test.ts`、`test/backend-native-profile-stream.test.ts`）使用临时 home / workspace 与假 key，覆盖：

- 原生 profile 选择、已识别前端替换范围、utility bin 保留与明确失败；
- profile 镜像只读、相对插件资源在 scratch 内解析、bridge overlay 为最高优先级、scratch 清理；
- 真实 `dsh-llm-pi-ai` 的 Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三条 loopback SSE 路径：结束事件被测试扣住，逐步上屏前缀、编辑草稿、取消、最终去重与 revision 递增；
- profile 默认模型传播与 home-vs-profile 原生优先级；
- 旧 Pi 环境指针不进入目录，`--models-file` 明确失败。

不会读取真实 `.credentials` / Pi 认证，也不会执行 OAuth 或凭据命令。

显式真实请求复测（会发送有界真实 prompt，不属于常规测试，也不在委派任务中执行）：

```bash
# 使用你原生配置好的 profile 与真实 DSH home
DSH_TUI_LIVE=1 \
DSH_TUI_LIVE_PROFILE=<name> \
node scripts/live-providers-smoke.ts

# 只测一条，或逗号分隔多条（route 必须已在原生配置中声明）
DSH_TUI_LIVE=1 \
DSH_TUI_LIVE_PROFILE=<name> \
DSH_TUI_LIVE_MODELS='cloudagent/deepseek-v4.1-flash-1017' \
node scripts/live-providers-smoke.ts
```

脚本要求生成中的多次正文画面，而不是只统计最终 chunk 数；`DSH_TUI_LIVE_DSH_HOME` 可把 DSH 数据目录指到隔离 home（但那样就需要该 home 自己具备原生路由与凭据）。

本机独立复测（原生 `--profile dsh-tui`，旧 TUI 行仅在 scratch overlay 禁用，未读 Pi 文件）：`cloudagent/deepseek-v4.1-flash-1017` 收到 235 个文本 chunk、1115 字符，结束前 171 个不同正文画面，1 秒内出现首段文本，正常结算、未请求工具、无错误。单条 `live-smoke` 也返回 `dsh-tui-ok`。这证明的是该 profile 当前配置的路由，不是全部模型逐项健康。