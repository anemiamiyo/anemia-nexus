<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 12 章 索引、增量与缓存；原文照录，未修改技术内容。 -->

# 12. 索引、增量与缓存

必须支持：

- 基于内容 Hash 的变化检测。
- 文件新增、删除、修改和重命名识别。
- 依赖变化后的关联索引失效。
- TypeScript 配置变化检测。
- package.json 和锁文件变化检测。
- 分析器版本变化检测。
- 全量重建和增量更新。
- 索引损坏检测。
- 原子写入与中断恢复。
- 多进程并发保护。
- **符号身份迁移及其历史记录**（5.2）。
- **构建指纹与语义等价校验**（5.11、12.2）。

## 12.1 失效传播规则（必须显式成表）

增量正确性的核心不是 Hash 链，而是失效传播是否完备。以下任一变化必须触发对应级联：

| 变更源 | 必须失效的产物 |
|---|---|
| 文件内容变化 | 该文件的符号、其引用边、其调用边（仅在该 root 内） |
| 符号签名变化 | 反向引用集合、Surface 快照、依赖该类型的下游符号、api-diff 基线 |
| 导出 / barrel 变化 | 重导出链上的全部引用、Surface 判定、架构模块图 |
| **符号身份迁移（5.2）** | 该符号的历史表新增一条、所有以旧 ID 为 key 的边重写、Surface 记录与基线中的 ID 引用 |
| tsconfig / 路径别名 | 该 root 全局重建（不做局部推断） |
| package.json / 锁文件 | 该 root 的依赖图、外部符号解析、架构规则；若声明依赖变化则一并失效跨 root 的 cross-package 边 |
| Vue 投影器或 language-core 版本 | 全部 `.vue` 文件的投影与坐标转译，等效全局重建 |
| 根集合（`workspaces.roots` / `exclude` / `followTsReferences`）变化 | 仅受影响的 root 重建（新增 root 全量、移除 root 删除、其余按 `configHash` 判定），不整仓全量重建（5.8） |
| 配置合并结果变化（`configHash` 变化） | 该 root 全局重建（配置影响扫描范围与预算，局部推断不成立） |
| 分析器或 Schema 版本 | 全局重建（按附录 A 判定是否需要迁移） |
| **`symbolId` 生成算法变化** | 全局重建 + 历史表重算，属不兼容变更，必须升 `schemaVersion` |

提供 `nex update --rebuild-affected`，对疑似受影响的闭包强制重建而非增量修补。

**禁止**：只按文件 mtime 判断变化；只失效"该文件"而不失效"指向它的边"；在身份迁移后保留旧 ID 的边不重写。

## 12.2 增量一致性门禁（强制）

"增量结果等于全量结果"必须是可自动执行的检查，且**不能只比行数与文件数**。

判定方式：同一份源代码 + 同一份配置 + 同一组分析器版本下，分别执行全量构建与增量构建，比较：

| 比较项 | 比较方式 |
|---|---|
| 符号集合 | 按 `symbolId` 排序后逐条比对（名称、kind、签名、可见性、`identityConfidence`） |
| 符号身份 | `symbolId` 集合完全相同；`SymbolIdHistory` 的 `active` 集合相同 |
| 引用关系 | `(source_id, target_id, kind, relationClass, confidence)` 五元组多重集完全相同 |
| 导出关系 | 导出边多重集相同 |
| 文件状态 | `(path, sourceHash, status)` 相同 |
| API Surface | `surfaceHash` 相同 |
| 依赖与调用边 | 边集合相同（含 `analysisEngine`） |
| 构建指纹 | `buildFingerprint` 相同，`degraded` 不同即判不等价 |
| 覆盖率 | 各 `*Coverage` 数值相同 |
| manifest | 除 `builtAt` / `lastSuccessAt` 外全部相同 |

执行位置：CI 中随机选择 N 个文件做修改、删除、重命名，执行增量后与全量重建比对；N 默认 20，且必须覆盖 17.1 中至少 3 类夹具。

