<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 5 章 核心数据模型；原文照录，未修改技术内容。 -->

# 5. 核心数据模型

所有索引必须拥有统一的数据结构，不能让不同分析器各自生成不兼容的 JSON。统一由 Normalizer 产出，分析器只提供原始结果；多分析器之间的对齐由 Semantic Merger 完成后交给 Normalizer（4.3）。

## 5.1 实体定义

| 实体 | 主要字段 |
|---|---|
| Project | 项目 ID、技术栈、配置哈希、工作区、构建指纹 |
| File | 相对路径、内容 Hash、语言、文件类型、是否生成物、覆盖状态 |
| Symbol | `symbolId`、declarationLocator、名称、类型、签名、容器链、可见性、是否 public、`identityConfidence`、`volatile` |
| API | API 名称、导出入口、Surface 类别、`evidenceSource`、导出类型、稳定性、since、替代符号 |
| Reference | 源符号、目标符号、引用位置、引用种类、`relationClass`、置信度、`analysisEngine` |
| Dependency | 来源文件、目标文件、依赖类型、`relationClass`、`analysisEngine` |
| CallRelation | 调用方、被调用方、调用位置、解析等级、conf、`relationClass` |
| Component | Props、Emits、Slots、Expose、来源（类型化 / 语法推导）、`propsCoverage` |
| ArchitectureModule | 模块职责、路径、允许依赖规则、违规记录 |
| Test | 测试文件、关联符号、测试类型、覆盖置信度 |
| Change | 修改对象、影响范围、风险等级、判定依据 |
| SurfaceSnapshot | Surface 条目集合、`surfaceHash`、构建指纹 |
| SymbolIdHistory | 历史身份记录（5.2.6） |
| BuildFingerprint | 构建指纹（5.11） |
| IndexHealth | 索引健康快照（5.12） |

## 5.2 符号身份（v1.24 重写，P0-02）

### 5.2.1 三个概念必须分离

v1.23 的 5.2 把"符号 ID"定义为 `<相对路径>#<容器链>::<名称>@<重载序号>`，同时在第 1.2 章承诺"文件重命名、移动不得改变符号身份"。这两条在数学上不可能同时成立：路径进 ID，路径一变 ID 必变。v1.24 拆成三个独立概念，各自承担一件事。

| 概念 | 回答的问题 | 是否含路径 | 生命周期 |
|---|---|---|---|
| `symbolId` | 这是不是同一个逻辑符号 | 否 | 跨文件移动、跨版本长期稳定 |
| `declarationLocator` | 它在哪、怎么再次找到它 | 是 | 随每次构建重算 |
| `identityConfidence` | 这次身份判定有多可信 | — | 每次迁移重新计算 |

### 5.2.2 symbolId 的构成与生成

```text
symbolId = "s_" + base32( sha256( canonical ) )[0..16]

canonical = rootId ‖ 0x00 ‖ kind ‖ 0x00 ‖ nameChain ‖ 0x00 ‖ structuralFingerprint

kind                 ：fn | class | var | interface | type | enum | ns | component | composable
nameChain            ：容器链 + 名称，以 "." 连接（不含文件路径）
structuralFingerprint：声明节点的规范化 AST 骨架哈希
                       去注释、去空白、去格式化差异；
                       保留：标识符、参数个数与名称、类型注解文本（归一化后）、修饰符、
                             导出修饰、返回值形状
rootId               ：root 标识（5.7），跨 root 同名符号天然不撞
```

四条实现约束：

1. **禁止把行号、文件路径、内存引用、时间戳、构建序号写进 `canonical`。** 违反即视为设计缺陷，评审可直接拒绝（对应 20 章禁令）。
2. **哈希碰撞与同构同名的处理**：若生成的 `symbolId` 已存在且 `declarationLocator` 不同，追加后缀 `#<sha256(locatorKey)[0..7]>`，并把该符号标记 `volatile: true`、`identityConfidence: medium`。这是唯一允许 ID 依赖路径的情形，且必须在 `status.coverage.hashCollisions` 中计数暴露。
3. **匿名符号**（默认导出、匿名函数、内联组件、`export default {}` 对象成员）使用"位置锚定哈希"：`sha256(rootId ‖ kind ‖ 所在文件相对路径 ‖ 声明起始行列 ‖ 语法上下文哈希)`，一律 `volatile: true`，且在 Surface 与 references 输出中标注 `anonymous`。
4. **ID 长度为 16 个 base32 字符**（80 bit 熵），在 100 万符号量级下碰撞概率可忽略；碰撞仍按第 2 条处理后置标记。

### 5.2.3 declarationLocator 的必备字段

