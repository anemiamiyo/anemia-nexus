# Phase 03 实施报告：API Surface 与基线

> 依据：`docs/19-delivery-phases.md` 19.1/19.3、`docs/06-api-surface.md`、`docs/phase-03/00-entry-and-decisions.md`、`docs/phase-03/01-task-checklist.md`、`docs/phase-03/02-plan-and-gates.md`
> 规范版本：v1.24（冻结）
> 日期：2026-11-12–13（Asia/Shanghai）
> 结论：**Phase 03 的 G0–G10 已执行并通过；Surface 判定无反向误报，每条 public 记录均带 `primaryEvidenceSource` 与 `exportKind`，`api-diff` 四级分级与 F07 golden 一致。Phase 03 记为 pass，等待负责人评审。**

## 1. 授权、基线与范围

- 负责人 2026-11-12 书面接受 Phase 02 以 pass 关闭、批准进入 Phase 03，并要求先写任务清单、补做 SQLite 边算边写；裁定见 `00-entry-and-decisions.md` §1。
- 基线 commit：`ea01efe`；工作区入场时仅负责人本地 `?? .actrc`。
- 实现范围：Surface 判定（五类证据、优先级、条件/子路径/通配、barrel、manual override、opaque）、`exportKind`/`isTypeOnly`/`runtimePresent`、`surface.json`、`nexus.baseline.json`、`api-snapshot`、`api-diff` 四级差分、`@deprecated` 继任者链路、F07 夹具、`symbol`/`search`/`status`/`doctor` 可见性、SQLite 边算边写。
- 明确未实现：依赖/调用图、架构规则、impact、preflight/postflight、增量、MCP、`print`、`doctor --repair`、`status --json-schema`；未实现命令仍 E24。

## 2. 实际完成内容（19.3 状态标注）

| 模块 | 状态 | 说明 |
|---|---|---|
| Surface 判定 | implemented | `public` / `internal` / `opaque`；证据优先级 `manual-override > package-exports > explicit-entry > barrel-derived > none` |
| 五类证据 | implemented | `surface/export-graph.ts` + `exports.ts`；条件、子路径、数组 fallback、`*` 通配、多层 barrel |
| exportKind | implemented | `type` / `value` / `both`；`isTypeOnly`、`runtimePresent`；条件导出按条件拆条 |
| manual override | implemented | `surface.manual` 按 symbolId / nameChain / name；冲突保留提示，不静默覆盖 |
| opaque | implemented | `export =`、无声明/外部/命名空间导出进入 `opaque`，默认不进 public |
| surface.json | implemented | `.nexus/roots/<rootId>/surface.json`；commit 后、manifest 前原子写；manifest 记 `surfaceHash` / `surfaceEntries` |
| api-snapshot | implemented | 按 root 分段 `nexus.baseline.json`；保留既有 `since`；覆盖需 `--yes`，否则 E00/64 |
| api-diff | implemented | `breaking` / `additive` / `internal` / `ambiguous`；`--base <ref|file>`、`--fail-on`；每条带 evidence + rationale |
| deprecated 链路 | implemented | JSDoc `@deprecated` / `@see` / `{@link}` / `@removal`；按 symbolId 解析继任者；多候选 ambiguous、无候选 no-successor |
| symbol / search | implemented | `surface=public|internal|opaque|unknown` + `api` / `internalApi`；surface 缺失时 unknown + warning |
| status | implemented | `capabilities.apiSurface='evidence-sources'`、`surfaceHash`、`surfaceEntries` |
| doctor | implemented | Surface 与 manifest 一致性检查；旧构建给出重建建议 |
| F07 夹具 | implemented | 8 个源文件、条件/子路径/通配、多层 barrel、overload、deprecated、no-successor、opaque、internal |
| SQLite 边算边写 | implemented（写入阶段） | `BuildWriter`、单事务、迭代器、批计数、SQL 历史表；移除全量副本 |
| 完整分析→写入重叠 | partial | 分析阶段仍保留声明/映射结构；未做到 SCIP 解析与 SQLite 写入完全重叠，留 Phase 06 |

## 3. 测试与验证证据

