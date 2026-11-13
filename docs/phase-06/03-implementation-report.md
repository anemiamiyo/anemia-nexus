# Phase 06 实施报告：增量、性能与一致性

> 依据：`docs/19-delivery-phases.md` 19.1/19.2/19.3、`docs/05-data-model.md` 5.10/5.11/5.12、`docs/12-indexing.md` 12.1–12.7、`docs/16-nfr-and-errors.md` 16.2/16.3、`docs/17-testing.md` 17.2、`docs/21-phase-00.md` 21.2
> 规范版本：v1.24（冻结）
> 日期：2026-11-13（Asia/Shanghai）
> 结论：**Phase 06 的增量一致性、七注入点恢复、状态机、调度/降级、指纹与门禁通过；八类性能场景已完成采集，但 P3（单文件增量）未达到 16.2 的 2s 目标，P7（MCP）因 Phase 07 未提供而记为 `not-available`。因此本阶段记为 `pass-with-limits`，等待负责人裁定；不得把 root 级保守重建表述为文件级增量。**

## 1. 授权、基线与范围

- 负责人 2026-11-13 批准进入 Phase 06；Phase 05 以 `pass` 关闭。裁定见 `docs/phase-05/03-implementation-report.md`。
- 基线 commit：`6725f99`（Phase 05 之后的 Prettier/行尾配置提交）；入场时 `git status --porcelain` 为空。
- 环境：Windows x64；Node 22.16.0；npm 10.9.2；`node:sqlite` 3.49.1；DSH 沙箱默认禁止 Node 子进程，构建/测试/性能在 `danger-full-access` 下执行。
- 范围：12.1 失效表、`nex update`、12.2 十项门禁、12.3 提交/恢复、12.4 状态机、5.10 调度器、5.11 指纹、F16/F18 夹具、P1–P8 采集、文档与报告。
- **不做**：文件级局部 AST 复用；真并行多 root 子进程编排；MCP/watch/print/`doctor --repair`/发布验证（Phase 07）。

## 2. 实际完成内容（19.3 状态标注）

| 模块 | 状态 | 说明 |
|---|---|---|
| 内容 Hash 变更检测 | implemented | 当前扫描 vs 上一 committed 的 `files.source_hash`；A/M/D/R；重命名按 Hash 唯一配对，歧义时保持 add+delete；禁止 mtime 判定 |
| 12.1 失效传播表 | implemented（保守） | `INVALIDATION_RULES` 12 条；文件变化→incremental，tsconfig/config/analyzer/schema/ignore/rootSet/recovered/surface-mismatch→full；`update` 以 root 为重建单位 |
| 反向闭包 | implemented | `computeInvalidatedClosure` 从 deps/refs/calls/tests 反向扩展，上限 2000 文件；用于 `--rebuild-affected` 证据与 manifest `invalidatedFiles` |
| `nex update` | implemented（root 级） | fresh/incremental/full 三模式；未变化 root 不写 DB/不启动 SCIP；`--rebuild-affected`、`--files`、`--serial`、`--budget-mb`；与 build 共用 `buildRoot`/`commitBuild`/恢复 |
| 12.2 门禁 | implemented | `verifyIncrementalEquivalence` 十项比较；差异快照每类前 20 条 + 计数；F08 的 A/M/D/R 场景通过；不得自动覆盖 |
| 12.3 提交协议 | implemented（补全） | pending→写行→完整性检查→COMMIT→只读校验→committed→manifest→surface→workspace→cleanup；七注入点；`manifest-repaired`/`pending-discarded` 事件 |
| 恢复矩阵 | implemented | committed/manifest 一致、manifest 滞后、pending+旧 manifest、pending+manifest 指向 pending、无 committed 有数据、integrity 失败、indexing 残留、surface 不一致 |
| 12.4 状态机 | implemented | 五态、转换表、`deriveRootState` 单源、indexing 标记、dirty 计算、非法转换 doctor 报 fail；重启先恢复 |
| 5.10 调度器 | implemented（串行执行） | 预算/权重/并发位/依赖顺序/同 root 锁/五级降级/取消；默认并发 1，不宣称并行 |
| 5.11 指纹 | implemented | 字段齐全；新增 `tsconfigHash` 并规范化绝对路径，保证跨目录同源可比；gitCommit 仅辅助；同输入两次 build 指纹一致 |
| 5.12 健康 | implemented | manifest 增加 `tsconfigHash`/`mode`/`changed`/`invalidatedFiles`/`lastIntegrityCheck`/`recoveryEvents`/`recovered`/`resources`；status 暴露状态机与能力 |
| F16 | implemented | 6 文件夹具 + 七注入点 SIGKILL + 恢复矩阵断言 |
| F18 | implemented | 3 root + 声明依赖 + 取消/失败隔离/旧索引保留 |
| 性能 P1–P8 | partial | P1/P2/P4/P5/P6/P8 有记录；P3 超目标；P7 `not-available`；50k+ 未测 |
| 文件级增量 | not started | 明确不做；P3 以 root 级重建测量 |
| 真并行多 root | partial | 并发位计算与串行执行；默认 1；子进程编排留待后续 |
| MCP/watch/print/doctor --repair | not started | Phase 07；仍 E24 |