| 字段 | 说明 |
|---|---|
| `rootId` | 所属 root（5.7） |
| `path` | 项目相对 POSIX 路径（不含绝对路径） |
| `startLine` / `startCol` / `endLine` / `endCol` | 行列口径见 5.4 |
| `kind` | 声明种类，与 `symbolId` 的 `kind` 一致 |
| `nameChain` | 与 `symbolId` 的 `nameChain` 一致 |
| `overloadOrdinal` | 重载 / 声明合并内的序号，从 0 开始 |
| `containerLocatorKey` | 容器（类 / 命名空间 / 模块）的定位键，用于结构对齐 |
| `syntaxContextHash` | 声明所在的语法上下文（是否在 export、是否在 default、是否在 barrel）哈希 |
| `sourceHash` | 该文件内容哈希（LF 归一化后） |

**用途分工**：`declarationLocator` 用于映射（4.3）、失效（12.1）、跳转（15.6 输出）与迁移证据（5.2.4）。查询输出必须能还原到 `path:line:col`，但**不得把 locator 当作身份**。

### 5.2.4 identityConfidence 的判定（证据制，不靠感觉）

身份迁移只允许基于可枚举的证据，禁止"看起来像"。证据清单：

| 证据码 | 含义 | 采集方式 |
|---|---|---|
| `E1` | Git 重命名检测 | `git diff -M --summary`，相似度 ≥ 90% 记为 R100/R09x |
| `E2` | 文件内容相似度 | 归一化后 token 级相似度，需 ≥ 0.8 |
| `E3` | 声明结构指纹一致 | 5.2.2 的 `structuralFingerprint` 相同 |
| `E4` | 导出图一致 | 该符号的导入者/导出者集合交集 ≥ 60%，且不与他人冲突 |
| `E5` | 名称链一致 | `nameChain` 完全相同 |
| `E6` | 引用邻域一致 | 入边与出边的目标集合交集 ≥ 60% |

判定规则（必须严格按下表，不得加权自创）：

| 置信度 | 成立条件 | 行为 |
|---|---|---|
| `high` | `E3` + `E5` + (`E1` 或 `E4`) 同时成立，且候选唯一 | 继承原 `symbolId`，写 `SymbolIdHistory` |
| `medium` | `E3` + `E5` 成立但缺 `E1`/`E4`；或候选唯一但仅 `E1`+`E2`+`E5` | 继承原 `symbolId`，但标 `identityConfidence: medium`，在 status 汇总计数 |
| `low` | 仅有 `E5`、仅 `E2`、或候选不唯一 | **不得继承**；创建新 `symbolId`，旧 ID 标 `retired`，输出 `identityAmbiguous` 或 `identityLowConfidence` |
| 不判定 | 上述证据均未采集（如无 git、文件被 ignore） | 创建新 `symbolId`；不猜测，记 `identityUnverified` |

**候选不唯一**（例如两个同名同结构的声明同时新增与删除）：全部保留，写入 `candidates[]`，输出 `identityAmbiguous: true` 并列出每个候选的证据，**禁止强行选一个**。

### 5.2.5 身份迁移规则（强制）

1. 文件移动不直接等同于符号身份变化，必须有证据（5.2.4）。
2. 文件重命名同理。
3. 同名声明不得直接认定为同一符号。
4. 仅凭名称、路径相似度或代码相似度，不得判定 `high`。
5. `low` 置信匹配不得自动继承旧 `symbolId`。
6. 存在多个候选时保留歧义，不得选择其中一个。
7. 无法确认时：创建新身份，旧身份写入 `SymbolIdHistory` 并标 `status = unknown`（可解释原因）或 `retired`（确认删除）。
8. **`symbolId` 永不复用**：`retired` 的 ID 不得分配给任何新声明。
9. **跨 root 移动一律按"删除 + 新增"处理**：旧 ID 标 `retired`，新 root 分配新 ID。理由是多 root 索引互不共享（5.7），跨 root "继承身份"没有数据基础，强行继承等于凭空造边。
10. 声明内容大幅修改（结构指纹变化）但文件未动：不改变 `symbolId`（同一文件同一位置仍是同一逻辑符号），但必须重算签名并触发 12.1 的下游失效。
11. 声明删除后在同位置重新创建：默认视为新身份（新 `symbolId`），除非同时满足 `E3` 与 `E6`，此时按 `medium` 处理并标注。
12. 每次迁移必须输出：迁移结果、置信度、命中证据、候选列表（若有）、判定依据摘要。无判据的迁移视为实现缺陷。

### 5.2.6 SymbolIdHistory（历史身份表）

