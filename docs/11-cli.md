<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 11 章 CLI 命令设计；原文照录，未修改技术内容。 -->

# 11. CLI 命令设计

v1.24 对本章做了结构性重排（P2-01/P2-02），并修复 v1.23 中参数示例的重复与拼接错误（原文"缺省 activeRoot--root"一节为拼接残留，已删除并按表重列）。

## 11.1 命令分层（控制复杂度）

按"生命周期 / 查询 / 治理 / 审计 / 接入 / 测试"六类分组，同类命令的参数结构必须一致。命令总数从 v1.23 的 23 个收敛为 **21 个主命令 + 4 个兼容别名**（`query` 并入 `search`；`mcp-config` / `agents` / `skill` 合并为 `print <asset>` 并保留别名）。

| 分组 | 主命令 | 作用 | 是否有副作用 |
|---|---|---|---|
| 生命周期 | `nex init` | 探测根、生成配置与索引目录骨架 | 写 `.nexus/`（需确认） |
| | `nex build` | 全量构建（按 root 分发） | 写 `.nexus/` |
| | `nex update` | 增量更新（按 root 失效） | 写 `.nexus/` |
| | `nex status` | 状态、覆盖、健康、能力声明；**永不报错** | 只读 |
| | `nex doctor` | 环境/配置/数据库/一致性诊断，`--repair` 修自身数据 | 只读 / 写 `.nexus/` |
| 查询 | `nex symbol` | 符号详情（含身份历史 `--history`） | 只读 |
| | `nex references` | 引用全集（按三分类计数） | 只读 |
| | `nex deps` | 依赖与架构模块（含样式反向） | 只读 |
| | `nex impact` | 变更影响与风险 | 只读 |
| | `nex search` | 按名称/类型/路径检索（原 `query` 并入） | 只读 |
| | `nex context` | 分层上下文供给（支持 `--cursor`） | 只读 |
| 治理 | `nex api-snapshot` | 生成/更新基线 | 写 `nexus.baseline.json` |
| | `nex api-diff` | 语义化差分 | 只读 |
| | `nex similar` | 相似 API 检索 | 只读 |
| | `nex audit-duplicates` | 重复实现巡检 | 只读 |
| 审计 | `nex preflight` | 变更前审计编排 | 只读（可写 `--output-file`） |
| | `nex postflight` | 变更后审计编排 | 只读（可写 `--output-file`） |
| | `nex verify` | 受授权白名单的检查命令编排 | 执行用户授权命令 |
| 接入 | `nex print <asset>` | 打印 mcp-config / agents / skill 片段 | 只读（**永不写文件**） |
| | `nex mcp` | 启动 MCP 服务（`--watch` / `--read-only` / `--auto-bootstrap`） | 写 `.nexus/`（非 read-only） |
| 测试 | `nex test` | 运行夹具与一致性测试 | 写临时目录 |

兼容别名（保留，不推荐新使用）：`nex query` → `nex search`；`nex mcp-config` → `nex print mcp-config`；`nex agents` → `nex print agents`；`nex skill` → `nex print skill`。别名在 `--help` 中不出现在主列表，仅在"兼容"附注中列出。

## 11.2 全局参数（所有命令通用）

| 参数 | 值域 | 默认 | 说明 |
|---|---|---|---|
| `--format <fmt>` | `pretty` \| `lines` \| `json` \| `markdown` | 见 11.4 | 输出格式；非法值报错退出 64，不回落 |
| `--color <mode>` | `auto` \| `always` \| `never` | `auto` | 仅影响 pretty |
| `--no-color` | flag | — | 等价 `--color never` |
| `--width <n>` | 正整数 | `min(COLUMNS, 120)` | 仅影响 pretty |
| `--pager <mode>` | `auto` \| `off` | `auto` | 仅 pretty + TTY 生效；非 TTY 强制 off |
| `--compact` | flag | 关 | 与 `--format pretty` 同现时被忽略，stderr 提示一句，不报错 |
| `--verbose` | flag | 关 | 诊断信息写 stderr，不污染 stdout |
| `--quiet` | flag | 关 | 只输出结果，不输出进度与提示 |
| `--explain` | flag | 关 | 输出判定依据（`relationClass` / `confidence` / `evidence`） |
| `--no-truncate` | flag | 关 | 要求完整输出；超大结果改为分页游标 |
| `--budget-hint <tokens>` | 正整数 | 无 | 软性预算提示；超预算只降级层次，不删条目 |
| `--cursor <token>` | 字符串 | 无 | 续读游标 |
| `--output-file <path>` | 路径 | 无 | 显式落盘；默认不写任何文件 |
| `--root <rootId>` | 字符串 | `activeRoot` | 单 root；与 `--roots` 互斥（同现报 64） |
| `--roots <sel>` | `all` 或逗号分隔 | `activeRoot` | 多 root 范围；与 `--root` 互斥 |
| `--yes` | flag | 关 | 非交互确认（等价于对所有确认回答 yes） |
| `--non-interactive` | flag | 自动检测 | 强制非交互；任何需要输入的场景改报错并给出所需参数 |
| `--version` | flag | — | 打印版本、包名、Node 版本、构建指纹（若在项目内） |
| `--help` | flag | — | 分组帮助；`nex <cmd> --help` 显示该命令参数与 2 个示例 |

