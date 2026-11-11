<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 14 章 Agent 接入协议；原文照录，未修改技术内容。 -->

# 14. Agent 接入协议

必须提供统一的 CLI 与 MCP 接口，MCP 为可选组件。两层共用同一套业务逻辑，禁止分别实现两套查询规则。

## 14.1 MCP 工具集（8 个工具，仅 refresh 可写索引）

| 工具 | 职责 |
|---|---|
| `status` | 项目概览、索引状态、staleness、覆盖范围、引导态、二进制自检、能力声明 |
| `search` | 按名称 / 类型 / 路径检索符号与 API |
| `symbol` | 符号详情：签名、可见性、Surface 归属、身份置信度、组件 Props/Emits/Slots |
| `references` | 引用全集（按 certain / heuristic / dynamicUnresolved 三分类计数） |
| `deps` | 依赖与架构模块信息 |
| `impact` | 变更影响、风险等级、关联测试 |
| `context` | 按任务生成分层上下文（支持 cursor 续读） |
| `refresh` | 增量刷新索引（唯一可写工具，仅写 `.nexus/`） |

设计原则：参数最少、幂等、可裁剪、返回必带 `coverage` 与 `staleness`。工具数量固定为 8；多根仓库不新增工具，8 个工具统一加可选 `root` / `roots` 参数；样式能力不新增工具，只在 `deps` / `impact` 的返回体增加 `styleDependents` 与 `styleCoverage`，`status` 增加 `capabilities.styleDependency`。

**（v1.24 新增）`status` 必含字段**：

```text
state: uninitialized | ready
staleness: fresh | dirty | indexing | stale | failed     （12.4）
buildFingerprint: "bf_xxx…"（前 12 位）
rootId / activeRoot / roots[]
coverage: { fileCoverage, semanticCoverage, filesIgnored, filesFailed, unresolvedRate }
capabilities: {
  styleDependency: "file-level",
  styleSelector: "none",
  htmlFileRef: "experimental-off",
  mcpFormats: ["lines","json"],
  relationClasses: ["certain","heuristic","dynamic-unresolved"]
}
self: { serverVersion, packageName, binaryPath, projectRoot, nodeVersion }
lastIntegrityCheck: { result, at }
degraded: string[]
```

**工具名与返回字段是稳定契约**：改名或删改字段视为破坏性变更，须走 6.x 的 Surface 变更流程。新增字段允许（向后兼容），但必须在 `status.capabilities` 中提前一个版本声明。

### 14.1.1 refresh 的边界与护栏

签名：`refresh({ mode?: "incremental", timeoutMs?: 10000, root?: string })`。返回必带 `indexMutation: true`、`filesUpdated`、`buildFingerprint`、`staleness`。

1. **只增量，禁止全量**：遇到 12.1 表中需要全局重建的变更（tsconfig、路径别名、分析器或 Schema 版本、`symbolId` 算法），refresh 直接拒绝并返回「请在终端执行 nex update」；package.json 与锁文件变化只触发依赖图与外部符号解析重建，也一并拒绝，交由 CLI 统一处理。
2. **规模上限**：默认 200 个改动文件（样式文件计入同一上限），超限拒绝并建议走 CLI。
3. **与 CLI 共用锁**：同一把 `proper-lockfile`；持锁时返回 E08，不并发写。
4. **幂等**：`buildFingerprint` 未变化时返回 `changed: 0, noop: true`，不产生任何写入。
5. **只写 `.nexus/`**：不碰源码与配置、不新建目录；执行后 `git status --porcelain` 必须仍为空。
6. **（v1.24 新增）** 返回体必须带 `degraded`，让调用方知道本次刷新是否降级（例如关闭了 calls 索引）。

### 14.1.2 运行模式

| 模式 | 启动方式 | 行为 | 适用 |
|---|---|---|---|
| watch | `nex mcp --watch` | 进程内监听文件，500ms 去抖后自动增量；查询返回 `fresh`，或短暂 `indexing` | 日常开发，默认推荐 |
| 手动 | `nex mcp` | 不监听，只提供 refresh 供 Agent 显式调用 | 客户端收不到文件事件 |
| 严格只读 | `nex mcp --read-only` | 不监听、不提供 refresh，永不写索引 | 合规、审计、共享环境 |

watch 模式下查询遇到更新尚未完成，返回 `state: indexing` 与进度，**禁止返回旧数据冒充 fresh**（12.4.3 第 4 条）。若客户端明确要求"允许旧数据"，必须显式传 `acceptStale: true`，且响应中 `staleness: "stale"` 与 `staleReason` 同时出现。