| 列 | 含义 |
|---|---|
| `symbol_id` | 被记录的身份 |
| `valid_from_build` / `valid_to_build` | 生效的构建指纹区间（闭开区间） |
| `locator_json` | 当时生效的 `declarationLocator` |
| `confidence` | 迁移进来时的置信度；首次分配为 `high` |
| `evidence_json` | 证据码与数值（相似度、集合交集等） |
| `status` | `active` / `retired` / `unknown` |
| `successor_id` | 若身份被判定为延续到新 ID（仅跨 root 场景），记录新 ID；否则为空 |

规则：`active` 每个 `symbolId` 至多一条；查询历史身份时（`nex symbol --history`）按构建指纹倒序返回，需明确标注"该身份在某次构建中已失效"。api-diff 必须能读取历史，否则重命名会被误判为"删一个加一个"。

### 5.2.7 与跨引擎映射的关系

`symbolId` 是多引擎之上的**唯一身份**；`symbol_map`（4.3.2）是"身份 → 各引擎原生引用"的映射表。两者不可混用：

- 查询与对外输出只用 `symbolId`。
- 映射失败时，`symbolId` 仍然存在（来自主链路），只是某引擎的边缺失，按 8.1 标 `unresolved(mapping)`。
- **禁止**用 SCIP 的 symbol 字符串或 TS 的 `ts.Symbol` 内部 id 作为对外身份。

### 5.2.8 验收（对应 F15 夹具）

| 场景 | 必须产出的结果 |
|---|---|
| 普通文件重命名 | `high` 或 `medium`，附 E1/E3/E5 证据 |
| 跨目录移动 | 同上，且路径更新、ID 不变（`high` 时） |
| 同名文件移动 | 候选唯一性判定；若双文件互换名称，判 `low` 并保留歧义 |
| 同名符号新增 | 新 ID，不合并到已有同名符号 |
| 声明删除后重建 | 默认新 ID；满足 E3+E6 时 `medium` 并标注 |
| 声明内容大幅修改 | ID 不变，签名更新，下游失效触发 |
| 多个候选匹配 | `identityAmbiguous: true` + 候选清单，不选择 |
| 跨 package 移动 | 旧 ID `retired`，新 ID 新建，无跨 root 继承 |

## 5.3 公共元字段

- `projectId`
- `entityId`（对 Symbol 即 `symbolId`；对 File 即 `rootId:path`）
- `rootId`
- `sourceFile`（项目相对 POSIX 路径）
- `startLine` / `endLine` / `startCol` / `endCol`
- `analysisEngine`
- `analysisVersion`
- `relationClass`：`certain` / `heuristic` / `dynamic-unresolved`（8.1）
- `confidence`：`direct` / `typed` / `heuristic` / `unresolved`（8.1 的四档，与 `relationClass` 是两个维度，不得互相替代）
- `identityConfidence`：`high` / `medium` / `low`（仅 Symbol）
- `identityEvidence`：证据码数组（仅 Symbol）
- `evidenceSource`：`package-exports` / `explicit-entry` / `barrel-derived` / `manual-override`（仅 API，见 6.1）
- `sourceHash`
- `buildFingerprint`（5.11）
- `derived`：该结论是直接解析还是推导

**`relationClass` 与 `confidence` 的区别（易错点，必须分开）**：前者回答"这条关系在原理上是否可被静态确定"，后者回答"这次解析用了多强的证据"。一条 `relationClass = certain` 的边，其 `confidence` 通常是 `direct` 或 `typed`；一条 `relationClass = heuristic` 的边，`confidence` 必然是 `heuristic`。两者不一致时以 `relationClass` 为准做承诺判断。

## 5.4 坐标与文本约定

- 行号从 1 开始；列号从 0 开始（与 TS Compiler / SCIP 保持一致，转换只发生在输出边界一次）。
- 列偏移以 UTF-16 code unit 计，与 TypeScript 一致。
- 路径一律使用项目相对 POSIX 路径，禁止输出绝对路径。
- 文本统一按 LF 规范化后计算 Hash，CRLF 差异不得触发重建。

## 5.5 Schema 版本与兼容矩阵

- Schema 必须带 `schemaVersion`，并区分三类变更语义：仅加字段（兼容）、改字段语义（不兼容）、删字段（不兼容）。
- 不兼容变更默认策略为**重建**，不提供自动迁移脚本；索引是派生物，重建成本低于迁移风险。
- `nex doctor --schema` 必须报告版本不一致并提供可直接执行的重建命令。
- **v1.24 新增**：版本变化必须按附录 A 的《Analyzer / Schema 兼容性矩阵》逐项判定三件事——是否需要重新索引、是否需要数据库迁移、是否允许直接启动。三件事不得合并成一个"是否兼容"的布尔值。
- **v1.24 新增**：`schemaVersion` 与实际表结构必须由同一份迁移描述源生成（`src/store/schema.ts`），禁止文档写一套、DDL 写一套。`doctor` 比对实际 `PRAGMA table_info` 与声明式定义，不一致即 E07。