## 3. 测试与验证证据

环境：Windows x64；Node 22.16.0；npm 10.9.2。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run build` | 0 | core / cli / mcp / adapter-vue ESM + d.ts；连续两次 dist 文件哈希逐字节一致 |
| `npm run typecheck` | 0 | 通过 |
| `npm run lint` | 0 | 0 error |
| `npm run format:check` | 0 | Prettier 通过 |
| `npm test` | 0 | **111 passed (13 files)**，94.66s |
| `act -j verify --container-options "-m 4g" --action-offline-mode` | 0 | Node 22.16.0：13 files / **111 passed**；Node 24.x：13 files / **111 passed**；两个 job 均 `Job succeeded` |
| `npx vitest run packages/core/test/incremental.test.ts` | 0 | 8 项：A/M/D/R、mtime、config full、状态机、no-op、增量=全量、root-set |
| `npx vitest run packages/core/test/recovery.test.ts` | 0 | 2 项：七注入点、pending 不被当作 current |
| `npx vitest run packages/core/test/scheduler.test.ts` | 0 | 6 项：预算/权重/顺序/阶梯、取消、失败隔离 |
| `node tools/perf/run.mjs --loc 1000/5000/10000` | 0 | P1–P8 记录；见 §4 |
| `node packages/cli/dist/main.js update`（10k 夹具） | 0 | 首次 full（config/root-set 变化）；单文件后 incremental；再次 fresh |
| 12.2 跨目录比较（10k 夹具） | pass | 十项全等；`buildFingerprint` 一致；修复了 tsconfig 绝对路径导致的指纹差异 |
| `git status --porcelain` | — | 仅本轮预期变更；`.nexus/tmp` 与 `.nexus/test-tmp` 为忽略目录 |

### 3.1 Gate 判定

| Gate | 结果 | 证据 |
|---|---|---|
| G0 变更检测与失效表 | pass | `invalidation.ts` 规则表；A/M/D/R 单测；mtime 同内容不触发 |
| G1 Update 与提交 | pass | no-op 零写、增量重建、失败保留旧索引、锁与恢复 |
| G2 增量=全量 | pass | F08 四类变更 + 10k 夹具十项全等；`buildFingerprint` 相同 |
| G3 崩溃恢复 | pass | F16 七注入点；manifest-repaired / pending-discarded / stale-surface |
| G4 状态机 | pass | 转换表、dirty/indexing、doctor 非法转换 |
| G5 调度与降级 | pass（串行） | 预算/权重/五级阶梯/E20/取消无提交/旧索引保留 |
| G6 指纹 | pass | 字段、tsconfigHash、同输入可复现、platform/gitCommit 不单独触发 |
| G7 构建与回归 | pass | build/typecheck/lint/format/test 全绿；Phase 01–05 断言不回归 |
| G8 性能与内存 | **partial** | P1/P2/P4/P5/P6/P8 有记录；**P3 未达 2s**；P7 not-available；50k+ 未测 |
| G9 输出与 CLI | pass | update 四格式、退出码、无 ANSI/绝对路径/时间戳 |
| G10 act | pass | Node 22.16.0 / 24.x 双矩阵各 111 项；`Job succeeded` ×2 |
| G11 文档 | pass | README（含目录结构）、docs/README、runtime-api、四份阶段文档、报告 |
| G12 自审 | pass（报告层） | 本报告、任务回填、已知问题、工作区残留 |

## 4. 性能与内存数据（16.2）

测量方式：`tools/perf/run.mjs`；`P1/P2/P3/P4/P5` 取 3 次中位数与最大值；`P3` 改 1 文件、`P4` 改 20 文件；P6 为进程内点查+一层邻接（10 次，p50/p95）；P8 为 F16 注入点到 `recoverWorkspace` 完成。生成项目位于 `.nexus/test-tmp/perf/`，不提交。

<!-- PERF_TABLE -->

| 场景 | 1k 行（中位/最大） | 5k 行（中位/最大） | 10k 行（中位/最大） | 5 万行档目标 | 结论 |
|---|---|---|---|---|---|
| P1 冷启动全量 | 2431 / 2460 ms | 3249 / 3250 ms | 4089 / 4102 ms | ≤ 20 s | pass（测试档位远低于目标） |
| P2 热启动全量 | 2443 / 2459 ms | 3215 / 3229 ms | 4074 / 4099 ms | 未单列 | 记录（cache 为空，仅验证路径） |
| P3 单文件增量 | 2479 / 2496 ms | 3485 / 3496 ms | 5308 / 5325 ms | ≤ 2 s | **target-miss**（root 级重建） |
| P4 20 文件增量 | 2475 / 2477 ms | 3466 / 3469 ms | 5265 / 5331 ms | ≤ 8 s | pass（10k 仍低于 8s） |
| P5 多 root | 4509 / 4534 ms（3 root 串行） | — | — | 无 16.2.2 数值 | 记录（串行） |
| P6 查询 p50/p95 | 9.56 / 10.24 ms | 25.85 / 27.03 ms | 44.29 / 46.52 ms | ≤ 30 ms（p95） | **target-miss**（10k 超过 30ms） |
| P7 MCP 延迟 | — | — | — | 无 16.2.2 数值 | **not-available**（Phase 07） |
| P8 崩溃恢复 | 12 ms | — | — | ≤ 5 s | pass（F16 注入点） |

内存与索引体积（同一批构建的 manifest 采样）：

| 规模 | 峰值 RSS | 硬上限（5 万行档） | SQLite（含 WAL） | 目标索引体积 |
|---|---|---|---|---|
| 1k 行 | 192.4 MB | 550 MB | 1.38 MB | 5–15 MB（5 万行档，仅供参考） |
| 5k 行 | 211.1 MB | 550 MB | 6.11 MB | 同上 |
| 10k 行 | 227.7 MB | 550 MB | 12.06 MB | 同上 |

**测量字段**：`projectLoc`、`fileCount`、`dependencyCount`（生成项目为 0）、`tsRatio`/`vueRatio`（1/0）、`nodeVersion`、`os`/`osVersion`、`cpuModel`/`cpuCores`、`availableMemMB`、`scenario`、`durationMs`、`peakRssMB`、`sqliteSizeMB`、`degraded`、`failureMode`、`buildFingerprint`、`repetitions` 均写入 `.nexus/test-tmp/perf-{1k,5k,10k}.json`（不提交）。完整原始数据见三份 JSON 的 `results` 与 `raw`。

**口径说明**：

- P1/P2 为 CLI 墙钟（含 Node 启动与 SCIP 子进程）；P3/P4 为 root 级重建；P5 为 3 root 串行。
- P6 为进程内查询，不含 CLI 启动；已预热。
- P7 无 MCP 传输，记 `not-available`。
- 峰值 RSS 为构建 CLI 进程 50ms 采样；SCIP 子进程 RSS 未计入。
- 生成项目无 `node_modules`，`dependencyCount = 0`。
- 50k/300k/1M 档未测；16.2.2 的 50k 列仅用于对照，不外推。

**结论**：P1/P2/P4/P6/P8 在 1k–10k 档低于 5 万行档目标；**P3 在 1k/5k/10k 均超过 2s**，未达到 16.2 目标；P5 无 16.2.2 数值目标但为串行；P7 不可用。按 21.2 与 16.2 的“不达标即登记、不调整口径”，本阶段不以性能宣布通过。

## 5. 已知问题与未完成事项

1. **文件级增量未实现**：`update` 重建整个受影响 root；P3 因此不达标。若 Phase 07 之后需要文件级复用，必须另立设计评审与等价性证明。
2. **多 root 串行**：`resources.concurrency` 默认 1；调度器计算上限但不启动并行子进程。F18/P5 记录串行。
3. **P7 不可用**：MCP server 属 Phase 07；性能报告不含 P7 数值。
4. **50k+ 未测**：只测 1k/5k/10k；百万行档按负责人批准未验证。
5. **P8 为 SIGKILL 自终止**：不是物理断电；恢复以 DB/manifest 最终状态为准。
6. **恢复后的 manifest 为 stale**：`recovered: true` 时需一次 `update`/`build` 才 fresh；不伪造 freshness。
7. **surface 不一致只标 stale**：缺少重新生成 surface 的独立命令；`update` 会重建。
8. **旧版本 manifest 无 `tsconfigHash`/`statHash`**：首次 update 判 full；这是预期的一次性重建。
9. **根集合移除不自动删目录**：新增 root 只建自己的索引，已有 root 不因 `rootSetHash` 变化而重建；移除 root 的 `.nexus/roots/<id>` 由 `doctor` 诊断、Phase 07 `--repair` 清理。
10. **`status` 行为变化**：源文件变化由 `stale` 改为 `dirty`（12.4）；Phase 05 断言已更新。
11. **查询期 freshness 使用 stat 快路径**：`statHash`（path/size/mtime）一致时跳过内容 Hash，以控制 P6 延迟；构建/更新仍以 `filesHash` 为权威。若外部工具在保留 size 与 mtime 的前提下改写内容，查询可能暂时误判 fresh，直到下一次 `update`/`build`。这是 12.4.3 “stat 预判 + 哈希确认”的保守折中，已在 README 限制中声明。
12. **P5 依赖顺序只在有 package.json 声明时生效**：无声明时按 rootId 稳定排序。

## 6. 依赖与架构变化

- 无新增第三方依赖；新增使用 `node:os`（`freemem`/`cpus`）与 `process.kill`（仅测试注入），已登记 `docs/runtime-api.md`。
- 新增模块：`store/{state,recovery,workspace,inject}.ts`、`index/{invalidation,equivalence}.ts`、`scheduler.ts`、`tools/perf/{generate,run}.mjs`。
- 修改：`index/{build,fingerprint}.ts`、`store/{commit,manifest,lock}.ts`、`status.ts`、`doctor.ts`、`query/service.ts`、`graph/builder.ts`、`config/{schema,merge}.ts`、`index.ts`、`cli/{cli,render}.ts`。
- **配置新增**：`defaults.resources.{maxMemoryMB,concurrency}`（默认 900 / 1）；`configHash` 因此变化，旧索引首次 update 全量重建。
- **行为变化**：`dirty` 状态；`update` 成为真实命令；`E20` 取消/资源不足；恢复事件写入 `.nexus/roots/<id>/recovery-events.jsonl`。
- Schema 仍为 v4；无表结构变更。

## 7. 对后续阶段影响

- **Phase 07** 可复用：`buildWorkspace({mode:'update'})`、`recoverWorkspace`、`deriveRootState`、`computeResourceBudget`、`verifyIncrementalEquivalence`、`readIndexingMarker` / 锁。
- MCP `refresh` 必须与 CLI `update` 共用 `withRootLock`；持锁 E08，watch 排队。
- `doctor --repair` 复用 `recoverWorkspace({repair:true})` 与 workspace 重建。
- `nex test --scale` 复用 `tools/perf/generate.mjs` 与采集器。
- 性能：Phase 07 若要在 50k 档达标，需要文件级增量或降低固定开销；本阶段不承诺。

## 8. 文档同步

- `README.md`：状态、能力表、`update` 命令、状态机、P1–P8 限制、**项目目录结构**。
- `docs/README.md`：阶段索引加入 `phase-06/`。
- `docs/runtime-api.md`：登记 `node:os`、`process.kill`。
- `docs/phase-06/{00,01,02,03}.md`：新增。
- 未修改 v1.24 规范正文。

## 9. 自审回执

**审查范围**：实际磁盘代码 + `git diff`；核心为 `packages/core/src/{index,store,scheduler,status,doctor,query,graph,config}`、`packages/cli/src`、`packages/core/test/{incremental,recovery,scheduler}`、`fixtures/F16|F18`、`tools/perf`、`docs/phase-06`。

**边界与安全审查**：

| API / 文件 | 风险场景 | 结论 | 代码证据 |
|---|---|---|---|
| `store/lock.ts` | 崩溃残留锁、误删活锁 | 仅当 owner.json 的 pid 已死才删除；活进程不碰；仍由 proper-lockfile 原子创建 | `lock.ts` |
| `store/recovery.ts` | 以 manifest 覆盖 DB、删错数据 | DB 为权威；pending 定向删除；invalid 不删；surface 只标 stale | `recovery.ts` |
| `store/inject.ts` | 产品误触发崩溃 | 仅 `NEXUS_CRASH_AT` 环境变量匹配时 SIGKILL；默认 inert | `inject.ts` |
| `index/invalidation.ts` | 重命名误配、mtime 误判 | Hash 唯一配对；歧义不猜；不用 mtime/size | `invalidation.ts` |
| `scheduler.ts` | 降级跳级、超预算继续 | 固定阶梯；85% 触发；abort E20；旧索引由事务保护 | `scheduler.ts` |
| `store/state.ts` | 非法转换、dirty 冒充 fresh | 转换表；derive 单源；indexing 标记；非法转换 doctor fail | `state.ts` |
| `index/equivalence.ts` | 只比行数、自动覆盖 | 十项比较；差异快照；只读 | `equivalence.ts` |

**递归检查**：无新增递归；反向闭包 BFS 使用显式 frontier；依赖拓扑排序使用迭代 Kahn；AST 遍历沿用既有 `forEachChild`。

**测试结果**：见 §3；本地 111 项通过；act Node 22.16.0 / 24.x 双矩阵各 111 项通过。

**已知缺陷**：root 级增量、串行多 root、P3/P6 超目标、P7 不可用、50k+ 未测、SIGKILL 模拟、recovered manifest stale。

**兼容性影响**：配置新增 `resources` → `configHash` 变化，旧索引首次全量重建；`status` 由 `stale` 改为 `dirty`；`update` 成为真实命令；无 Schema 变更。

**最终结论**：

**pass-with-limits。增量一致性、七注入点恢复、状态机、调度/降级、指纹与门禁通过；P3 性能未达 16.2 目标，P7 不可用，多 root 默认串行。等待负责人裁定；未经批准不进入 Phase 07。**
