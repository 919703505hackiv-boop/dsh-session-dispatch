# dsh-session-dispatch

给模型用的「会话派发」插件：让模型自己新开工作区会话、发指令、等结果、读回复，把子任务丢进独立上下文里跑。

Model-facing session dispatch for DeepSeek Harness (DSH): create workspace conversations, send prompts into them, wait for a turn to finish, and read the reply — all from tool calls.

- 包名 / package: `dsh-session-dispatch`
- 版本 / version: `0.1.0`
- 兼容 / compatibility: DSH `>=0.2.0 <0.3.0`, Node.js `>=22`
- 许可证 / license: MIT

---

## 中文

### 解决什么问题

DSH 的 Session Controller 本来就能新建会话、给会话发消息（Web 界面走的就是这套），但这套能力没有暴露成模型可调用的工具。于是模型只能用 `subagent` 这类「一次性任务」模型，无法：

- 把任务派发到一个**独立、持久、用户可见可接管**的工作区会话；
- 在任务跑的时候先去做别的事，之后再回来读结果；
- 用 `steer` 给正在跑的会话追加指令。

这个插件把五步做成同进程内的工具调用。会话就是真正的顶层 Session，会出现在工作区会话列表里，屋主可以直接打开继续聊。

### 五个工具

| 工具 | 作用 | 关键点 |
| --- | --- | --- |
| `conversation_create` | 新建顶层会话，返回 `sessionId` | `cwd` 默认继承调用方；可传 `agentPreset` |
| `conversation_send` | 往会话里发文本 | 默认排队起新一轮；`mode: "steer"` 注入当前轮 |
| `conversation_wait` | 等当前/下一轮 assistant 回合结束 | 返回 `state: "idle" \| "timeout"`、`lastReason`（**永远是字符串**）、`running` |
| `conversation_read` | 读最近回复和回合状态 | 返回 `live`、`running`、`turns`、`lastTurnReason`、`text`、`truncated` |
| `conversation_list` | 列出本进程内存活会话 | 可按绝对路径 `cwd` 过滤 |

典型流程：

```text
conversation_create({ cwd })
  → conversation_send({ sessionId, text: "把 xxx 做完" })
  → conversation_wait({ sessionId })
  → conversation_read({ sessionId })
```

### 安装

npm 发布之后（见文末「发布步骤」）：

```bash
dsh plugin --profile web add dsh-session-dispatch
```

安装后**重启 DSH**，五个工具才会出现在模型工具表里。安装会做两件事：把包加进 profile 的 `dsh.profile.bundles`，并应用包内的 `cordis.patch.yml` 层。

本地目录安装（未发布时调试用）：

```bash
dsh plugin --profile web add ./plugins/dsh-session-dispatch
```

检查层是否生效：

```bash
dsh --profile web --dump-config   # 应出现 "# == dsh-session-dispatch" 层
```

> 如果 profile 里还留着旧版 `dsh-session-dispatch3`（row id `tool-session-dispatch3`），先删掉它再装这个包。两个插件注册同名工具，同时启用会因工具名重复而失败。

### 配置

`cordis.patch.yml` 只做一件事：把插件行插进 profile。

```yaml
- insert:
    - id: tool-session-dispatch
      name: dsh-session-dispatch
```

`name` 必须和 npm 包名完全一致；`id` 在 profile 内保持唯一。没有其它必填配置。环境变量（都可选）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_DISPATCH_LOG` | `os.tmpdir()/dsh-session-dispatch.log` | 调试日志路径；`off` / `0` / `none` 关闭 |
| `DSH_DISPATCH_TZ` | 系统时区 | 写进用户消息 source 的 `clientTimeZone` |
| `DSH_DISPATCH_START_GRACE_MS` | `8000`（最小 5） | `conversation_wait` 发现会话已空闲时，等待新回合的宽限时间 |

插件不写自己的数据库，不改会话日志格式；唯一的落盘是可选调试日志。

### 自测

不依赖 DSH 运行时，纯 Node：

```bash
node plugins/dsh-session-dispatch/test.mjs
# 18/18 通过

