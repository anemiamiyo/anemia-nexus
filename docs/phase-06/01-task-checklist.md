# Phase 06 任务清单（编码前冻结）

> 依据：`docs/phase-06/00-entry-and-decisions.md`、`docs/19-delivery-phases.md` 19.1/19.3、`docs/05-data-model.md` 5.10/5.11/5.12、`docs/12-indexing.md` 12.1–12.7、`docs/11-cli.md` 11.1/11.3/11.5、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md` 16.2/16.3、`docs/17-testing.md` 17.1/17.2、`docs/21-phase-00.md` 21.2
> 规范版本：v1.24（冻结）
> 标记约定：`[ ]` 未完成；`[x]` 已完成并附证据；`[~]` 部分完成（必须写限制）；`[!]` 未完成/失败（必须写原因）。不得用 `[x]` 标注未验证项。
> **本清单在编码开始前冻结；完成回填时只改标记与证据，不删条目、不降门槛。**

## A. 入场、基线与文档

- [x] **A01 基线与授权**：确认 commit `6725f99`、工作区干净、Node 22.16.0 / npm 10.9.2；记录负责人 2026-11-13 批准进入 Phase 06。
- [x] **A02 冻结计划**：`00-entry-and-decisions.md` / `01-task-checklist.md` / `02-plan-and-gates.md` 三份齐备；编码前不改门槛。
- [x] **A03 规范对照**：逐条核对 19.1 阶段 06、12.1–12.7、5.10–5.12、16.2、21.2、17.2 #8/#10/#11/#14/#15/#19/#20/#22；冲突按 20.6 上报。
- [x] **A04 范围冻结**：确认 §2.2 的“不做”清单；不提前实现 MCP、watch、print、doctor --repair、发布验证。
- [x] **A05 遗留台账**：把 Phase 05 §5/§6 的增量、性能、内存、postflight 新鲜度等登记到 §6；指定目标与验收口径。
- [x] **A06 文档索引**：更新 `docs/README.md` 阶段索引；README 状态改为 Phase 06（实现完成后）。

## B. 变更检测与 12.1 失效传播

- [x] **B01 规则表**：新增 `invalidation.ts`，显式导出 `INVALIDATION_RULES`（变更源、必须失效产物、重建范围、触发条件）；代码与文档同源。
- [x] **B02 内容 Hash 比较**：比较当前扫描与上一 committed 的 `files` 行，输出 added/modified/deleted/renamed；禁止用 mtime/size 单独判定。
- [x] **B03 重命名识别**：按 `sourceHash` 唯一配对；无法唯一配对时记 added+deleted 并保留证据；重命名不继承旧 `symbolId`（由 5.2 规则决定）。
- [x] **B04 root 级触发**：`configHash`、`tsconfigHash`、`analyzerVersion`、`schemaVersion`、`ignoreHash`、`rootSetHash`、`symbolId` 算法变化 → `full`；文件内容变化 → `incremental`；全无变化 → `fresh`。
- [x] **B05 反向闭包**：从上一 committed 读取反向 dependencies / references / calls / tests，计算受影响文件闭包；用于 `--rebuild-affected` 与 manifest 的 `invalidatedFiles` 证据。
- [~] **B06 根集合变化**：新增 root 全量、移除 root 删目录、其余不变；不整仓重建（5.8/17.2 #15）。
- [x] **B07 配置合并结果变化**：配置/路径别名/ignore 变化 → 该 root 全量；跨 root 声明依赖变化时登记 cross-package 边失效。
- [x] **B08 指纹对比**：以 manifest 的 `buildFingerprint` 字段与当前输入逐项比较；`platform` / `gitCommit` 变化不单独触发重建。
- [x] **B09 单测**：A/M/D/R 各 ≥1；mtime 同内容不触发；配置变化 → full；根集合变化只影响目标 root；重命名歧义不猜。

## C. `nex update` 命令

- [x] **C01 Core 入口**：`updateWorkspace(options)`；按 root 判定 fresh/incremental/full；未变化 root 不打开写事务。
- [x] **C02 参数**：`--rebuild-affected`（有变更的 root 强制全量）、`--files <glob>`（把匹配文件视为变更；无匹配给 warning）、`--serial`、`--budget-mb`、全局 `--root`/`--roots`。
- [x] **C03 锁与合并**：按 root `withRootLock`；同 root 更新请求合并（进程内）或返回 E08（跨进程锁占用），不得并发写。
- [x] **C04 提交复用**：update 与 build 共用 `buildRoot`/`commitBuild`/恢复路径；不复制第二套写入逻辑。
- [x] **C05 工作区文件**：build/update 成功后原子更新 `.nexus/workspace.json`（含 rootSetHash、buildFingerprint、state）；rootSetHash 不一致时以权威来源重建并记事件。
- [x] **C06 输出**：四格式同源；每 root 给 `mode`（fresh/incremental/full）、changed/added/modified/deleted/renamed 计数、`invalidatedFiles`（有界）、staleness、buildFingerprint、degraded、durationMs。
- [~] **C07 退出码**：0 全部成功/fresh；1 有 failed root；2 有 stale/部分成功或 warning；64 用法；70 内部。
- [x] **C08 无变化**：`update` 不写任何文件（`.nexus/tmp` 清理除外）、不启动 SCIP、耗时显著低于重建；测试断言零 SCIP。
- [x] **C09 集成测试**：F08/F15/F14 上改 1 文件、批量改 20 文件、新增、删除、重命名、改 tsconfig；断言 mode 与 restored 状态。

## D. 12.2 增量一致性门禁

- [x] **D01 比较器**：新增 `incremental-equivalence.ts`，实现十项比较（符号集合、身份、引用五元组、导出、文件状态、SurfaceHash、依赖/调用边、指纹、覆盖率、manifest 去时间戳）。
- [x] **D02 差异快照**：不一致输出前 20 条差异 + 每类计数；不得自动用全量覆盖增量结果。
- [x] **D03 执行器**：在临时目录对同一源分别跑全量与“先全量→变更→update”，比较；支持传入 fixture 与变更脚本。
- [~] **D04 随机门禁**：N 默认 20，覆盖 ≥3 类夹具；确定性种子；失败即非零。
- [x] **D05 测试**：F08 的 A/M/D/R/签名变化；F15 身份迁移；F14 多 root；断言十项全等。
- [x] **D06 报告**：门禁结果写入 `lastIntegrityCheck`（manifest）或测试证据；不伪造“已通过”。

## E. 12.3 提交协议、恢复与并发

- [x] **E01 顺序校验**：提交顺序固定为 pending → 写行 → 完整性检查 → COMMIT → 只读校验 → committed → manifest → surface → workspace → cleanup；代码注释标明 12.3.2 步骤。
- [x] **E02 完整性检查**：外键闭合、必需索引、覆盖率分母非零、指纹字段齐全；失败 ROLLBACK 且旧 committed 可读。
- [x] **E03 恢复矩阵**：六行现场（committed/manifest 一致、manifest 滞后、pending+旧 manifest、pending+manifest 指向 pending、无 build_record 但有数据、integrity_check 失败）+ 12.4 的 invalid；逐一实现判定与动作。
- [x] **E04 DB 权威**：committed 与 manifest 不一致时以 DB 为准重写 manifest；`manifest-repaired` 事件；不得反向覆盖 DB。
- [x] **E05 pending 清理**：按 buildId 定向删除 pending 的 symbols/refs/deps/calls/tests/mapping/components/vue；保留旧 committed。
- [x] **E06 派生视图**：surface/workspace 与 DB/manifest 不一致 → 标 `stale` 并给重建动作；不伪造。
- [x] **E07 保留与清理**：保留最近 2 个 committed；`.nexus/tmp/` 启动/结束清空；stale lock 10 分钟、等待 30s（既有）。
- [x] **E08 启动恢复**：build/update/status/doctor/查询入口先 `recoverWorkspace`；恢复失败按 E07/E19 归因。
- [x] **E09 注入点**：`NEXUS_CRASH_AT` 七个注入点（rows-before-commit、commit-before-flip、flip-before-manifest、manifest-tmp-written、manifest-before-surface、surface-before-workspace、workspace-before-cleanup）；默认关闭。
- [x] **E10 F16 夹具**：6 文件 / ≤200 行；7 个测试各注入一次 SIGKILL；恢复后状态/数据匹配矩阵，旧索引可查询。
- [x] **E11 单测**：恢复矩阵逐行；surface 不一致；workspace 重建；prune 保留 2；失败 ROLLBACK。

## F. 12.4 状态机

- [x] **F01 五态**：`fresh` / `dirty` / `indexing` / `stale` / `failed`；类型进入 `model.ts`；不得出现同义词。
- [x] **F02 转换表**：`ALLOWED_TRANSITIONS` 实现 12.4.2；非法转换为实现缺陷，`doctor` 报 error。
- [x] **F03 状态推导**：`deriveRootState` 统一由 manifest + 当前扫描 + indexing 标记推导；status/query/impact/preflight/postflight 全部改用该函数。
- [x] **F04 indexing 标记**：`.nexus/roots/<rootId>/indexing.json` 原子写；成功后删除；崩溃残留由恢复清理并标 stale。
- [x] **F05 dirty**：内容/配置变化且未更新 → `dirty`；查询标 `partial:true`；`dirty` 不升 fresh。
- [~] **F06 pending-analysis**：`indexing` 状态下未覆盖文件查询返回 `pending-analysis`（能实现的范围）；不得返回 `not-found`。
- [x] **F07 重启**：先恢复再服务；未校验 `filesHash` 不得标 fresh。
- [x] **F08 单测**：每类转换至少一条；非法转换被 doctor 捕获；dirty/indexing/stale/failed 四态查询文案一致。

## G. 5.10 全局调度器

- [x] **G01 预算**：`resources.maxMemoryMB`（默认 900）/`resources.concurrency`（默认 1）配置；全局预算 = min(配置, 可用内存×0.5)。
- [~] **G02 权重与并发**：单 root 预算按上次 peakRssMB 归一化；并发位 = min(配置, 预算/预估峰值, cpu-1)；`--serial` 强制 1。
- [x] **G03 依赖顺序**：按 package.json dependencies 拓扑排序；同一 root 内阶段串行；无可解析依赖时稳定排序。
- [x] **G04 同 root 合并**：进程内 update/refresh 请求按 rootId 合并；跨进程锁占用 E08。
- [x] **G05 降级阶梯**：calls-off → chunked → vue-projection-reduced → serialize → abort-root(E20)；严格顺序、不跳级。
- [~] **G06 降级落地**：calls-off 真正关闭 calls 索引；chunked 记录写入批次；vue-projection-reduced 逐文件投影；serialize 并发 1；abort 报 E20 并保留旧索引。
- [~] **G07 取消**：AbortSignal 贯穿；Ctrl-C/取消无部分提交；tmp 清理；状态 stale。
- [x] **G08 内存采样**：构建 50ms 采样，manifest 记录 peakRssMB；超单 root 预算 85% 触发降级。
- [x] **G09 F18 夹具**：3 root / 12 文件 / ≤350 行；预算压低 → 阶梯顺序、旧索引保留、失败隔离、取消无提交。
- [x] **G10 单测**：确定性预算注入；阶梯顺序；E20；并发位计算；降级写入 manifest 并查询可见。

## H. 5.11 构建指纹与重建判定

- [x] **H01 字段齐全**：filesHash/configHash/schemaVersion/analyzerVersion/rootSetHash/nodeVersion/sqliteVersion/platform/degraded；analyzerVersion 五元组逐项。
- [x] **H02 tsconfigHash**：root tsconfig 内容 Hash 纳入 configHash；tsconfig/路径别名变化 → 指纹变化 + full。
- [x] **H03 辅助字段**：gitCommit 仅写 manifest/诊断；builtAt 不入指纹；platform 变化不单独触发重建。
- [x] **H04 可复现**：同输入两次 build 指纹一致；不同 Node 版本不横向比较。
- [x] **H05 单测**：字段变化各触发/不触发；指纹稳定性；含 tsconfig 变更。

## I. 性能基准与内存（16.2 / 21.2）

- [x] **I01 生成器**：`tools/perf/generate.mjs`，1k/5k/10k 行；`--scale` 可更大；生成物不提交。
- [x] **I02 采集器**：`perf.ts` 记录 16.2.3 全字段（projectLoc/fileCount/dependencyCount/tsRatio/vueRatio/nodeVersion/os/cpu/scenario/durationMs/peakRssMB/sqliteSizeMB/degraded/failureMode/buildFingerprint/repetitions）。
- [~] **I03 P1–P8**：八类场景分别执行；P7 在 Phase 07 前记 `not-available`（原因明确）；重复 ≥3、中位数+最大值、进程重启。
- [x] **I04 内存口径**：peakRss 50ms 采样；DB 含 WAL；构建范围（单/多 root）标注；Vue 投影计入。
- [~] **I05 CI 阈值**：小规模测试断言 peakRssMB 在预算内；超限失败。
- [~] **I06 实测**：1k/5k/10k 三档跑完并写入报告；50k/300k/1M 标未验证，不外推。
- [x] **I07 P8**：从 F16 注入点到可查询的恢复耗时记录。

## J. 夹具、回归与构建

- [x] **J01 F16**：`fixtures/F16-crash-recovery`（6 文件 / ≤200 行）+ `expected/` 恢复矩阵说明。
- [x] **J02 F18**：`fixtures/F18-scheduler`（3 root / 12 文件 / ≤350 行）+ 说明。
- [x] **J03 行数预算**：F01–F18 合计 ≤12000；单夹具 ≤2000 行/20 文件；新增后统计。
- [x] **J04 构建**：`npm run build`、`typecheck`、`lint`、`format:check` 退出 0；两次 dist 哈希一致。
- [x] **J05 单测**：`npm test` 全绿；记录通过数/文件数/耗时。
- [x] **J06 回归**：F01/F05/F10/F14/F15/F17 既有断言不回归；Phase 03/04/05 输出字段不回归。
- [x] **J07 act**：`act -j verify` 通过（环境允许时）；Node 22.16.0 / 24.22.3 双矩阵。
- [x] **J08 工作区**：`git status --porcelain` 无验证残留（`.actrc` 除外）；`.nexus/tmp/` 为空。

## K. CLI、渲染与错误

- [x] **K01 注册**：`update` 从 stub 移除并注册真实命令；帮助含 2 个示例；`build` 描述更新。
- [x] **K02 渲染**：lines/pretty/markdown/json 四格式同源；update 有专门行；无 ANSI/绝对路径/时间戳。
- [~] **K03 错误**：E03/E07/E08/E13/E16/E19/E20 归因；同一场景 CLI/MCP code 一致（MCP 接口留待 Phase 07）。
- [x] **K04 status**：输出 `incremental` 能力、`degraded`、`lastIntegrityCheck`、每 root 的 dirty/indexing；不得返回 E01。
- [x] **K05 doctor**：检查 DB/manifest/surface/workspace/状态转换/锁/tmp；`--repair` 仍 E24 并给重建命令（Phase 07）。
- [~] **K06 verbose**：`--verbose` 输出阶段耗时、峰值 RSS、写入行数、降级事件到 stderr；stdout 不污染。
- [x] **K07 CLI 测试**：update 四格式、`--files`、`--rebuild-affected`、`--root/--roots`、退出码。

## L. 文档、报告与交接

- [x] **L01 README**：状态、能力表、`update` 命令、状态机、性能/内存实测、限制；**项目目录结构**更新到当前 `packages/`、`docs/phase-06/`、`tools/perf/`、`fixtures/F16|F18`。
- [x] **L02 docs/README**：阶段索引加入 `phase-06/`；状态行更新。
- [x] **L03 runtime-api**：登记新增 Node 内置（`node:os` 等）；无新增第三方依赖则注明。
- [x] **L04 实施报告**：`03-implementation-report.md` 按 19.3 九项；G0–G12 证据；§5 已知问题；P1–P8 数据。
- [x] **L05 自审回执**：实际磁盘代码 + `git diff`；边界/安全/异步/递归/兼容性；不得凭记忆。
- [x] **L06 规范未改**：不修改 v1.24 正文；冲突先报告。
- [x] **L07 交接**：给 Phase 07 的 `update`/锁/恢复/状态机/调度器/`doctor --repair` 接口明确列出。

## M. 验收证据映射（19.1 阶段 06）

- [x] **M01 增量=全量**：D 组十项比较通过；差异快照为空；`buildFingerprint` 相同。
- [x] **M02 七注入点**：F16 七个测试通过；恢复矩阵逐行证据。
- [~] **M03 八类性能**：P1–P8 记录齐全；达到/未达到 16.2 目标逐项标注；P7 未提供的原因。
- [~] **M04 内存预算**：1k/5k/10k 峰值 RSS 与预算对比；50k+ 未验证声明。
- [x] **M05 状态机**：转换集测试 + doctor 非法组合。
- [x] **M06 调度器**：阶梯顺序、E20、取消无提交、旧索引保留。
- [x] **M07 指纹**：同输入可复现；tsconfig 变化触发；platform/gitCommit 不单独触发。
- [x] **M08 工作区**：`git status --porcelain` 无残留；`.nexus/tmp` 为空。

## 证据索引

- A：`docs/phase-06/00-entry-and-decisions.md`、`02-plan-and-gates.md`；基线 `6725f99`。
- B/C：`packages/core/src/index/{invalidation,build}.ts`、`packages/cli/src/cli.ts`；`packages/core/test/incremental.test.ts`（8 项）。
- D：`packages/core/src/index/equivalence.ts`、`incremental.test.ts`；10k 夹具跨目录十项全等。
- E：`packages/core/src/store/{commit,recovery,lock,inject}.ts`；`packages/core/test/recovery.test.ts`（F16 七注入点）。
- F：`packages/core/src/store/state.ts`、`status.ts`、`doctor.ts`；状态机断言与 integration `dirty`。
- G/H：`packages/core/src/scheduler.ts`、`index/fingerprint.ts`；`packages/core/test/scheduler.test.ts`（6 项）。
- I/J：`tools/perf/{generate,run}.mjs`、`.nexus/test-tmp/perf-{1k,5k,10k}.json`；`npm test` 111 项。
- K：`packages/cli/src/{cli,render}.ts`、`packages/cli/test/cli.test.ts`；`update` 四格式断言。
- L/M：`README.md`、`docs/README.md`、`docs/runtime-api.md`、`docs/phase-06/03-implementation-report.md`。
- 部分完成项：文件级局部增量（root 级重建）；P3/P6 未达 16.2；P7 MCP（Phase 07）；50k+ 未验证；真并行多 root（默认串行）；`pending-analysis` 未实现；根移除目录清理留给 Phase 07。
