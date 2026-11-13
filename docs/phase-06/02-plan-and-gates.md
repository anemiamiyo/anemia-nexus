# Phase 06 实施计划与验收门槛（编码前冻结）

> 依据：`docs/19-delivery-phases.md` 19.1/19.2/19.3、`docs/05-data-model.md` 5.10/5.11/5.12、`docs/12-indexing.md` 12.1–12.7、`docs/16-nfr-and-errors.md` 16.2/16.3、`docs/17-testing.md` 17.1/17.2、`docs/21-phase-00.md` 21.2、`docs/20-prohibitions.md`
> 入场判定：`docs/phase-06/00-entry-and-decisions.md`
> 规范版本：v1.24（冻结）
> 冻结日期：2026-11-13
> **本文件的门槛在编码开始前冻结；不达标时按 20.6 报告，不得事后调低。**

## 1. 范围与不变量

### 1.1 本阶段范围

- 内容 Hash 变更检测与 12.1 失效传播表；
- `nex update`（root 级保守重建、`--rebuild-affected`、`--files`）；
- 12.2 十项增量一致性门禁；
- 12.3 提交协议补全、启动恢复矩阵、七注入点、保留/清理；
- 12.4 五态状态机与统一 `staleness`；
- 5.10 全局资源协调器、降级阶梯、取消；
- 5.11 指纹补全（含 `tsconfigHash`）；
- 5.12 健康快照与 `lastIntegrityCheck`；
- F16/F18 夹具、F11 生成器、P1–P8 基准；
- README（含目录结构）、阶段文档与实施报告。

### 1.2 不变量（违反即 gate 失败）

1. DB 为权威，manifest/surface/workspace 为派生；不得反向覆盖。
2. 提交顺序固定；失败 ROLLBACK；旧 committed 保留。
3. 内容 Hash 判定；不得以 mtime/size 单独判定。
4. 增量与全量十项比较全等；不一致不得自动覆盖。
5. `dirty`/`indexing` 不得标 `fresh`；所有查询 `staleness` 取自状态机。
6. 不跨 root 污染；不产出合并索引；失败隔离。
7. 降级显式；`degraded` 非空必须可见。
8. 只写 `.nexus/`；`update` 不写项目源文件；`print`/MCP 仍不实现。
9. 四格式同源；lines/json 无 ANSI/绝对路径/时间戳。
10. 不修改 v1.24 正文；冲突按 20.6 报告。
11. 未实现/未验证项必须标 `partial` / `not-available` / `failed`，不得冒充。

## 2. Gate 定义

| Gate | 判定 | 通过条件 | 证据 |
|---|---|---|---|
| **G0 变更检测与失效表** | 变更源→产物显式 | 规则表存在且被代码引用；A/M/D/R 判定正确；mtime 同内容不触发；配置/tsconfig/分析器变化 → full | 单测 + 规则表 |
| **G1 Update 与提交** | 增量可写、可回滚 | `update` 四模式；共用 buildRoot；锁；失败保留旧索引；workspace 更新 | 集成测试 + `git status` |
| **G2 增量=全量** | 十项全等 | D 组比较器十项全等；差异快照为空；指纹相同；F08/F15/F14 至少各一条 | 门禁测试输出 |
| **G3 崩溃恢复** | 七注入点 | F16 七点 SIGKILL 后恢复矩阵逐行正确；旧索引可查询；无 pending 残留 | F16 测试 + 恢复矩阵 |
| **G4 状态机** | 五态唯一转换 | 转换表实现；status/query 统一；非法组合 doctor 报；dirty/indexing 不升 fresh；重启先恢复 | 单测 + doctor |
| **G5 调度与降级** | 阶梯与预算 | 预算/权重/并发位计算；五级顺序；E20；取消无提交；F18 通过；旧索引保留 | 单测 + F18 |
| **G6 指纹** | 可复现、可解释 | 字段齐全；tsconfigHash 生效；同输入两次一致；platform/gitCommit 不单独触发 | 单测 + 两次构建 |
| **G7 构建与回归** | 不回归 | build/typecheck/lint/format 退出 0；`npm test` 全绿；F01/F05/F10/F14/F15/F17 断言不回归 | 命令输出 |
| **G8 性能与内存** | 八类记录完整 | P1–P8 各 ≥1 条完整记录（字段齐全，重复 ≥3）；P1/P4/P5/P6/P8 在测试档位达标；P7 标 `not-available`（Phase 07）；P3 实测并显式登记偏差；内存预算对比 | `perf` 结果 JSON + 报告 |
| **G9 输出与 CLI** | 四格式同源 | `update` 四格式字段一致；退出码 0/1/2/64/70；无 ANSI/绝对路径/时间戳 | CLI 测试 |
| **G10 act** | 容器复现 | `act -j verify` 通过（环境允许时）；Node 22.16.0 / 24.22.3 | act 输出 |
| **G11 文档** | 同步且不越权 | README（含目录结构）、docs/README、runtime-api、阶段四份文档、报告 | 文件审查 |
| **G12 自审** | 报告可复核 | 19.3 九项、任务回填、已知问题、`git status` 无残留 | 报告 + 命令 |