失败处理：不一致即判失败并输出差异快照（前 20 条差异 + 计数），**不得自动"取全量结果覆盖"以掩盖增量缺陷**。修复前禁止发布。

## 12.3 提交协议、原子性与并发（v1.24 重写，P1-01）

### 12.3.1 为什么 WAL 不够

SQLite 的 WAL 保证的是**单个数据库连接内的事务原子性**。而一次索引更新涉及多个独立写入点：数据库行、`manifest.json`、`surface.json`、`workspace.json`、临时目录。这些写入发生在不同时刻，进程在中间被杀，就会出现"数据库是新版本、manifest 指向旧版本"或反之。v1.23 只写了"WAL + 原子 rename"，没有定义这些写入的先后与恢复规则。

### 12.3.2 索引提交协议（顺序固定，不得调整）

```text
1. 生成 buildId（本次任务的唯一标识，含 buildFingerprint 前缀）
2. 在 index.db 中 BEGIN IMMEDIATE
3. 写入：本次索引数据（符号/边/映射/历史）+ 一行 build_record(buildId, fingerprint, status='pending')
4. 事务内执行完整性检查：
     - 外键闭合（每条边的 source/target 均存在）
     - 必需索引存在
     - 覆盖率可计算（分母非零）
     - 指纹字段齐全
5. COMMIT
6. 校验 COMMIT 结果：重开只读连接，读 build_record.status = 'pending' 且 fingerprint 一致
7. 将该行更新为 status='committed'（独立短事务）
8. 原子更新 manifest.json（写临时文件 + fsync + rename），使其 buildId / buildFingerprint 指向本次
9. 原子更新 surface.json / workspace.json（同上）
10. 清理：删除 build_record 中 status='pending' 且 buildId 更早的记录；清理 .nexus/tmp/
11. 保留策略：保留最近 K 次 committed（K 默认 2），更早的仅在 baseline 引用时保留
```

### 12.3.3 崩溃恢复（启动时执行，先于任何查询）

| 现场状态 | 判定 | 恢复动作 |
|---|---|---|
| DB 有 `committed` 且 fingerprint 与 manifest 一致 | 正常 | 无操作 |
| DB 有 `committed`，manifest 指向旧 buildId | manifest 滞后 | 重写 manifest 指向 DB 中的 committed（以 DB 为准），记一条 `manifest-repaired` 事件 |
| DB 有 `pending`，manifest 指向旧 buildId | 上次提交中断 | 丢弃 `pending` 数据（按 buildId 定向删除），保留旧索引，状态标 `stale` |
| DB 有 `pending`，manifest 指向该 pending | 不可能出现的中间态（协议违反） | 判 `invalid`，报 E19，要求重建 |
| DB 无任何 `build_record`，但表中有数据 | 旧版本或损坏 | 判 `invalid`，报 E19，`doctor --repair` 提供重建命令 |
| DB 文件损坏 / WAL 无法恢复 | `PRAGMA integrity_check` 失败 | 报 E07；`--repair` 只删除并重建，不尝试抢救数据 |

**以数据库为权威，manifest 为派生视图**：任何两者不一致的情形，一律以 DB 的 `committed` 记录为准，manifest 可重写。这条是 12.3 的核心，写进代码注释。

### 12.3.4 临时数据与旧版本清理

- `.nexus/tmp/`：每次进程启动先清空；构建结束（成功或失败）也必须清空。残留非空即 `doctor` 报 warn。
- `.nexus/cache/`：可随时删除；删除后不影响正确性，只影响速度。
- 旧索引版本：保留最近 2 个 committed；`nex update` 成功后才删更早的，失败时**不删**（回滚依赖）。
- 数据库损坏：删除整个 root 的 `index.db` 并重建；**禁止**在损坏库上继续增量。

### 12.3.5 并发