环境：Windows x64；Node 22.16.0（nvm-windows，npm 10.9.2）与 24.22.3（act 容器）；`node:sqlite` 3.49.1（Node 22.16）。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run build` | 0 | core / cli / mcp / adapter-vue ESM + d.ts；`node:sqlite` external |
| `npm run typecheck` | 0 | 通过 |
| `npm run lint` | 0 | 0 error |
| `npm run format:check` | 0 | Prettier 通过 |
| `npm test`（本地 Node 22.16.0） | 0 | **73 passed (8 files)**，75.93s |
| `act -j verify --container-options "-m 4g" --action-offline-mode` | 0 | Node 22.16.0 与 24.22.3 两个矩阵各 **73 passed**；Node 22.16.0 78.15s / Node 24.22.3 78.29s |
| `nex init` + `nex build` F07 | 0 | 8 文件 / 22 符号 / 27 引用；33 条 public entries、3 internal、1 opaque、2 deprecated；`writeMs=19`、`writeBatches=1` |
| `nex api-snapshot --yes` F07 | 0 | 基线 33 entries / 3 internal / 2 deprecated；两次逐字节一致 |
| `nex api-diff`（干净基线） | 0 | 0 差异 |
| `nex api-diff`（变异基线） | 1（`--fail-on additive`） | additive / breaking / ambiguous / internal 均命中 |
| `nex api-diff`（仅 ambiguous） | 2 | 警告态，不阻断 |
| `nex api-diff --base HEAD`（干净） | 0 | 从 `git show HEAD:nexus.baseline.json` 读取，0 差异 |
| `nex api-snapshot`（已存在基线、无 `--yes`） | 64/E00 | 拒绝隐式覆盖 |

**act 说明**：首次执行用户给出的命令时，act 需要从 GitHub 克隆 `actions/setup-node@v4`，网络连接超时导致失败；随后加 `--action-offline-mode` 使用本地 action 缓存，两个 Node 矩阵全部通过。命令与结果均记录在此，不用“本地通过”替代容器结果。

### 3.1 Gate 判定

| Gate | 结果 | 证据 |
|---|---|---|
| G0 遗留补齐 | pass | `BuildWriter` 单事务；`references` / `symbols` 由 `drain()` 迭代器写入；`mappingRows` 改为生成器；`qualityBySymbolId` 删除；历史表用 `temp.current_symbols` + SQL；writer 测试 1200 行、批计数、失败 ROLLBACK |
| G1 构建 | pass | 上表 build / typecheck / lint / format |
| G2 Surface 完整性 | pass | F07 33 条 public 全部有 primary + exportKind + symbolId；internal 不进 public |
| G3 证据与优先级 | pass | 条件 3 条、子路径、通配、barrel、manual、opaque 断言 |
| G4 快照 | pass | 两次 snapshot 字节一致；改 exports 后 `surfaceHash` 改变；无时间戳/行号/绝对路径 |
| G5 差分 | pass | F07 变异基线四类齐全；fail-on / exit code tested；`--base HEAD` 读取提交基线并 0 差异 |
| G6 弃用 | pass | `oldAdd` resolved → `add`；`doomed` no-successor + `2.0.0` |
| G7 回归 | pass | 73 项全绿；F01/F05/F10/F15/F17 不回归；`update` / `status --json-schema` 仍 E24 |
| G8 输出 | pass | 四格式一致；无 ANSI；lines/json 稳定 |
| G9 act CI | pass | 见上表 |
| G10 自审 | pass | 本报告、任务回填、已知问题、自审回执 |

## 4. 性能与内存记录（只代表夹具，不构成 21.2 达标声明）

| 指标 | F07 |
|---|---|
| 文件 / 符号 / 引用 | 8 / 22 / 27 |
| scan / analyze / scip / map / write / total | 5 / 1488 / 1059 / 2 / 19 / 1517 ms |
| 父进程峰值 RSS | 136.4 MB |
| `writeBatches` / `writeMs` | 1 / 19 ms |
| SCIP 子进程峰值 | null（仍不可观测，带原因） |
| index.db / WAL | 见构建产物；WAL 构建后为 0 |

**边算边写证据**（不是大项目外推）：

- 旧路径：`analysis.mapping.references.map({...})` 生成全量副本、`mappingRows()` 生成全量数组、`qualityBySymbolId` 生成全量 Map、`applyHistory` 生成全量 Set。
- 新路径：`BuildWriter` 在同一 `BEGIN IMMEDIATE` 内逐行绑定执行；`references` 由生成器逐条 `{...buildId}`；`symbols` 用 `drain()` 在写入时释放数组槽位；mapping 行按需生成；历史 retire/insert 全 SQL。
- 单测：1200 行写入 `writeBatches=2`、`rowsWritten=1201`；生成器中途抛错后 `build_record=0`、`files=0`（无半套行）。
- **限制**：分析阶段仍需保留声明集与映射结构以完成全局身份分配；未做到分析/写入完全重叠，21.2 全量预算达标留 Phase 06。

## 5. 已知问题与未完成事项

1. **Surface 不在 DB**：按 root 写 `surface.json`，是 manifest 的派生视图；不是 5.1 的 API 表。理由与协议见 `00-entry-and-decisions.md` §4.1；Phase 06 若需要跨构建查询再评估落库。
2. **签名归一化是文本级**：复杂条件类型/映射类型可能落 `ambiguous`；不猜 breaking/additive。
3. **`opaque` 判定保守**：目前覆盖 `export =`、无声明/外部/命名空间导出；运行时注册、字符串索引等仍需人工确认。
4. **`ownerModule` 为 null**：架构模块 Phase 04 才有，不用目录名冒充。
5. **`since`**：构建时取根 `package.json` 版本；`api-snapshot` 保留既有基线值；无版本时为 `unknown`。
6. **F07 degraded**：`hash-collisions`（既有身份碰撞检测）与 `surface-warnings`（`./legacy` 目标为 `export =`，无命名导出）会出现在 manifest；不伪造 public。
7. **`api-diff` 分级启发式**：参数可选性/签名文本规则不能覆盖所有类型收窄；不能判定即 `ambiguous`，这是 6.4 允许的保守结果。
8. **git ref 基线**：通过 `git -C projectRoot show <ref>:<prefix><path>` 读取；要求项目根在 git 内且基线已提交。
9. **act**：无网络时需 `--action-offline-mode`；首次网络失败已记录，不隐藏。
10. **写入分析重叠**：见 §4 限制。
11. **多 root 查询合并、`status --json-schema`、SCIP 峰值、完整本地 `npm ci`**：仍不在本阶段；对应 E24 或 null + 原因。
12. **`manual` 匹配同名多符号**：可能命中多个；本阶段按匹配集合处理，不自动消歧，报告 warning。

## 6. 依赖与架构变化

- 无新增第三方依赖；仍只用 `node:sqlite` / `node:fs` / `node:path` / `node:child_process`（git ref）。
- 新增模块：`packages/core/src/surface/{types,exports,export-graph,builder,diff,service,store}.ts`；`store/commit.ts` 重写为 `BuildWriter`；`build.ts` 增加 Surface 生成与 `surface.json` 写入；`query/service.ts` 读取 Surface；`status.ts` / `doctor.ts` / `cli.ts` / `render.ts` 增加 API。
- Schema 保持 `SCHEMA_VERSION=2`，无表/列变更；旧索引只需 rebuild 生成 `surface.json`（缺文件时 `symbol.surface=unknown` + warning）。
- manifest 新增可选 `surfaceHash` / `surfaceEntries` 与 `timings.writeBatches`；旧 manifest 读取不受影响。

## 7. 对后续阶段影响

- Phase 04 可复用：`surface.json` 的 public/internal 分类、`exportKind`、组件 `propsCoverage`、`opaque` 清单；`ownerModule` 待架构模块规则补齐。
- Phase 05 可复用：`api-diff` 的 `breaking/additive/ambiguous` 结果与 evidence，作为 preflight/postflight 的 Surface 差分输入；需补 impact 盲区与多 root 合并。
- Phase 06 可复用：`BuildWriter` 的批计数与单事务协议；需完成分析/写入重叠、SCIP 峰值、增量=全量门禁与 21.2 预算。
- Phase 07：`api-snapshot` / `api-diff` 已可被 MCP 之外的 CI 管道消费；MCP 工具仍待实现。

## 8. 文档同步

- `README.md`：状态、能力表、命令、阶段结果、限制。
- `docs/README.md`：阶段索引更新。
- `docs/phase-03/{00,01,02,03}.md`：新增。
- `docs/phase-02/03-implementation-report.md`：不改写正文；负责人接受记录在 Phase 03 入场文档。
- `docs/runtime-api.md`：新增登记 `node:child_process` `execFileSync`（git ref 基线读取）。
- `.dsh/AGENTS.md`：当前状态同步（git 忽略，不纳入变更）。
- 未修改 v1.24 规范正文。

## 9. 自审回执

**审查范围：**

- 变更文件：见 `git status --porcelain`；核心为 `packages/core/src/surface/*`、`store/commit.ts`、`store/manifest.ts`、`index/build.ts`、`index/mapping.ts`、`vue/references.ts`、`query/service.ts`、`status.ts`、`doctor.ts`、`config/{schema,merge}.ts`、`cli/src/{cli,render}.ts`、`core/test/{surface,writer,integration}.test.ts`、`cli/test/cli.test.ts`、`fixtures/F07-api-surface/**`、`docs/phase-03/**`、`README.md`、`docs/README.md`。
- 新增 API：`BuildWriter` / `commitBuild`（Iterable）、`buildSurface`、`createSurfaceSnapshot`、`writeBaselineSnapshot`、`diffCurrentSurface`、`diffSnapshots`、`readSurface`、`readBaseline`、`buildSurfaceLookup`、`Surface*` 类型、`CAPABILITIES.apiSurface`、`RootStatus.surfaceHash/surfaceEntries`、CLI `api-snapshot` / `api-diff`。
- 关键调用点：`buildRoot` → `analyzeRoot` → `buildSurface` → `commitBuild(BuildWriter)` → `writeSurface` → manifest；`api-snapshot` → `createSurfaceSnapshot` → `writeBaselineSnapshot`；`api-diff` → `diffCurrentSurface` → `diffSnapshots`。

**边界与安全审查：**

| API / 文件 | 风险场景 | 结论 | 代码证据 |
|---|---|---|---|
| `surface/exports.ts` | 恶意/畸形 exports、绝对路径、`..`、符号链接 | 仅解析 package.json；目标必须落在 root 且已在索引；无越界读取 | `exports.ts` |
| `surface/export-graph.ts` | 恶意源码、循环 re-export、超大声明 | TS checker 只读 Program；循环 Set；未执行项目代码 | `export-graph.ts` |
| `surface/builder.ts` | 误标 public、伪造证据、重复记录 | 证据必须来自 resolver；同名候选保留；opaque/internal 保守 | `builder.ts` |
| `surface/service.ts` | git 参数注入、基线损坏 | ref 白名单、参数数组、无 shell；损坏基线 E19 | `service.ts` |
| `surface/store.ts` | 覆盖写、绝对路径、原子性 | 临时文件 + fsync + rename；路径来自 config 校验 | `store.ts` |
| `store/commit.ts` | 半提交、失败残留、历史丢失 | 单事务；失败 ROLLBACK；临时表；闭合校验；旧 committed 保留 | `commit.ts` |
| `build.ts` | Surface 失败破坏索引 | try/catch 降级为 `surface-failed` + 空 Surface；manifest 仍按协议写 | `build.ts` |
| `query/service.ts` | Surface 与索引不同步 | buildId/fingerprint 校验；不一致返回 unknown + warning | `service.ts` |
| `cli.ts` | 非 TTY 覆盖、参数注入 | 覆盖需 `--yes`；`--base` 校验；退出码 64/1/2 | `cli.ts` |

**递归检查：**

- 产品新增代码无递归；导出图循环检测使用 `Set`；签名参数解析为线性扫描。
- `stableStringify` 仍是迭代实现；Surface 排序为显式排序。

**测试结果：**

- 类型检查 / Lint / 格式：通过。
- 单元 / 集成：**73 passed (8 files)**（本地 Node 22.16.0；act 内 Node 22.16.0 与 24.22.3 各 73）。
- act：`act -j verify --container-options "-m 4g" --action-offline-mode` 两个矩阵通过。
- 未执行：完整本地 `npm ci`（以 act 容器内 `npm ci` 为证）、真实百万行项目、SCIP 子进程 RSS、增量=全量。

**已知缺陷：**

- 见 §5 的 12 项；无未披露的本阶段正确性缺陷。Surface 分析/写入未完全重叠与签名归一化保守是本阶段明确限制。

**兼容性影响：**

- 新增 CLI 命令与配置字段 `surface`；未删除既有字段/命令。
- `symbol.surface` 从恒为 `unknown` 变为 `public|internal|opaque|unknown`；这是 Phase 03 的预期语义变化，既有测试已更新。
- manifest 只增可选字段；schema 不变；旧索引 rebuild 后生成 Surface。
- 未修改用户源码或项目配置；`api-snapshot` 只写 `nexus.baseline.json`；`api-diff` 只读。

## 10. 负责人评审请求

请负责人决定：

1. 是否接受 Phase 03 以 **pass** 关闭，并批准进入 Phase 04（关系图与架构分析）；
2. 是否要求先补齐 §5 的任一项（尤其分析/写入完全重叠、真实项目 Surface 样本、git ref 基线）再评审；
3. 是否同意 `surface.json` 作为派生视图、不升 schema 的架构决定（§5.1）。