**19.1 阶段 06 通过条件**：增量与全量全字段等价；七注入点崩溃恢复通过；八类性能场景记录完整且达到 16.2 目标；内存落入 21.2 预算。

**本阶段对“达到 16.2 目标”的口径**（编码前冻结，不得事后放宽）：

- 16.2.2 的数字是“待校准目标”，Phase 00 未固化 50k+ 的 P1/P3/P4/P6/P8；本阶段只在 **1k/5k/10k 行** 三档实测，并逐项对照最近的 5 万行档目标值。
- **P1/P4/P6/P8**：测试档位必须低于 5 万行档目标（更小规模更严格）。
- **P3**：以 root 级保守重建测量；若超过 2s，标记 `target-miss`，**Phase 06 总体结论降为 `pass-with-limits`，并请求负责人裁定**；不得改口径、不得把 root 级重建写成文件级增量。
- **P5**：无 16.2.2 数值目标；记录实际并发位与总耗时，串行应显式标注。
- **P7**：MCP 在 Phase 07 前不存在，记 `not-available` 并给原因；不计为通过。
- **内存**：1k/5k/10k 峰值 RSS 对照 5 万行档目标（≤400 MB / 硬上限 550 MB）；50k+ 未验证，不外推。
- **P8**：以 F16 注入点到可查询的耗时计；≤5s（5 万行档目标）在测试档位作参考。

## 3. 量化口径

### 3.1 增量一致性（12.2 十项）

1. 符号集合：按 `symbolId` 排序，逐条比 name/kind/signature/visibility/identityConfidence。
2. 符号身份：`symbolId` 集合相同；`symbol_id_history` 的 active 集合相同。
3. 引用：`(source_id,target_id,kind,relationClass,confidence)` 多重集相同。
4. 导出：Surface 导出边多重集相同（`surface.entries` 的 entryPath/condition/exportKind）。
5. 文件状态：`(path,sourceHash,status)` 相同。
6. API Surface：`surfaceHash` 相同。
7. 依赖与调用：边集合相同（含 `analysisEngine`）。
8. 构建指纹：`buildFingerprint` 相同；`degraded` 不同即不等价。
9. 覆盖率：`fileCoverage`/`semanticCoverage`/`referenceCoverage`/`unresolvedRate`/`mappingSuccessRate` 相同。
10. manifest：除 `builtAt`/`lastSuccessAt`/`lastFailureAt`/`timings`/`memory`/`dbBytes`/`walBytes` 外全部相同。

差异快照：每类前 20 条 + 计数；失败退出非零；不得自动重跑全量覆盖。

### 3.2 恢复矩阵（12.3.3 + 12.4）

| 现场 | 判定 | 必做动作 |
|---|---|---|
| committed + manifest 一致 + surface/workspace 一致 | normal | 无 |
| committed，manifest 旧 | manifest 滞后 | 以 DB 重写 manifest；`manifest-repaired` |
| pending，manifest 旧 | 提交中断 | 删 pending；旧索引可读；`stale` |
| pending，manifest 指向 pending | 协议违反 | `invalid`；E19；要求重建 |
| 无 build_record 但有数据 | 旧版/损坏 | `invalid`；E19；`doctor --repair` 给命令 |
| integrity_check 失败 | 损坏 | E07；只删重建，不抢救 |
| indexing 标记残留 | 进程中断 | 清标记；状态 `stale` |
| surface/workspace 与 manifest 不一致 | 派生滞后 | 标 `stale`；给重建动作 |

### 3.3 调度

- 预算：`min(config.resources.maxMemoryMB, floor(os.freemem/1MB × 0.5))`；默认 900 MB。
- 并发位：`min(config.concurrency, floor(globalBudget / estimateMB), cpuCores-1, rootCount)`，至少 1。
- 降级顺序：`calls-off` → `chunked` → `vue-projection-reduced` → `serialize` → `abort-root(E20)`。
- 触发：单 root RSS ≥ 85% 预算；降级不得跳级；abort 保留旧索引。
- 取消：≤2s 内停止；无部分提交；tmp 清空。

### 3.4 性能记录字段（缺一无效）

`projectLoc`、`fileCount`、`dependencyCount`、`tsRatio`、`vueRatio`、`nodeVersion`、`os`、`osVersion`、`cpuModel`、`cpuCores`、`availableMemMB`、`scenario`、`durationMs`、`peakRssMB`、`sqliteSizeMB`、`degraded`、`failureMode`、`buildFingerprint`、`repetitions`。

重复 ≥3；报告中位数与最大值；进程间重启；不在降级状态宣称达标。

## 4. 风险与暂停条件

出现以下任一情况，暂停编码并按 20.6 报告，不自行降低门槛：

1. 10 项比较出现无法用指纹/实现解释的差异。
2. 注入点恢复后出现数据丢失或旧索引不可读。
3. 状态机出现允许集之外的转换且无法定位。
4. 降级后旧索引被破坏。
5. 为达成性能目标需要改变 certain 口径或伪造数据。