### 14.1.3 MCP 封装实现（官方 SDK v2 拆分包）

MCP 层使用官方 TypeScript SDK 的 **v2 拆分包**，不使用 v1 单体包，也不手写 JSON-RPC。

| 项 | 选择 | 说明 |
|---|---|---|
| 服务端包 | `@modelcontextprotocol/server` | v2 稳定线，独立包 |
| 传输 | `@modelcontextprotocol/server/stdio` | 平台以子进程拉起，不开端口、不做 HTTP |
| 客户端 | `@modelcontextprotocol/client` | 仅 devDependency，供内存传输单测使用 |
| Schema | Standard Schema（Zod v4） | 输入与输出同时声明 |
| API 层 | 高层 `registerTool` | 低层 `Server` 仅在需接管协议行为时使用 |

五条实现约束：

1. 输入与输出都要声明 schema；`outputSchema` 支撑 `structuredContent` 与夹具断言。
2. 双轨输出：`content` 返回紧凑文本给模型直读，`structuredContent` 返回结构化数据给程序消费；客户端不支持结构化时自动退回文本，不得因缺字段崩溃。
3. 工具错误用 `isError: true` 返回，不 throw；抛出会变成协议层错误，E01–E23 的语义与修复命令无法到达模型。
4. 按握手协商到的 `protocolVersion` 降级，禁止硬编码最新版。
5. 锁定 SDK 精确版本；v2 与 v1 的 API 不同（`registerTool` 传 config 对象），禁止混用两代写法。

### 14.1.4 MCP 冒烟（分两级）

| 级别 | 阶段 | 内容 | 目的 |
|---|---|---|---|
| 协议探针 | Phase 00 | 用官方 SDK v2 起一个最小 stdio server（仅一个 echo 工具），client 直连，完成 initialize → tools/list → 一次调用 | 排除致命前置风险：平台是否支持 stdio MCP、协商出版本、拉起方式与超时行为 |
| 完整冒烟 | Phase 07 | 真实 `nex mcp`：握手、8 个工具、status 全字段、无索引引导态、错误不 throw | 交付前验收，与 19 章阶段 07 对齐 |

Phase 00 的探针**不依赖任何业务功能**：不建索引、不读项目、不使用夹具，产物只是"握手成功 / 协商出版本 X / 拉起耗时 T"，写入 21.1 的项目描述文档。它验证的是环境，不是产品。

完整冒烟的执行约束（Phase 07 适用）：

- **不进全局配置**：不修改任何平台的 MCP 配置文件、不注册全局服务；只由测试进程内的 client 直连一次性 stdio 子进程。
- **隔离目录**：在系统临时目录建 F05 夹具作为 projectRoot，不触碰当前工作区与现有 `.nexus/`。
- **短时退出**：全流程 ≤ 30s，超时强制终止子进程并判失败。
- **只读**：只做 initialize、tools/list 与一次 status，不建索引、不刷新、不写文件。
- **默认跳过**：普通 `npm test` 中标记 skip，仅在 CI 与显式 `nex doctor --mcp` 时运行。
- **无残留**：结束清理临时目录，`git status --porcelain` 必须仍为空。

### 14.1.5 格式约束（MCP 通道恒紧凑）

7 个查询工具与 refresh 的返回体统一受本节约束。

1. **值域**：`format` 参数为 `z.enum(["lines","json"]).default("lines")`；缺省即 lines。
2. **服务端兜底**：客户端绕过 schema 传入 pretty / markdown / 垃圾值时，服务端仍按 lines 处理，不报错、不 `isError`、不 throw。
3. **回落可见**：`structuredContent` 增 `formatApplied: "lines"`、`formatFallback: true`（仅当入参非法或缺省时）与 `formatReason`（如 `"unknown-format: pretty"`）。
4. **无装饰**：content 轨道为紧凑行文本或 JSON 文本；两者均不含 ANSI，以 `/\x1b\[/` 断言为空。
5. **描述洁净**：8 个工具的 description 与 format 参数描述中不出现 pretty / markdown 字样，format 描述为"compact text (lines) or structured JSON text"。
6. **能力声明**：`status.capabilities.mcpFormats: ["lines","json"]`。

结论：AI 无论传什么、忘传什么，拿到的都是紧凑格式；pretty 在 MCP 协议层不可达。

## 14.2 接入模板（AGENTS.md 与 Skill）