## 5.6 存储形态（SQLite 为权威存储）

查询负载的性质决定存储形态：本工具的查询几乎全是点查与邻接展开（references、callers、impact 的 BFS），这类负载用 B-tree 索引天然高效，而分片 JSON 每次查询都要反序列化整片。因此 v1.3 起 **SQLite 作为唯一权威存储**。

混合策略：机器查的进库，人看和需要 diff 的留 JSON。

| 数据 | 存储 | 理由 |
|---|---|---|
| symbols、references、calls、dependencies、tests、symbol_map、symbol_id_history | SQLite 大表 | 体积大、只做机器查询、不需要人读 |
| `nexus.baseline.json` | JSON，纳入 git | 必须在 code review 中可 diff、可评审 |
| `manifest.json`、`surface.json`（人读视图） | JSON | 状态与快照，体积小且需要可读 |
| 构建指纹 | SQLite + 复制到 manifest | 需被查询与 `doctor` 双路径读取 |
| 诊断导出 | 仅在显式 `--output-file` 时生成的 JSON | 排查问题时才展开，不常驻 |

目录结构：

```text
.nexus/
├── roots/<rootId>/
│   ├── index.db            # SQLite：symbols / references / calls / deps / tests /
│   │                       #         symbol_map / symbol_id_history / vue_file_meta / build_fingerprint
│   ├── manifest.json       # 版本、构建指纹、schemaVersion、分析器版本、峰值内存、状态机态
│   └── surface.json        # API Surface 人读视图
├── cache/                  # 中间产物与 protobuf 暂存（可清理）
├── tmp/                    # 构建期临时目录（如 vue/ 影子文件）；构建结束即清空
├── workspace.json          # 派生数据（可从配置与各 root manifest 重建，见 5.10.4）
└── nexus.config.json       # 唯一配置源（或 nexus.config.ts，需授权）
```

索引与表结构的强制要求：

| 表 | 必备索引 |
|---|---|
| references | `(target_id)`、`(source_id)` |
| calls | `(callee_id)`、`(caller_id)` |
| symbols | `(name)`、`(symbol_id)`、`(root_id, path)` |
| symbol_map | `(symbol_id, engine)`、`(engine, engine_ref)` |
| symbol_id_history | `(symbol_id, valid_from_build)` |
| dependencies | `(source_file_id)`、`(target_file_id)` |

缺失索引的查询视为不通过验收（`doctor` 直接报出，不需要压测证明）。

读写方式：单写多读，启用 WAL（`PRAGMA journal_mode=WAL`）；只读模式用 `new DatabaseSync(path, { readOnly: true })`，与 `--read-only` 档对应；查询走 `PRAGMA mmap_size` 由操作系统页缓存承载，禁止把全库预热进 JS 堆。

SQLite 驱动：只允许使用内置 `node:sqlite`（`DatabaseSync` + prepare / iterate），禁止引入第三方驱动或保留回退路径。理由：零原生依赖、安装即用、无需为 Windows 预编译；代价是抬高 Node 下限至 22.16.0，且该模块 Stability 1.1，跨 Node 大版本需回归。`engines.node` 写 `>=22.16.0`，启动时校验，不满足即 E14。SQLite 版本随 Node 内置，Node 版本写入构建指纹，跨大版本变更视为存储层变化并触发全局重建。

`.nexus/` 默认加入 `.gitignore`；`nexus.baseline.json` 必须纳入版本管理，并支持显式配置是否共享。

## 5.7 多根工作区（monorepo 与多 package 仓库）

Nexus 的承诺前提是"每个 package 都能独立 typecheck"。多根仓库里，组件库、文档站、示例应用往往各有独立 tsconfig 与依赖，把它们塞进同一个索引会产生两个后果：符号表混装导致同名符号歧义，以及靠"路径能走通"推出实际不成立的跨包依赖。因此 v1.21 起，**索引单位是 root（可独立 typecheck 的 package），不是仓库**。

**根识别**（按顺序，命中即记录来源）：`package.json` 的 `workspaces`、`pnpm-workspace.yaml`（只读识别，不要求项目使用 pnpm）、`lerna.json`、`nx.json`、`turbo.json`、`rush.json`、`*.code-workspace`，以及配置文件的 `workspaces.roots` 显式声明。识别结果必须打印根列表（名称、路径、tsconfig、是否有 exports），不得静默取第一个。

**索引隔离**：每个 root 一套索引，互不共享。符号表、references、calls、dependencies、manifest、历史身份全部按 root 分开；跨 root 不做 BFS、不做引用合并、不做 Surface 合并。