node --check plugins/dsh-session-dispatch/index.js
```

自测覆盖：五个工具都注册、缺 `sessionId` 明确报错、`conversation_wait` 在「回合结束但没有 reason」和「超时」两条路径都返回字符串 `lastReason`（历史上这里返回过 `null`，会撞上输出 schema 的类型校验）。

### 已知限制与实战坑

1. **HMR 不会重载 host 插件。** 改完 `index.js` 必须重启 DSH；新开一个聊天不会重新加载插件模块。
2. **同名同版本不会重新生效。** ESM 模块缓存按解析后的路径/包名走；把旧目录原地改文件、或对同一个包名重复 `add` 同一版本，进程里仍是旧模块。可靠做法是**换新包名**（这也是本包从 `dsh-session-dispatch3` 改名为 `dsh-session-dispatch` 的原因）+ 重启，或先 `dsh plugin --profile web remove <旧包>` 再装。
3. **发布后版本不可覆盖。** 任何改动都要升 `version` 再 `npm publish`；调试本地包建议用 `0.1.1-dev.N`。
4. **只对同一 host 进程内的 live 会话有效。** `conversation_read` 返回 `live: false` 表示该会话不在当前进程（可能在别的 DSH 实例里），只能读到空结果。
5. **`conversation_wait` 的等待语义。** 会话已空闲时最多等 `DSH_DISPATCH_START_GRACE_MS` 才返回 `idle`；`timeoutMs` 默认 120000、上限 600000，不要用超大 timeout 占住工具调用。
6. **`conversation_create` 默认继承调用方工作区。** 跨工作区要显式传绝对 `cwd`，并且仍然受 DSH 的审批/权限策略约束。
7. **依赖 Web/Desktop profile 的宿主服务。** 插件 `inject` 了 `tools`、`sessionController`、`sessions`、`agents`；没有这些服务的 headless profile 会加载失败。`conversation_send` 依次尝试 `controller.commands.prompt` → `controller.prompt` → `agent.followup`，失败时把三条链路的原因汇总在错误里。
8. **1024Store 安装只认 npm 已发布包。** 没发布时目录只会以「浏览模式」收录（有仓库链接、无安装命令）。

### 发布步骤（屋主操作清单）

当前环境没有 npm 凭据、没有 GitHub 写权限，以下动作需要屋主执行：

1. **合入默认分支。** 把 `ds/plugin/session-dispatch` 合到 GitHub 默认分支并 push。1024Store 的静态审查读的是默认分支 tree，`plugins/dsh-session-dispatch/package.json` 与 `cordis.patch.yml` 必须在同一 revision 里。
2. **确认包名可用。**
   ```bash
   npm view dsh-session-dispatch version
   ```
   2026-11-01 查询为 404（未占用）。如果之后被占，改用 `@919703505hackiv-boop/dsh-session-dispatch`，同时改 `package.json` 的 `name`、`cordis.patch.yml` 的 `name`、README 的安装命令。
3. **登录 npm 并检查打包内容。**
   ```bash
   npm login                      # 需要 2FA 或 Automation token
   cd plugins/dsh-session-dispatch
   npm pack --dry-run             # 必须包含 index.js、cordis.patch.yml、README.md、LICENSE
   ```
4. **发布。**
   ```bash
   npm publish --access public
   ```
5. **发布后验证。**
   ```bash
   npm view dsh-session-dispatch@0.1.0 version dist.tarball
   dsh plugin --profile web add dsh-session-dispatch
   ```
   重启 DSH，确认五个 `conversation_*` 工具出现、`conversation_create` 能开出一个可见会话。
6. **给仓库加 GitHub topic `dsh-plugin`。** 自动收集服务靠它发现仓库。
7. **提交 1024Store 收录 PR。**
   - fork `imsai-sh/awesome-deepseek-harness-plugins`；
   - 把本目录的 `catalog-entry.json` 复制为
     `catalog/plugins/919703505hackiv-boop--chat-build-3d--plugins--dsh-session-dispatch.json`
     （字段已经按 `catalog/schema/plugin.schema.json` 写好；`$schema` 是相对目标目录的路径，所以本目录里的原文件只是模板）；
   - 该 PR **只允许改这一个文件**，`added` 保持 `2026-11-01`，`category` 为 `session`；
   - 静态审查会校验 package.json 的 `dsh.bundle.patch` 字段和 patch 文件是否存在，通过后自动 squash merge，CI 同步到 deepseek1024.com。
8. **后续发版。** 改代码 → 升 `version` → `npm publish` → 等目录自动检测新版本（收录条目不用改）。不要覆盖旧版本。

### 目录结构

```text
plugins/dsh-session-dispatch/
├── package.json          # npm 元数据 + dsh.bundle.patch 声明
├── cordis.patch.yml      # bundle 层：insert 插件行
├── index.js              # 五个工具的实现（纯 ESM）
├── test.mjs              # 纯 node 自测（18 项）
├── catalog-entry.json    # 1024Store 收录条目模板
├── README.md
└── LICENSE
```

---

## English

### What problem it solves

DSH's Session Controller can already create conversations and prompt them — that is exactly what the Web UI does — but none of it was exposed as model-callable tools. With this plugin the model can dispatch a task into an **independent, persistent, user-visible** workspace conversation, keep working elsewhere, and read the result later, or `steer` a running turn.

The created conversation is a real top-level Session: it shows up in the workspace conversation list and the human can open and continue it by hand.

### The five tools

| Tool | Purpose | Notes |
| --- | --- | --- |
| `conversation_create` | Create a top-level conversation, return `sessionId` | `cwd` inherits the caller by default; optional `agentPreset` |
| `conversation_send` | Send text into a conversation | Queues a new turn; `mode: "steer"` injects into the running turn |
| `conversation_wait` | Wait for the current/next assistant turn to end | Returns `state: "idle" \| "timeout"`, `lastReason` (**always a string**), `running` |
| `conversation_read` | Read the latest reply and turn state | Returns `live`, `running`, `turns`, `lastTurnReason`, `text`, `truncated` |
| `conversation_list` | List conversations live in this host process | Optional absolute `cwd` filter |

### Install

After the package is published to npm:

```bash
dsh plugin --profile web add dsh-session-dispatch
```

Restart DSH afterwards; only then the five tools appear in the model's tool set. For an unpublished local checkout:

```bash
dsh plugin --profile web add ./plugins/dsh-session-dispatch
```

Verify the bundle layer with `dsh --profile web --dump-config` (look for `# == dsh-session-dispatch`). Remove an older `dsh-session-dispatch3` row first — it registers the same tool names.