提供一份可复制的 AGENTS.md 模板，以及一个可选的 Agent Skill 示例。**工具只负责打印，绝不写文件**：不修改宿主项目的 AGENTS.md，不创建 Skill 目录，不改动任何 Agent 平台的配置文件。

模板必须写死以下七条纪律，缺一条即视为模板不合格（第六条为 v1.24 新增，其余为原文六条并按新状态名修订）：

1. **起步纪律**：每个任务的第一条工具调用必须是 `status`；未取得可用状态前，不得直接回答代码结构类问题。
2. **阻断纪律**：状态为 `uninitialized`、`failed` 或 `indexing` 时禁止继续产出结论，必须原样输出工具返回的引导块（含可复制命令）。`dirty` / `stale` 时允许继续，但回答开头必须声明索引状态与影响。
3. **声明纪律**：一旦未使用 Nexus（例如改用文件搜索），必须在回答开头声明「本次未使用 Nexus，结论未经索引校验」，且不得据此变更公共 API。
4. **证据纪律**：引用数、影响范围、Surface 变更一律引用工具输出，不得自行推断；遇到 `heuristic` / `dynamic-unresolved` 必须提示人工确认，不得当作事实；不得把静态引用数说成调用频率。
5. **变更纪律**：动公共 API 前先看 `nex impact` 与 `nex api-diff`；`postflight` 未通过前不提交。
6. **配置纪律（新增）**：不得擅自把 `.nexus/nexus.config.json` 改成 `.ts`；不得在未获用户授权时让工具执行任何配置代码或项目脚本。
7. **格式纪律**：走 MCP 时无需指定 format（恒为紧凑格式）；走 CLI 时必须显式 `--format lines` 或 `--format json`，不得依赖 TTY 推断，不得使用 pretty / markdown。

模板骨架（由 `nex print agents` 打印到终端，复制即用）：

```markdown
# AGENTS.md（项目级接入约定）

## 每次任务开始
- 先运行 nex status
- 状态为 fresh：直接查询
- 状态为 dirty / stale：先看 staleness 原因，再决定是否 nex update
- 状态为 uninitialized / failed / indexing：停止，原样输出引导块，不产出结论

## 定位与判定
- 查符号、引用、依赖：nex symbol / nex references / nex deps
- 不自行用文件搜索推断引用全集
- heuristic 与 dynamic-unresolved 必须提示人工确认
- 静态引用数不代表调用频率

## 变更
- 动公共 API 前：nex impact 与 nex api-diff
- postflight 未通过不提交

## 配置
- 不改配置格式，不授权执行未确认的配置代码

## 声明
- 未使用 Nexus 时，回答开头声明「结论未经索引校验」
```

Skill 侧只保留流程：起步检查、查询选择、变更前审计、失败时的引导输出。Skill 不得复述错误码表、不得复制索引内容、不得要求用户先完成额外配置才能使用。

## 14.3 接入物料的分发方式（只打印、不落盘）

三类物料一律由 CLI 打印到 stdout，由用户决定去留；不存在任何 `--write-*` / `--install` / `--apply` 参数。

| 物料 | 获取命令 | 用户动作 |
|---|---|---|
| MCP 服务配置 | `nex print mcp-config [--client dsh\|claude\|cursor]`（兼容：`nex mcp-config`） | 复制并合并到平台的 MCP 配置文件 |
| AGENTS.md 片段 | `nex print agents`（兼容：`nex agents`） | 粘贴到仓库根目录 AGENTS.md，或交给自己的 AI 写入 |
| Skill 示例 | `nex print skill`（兼容：`nex skill`） | 从仓库 `skills/` 目录复制到平台的 skills 目录 |

```bash
# 1. MCP：把打印出的 JSON 合并到平台的 MCP 配置
nex print mcp-config --client dsh

# 2. AGENTS.md：在仓库根目录创建或追加
nex print agents

# 3. Skill：从仓库获取后放入平台 skills 目录
git clone https://github.com/<org>/anemia-nexus
cp -r anemia-nexus/skills/nexus ~/.dsh/skills/nexus
```

禁止事项：不得自动创建或修改 AGENTS.md、`.mcp.json`、平台配置文件与 skills 目录；不得在用户未显式指示时执行任何写入类命令；用户说「帮我装上」时，应输出具体命令与目标路径，待用户确认后再执行。

验收：执行任一打印命令后，工作区不得出现新增未跟踪文件（`git status --porcelain` 为空）。---