- 写入流程：写临时目录 → 校验 → 原子 rename（manifest/surface 用此方式；DB 用事务）。
- 并发保护使用 `proper-lockfile`，锁粒度按 root；锁超时默认 30s，stale 锁回收阈值 10 分钟，两者可配。禁止自研锁。
- **写入串行化**：`node:sqlite` 是同步单连接 API，进程内写入天然串行；跨进程仍以文件锁判定正确性。`DatabaseSync` 的 `timeout` 只作读侧 busy-timeout 兜底，**不得作为并发正确性依赖**。
- MCP 的 watch 与 refresh 必须与 CLI 的 update 共用同一把锁；持锁时 refresh 返回 E08，watch 排队等待而不是并发写入。
- 同一 root 的多个任务由 5.10 的调度器合并，不排队叠加。

## 12.4 索引状态机（v1.24 重写，P1-03）

### 12.4.1 五态定义

| 状态 | 定义 | 允许查询 | 完整性承诺 |
|---|---|---|---|
| `fresh` | 索引内容与"已确认的源文件版本"一致（`filesHash` 与当前文件系统一致） | 是 | 可承诺（前提是 1.2 三条） |
| `dirty` | 已检测到源文件变化，尚未开始更新 | 是，但必须标注 | **不承诺**，输出 `partial: true` |
| `indexing` | 正在处理更新 | 是，但必须标注进度 | **不承诺**；MCP 是否返回旧数据见 14.1.2 |
| `stale` | 存在已知过期数据（上次更新失败、部分 root 失败、配置变化未重建） | 是，但必须标注 | **不承诺**；`stale` 原因必须逐条列出 |
| `failed` | 最近一次更新失败且无法保留可用状态（或索引 `invalid`） | 否（返回 E19/E02） | 拒绝回答，不返回旧数据 |

### 12.4.2 状态转换（唯一允许的转换集）

| 从 | 到 | 触发条件 |
|---|---|---|
| `fresh` | `dirty` | 文件监听收到变化信号 / 查询前 `stat` 校验发现 `mtime` 或 `size` 变化 |
| `dirty` | `indexing` | 调度器准入通过，任务开始 |
| `dirty` | `fresh` | 复核（内容哈希）后确认文件实际未变（事件抖动） |
| `indexing` | `fresh` | 提交协议第 10 步完成 |
| `indexing` | `stale` | 提交失败但旧索引可读 |
| `indexing` | `failed` | 提交失败且旧索引不可读，或 DB 损坏 |
| `stale` | `indexing` | 下一次更新开始 |
| `stale` | `fresh` | 更新成功且 `filesHash` 复核一致 |
| `failed` | `indexing` | `doctor --repair` 或重建开始 |
| 任意 | `failed` | `PRAGMA integrity_check` 失败、manifest 与 DB 不可调和 |

除上表外的转换视为实现缺陷，`doctor` 必须报出。

### 12.4.3 强制规则

1. **文件监听器只提供信号，不作为一致性依据。** 收到事件后必须先做内容哈希核对（或 `stat` 快速预判 + 哈希确认），才允许进入 `indexing`。
2. **必须有防事件遗漏的重新核对机制**：watch 模式下每 N 秒（默认 30s，可配）或每 M 次查询（默认 50 次）做一次全量 `stat` 扫描；发现漏事件立即转 `dirty` 并补一次增量。扫描期间不影响查询，但查询结果标 `verifying: true`。
3. **索引期间的查询必须能识别状态**：任何响应都必须带 `staleness` 字段，值取自状态机，不得由各命令自行推断。
4. **不得把 `dirty` / `indexing` 标记为 `fresh`**，即使是"刚刚改的只是注释"。
5. **更新失败必须保留最后一次有效索引**：回滚到上一个 `committed`，状态置 `stale`（可读）或 `failed`（不可读）。
6. **MCP 响应必须提供索引版本或新鲜度信息**：至少 `buildFingerprint`（前 8 位）+ `staleness` + `indexedAt`。
7. **必须区分"没有结果"与"尚未分析完"**：`indexing` 状态下对未覆盖文件的查询返回 `pending-analysis`，不得返回 `not-found`。
8. **重启后状态恢复**：进程启动先跑 12.3.3 的恢复流程，再从 `fresh` 或 `stale` 起步；禁止以 `fresh` 直接启动而不校验 `filesHash`。

### 12.4.4 状态与对外文案的统一