### Configuration

`cordis.patch.yml` inserts one row (`id: tool-session-dispatch`, `name: dsh-session-dispatch`). Optional environment variables: `DSH_DISPATCH_LOG` (default `os.tmpdir()/dsh-session-dispatch.log`, set `off` to disable), `DSH_DISPATCH_TZ` (default system time zone), `DSH_DISPATCH_START_GRACE_MS` (default 8000, min 5).

### Test

```bash
node plugins/dsh-session-dispatch/test.mjs
# 18/18 passed

node --check plugins/dsh-session-dispatch/index.js
```

### Known limitations

1. **HMR does not reload host plugins.** Restart DSH after editing `index.js`; a new chat does not reload modules.
2. **Same name + same version will not take effect.** Module caches key on the resolved package. Change the package name (that is why this package is `dsh-session-dispatch`, not `...dispatch3`) and restart, or remove the old bundle before adding the new one.
3. **Published npm versions are immutable.** Bump `version` for every change; use `0.1.1-dev.N` while iterating locally.
4. **Only live sessions in the same host process work.** `live: false` means the session belongs to another process/instance.
5. **`conversation_wait` semantics.** An already-idle conversation returns `idle` after the start grace; `timeoutMs` defaults to 120000 and is capped at 600000.
6. **`conversation_create` inherits the caller's cwd** unless an absolute `cwd` is passed; DSH approval/permission policy still applies.
7. **Needs the Web/Desktop host services** (`tools`, `sessionController`, `sessions`, `agents`). `conversation_send` falls back from `controller.commands.prompt` to `controller.prompt` to `agent.followup` and aggregates all failure reasons.
8. **1024Store installs npm packages only.** Without a published npm package the catalog lists the plugin browse-only.

### Publishing checklist (repository owner)

The current environment has no npm credentials and no GitHub write access. To publish:

1. Merge `ds/plugin/session-dispatch` into the GitHub default branch and push (the catalog static review reads the default branch tree).
2. `npm view dsh-session-dispatch version` — unclaimed as of 2026-11-01; otherwise switch to `@919703505hackiv-boop/dsh-session-dispatch` and update `package.json`, `cordis.patch.yml`, and the install commands.
3. `npm login` (2FA or automation token), then `npm pack --dry-run` inside this directory and confirm `index.js`, `cordis.patch.yml`, `README.md`, `LICENSE` are included.
4. `npm publish --access public`.
5. Verify with `npm view dsh-session-dispatch@0.1.0` and `dsh plugin --profile web add dsh-session-dispatch`, then restart DSH and run `conversation_create`.
6. Add the GitHub topic `dsh-plugin` to the repository.
7. Fork `imsai-sh/awesome-deepseek-harness-plugins`, copy `catalog-entry.json` to `catalog/plugins/919703505hackiv-boop--chat-build-3d--plugins--dsh-session-dispatch.json`, and open a PR that changes only that file (`added: "2026-11-01"`, `category: "session"`). The static review validates `dsh.bundle.patch` and the patch file's presence in the same revision, then auto-merges and syncs the catalog.
8. For later releases: bump `version`, publish, and let the catalog detect the new npm version.