```text
.nexus/
└── roots/
    ├── packages-ui/          # rootId 由 root 的 package name 归一化而来
    │   ├── index.db
    │   ├── manifest.json     # rootPath、packageName、tsconfig、根集合哈希、构建指纹
    │   └── surface.json
    └── apps-docs/
        ├── index.db
        └── ...
```

**跨根关系规则（关键）**：只有当 A 的 `package.json` 在 `dependencies`/`devDependencies`/`peerDependencies` 里显式声明 B，且 B 的 `exports` 能把 import 解析到 B 内的具体文件时，才允许一条跨根边，标 `depType: cross-package`、`analysisEngine: package-boundary`、`relationClass: certain`。不满足任一条，一律记 `unresolved(package-boundary)` 并写明原因（未声明依赖 / exports 不匹配 / 目标 root 未被索引）。**禁止**用 tsconfig `paths`、相对路径上跳或目录约定去"推断"跨包依赖。

**选择行为**：`nex init` 检测到多个 root 时，交互式列出根并给出建议——**默认建议分别建索引**；用户可选择全部、或只选其中若干。非 TTY 环境必须显式给 `--roots all` 或 `--roots packages-ui,apps-docs`，缺失即退出并打印可选根（E15）。

```json
{
  "workspaces": {
    "mode": "prompt",
    "roots": [],
    "exclude": ["apps/legacy"],
    "followTsReferences": false
  }
}
```

**与查询、增量、MCP 的关系**：`status` 返回 `roots[]`（每个 root 的 `state` / `staleness` / 文件数 / 构建指纹摘要），并标出 `activeRoot`；CLI 查询默认作用于 `activeRoot`，可用 `--root` 切换，`--roots all` 时结果按 root 分组且各自带 coverage，不混排。MCP 的 8 个工具加可选 `root` 参数（缺省 `activeRoot`），返回体带 `rootId`；不新增工具。增量按 root 独立失效；`workspaces.roots`、`exclude`、`followTsReferences` 任一变化 → 先重算根集合，仅新增 root 全量、移除 root 删除、其余 root 按各自配置哈希判定后增量（见 5.8）。

**禁止**：把多 root 合并成单一索引；为未声明依赖的两个 package 造边；用"同仓库"作为跨包引用成立的依据；在 root 选择上静默替用户做决定。

## 5.8 工作区配置与命令分发（v1.24 修订：默认 JSON）

### 5.8.1 配置格式与唯一源

| 项 | 规定 |
|---|---|
| 默认格式 | `.nexus/nexus.config.json`（数据配置，**不被执行**） |
| 校验 | Zod Schema，`strict()` 模式：未知字段直接报错（E17），不做静默忽略 |
| 派生 | 由 Zod Schema 派生 JSON Schema（`schema/nexus.config.schema.json`），供编辑器补全与文档生成（P2-03） |
| 可选格式 | `.nexus/nexus.config.ts`（**可执行代码**），仅在 18.3 的显式授权后加载 |
| 双源 | 同时存在 `.json` 与 `.ts` → 报 E17「双源配置」并拒绝启动，不做静默合并、不按优先级猜 |
| 旧路径 | 仓库根目录存在 `nexus.config.*` → 报 E17，提示移动到 `.nexus/` |
| 版本字段 | 配置必须含 `configVersion`（整数）；当前为 1；更高版本由不认识它的旧 CLI 读取时报 E17 |

```json
{
  "configVersion": 1,
  "defaults": {
    "ignore": { "dirs": [], "files": [], "globs": [], "include": [] },
    "budgets": { "maxTokens": 8000, "maxFiles": 200 },
    "output": { "format": "auto", "width": 120 }
  },
  "workspaces": { "mode": "prompt", "roots": [], "exclude": [], "followTsReferences": false },
  "roots": {
    "docs": { "budgets": { "maxTokens": 4000 } },
    "ui": { "include": ["dist/types/**"] }
  },
  "style": { "aliases": {}, "extensions": [".css", ".scss", ".less"], "html": false },
  "vue": { "typeResolver": null },
  "commands": { "allow": [] }
}
```

**合并优先级**：内置基线（不可删）→ `defaults` → `roots.<rootId>`；越靠后优先级越高，但任何一层都不能删除内置基线条目。合并结果按 root 计算哈希，写进该 root 的 manifest，供失效判断与 `doctor` 回显。

### 5.8.2 命令语义

**init（在仓库根执行）**：