`status`、CLI 查询首行、MCP `structuredContent`、错误信息、文档示例，五处必须使用本节的状态名，不得出现 `outdated` / `up-to-date` / `syncing` 等同义词（跨章节冲突 23.4）。

## 12.5 忽略规则（全量与增量共用同一份）

"忽略哪些目录 / 文件"必须是可配置的一等概念。核心约束只有一条：**全量 build、增量 update、watch 必须使用同一份规则源**，否则全量与增量的索引范围不同，"增量=全量"的门禁失去意义。

```json
{
  "ignore": {
    "dirs": [".git", ".dsh", ".agent", ".turbo", ".cache", ".next", ".nexus",
             "node_modules", "dist", "build", "out", "coverage", "fixtures/local"],
    "files": ["*.min.css", "*.map", "*.snap", "*.log"],
    "globs": ["**/generated/**", "**/*.d.ts"],
    "include": [],
    "modes": ["build", "update", "watch"],
    "pruneWatcher": true
  }
}
```

**默认忽略基线（内置，不可静默清空）**：构建产物（`dist`、`build`、`out`、`.next`）、依赖与缓存（`node_modules`、`.turbo`、`.cache`）、版本库与工具目录（`.git`、`.dsh`、`.agent`）、索引自身（`.nexus`）永远在扫描前被排除。理由很具体：这些目录里的 `.d.ts` 与打包产物会引入重复符号和假引用，`.git` 里的对象文件一旦被当作源码解析就是纯噪声；Agent 工具目录常含大体积缓存与配置，索引它们既无意义也拖慢构建。

**基线的可见与可覆盖**：配置文件只能在这条基线上追加规则，不能删项；若确有需要把某目录重新纳入（例如从 `dist` 里读已发布的类型声明），必须显式写进 `include`，此时 `status` 打印「已反向纳入 X」并在 manifest 记录，禁止仅靠删配置就让默认目录消失。`nex doctor` 必须打印生效中的完整忽略清单与其来源（`builtin` / `config` / `include`）。

**必须声明，不得静默**：构建指纹记录 `ignoreHash` 与忽略清单摘要，`status` 返回 `ignoredFiles` 计数与最近一次规则变更；`coverage` 增加 `filesIgnored`。原因是忽略会缩小"可证明完整性"的范围——`references` 的 0 漏报只在索引范围内成立，用户必须能看见边界。

**跨越边界的引用**：未忽略文件引用被忽略文件时，该边记为 `unresolved(ignored)` 并带原因，不得默默丢弃；impact 中被忽略的消费方要出现在盲区清单里（8.2）。

**失效规则**：`ignore` / `include` / `style.aliases` 任一变化 → 全局重建（边界变了，局部推断不成立）。文件仅被忽略规则覆盖后重新纳入，同样按新增文件处理。

**禁止**：默认忽略 `src/**` 或任何业务源码目录；用忽略规则规避解析失败；忽略规则按模式不同而实质不同（`modes` 只允许控制"是否生效"，不允许各模式给不同清单）；删除或清空内置默认基线中的条目。

## 12.6 资源调度（引用 5.10）

构建与增量必须统一走 `Global Resource Coordinator`，禁止在索引层另起并发控制。三条约束：

1. 并发上限、内存预算、取消传播全部由 5.10 决定，索引层只报告"任务开始 / 进度 / 结束"。
2. 降级顺序严格按 5.10.4 的五级阶梯，不允许自定义顺序。
3. 降级结果必须写入 manifest 的 `degraded` 并在所有查询中可见。

## 12.7 索引健康与可观测性（引用 5.12）

- `status` 必须输出 5.12 的全部字段；`doctor` 必须能校验这些字段与实际数据是否自洽（例如 `fileCoverage` 的分母是否等于扫描结果）。
- 构建与增量必须输出：各阶段耗时、峰值 RSS、写入行数、降级事件、取消原因。统一写 stderr（`--verbose` 时）/ 写 manifest 摘要（始终）。
- CI 对峰值 RSS 设阈值，超限判失败（21.2）。

---

