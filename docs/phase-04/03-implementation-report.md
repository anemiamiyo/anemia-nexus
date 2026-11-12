# Phase 04 实施报告：关系图与架构分析

> 依据：`docs/19-delivery-phases.md` 19.1/19.3、`docs/04-architecture.md` 4.2、`docs/05-data-model.md` 5.1/5.5/5.6/5.7、`docs/08-relations.md`、`docs/10-impact-analysis.md`、`docs/11-cli.md`、`docs/12-indexing.md`、`docs/17-testing.md`
> 规范版本：v1.24（冻结）
> 日期：2026-11-13（Asia/Shanghai）
> 结论：**Phase 04 的 G0–G10 已执行并通过；本地 79 项与 act 的 Node 22.16.0 / 24.22.3 双矩阵均全绿。Phase 04 记为 `pass`，等待负责人评审。** 已知限制见 §5，均以 `partial` / 限制显式登记，不冒充完成。

## 1. 授权、基线与范围

- 负责人 2026-11-13 书面接受 Phase 03 以 `pass` 关闭并批准进入 Phase 04；裁定见 `docs/phase-03/00-entry-and-decisions.md` §8。
- 基线 commit：`29d6722`；入场时工作区干净。
- 环境：Windows x64；Node 22.16.0；npm 10.9.2；`node:sqlite` 3.49.1。
- Schema：`SCHEMA_VERSION = 3`；新增 `dependencies`、`calls`、`architecture_modules`、`architecture_violations` 与 `files.owner_module`；v2 索引必须重建，不提供迁移。
- 实现范围：文件/模块依赖图、静态调用图、架构 `allow` 规则、S1 样式五类边、跨 root 边界、盲区清单、`nex deps`、`status` / manifest 可见性、F06/F13/F14 夹具。

## 2. 实际完成内容（19.3 状态标注）

| 模块 | 状态 | 说明 |
|---|---|---|
| Schema v3 | implemented | 四表 + `files.owner_module` + 必需索引；`BuildWriter` 单事务、批计数、失败 ROLLBACK；旧 v2 库 E06 |
| 文件依赖图 | implemented | TS/TSX 的 import / import-type / export / require / dynamic-import；`ts.resolveModuleName`；未解析原因与七项证据 |
| 模块依赖图 | implemented | 显式 `architecture.modules[].include`；最长匹配、重叠 warning；模块边与违规 |
| 引用图加固 | implemented | 沿用 Phase 01–03 `references`；`deps` 与引用均按三分类计数；未改既有语义 |
| 静态调用图 | implemented（TS/TSX） | direct / typed / heuristic / unresolved；顶层 caller 为 null；动态下标、eval、call/apply 显式 unresolved |
| 架构规则 | implemented（allow-list） | 省略 allow = 不限制；`[]` = 仅模块内；跨模块边产违规；无配置不推断 |
| S1 样式链 | implemented | CSS/Less `@import`、SCSS `@use` / `@forward`、Vue `<style src>`、TS/JS 样式 import；别名 heuristic；动态/`sass:*`/外部/缺失 unresolved |
| 跨 root 边界 | implemented | 已声明依赖 + exports 可解析 → `cross-package`/certain；其余 `package-boundary:*`；不展开目标 root |
| 盲区清单 | implemented | code / style / multi-root / coverage 四类；`affectedFiles`、`potentiallyAffectedSymbols`（或 null + 估算方式）、`manualCheckHint` |
| `nex deps` | implemented | `file` / `module` / `style` / `call`，`--reverse`、`--explain`；四格式；退出码 0/64/E01/E16/E19/E04/E00 |
| `status` / `doctor` | implemented | 关系图计数、`capabilities`、manifest `graph` / `blindSpots`；doctor 复用 schema/索引检查 |
| `surface.json` | implemented | `ownerModule` 由显式模块规则派生；不进入 `surfaceHash`；Phase 03 快照语义不变 |
| 夹具 | implemented | F13 样式五类边、F14 三 root 边界、F06 动态/启发式调用；F01 增加依赖/调用断言 |
| Vue 脚本调用图 | partial | 只对 TS/TSX 产 CallRelation；Vue `<script>` 与模板调用不产调用边（模板引用仍由 Phase 02 负责） |
| postcss 系样式解析 | partial | 使用有限语法扫描器，不引入 `postcss-scss` / `postcss-less`；只保证 4.2 五类字面量边 |
| act 容器矩阵 | pass | Node 22.16.0 与 24.22.3 两个矩阵各 79 项通过；见 §3.1 |

