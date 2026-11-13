# Phase 06 入场记录：增量、性能与一致性

> 记录日期：2026-11-13（Asia/Shanghai）
> 依据：`docs/19-delivery-phases.md` 19.1/19.2/19.3、`docs/05-data-model.md` 5.10/5.11/5.12、`docs/08-relations.md` 8.1/8.2、`docs/11-cli.md` 11.1/11.3/11.5、`docs/12-indexing.md` 12.1–12.7、`docs/14-agent-integration.md` 14.1.2（仅接口依赖）、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md` 16.2/16.3、`docs/17-testing.md` 17.1/17.2、`docs/19-delivery-phases.md`、`docs/20-prohibitions.md` 20.2、`docs/21-phase-00.md` 21.2
> 规范版本：v1.24（冻结）
> 前置：`docs/phase-05/03-implementation-report.md`（Phase 05，pass，负责人 2026-11-13 批准进入 Phase 06）
> 状态：**负责人 2026-11-13 批准进入 Phase 06。本文件与 `01-task-checklist.md`、`02-plan-and-gates.md` 共同构成编码前冻结基线。**

## 1. 授权与基线

| 项 | 值 |
|---|---|
| 负责人裁定 | 2026-11-13：接受 Phase 05 以 `pass` 关闭；**允许进入 Phase 06** |
| 基线 commit | `6725f991…`（Phase 05 实现提交后的 Prettier/行尾配置提交） |
| 工作区 | `git status --porcelain` 为空；`.actrc` 为负责人本地 act 配置，不纳入库 |
| Node / npm | v22.16.0 / 10.9.2（本地）；act 矩阵沿用 Node 22.16.0 与 24.22.3 |
| Schema | **保持 `SCHEMA_VERSION = 4`**；本阶段不新增表、不改既有列。状态机与恢复使用 `.nexus/` 派生文件 + `build_record` 既有字段 |
| 本地执行环境 | DSH 沙箱默认禁止 Node 子进程（`spawn EPERM`）；构建/测试/基准需在 `danger-full-access` 下执行，否则 SCIP 子进程无法启动。该限制只影响验证执行，不改变产品行为 |
| 冻结文件 | 本文件、`01-task-checklist.md`、`02-plan-and-gates.md`；编码开始后不得调低门槛 |

## 2. 本阶段范围

### 2.1 交付能力（对应 19.1 阶段 06）

1. **内容 Hash 变更检测（12 章）**：新增、删除、修改、重命名识别；禁止按 mtime 判断；`sourceHash` 跨构建比较。
2. **12.1 失效传播表**：显式规则表（变更源 → 必须失效的产物 → 重建范围），并在代码中作为唯一判定源；tsconfig / 路径别名 / package.json / 锁文件 / 分析器版本 / Schema / 根集合 / 配置合并结果 / `symbolId` 算法变化按表级联。
3. **`nex update`（11.1）**：按 root 失效；`--rebuild-affected`、`--files <glob>`；无变化时零写入快速返回；与 `build` 共用提交协议。
4. **12.2 增量一致性门禁**：全量 vs 增量十项比较（符号集合、身份、引用五元组、导出、文件状态、SurfaceHash、依赖/调用边含引擎、构建指纹、覆盖率、manifest 除时间戳）；不一致输出差异快照（前 20 条 + 计数），不得自动用全量覆盖。
5. **12.3 提交协议**：固定顺序；DB 为权威、manifest 为派生；启动恢复矩阵；`.nexus/tmp/` 清理；保留最近 2 个 committed；并发锁沿用 `proper-lockfile`（按 root）。
6. **12.3.3 崩溃恢复**：七注入点（F16）后重启，状态与数据符合表定义；旧索引可用。
7. **12.4 状态机**：`fresh` / `dirty` / `indexing` / `stale` / `failed` 五态；唯一允许转换集；`staleness` 取自状态机；更新失败保留最后有效索引；重启先恢复再服务。
8. **5.10 全局资源协调器**：全局预算、root 权重、并发位、依赖顺序、同 root 合并、取消传播、五级降级阶梯；降级写入 manifest 并在查询中可见。
9. **5.11 构建指纹**：`filesHash` / `configHash` / `schemaVersion` / `analyzerVersion` / `rootSetHash` / `nodeVersion` / `sqliteVersion` / `platform` / `degraded`；新增 `tsconfigHash` 纳入 `configHash` 语义；`gitCommit` 仅辅助；`builtAt` 不入指纹。
10. **5.12 健康快照**：`lastIntegrityCheck`、`filesIgnored`、`filesFailed`、`degraded`、按 root 的 `state`/`staleness` 写入 manifest 与 `status`。
11. **性能基准（16.2）**：P1–P8 八类场景分别记录；16.2.3 全字段；重复 ≥3 次取中位数与最大值；生成器 F11（1k/5k/10k 行，可选更大）。
12. **夹具**：F16 crash-recovery（6 文件 / ≤200 行）、F18 scheduler（3 root / 12 文件 / ≤350 行）；F08/F15/F14 复用。
13. **文档与报告**：README（含项目目录结构）、`docs/README.md`、`docs/runtime-api.md`、阶段四份文档、实施报告。

### 2.2 明确不做

| 能力 | 处理 |
|---|---|
| 文件级局部 AST 复用（只重算受影响文件的声明/引用/调用） | **本阶段不做**。SCIP 是整程序索引；局部复用会把“正确性”建立在未验证的边界上。`update` 采用**按 root 的保守重建**：文件级变更检测 + 完整失效传播 + 受影响 root 重建；未受影响 root 零写入。P3/P4 以该口径测量，不冒充文件级增量 |
| 多 root 真并行子进程编排 | 默认并发位 1（内存安全）；调度器实现并发上限计算与 `Promise` 池，但默认串行。P5 以实际并发位记录，不宣称并行加速 |
| `nex context` / `nex similar` / `audit-duplicates` CLI | Phase 07 |
| MCP 8 工具、watch、refresh、`print`、`doctor --repair`、发布验证 | Phase 07；本阶段只保留 `staleness` / 指纹 / 锁接口供其复用 |
| 百万行档性能与内存 | 不进入 CI；本阶段记录 1k–10k 实测，50k/300k/1M 只给未验证声明，不外推 |
| 自动修复、自动合并、自动改写 | 永久禁止 |
| 跨 root 合并索引 / 跨 root BFS | 5.9 / 5.7 禁止 |

### 2.3 不变量（违反即 gate 失败）

1. **DB 为权威**：任何 DB 与 manifest/surface 不一致，以 `committed` 记录为准；manifest 可重写，不得反向覆盖 DB。
2. **不得把 `dirty` / `indexing` 标成 `fresh`**；查询必须带状态机给出的 `staleness`。
3. **更新失败保留最后有效索引**：失败后旧 `committed` 可读；无可用索引才 `failed`。
4. **提交顺序固定**：pending → 完整性检查 → COMMIT → 校验 → committed → manifest → surface → cleanup。
5. **不自动“取全量结果覆盖”增量缺陷**；不一致即失败并出差异快照。
6. **内容 Hash 为准**：禁止 mtime/大小单独判定；重命名按 Hash 配对，无法唯一配对时记 added+deleted 并保留证据。
7. **不跨 root 污染**：一个 root 失败不影响其它 root；不产出跨 root 合并索引。
8. **降级显式**：`degraded` 非空必须写入 manifest、`status` 与查询输出；不得降级后宣称完整。
9. **锁不自研**：沿用 `proper-lockfile`；锁粒度 root；写临时目录 → 校验 → 原子 rename。
10. **输出契约**：四格式同源；lines/json 无 ANSI、无绝对路径、无时间戳；裁剪有 `truncated` + `nextCursor`。
11. **只读命令不写项目文件**：`update`/`build`/`doctor --repair` 之外不得写 `.nexus/`；`update` 只写 `.nexus/` 下派生文件。
12. **不修改 v1.24 正文**；冲突按 20.6 报告。
13. **不冒充**：未实现、未验证、跳过项必须标 `partial` / `heuristic` / `unresolved` / `unsupported` / `failed`。

## 3. 关键技术决策（编码前冻结）

### 3.1 增量粒度：root 级保守重建

**决策**：`nex update` 对每个 root 做内容 Hash 变更检测与 12.1 失效传播判定：

- 无变化 → `mode: fresh`，零写入。
- 仅文件内容/新增/删除/重命名变化，且无配置/tsconfig/分析器/根集合/Schema 变化 → `mode: incremental`，**重建该 root**；重建使用与全量完全相同的分析路径，因此结果与全量逐字段等价。
- 触发 tsconfig、配置合并结果、分析器版本、Schema、根集合、`symbolId` 算法变化 → `mode: full`，重建该 root；不整仓重建（除非根集合移除/新增的语义要求）。

**理由**：

1. 当前分析链以 `scip-typescript` 的整程序索引与单一 TS Program 为核心；局部重算引用/调用需要新分析器与新的等价性证明，超出本阶段可验证范围。
2. 12.1 的“必须失效”是最小集合；保守地重建整个 root 是超集，不会漏失效，因此正确性优先。
3. 12.2 门禁仍能真实检验“增量路径与全量路径等价”，避免只比行数。
4. 未变化 root 完全跳过（不扫描、不打开 DB 写事务），多 root 场景有明显收益。

**限制**（写入 README 与实施报告）：不宣称文件级增量；P3/P4 只按 root 重建口径记录；50k+ 目标未验证，不外推。

### 3.2 状态机与持久化

**决策**：

- 持久态写入 `manifest.staleness`：`fresh` / `stale` / `failed`。
- `dirty` 为查询期计算：manifest 的 `filesHash` 与当前扫描不一致，或 `configHash`/`tsconfigHash`/`analyzerVersion` 不一致，且尚未开始更新。
- `indexing` 为进程内/跨进程标记：`.nexus/roots/<rootId>/indexing.json`（含 pid、startedAt、phase）。构建开始写、成功/失败/取消后删；进程崩溃残留由恢复流程清理并标 `stale`。
- 唯一转换集在 `store/state.ts` 中以表定义；`doctor` 对“非法状态组合”报 error。
- 重启先跑 12.3.3 恢复，再服务；禁止未校验 `filesHash` 直接 `fresh`。

### 3.3 提交协议与恢复

**决策**：

- 复用 Phase 05 的 `BuildWriter` 单事务 + pending 校验 + committed flip；补：
  - COMMIT 前 `crashPoint('after-rows-before-commit')`；
  - COMMIT 后 `after-commit-before-flip`；
  - flip 后 `after-flip-before-manifest`；
  - manifest 临时文件写完、rename 前 `manifest-tmp-written`；
  - manifest rename 后 `after-manifest-before-surface`；
  - surface 写完后 `after-surface-before-workspace`；
  - workspace 写完后 `after-workspace-before-cleanup`。
- 注入点通过 `NEXUS_CRASH_AT` 环境变量触发 `process.kill(process.pid, 'SIGKILL')`，模拟断电；不由产品默认触发。
- 恢复矩阵按 12.3.3 六行 + 完整性检查实现；`manifest-repaired` / `pending-discarded` 事件写入 `.nexus/roots/<rootId>/recovery-events.jsonl`（最多保留 20 条）。
- `surface.json` / `workspace.json` 为派生视图；与 DB/manifest 不一致时标 `stale` 并给出重建动作，不伪造内容。
- 保留最近 2 个 committed（既有实现）；pending 定向删除；`.nexus/tmp/` 每次启动与构建结束清空。

### 3.4 全局调度器

**决策**：

- 新增 `resources` 配置（`defaults.resources`，root 覆盖可选）：`maxMemoryMB`（默认 900）、`concurrency`（默认 1）。
- 全局预算 = `min(config.maxMemoryMB, floor(os.freemem/1MB × 0.5))`；单 root 预算按上次 `peakRssMB` 归一化权重分配，首次均分。
- 并发位 = `min(config.concurrency, floor(globalBudget / 单任务预估峰值), cpu物理核数 - 1)`，且至少 1。
- 依赖顺序：按 root 的 `package.json` dependencies 拓扑排序（被依赖先建），无法解析依赖时按 rootId 稳定排序。
- 降级阶梯（严格顺序）：`calls-off` → `chunked` → `vue-projection-reduced` → `serialize` → `abort-root(E20)`。本实现中 `chunked` 为写入批次（已流式），`vue-projection-reduced` 为逐文件投影（已具备）；记录为生效/固有，不伪装为优化。
- 取消：`AbortSignal` 贯穿 build/update；取消后事务 ROLLBACK、删 tmp、清单标 `stale`（旧 committed 保留）。

### 3.5 构建指纹

**决策**：

- 保持 5.11 字段；新增 `tsconfigHash`（root 的 tsconfig 内容 Hash）并入 `configHash` 计算，确保 tsconfig/路径别名变化触发重建与指纹变化。
- `gitCommit` 只写入 manifest 与诊断，不进入指纹；`platform` 保留在指纹字段中（5.11 表要求），但**不作为单独重建触发条件**。
- 重建判定只看：`filesHash`、`configHash`（含 tsconfigHash）、`analyzerVersion`、`schemaVersion`、`rootSetHash`、`ignoreHash`。
- 同一指纹下 lines/json 输出逐字节一致；`builtAt`/`lastSuccessAt` 不参与指纹。

### 3.6 性能测量口径

- 生成器：`tools/perf/generate.mjs`（1k/5k/10k 行三档，默认不提交生成物）；`--scale` 可更大，仅本地。
- 场景：P1 冷启动、P2 热启动（有 cache 无 DB）、P3 单文件、P4 20 文件、P5 多 root、P6 查询 p50/p95、P7 MCP（Phase 07 未提供 → `not-available`）、P8 崩溃恢复。
- 每次 ≥3 次、进程重启、取中位数与最大值；16.2.3 字段齐全；`sqliteSizeMB` 含 WAL；`peakRssMB` 50ms 采样。
- 50k/300k/1M 档不在 CI；报告只写实测档位，不外推。

## 4. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| root 级重建达不到 P3 目标 | 性能门禁不通过 | 如实记录；限制声明；不调低口径；Phase 07 若需文件级增量，另立设计评审 |
| 崩溃注入使用 SIGKILL 在 Windows 的语义差异 | F16 结果偏差 | 记录平台差异；以 DB/manifest 最终状态为准，不以退出信号为唯一断言 |
| `os.freemem()` 波动导致调度测试不确定 | 测试抖动 | 调度器接受注入的 `availableMemMB`；测试用固定值；产品用实时值 |
| manifest 重建依赖 DB 统计 | 恢复后字段缺失 | 从 DB 计算 counts/coverage；timings/memory 置 0 并标 `recovered: true`；查询不依赖 timings |
| 改变 `stale` → `dirty` 影响既有断言 | 回归 | 更新 Phase 05 相关断言；报告登记行为变化；12.4.4 要求统一状态名 |
| 新增 `resources` 配置改变 `configHash` | 旧索引需重建一次 | 首次 update 判 `config-changed` 全量重建；不迁移数据 |

## 5. 对后续阶段的接口

- **Phase 07** 可直接复用：`updateWorkspace`、`recoverWorkspace`、`deriveRootState`、`computeResourceBudget`、`verifyIncrementalEquivalence`、`readIndexingMarker`。
- MCP `refresh` 必须与 CLI `update` 共用 `withRootLock`；持锁时返回 E08，watch 排队等待（12.3.5）。
- `doctor --repair` 复用 `recoverWorkspace({repair:true})` 与 `workspace.json` 重建。
- `nex test --scale` 复用 `tools/perf/generate.mjs` 与 `perf.ts` 采集器。