1. 按 5.7 的顺序探测工作区声明，得到候选 root 列表。
2. 逐个判定可索引性：有 tsconfig 且能独立 typecheck 才算 root；文档站、纯配置包、无 TS 的 utils 标 `non-indexable` 并单独列出，不静默丢弃。
3. TTY 下打印候选表（名称 / 路径 / tsconfig / exports / 是否可索引），让用户选"全部 / 部分 / 跳过"；非 TTY 必须给 `--roots all|a,b`，否则 E15 退出并列候选。
4. 生成 `.nexus/nexus.config.json`（带注释的 JSON 不支持注释，因此生成 `.nexus/nexus.config.example.json` 作为注释版参考，真实配置保持纯 JSON）与 `.nexus/workspace.json`、`.nexus/roots/<rootId>/` 目录。
5. 默认**只打印**拟写入内容；TTY 需一次确认，非 TTY 需显式 `--write-config`，否则不落盘。
6. 不写 AGENTS.md、不写 MCP 配置、不改 `.gitignore`，只在末尾打印需要用户自己添加的一行。

**build（在仓库根执行）**：先读 `workspace.json` 与配置算 `rootSetHash` 与各 root 的 `configHash`；按 package 依赖拓扑排序（被依赖方先建，保证 `.d.ts` 就绪）；每个 root 独立子进程、独立 SQLite 连接、独立锁文件，并发由 5.10 的全局调度器统一分配（不再硬编码 `min(4, cpu/2)`）。**失败隔离**：某 root 失败不终止其它 root，末尾汇总 `failedRoots` 并非零退出；任何情况下都不产出跨 root 的合并索引，失败 root 保持上一次成功状态并标 `stale`。

**update（在仓库根执行）**：先比对 package.json / workspace 声明算新的 root 集合；新增 root 全量构建、移除 root 删除其 `.nexus/roots/<rootId>/`、其余 root 仅按文件变更做增量，**不因集合变化而全量重建所有 root**。根级 `defaults` 变化 → 受影响 root 按配置哈希判定后各自重建；`roots.<rootId>` 变化只影响该 root。

**禁止**：把配置文件写到仓库根并同时保留 `.nexus` 内的副本；`init` 未经确认就落盘配置；某 root 构建失败后仍对外声称工作区索引完整。

## 5.9 查询期根路由（单包 / 指定包 / 全包）

索引永不跨 root，查询也不跨 root 读，只在边界上做受限聚合。三个概念必须分开：`rootId`（索引单元，构建期确定，运行期只读）、`activeRoot`（本次调用的默认归属，由 cwd 或显式参数决定，不跨会话缓存猜测）、`scope`（本次覆盖范围：`root` / `roots` / `all`）。

**cwd 归属解析**：取 cwd 相对仓库根的路径，按 rootPath 做**最长前缀匹配**；命中唯一 root 即 `activeRoot`。cwd 落在仓库根或任何 root 之外 → 归零，必须显式给 `--root` 或 `--roots`；此时若仍未给，报 **E16**（E15 是构建期根集合歧义，语义不同，不复用），并列出候选 root。cwd 同时落在两个嵌套 root 内 → 按最长路径取胜并打印一条提示，提示嵌套关系。

**包内调用（cwd 在 root A 内）**：默认 `scope=root`，只读 A 的索引。目标符号只存在于 B 时返回 `not-found`，附"该符号存在于 root B，但 A 未声明依赖，不跨 root 取值"，不返回 B 的数据；A 的 package.json 已声明依赖 B 且 B 的 exports 可解析时，只呈现索引期已记录的 `cross-package` 边，不现场展开 B 的符号。

```bash
nex deps src/styles/theme.scss --root ui --reverse
nex impact packages/ui/src/button.ts --roots ui,docs
nex query useButton --roots all
nex status --roots all
```

| scope | 行为 | 完整性承诺 |
|---|---|---|
| `root`（默认） | 只查 `activeRoot`，返回带 `rootId` | 仅对该 root 承诺确定性关系 0 漏报 |
| `roots a,b` | 并行查指定 root，结果按 root 分组 | 逐 root 承诺，不合并声明 |
| `all` | 并行查全部已建索引 root，结果 `byRoot` 分组 | 仅当全部 root fresh 时给整体完整性，否则列 `staleRoots` |

**all 模式四条硬规则**：组内保持原有排序，组间不做全局排序；不做跨 root 去重；同名符号跨 root 命中各自独立成条，并在顶层给 `globalAmbiguous: true` 与候选清单；预算按 root 均分 `budget/N`，超出报 E10 并指出是哪个 root 撑爆。

**cross-package 反向边的呈现**：查询结果可带独立的 `crossRootEdges` 段，只列索引期已记录的跨包边（`fromRoot` / `toRoot` / `specifier` / `confidence`），并标"来自已声明的 package 依赖"，不展开对方符号、不作为本次查询的 completeness 依据。