## 3. 测试与验证证据

环境：Windows x64；Node 22.16.0；npm 10.9.2。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run build` | 0 | core / cli / mcp / adapter-vue ESM + d.ts；连续两次构建 dist 哈希一致（core `b2c187b8…`，cli `7d8770e5…`） |
| `npm run typecheck` | 0 | 通过 |
| `npm run lint` | 0 | 0 error |
| `npm run format:check` | 0 | Prettier 通过 |
| `npm test`（本地 Node 22.16.0） | 0 | **79 passed (9 files)**，80.73s |
| `act -j verify --container-options "-m 4g" --action-offline-mode` | 0 | Node 22.16.0：9 files / 79 passed / 96.57s；Node 24.22.3：9 files / 79 passed / 84.45s；两个 job 均 `Job succeeded` |
| F13 `build` + `deps --type style` | 0 | 五类边：style-import / style-use / style-forward / style-src；别名 heuristic；dynamic-path / not-found / sass-builtin / external-package；样式文件 0 symbols |
| F14 三 root `build` + `deps` | 0 | 1 条 `cross-package` certain；exports-mismatch / root-not-indexed / undeclared-dependency / outside-root 各命中；1 条架构违规 |
| F06 `deps --type call` | 0 | direct / heuristic / unresolved 齐备；unresolvedReason 含 `eval` / `dynamic-callee`；dynamic-import 不计为 call |
| F01 `deps` / `deps --type call` | 0 | 5 条文件依赖全 certain；`add` 反向 2 条调用边；每条带 evidence |
| 本仓库自索引（有界真实样本） | 0 | 4 roots / 69 files / 1986 symbols / 9370 ms / peak RSS 355.1 MB；core 259 deps + 1452 calls，cli 12 deps + 418 calls；25 条 cross-package 边；每 root 5 条盲区；见 §4 |
| `git status --porcelain` | — | 仅本轮变更；`.nexus/` 已清理（含 tmp / roots / 自索引配置） |

### 3.1 Gate 判定

| Gate | 结果 | 证据 |
|---|---|---|
| G0 Schema 与写入 | pass | schema v3、四表、索引、`BuildWriter` 单事务 / 批计数 / ROLLBACK；writer 测试通过；v2 库 E06 由 `ensureSchema` 保证 |
| G1 构建 | pass | 上表 build / typecheck / lint / format；两次 dist 哈希一致 |
| G2 文件依赖图 | pass | F01 5 条 import/import-type 全 certain；F14/F06 的未解析路径与原因 |
| G3 调用图 | pass | F01 direct/typed；F06 direct/heuristic/unresolved；每条有位置、confidence、evidence |
| G4 架构规则 | pass | F13 `ownerModule=app`；F14 `arch/app->ui` 违规；F13 重叠 warning 可见 |
| G5 S1 样式链 | pass | F13 五类边、别名 heuristic、四类 unresolved、0 符号 |
| G6 跨 root | pass | F14 一条 certain + 四类失败原因；无跨 root 合并索引 |
| G7 盲区 | pass | 四类盲区字段齐全；null + 估算方式；`manualCheckHint` 非空 |
| G8 输出 | pass | deps 四格式 counts 一致、无 ANSI；lines/json 稳定；既有四格式回归通过 |
| G9 act CI | pass | Node 22.16.0 与 24.22.3 各 79 项通过；`Job succeeded` ×2 |
| G10 自审 | pass（报告层） | 本报告、任务回填、已知问题、工作区无残留；代码自审见 §9 |

## 4. 性能与内存记录（只代表夹具/有界样本）

| 指标 | F13 | F14 | 本仓库 core | 本仓库 cli |
|---|---|---|---|---|
| 文件 / 符号 / 引用 | 9 / 2 / 0 | 5 / 5 / 2 | 61 / 1869 / 18173 | 6 / 117 / 1737 |
| graphMs | 见 manifest | 见 manifest | 513 | 152 |
| writeMs / writeBatches | 见 manifest | 见 manifest | 378 / 51 | 40 / 5 |
| 依赖 / 调用 / 样式边 | 9 / 0 / 9 | 5 / 0 / 0 | 259 / 1452 / 0 | 12 / 418 / 0 |
| 跨 root 边 / 架构违规 | 0 / 0 | 1 / 1 | 22 / 0 | 3 / 0 |
| 父进程峰值 RSS | 321.1 MB | 284.1 MB | 355.1 MB（整个 workspace） | — |
| 盲区条数 | 8 | 7 | 5 | 5 |

**边界**：以上是小型夹具与本仓库（约 1.3 万行 core）的有界样本，**不构成 21.2 任何规模档达标声明**；未测百万行、未测 SCIP 子进程 RSS、未测增量。

## 5. 已知问题与未完成事项

1. **Vue 脚本调用图未实现**：调用图只覆盖 TS/TSX；Vue `<script>` 调用与模板表达式调用不产 CallRelation，避免伪造。
2. **样式解析不是 postcss 系**：使用有限扫描器（去注释 + at-rule 字符串），不引入 `postcss-scss` / `postcss-less`；复杂嵌套/变量拼接只到 unresolved，不保证完整。
3. **架构规则只有 allow-list**：没有层号、循环依赖、命名规则 DSL；循环只作为观察项，不是 gate。
4. **跨 root 不读目标索引**：只按 package.json + exports 判定；目标 root 的实际符号可达性不在本阶段验证。
5. **`deps` 读取上限 20000 行**：超出时未显式设置 `truncated`/`nextCursor`；大项目需分页（Phase 05/06）。
6. **空盲区类别会输出 0 行**：例如无动态 import 时仍输出 `code/dynamic-import files=0`，字段完整但略噪声；不影响“可标注”。
7. **调用 unresolved 偏多**：`obj.any()` 等 transient symbol 在无同文件候选时记 `unresolved-symbol`；本仓库 core 1452 条调用中 614 条 unresolved，属诚实但偏保守，Phase 05 可细化。
8. **schema v3 需重建**：旧 v2 索引 `ensureSchema` 报 E06；不提供迁移/自动删除。
9. **真实样本 Surface 未产出 public 条目**：本仓库 package exports 指向 `dist/`，Surface 无 public；`ownerModule` 由 F13 夹具验证，真实项目 ownerModule 样本仍缺。
10. **`source_file_id` / `target_file_id` 口径**：以路径列 + 等价索引实现（跨 root 目标不在同一 files 表），与 5.6 逐字不同，已在入场文档披露。
11. **F13/F14 的 init**：F14 未安装 workspace 链接，`init` 需 `--no-typecheck`；夹具 README 已说明，不冒充独立 typecheck 通过。

## 6. 依赖与架构变化

- 无新增第三方依赖；仍只用 `node:sqlite` / `node:fs` / `node:path` / `node:child_process` / 既有 TS、Vue、Zod。
- 新增模块：`packages/core/src/graph/{architecture,blindspots,builder,calls,cross-root,dependencies,style}.ts`。
- 修改：`store/schema.ts`、`store/commit.ts`、`store/read.ts`、`store/manifest.ts`、`index/build.ts`、`query/service.ts`、`status.ts`、`config/{schema,merge}.ts`、`surface/{builder,types}.ts`、`discovery/{scan,ignore}.ts`、`cli/{cli,render}.ts`。
- Schema v3：四表 + `files.owner_module`；旧 v2 必须重建。`surfaceVersion` / `baselineVersion` 不变；`ownerModule` 不进入 `surfaceHash`。

## 7. 对后续阶段影响

- **Phase 05** 可直接复用：`dependencies` / `calls` 的行、三分类/四档、`architecture_violations`、`blindSpots`、`crossRootEdges`；impact 的 `architecture.violations` 与 `blindSpots` 已有数据源。
- **Phase 05 仍需补**：测试与源码关系、cross-root 反向边呈现、`deps` 分页/`truncated`、Vue 脚本调用图评估、公开 Surface 与 ownerModule 的真实项目样本。
- **Phase 06**：schema v3 不兼容变更已按 5.5 走重建；分析/写入完全重叠、增量=全量、21.2 预算仍待完成。
- **Phase 07**：`deps` 可作为 MCP 的依赖/架构工具数据源；本阶段未新增 MCP 工具。

## 8. 文档同步

- `README.md`：状态、命令、Phase 04 能力与限制。
- `docs/README.md`：阶段索引加入 `phase-04/`。
- `docs/phase-03/00-entry-and-decisions.md`：负责人评审回执与三项裁定。
- `docs/phase-04/{00,01,02,03}.md`：新增。
- `docs/runtime-api.md`：未新增 Node 内置 API；无改动。
- `.dsh/AGENTS.md`：当前状态同步（不入库）。
- 未修改 v1.24 规范正文。

## 9. 自审回执

**审查范围：**

- 变更文件：见 `git status --porcelain`；核心为 `packages/core/src/graph/*`、`store/{schema,commit,read,manifest}.ts`、`index/build.ts`、`query/service.ts`、`status.ts`、`config/{schema,merge}.ts`、`surface/{builder,types}.ts`、`discovery/{scan,ignore}.ts`、`cli/{cli,render}.ts`、`core/test/graph.test.ts`、`cli/test/cli.test.ts`、`fixtures/F06-dynamic`、`fixtures/F13-style-deps`、`fixtures/F14-multi-root`、`docs/phase-04/*`。
- 新增 API：`queryDependencies`、`DependencyQueryType` / `DependencyItem` / `DependencyQueryResult`；`DependencyRecord` / `CallRecord` / `BlindSpot` / `ArchitectureModuleRecord` / `ArchitectureViolationRecord`；`ArchitectureIndex`；`CAPABILITIES.dependencyGraph/callGraph/architectureRules`；CLI `deps`。
- 关键调用点：`buildRoot` → `analyzeRoot` → `buildGraph` → `commitBuild` → manifest / surface；`queryDependencies` → `readDependencies` / `readCalls` / `readArchitecture{Violations,Modules}`；`deps` → `render`.

**边界与安全审查：**

| API / 文件 | 风险场景 | 结论 | 代码证据 |
|---|---|---|---|
| `graph/dependencies.ts` | 恶意/越界 specifier、外部包、`..`、绝对路径 | 已处理：`resolveModuleName` + 根内校验 + outside-root | `packages/core/src/graph/dependencies.ts` |
| `graph/cross-root.ts` | exports 条件/通配、`..`、绝对路径、目标缺失 | 已处理：条件顺序、`safeTarget`、`..` 拒绝、exists 校验 | `packages/core/src/graph/cross-root.ts` |
| `graph/style.ts` | 注释/字符串、动态路径、`sass:*`、外部 URL、alias | 已处理：去注释扫描、动态/外部/别名原因；不执行编译 | `packages/core/src/graph/style.ts` |
| `graph/calls.ts` | transient symbol、外部 lib、动态下标、eval、call/apply | 已处理：只在同文件唯一候选时 heuristic；外部调用不建边 | `packages/core/src/graph/calls.ts` |
| `store/commit.ts` | 新表半提交、失败残留、旧 committed | 已处理：单事务 + ROLLBACK；recover/prune 覆盖四表 | `packages/core/src/store/commit.ts` |
| `store/schema.ts` | v2 旧库、索引缺失 | 已处理：v3 + E06；`REQUIRED_INDEXES` 增 graph 索引 | `packages/core/src/store/schema.ts` |
| `query/service.ts` | 非法 type、缺 target、无模块、同名多候选 | 已处理：E00/E04/E05/E16/E19；单 root 提示 | `packages/core/src/query/service.ts` |
| `surface/builder.ts` | ownerModule 污染 surfaceHash、无配置推断 | 已处理：仅显式 map；ownerModule 不进 hash | `packages/core/src/surface/builder.ts` |
| `discovery/scan.ts` | 样式文件越界、符号链接、超大文件 | 已处理：复用 ignore/sensitive/size/symlink 规则 | `packages/core/src/discovery/scan.ts` |

**递归检查：**

- 是否存在递归：无新增递归。
- 是否已转换为迭代：依赖/调用/样式遍历均为显式栈或循环。
- 如保留递归：不适用。

**测试结果：**

- 类型检查：`npm run typecheck` 退出 0。
- Lint：`npm run lint` 退出 0。
- 单元 / 集成测试：`npm test` **79 passed (9 files)**。
- 构建：`npm run build` 退出 0；两次 dist 哈希一致。
- 未执行项目及原因：百万行 / SCIP 子进程 RSS / 增量（Phase 06）；真实项目的 public Surface ownerModule 样本仍缺（§5）。

**已知缺陷：**

- Vue 脚本调用图未实现；样式非 postcss；架构规则仅 allow-list；跨 root 不读目标索引；`deps` 未分页；调用 unresolved 偏多；schema v3 需重建；真实样本 Surface 无 public 条目。均见 §5，影响范围与触发条件已写明。

**兼容性影响：**

- 破坏性：schema v3（v2 索引必须重建）；`status.capabilities.styleDependency` 从 `none` 变为 `file-level`，新增 `dependencyGraph` / `callGraph` / `architectureRules`；`SurfaceEntry.ownerModule` 由 `null` 变为 `string | null`。
- 非破坏性：`surfaceVersion` / `baselineVersion` 不变；既有命令/字段语义不变；`deps` 为新增命令。

**最终结论：**

**pass（G0–G10 通过；已知限制见 §5）。等待负责人评审，未经批准不进入 Phase 05。**