**参数一致性规则**（P2-01）：

1. 同一语义只允许一个参数名。跨包的路径范围一律用 `--root` / `--roots`，不允许某些命令用 `--package`、另一些用 `--workspace`。
2. 布尔开关统一 `--flag` / `--no-flag` 形态，不使用 `--flag=true`。
3. 所有列表型输出共享 `--cursor` / `--no-truncate` / `--budget-hint` 三个参数，不允许某命令自造 `--page` / `--limit`。
4. 破坏性操作（`api-snapshot` 覆盖基线、`doctor --repair`、`init --write-config`）必须显式确认；非 TTY 下必须 `--yes`，否则退出 64 并打印所需参数。

## 11.3 命令专有参数（只列差异，避免重复）

| 命令 | 专有参数 |
|---|---|
| `init` | `--roots <sel>`、`--write-config`、`--force`（覆盖已有配置，需 `--yes`） |
| `build` | `--serial`、`--rebuild`、`--budget-mb <n>`（单 root 上限） |
| `update` | `--rebuild-affected`、`--files <glob>` |
| `status` | `--roots <sel>`、`--json-schema`（打印输出 Schema） |
| `doctor` | `--schema`、`--mcp`、`--dump-vue-map <file>`、`--repair`（需 `--yes`） |
| `symbol` | `--history`、`--expand` |
| `references` | `--no-template`、`--depth <n>`、`--include-heuristic` |
| `deps` | `--reverse`、`--type <style\|module\|file>` |
| `impact` | `--symbol <name>`、`--depth <n>` |
| `search` | `--type <kind>`、`--path <dir>`、`--public` / `--internal` |
| `context` | `--task <text>`、`--context-lines <n>` |
| `api-diff` | `--base <ref\|file>`、`--fail-on <breaking\|additive\|ambiguous>` |
| `similar` | `--top <n>`、`--scope <public\|all>` |
| `audit-duplicates` | `--threshold <0..1>` |
| `preflight` / `postflight` | `--base <ref>`、`--fail-on <...>`、`--report <md\|json>` |
| `verify` | `--only <ids>`、`--dry-run` |
| `print` | `<asset>`（必填，三选一）、`--client <dsh\|claude\|cursor>`（仅 mcp-config） |
| `mcp` | `--watch`、`--read-only`、`--auto-bootstrap` |
| `test` | `--fixtures <dir>`、`--project <name>`、`--scale <n>` |

## 11.4 格式与优先级

- **CLI** 的 `--format` 优先级（自高到低）：`--format` → `NEXUS_FORMAT` 环境变量 → `output.format` 配置 → `stdout.isTTY ? pretty : lines`。
- **MCP** 通道值域仅 `lines` / `json`，默认 `lines`（14.1.5）。
- `--format` 非法值严格报错（列出合法枚举、退出码 64），不回落。
- 默认输出为适合 Agent 阅读的紧凑行格式；JSON 模式必须严格遵循版本化 Schema（`nex status --json-schema` 可打印）。
- 错误输出的机器层必须包含 `code`、`category`、`reason`、`file`、`suggestion`（16.3）；人读层按 16.4 的四行格式，不以错误码开头。

## 11.5 退出码（v1.24 修订，P2-02）

| 退出码 | 含义 | 典型场景 |
|---|---|---|
| 0 | 成功，无阻断项 | 查询正常返回；`api-diff` 无 breaking |
| 1 | 存在阻断项 | `--fail-on breaking` 命中；索引损坏；构建失败 |
| 2 | 仅有告警（不阻断） | 存在 heuristic/unresolved 影响面；样式依赖警告 |
| 64 | 用法错误 | 参数非法、互斥参数同现、非 TTY 缺必需参数 |
| 70 | 内部错误 | 未捕获异常、断言失败（必须附 `code=E23` 与复现信息） |

**变更说明**：v1.23 只定义 0/1/2 三档，且"参数错误"无专属码。v1.24 明确 64/70，属补充定义而非改写既有语义（0/1/2 含义不变）。CI 若依赖"非零即失败"，无需修改；若依赖"退出码 2 = 告警"，同样不受影响。**禁止**用自然语言错误信息判断失败类型，必须读 `code`。

## 11.6 非 TTY 与交互（v1.24 新增，跨章节冲突 5.2 的落地）

| 场景 | TTY 行为 | 非 TTY 行为 |
|---|---|---|
| `init` 根选择 | 列表 + 选择 | 必须 `--roots`，否则 E15 |
| `init` 写配置 | 一次确认 | 必须 `--write-config` + `--yes`，否则只打印 |
| `doctor --repair` | 确认后执行 | 必须 `--yes` |
| `api-snapshot` 覆盖 | 确认后覆盖 | 必须 `--yes` |
| 破坏性 `--force` | 二次确认 | 必须 `--yes` |
| 长任务进度 | stderr 刷新 | stderr 输出有限行数摘要（不刷屏） |
| 分页 | 按 `--pager` | 强制 off |

**硬规则**：任何命令在非 TTY 下都不得因等待输入而阻塞。检测到需要输入且没有 `--yes` / 必需参数时，立即以 64 退出并打印"缺失的参数名 + 可直接复制的完整命令"。这是 CI 与 Agent 场景的基本要求。---