**输出与 MCP**：`lines` 每行以 `[rootId]` 前缀开头（单 root 时可省略）；`json` 每条带 `rootId`；`pretty` 按 root 分小节。8 个 MCP 工具加可选 `root` 与 `roots`（`"all"` 或 `string[]`），缺省 `activeRoot`；server 启动时唯一 root 自动绑定，多 root 且客户端未给 → E16 + 候选清单，不默认第一个。

**禁止**：把多 root 结果合并成一张符号表后统一排序去重；在 `all` 模式假设"符号全局唯一"；查询期用相对路径上跳或 tsconfig paths 去补另一个 root 的符号；部分 root 过期时仍声明引用全集完整。

## 5.10 全局资源协调器（v1.24 新增，P0-05 + P1-04）

### 5.10.1 为什么必须有

v1.23 的并行策略是 `min(4, cpu/2)`，只考虑 CPU，不考虑内存。实际链路里同时可能驻留：SCIP 的 index.scip 解析缓冲、TS Program（含 lib.d.ts 与全部依赖 `.d.ts`）、Vue 投影的 shadow 文本与映射、SQLite 写入批次。**这些峰值会重叠**，逐个工具的占用相加既高估也低估——高估是因为峰值不同时发生，低估是因为重叠时无人管。多 root 并行时更危险：4 个 root 各自的 TS Program 可能把 1.5 GB 预算一次吃穿。

同时，v1.23 让每个 root 独立管理资源，会产生：重复分析同一依赖、任务取消不一致、拓扑变化后状态不一致。

### 5.10.2 职责边界

`Global Resource Coordinator` 是唯一有权决定"谁能跑、跑几个、什么时候停"的模块。它只做四件事，不参与业务逻辑：

| 职责 | 具体内容 |
|---|---|
| 准入控制 | 判断新任务能否启动（内存、并发位、依赖是否就绪） |
| 预算分配 | 全局预算 → 各 root 配额；单任务上限 |
| 调度与串行化 | 优先级、依赖顺序、同 root 任务合并 |
| 取消与降级 | 超时 / OOM 预警 / 用户中断时的取消传播与降级阶梯 |

### 5.10.3 预算与调度规则

| 项 | 规则 |
|---|---|
| 全局内存预算 | 取 `min(配置上限, 可用物理内存 × 0.5)`；默认上限按 21.2 的三档表；未知规模时默认 900 MB |
| 单 root 预算 | `全局预算 × (该 root 预估权重)`，权重由上次构建的峰值 RSS 归一化得出；首次构建均分 |
| 并发任务数 | `min(配置并发上限, floor(全局预算 / 单任务预估峰值), cpu 物理核数 - 1)`，三项取最小 |
| 依赖顺序 | 被依赖 root 先建；同一 root 内按「配置解析 → 文件发现 → 语义分析 → 归一化 → 写入」串行，禁止跨阶段流水 |
| 同 root 任务合并 | 同一 root 的重复 refresh / update 请求合并为一次；已排队任务被更新的请求取代，不叠加 |
| 取消传播 | 用户中断（Ctrl-C / MCP 取消通知）必须停掉子进程与 SQLite 写入；取消后不得留下部分提交（12.3） |
| 超时 | 单 root 构建超时默认 30 分钟（百万行档可配）；超时按"失败"处理，保留上一次有效索引 |
| OOM 预警 | 进程 RSS 达单 root 预算 85% 时，先降级（关闭 calls 索引 → 分块处理 → 降低投影粒度），仍超则中止该 root 并报 E20 |

### 5.10.4 降级阶梯（必须按顺序，不得跳级）

1. 关闭 calls 索引（保留 references 与 dependencies）。
2. 分块构建（按目录分批写入，释放 AST）。
3. 降低 Vue 投影粒度（按文件投影而不是按 batch）。
4. 串行化该 root 的全部任务（并发位降为 1）。
5. 中止该 root，标记 `failed`，保留上一次有效索引，报 E20 并给出建议（减少并发 / 增大预算 / 缩小索引范围）。

降级必须显式：`manifest.json` 记 `degraded: ["calls", "chunked"]`，`status` 与所有查询结果首行体现，`coverage` 记受影响的能力。**禁止**降级后仍宣称完整。

### 5.10.5 workspace.json 的定性（P1-04）

`workspace.json` 明确定义为**派生数据 + 缓存**，不是权威事实来源：

| 项 | 规定 |
|---|---|
| 权威来源 | 配置文件（roots / exclude / mode）+ 各 root 的 `package.json` + 各 root 的 `manifest.json` |
| 内容 | 根列表、`rootSetHash`、各 root 的 `rootId`/`rootPath`/`packageName`/`tsconfig`/`configHash`/`buildFingerprint` 摘要 |
| 可恢复性 | 删除后必须能由上述权威来源重建，重建结果与删除前逐字段一致（`doctor --repair` 的职责之一） |
| 一致性校验 | 每次 build/update 前校验 `rootSetHash`；不一致即以权威来源为准重建，并记一条 `workspace-rebuilt` 事件 |
| 禁止 | 把 `workspace.json` 当作唯一配置来源；手工编辑后被当作权威；在它与配置冲突时以它为准 |

## 5.11 索引构建指纹（v1.24 新增）

仅用 git commit 判断索引是否过期是不够的：工作区可能有未提交改动，分析器可能升级，Node 可能换版本，配置可能改一行。因此每次构建必须生成一个**可复现的构建指纹**。

```text
buildFingerprint = "bf_" + base32( sha256( canonicalFingerprintInput ) )[0..20]
```

| 字段 | 来源 | 缺失时 |
|---|---|---|
| `filesHash` | 索引范围内全部文件的 `(相对路径, sourceHash)` 排序后的哈希 | 必填，不可为空 |
| `configHash` | 合并后的生效配置（内置基线 + defaults + root 覆盖）的规范化 JSON 哈希 | 必填 |
| `schemaVersion` | 5.5 | 必填 |
| `analyzerVersion` | `{ scip, typescript, vueLanguageCore, vueTsc, tsMorph }` 五元组 | 必填，逐项记录而非拼接字符串 |
| `rootSetHash` | 根集合（rootId 列表 + 各自 configHash）哈希 | 单 root 时也有值 |
| `nodeVersion` | `process.versions.node` | 必填 |
| `sqliteVersion` | `node:sqlite` 报告的版本 | 必填 |
| `platform` | `os.platform()` + `os.arch()` | 必填（用于解释跨平台差异，不参与"是否重建"判定） |
| `degraded` | 降级能力列表 | 可为空数组 |
| `gitCommit` | HEAD（可能为 null） | **仅作辅助**，不得单独作为指纹 |

用途与约束：

1. **过期判定**：`filesHash` / `configHash` / `analyzerVersion` / `schemaVersion` 任一变化 → 索引过期，按 12.1 处理。`platform` 与 `gitCommit` 变化不单独触发重建。
2. **可复现性**：同一指纹必须产出逐字节一致的结果（15.5）；指纹不同则允许结果不同，但差异必须能由指纹差异解释。
3. **问题复现**：报告缺陷时必须附指纹，否则无法区分"代码问题"与"环境差异"。
4. **增量 vs 全量校验**：12.2 的门禁要求"增量后的指纹"必须等于"同源全量构建的指纹"；`degraded` 不同则视为不等价，判失败。
5. **禁止**把 `builtAt` 时间戳纳入指纹（会破坏可复现性）；时间只写 manifest 供人读。

## 5.12 索引健康与覆盖率口径（v1.24 新增）

v1.23 多处出现"覆盖率"但没有定义分子分母，等于给了一个无法核对的百分比。v1.24 统一口径。

| 指标 | 分子 | 分母 | 排除规则 |
|---|---|---|---|
| `fileCoverage` | 成功解析并入库的文件数 | 索引范围内应索引的文件数 | 被 ignore 排除的**不进分母**，单列 `filesIgnored`；解析失败进分母并计入 `filesFailed` |
| `semanticCoverage` | 完成语义分析的符号数 | 应做语义分析的符号数 | `syntax-only` 降级时该指标置为 `null`，不显示伪百分比 |
| `referenceCoverage` | 有完整出边与入边的符号数 | 应建引用的符号数 | `unmapped` 符号单独计数，不从分母扣除 |
| `unresolvedRate` | `relationClass=dynamic-unresolved` 的边数 | 全部关系边数 | heuristic 不计入此指标，单独统计 |
| `mappingSuccessRate` | 4.3.4 定义 | 4.3.4 定义 | 同上 |

`IndexHealth` 快照（写入 manifest，并由 `status` 输出）必备字段：

- `buildFingerprint`、`indexVersion`
- `lastSuccessAt`、`lastFailureAt`、`lastFailureCode`
- `fileCoverage`、`semanticCoverage`、`referenceCoverage`、`unresolvedRate`、`mappingSuccessRate`
- `filesIgnored`、`filesFailed`、`filesSkippedBySize`
- `roots[]`：每个 root 的 `state` / `staleness` / `degraded` / 上述指标
- `lastIntegrityCheck`：最近一次 12.2 等价性校验结果（通过 / 失败 / 未跑）与时间

**禁止**：用一个未定义口径的"完整性百分比"代表整个项目；在 `semanticCoverage = null` 时用 0% 或 100% 填充；把 `filesIgnored` 计入失败。---

