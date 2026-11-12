# Phase 04 任务清单（编码前冻结）

> 依据：`docs/phase-04/00-entry-and-decisions.md`、`docs/19-delivery-phases.md` 19.1/19.3、`docs/04-architecture.md` 4.2、`docs/05-data-model.md` 5.1/5.5/5.6/5.7、`docs/08-relations.md`、`docs/10-impact-analysis.md`、`docs/11-cli.md`、`docs/17-testing.md`
> 规范版本：v1.24（冻结）
> 标记约定：`[ ]` 未完成；`[x]` 已完成并附证据；`[~]` 部分完成（必须写限制）；`[!]` 未完成/失败（必须写原因）。不得用 `[x]` 标注未验证项。

## A. 入场、基线与文档

- [x] **A01 基线与授权**：确认 commit `29d6722`、工作区干净、Node 22.16.0 / npm 10.9.2；记录负责人 2026-11-13 裁定（`docs/phase-03/00-entry-and-decisions.md` §8）。
- [x] **A02 冻结计划**：`00-entry-and-decisions.md` / `01-task-checklist.md` / `02-plan-and-gates.md` 三份齐备，编码前不改门槛。
- [x] **A03 规范对照**：逐条核对 19.1 阶段 04、4.2、5.1、5.5、5.6、5.7、8.1、8.2、8.3、11.3、12.3；冲突按 20.6 上报。
- [x] **A04 范围冻结**：确认 §2.2 的“不做”清单；不提前实现 impact/update/MCP/测试关系。
- [x] **A05 遗留台账**：把 Phase 03 §5 三项与 8 章第 7 类关系登记到 §6；指定目标阶段与验收口径。
- [x] **A06 文档索引**：更新 `docs/README.md` 阶段索引；README 状态改为 Phase 04 进行中。

## B. Schema v3 与存储

- [x] **B01 Schema 版本**：`SCHEMA_VERSION = 3`；注释说明新增四表与 `files.owner_module`，旧 v2 需重建。
- [x] **B02 `dependencies` 表**：`dep_id`、`build_id`、`source_file`、`target_file`、`source_root_id`、`target_root_id`、`is_cross_root`、`dep_type`、`specifier`、`relation_class`、`confidence`、`analysis_engine`、`line`、`col`、`unresolved_reason`、`evidence_json`；索引 `(build_id, source_file)`、`(source_file)`、`(target_file)`。
- [x] **B03 `calls` 表**：`call_id`、`build_id`、`caller_symbol_id`、`callee_symbol_id`、`caller_file`、`callee_file`、`line`、`col`、`resolution`、`relation_class`、`confidence`、`analysis_engine`、`unresolved_reason`、`evidence_json`；索引 `(caller_symbol_id)`、`(callee_symbol_id)`、`(build_id, caller_symbol_id)`。
- [x] **B04 `architecture_modules` 表**：模块名、include/allow JSON、计数；主键 `(build_id, module_name)`。
- [x] **B05 `architecture_violations` 表**：`rule_id`、from/to module、文件、行、dep_type、relationClass、confidence、evidence；索引 `(build_id, from_module)`、`(build_id, to_module)`。
- [x] **B06 `files.owner_module`**：新增可空列；写入模块名或 null；不改变既有列语义。
- [x] **B07 必需索引**：`REQUIRED_INDEXES` 增加 dependencies/calls/architecture 索引；补 `symbols(symbol_id)`。
- [x] **B08 Writer 扩展**：`BuildWriter` 增加 `addDependency` / `addCall` / `addArchitectureModule` / `addArchitectureViolation`；单事务、批计数、失败 ROLLBACK。
- [x] **B09 计数与闭合**：`CommitResult.counts` 增加 dependencies/calls；闭合校验确认 `caller/callee_symbol_id` 非空时存在；违规引用的文件存在（路径级）。
- [x] **B10 恢复与清理**：`recoverPending` / `pruneBuilds` 删除四张新表的 build 行；`doctor` 检查表与索引。
- [x] **B11 旧库错误**：v2 库在 `ensureSchema` 返回 E06；`doctor --schema` 给出具体重建命令（按 root 目录）。
- [x] **B12 写入内存**：确认依赖/调用边以迭代器交给 writer，不生成全量 `map` 副本；记录 `writeBatches` 与行数。

## C. 文件依赖图

- [x] **C01 提取导入**：`ImportDeclaration` / `ExportDeclaration` / `ImportEqualsDeclaration` / 字面量 `require` / `import()` 全覆盖。
- [x] **C02 解析**：使用 `ts.resolveModuleName` + 已加载 `compilerOptions`；相对路径、`paths`、`baseUrl` 与编译器一致。
- [x] **C03 关系分类**：静态 import/export → `certain`/`typed`；动态 `import()` → `dynamic-unresolved`（即使字面量可解析）；`missReason=dynamic-import`。
- [x] **C04 未解析原因**：`not-found` / `alias-unresolved` / `ignored` / `skipped-size` / `outside-root`；不得静默丢弃。
- [x] **C05 外部依赖**：`node_modules`、`lib.*.d.ts`、项目根外不建边、不计盲区；不得当项目内依赖。
- [x] **C06 去重与排序**：同一 `(source, target, line, col, dep_type)` 不重复；输出按路径/行/列稳定排序。
- [x] **C07 七项字段**：输出含 `relationType` / `sourceOfTruth` / `analysisVersion` / `isDeterministic` / `confidence` / `constraints` / `missReason`。
- [~] **C08 Vue 文件依赖**：本阶段未实现 `.vue` `<script>` import 边；Vue 侧只做 `<style src>`，调用图也不含 Vue script。限制见 `03-implementation-report.md` §5.1，未静默。
- [x] **C09 单测**：F01 的 import/export/alias/动态 import 各 ≥1；解析失败、外部包、ignore 边界。

## D. 模块依赖与架构规则

- [x] **D01 配置 Schema**：`architecture.modules[]`（`name` / `include` / `allow`）Zod strict；默认 `[]`；未知字段 E17。
- [x] **D02 路径校验**：include 必须项目相对、无 `..`/绝对路径/盘符；复用 `safeRelativePattern` 规则。
- [x] **D03 归属算法**：最长匹配模式优先，同长按模块名；无匹配 null；重叠输出 warning；禁止目录名推断。
- [x] **D04 模块边**：文件依赖聚合为模块间边（from/to、边数、certain/heuristic/unresolved 计数、样例）。
- [x] **D05 允许清单**：省略 allow = 不限制；`[]` = 只允许模块内；违规带 `ruleId` / 文件 / 行 / 证据。
- [x] **D06 未归属盲区**：未归属文件计入 `coverage`/盲区，不参与违规；不得静默忽略。
- [x] **D07 ownerModule**：`SurfaceEntry.ownerModule` 写入模块名或 null；不进入 `surfaceHash`；baseline 同步。
- [x] **D08 模块查询**：`deps --type module <name>` 返回入/出边与违规；无配置 E00 + 提示。
- [x] **D09 单测**：重叠、最长匹配、allow=[]、allow 缺省、跨 root 模块、未归属文件。

## E. 静态调用图

- [x] **E01 遍历**：显式栈遍历 `CallExpression` / `NewExpression` / 标签模板；禁止递归。
- [x] **E02 调用方**：按偏移取最近封闭声明；顶层 `caller_symbol_id=null`；`caller_file` 始终写。
- [x] **E03 被调方解析**：Identifier / PropertyAccess / 字符串字面量 ElementAccess → checker + `getAliasedSymbol`；重载按 ordinal。
- [x] **E04 四档**：`direct` / `typed` / `heuristic`（同文件唯一同名候选）/ `unresolved`（动态、eval、Function、require(expr)、call/apply 不可判定）。
- [x] **E05 外部调用**：外部库/lib 调用不建边、不记 unresolved；仅“应解析到项目内却失败”才记。
- [x] **E06 三分类一致性**：`direct`/`typed` → `certain`；`heuristic` → `heuristic`；`unresolved` → `dynamic-unresolved`；不得自创。
- [x] **E07 证据与限制**：`sourceOfTruth=ts-ast`；`constraints` 含 `vue-script-not-analyzed`；`missReason` 枚举。
- [x] **E08 Vue 限制**：Vue `<script>` 调用不产边时在 manifest/`status` 显式标注，不宣称完整。
- [x] **E09 单测**：F01 direct/typed；F06 heuristic/unresolved；重载、alias、动态下标、`call/apply`。

## F. S1 样式文件级依赖

- [x] **F01 发现**：`.css` / `.scss` / `.less` 纳入扫描；遵循 ignore/sensitive/size/symlink；`language` 记录扩展名。
- [x] **F02 扫描器**：去注释、保留行/列；识别 `@import` / `@use` / `@forward` / `url()`；字符串支持单双引号与转义。
- [x] **F03 五类边**：`style-import`（CSS/Less）、`style-use`、`style-forward`、`style-src`（Vue）、`style-import`（TS/JS，`analysisEngine=script-side`）。
- [x] **F04 解析**：相对路径 → `style.aliases` → 失败；别名 heuristic；动态/变量/`sass:*`/外部 URL unresolved + reason。
- [x] **F05 目标校验**：目标必须已扫描且在 root 内；ignore / not-found / alias-unresolved / outside-root 分别标注。
- [x] **F06 不进符号链**：样式文件不产 Symbol/Reference，不进 Surface/SCIP/`api-diff`；`files` 记录保留。
- [x] **F07 Vue style src**：用 `@vue/compiler-sfc` 或既有投影读取 `<style src>`；坐标映射回 `.vue`。
- [x] **F08 覆盖与盲区**：`styleCoverage`（files/edges/resolved/unresolved）；动态路径、别名、外部包、未覆盖目标进盲区。
- [x] **F09 夹具 F13**：10 文件 / ≤200 行；五类边、动态、别名、ignore 边界；golden。
- [x] **F10 单测/集成**：F13 build + `deps --type style --reverse`；无结果区分三种情况；`git status` 无残留。

## G. 跨 root 边界

- [x] **G01 根清单传递**：`buildWorkspace` 把全部选中 root 的 name、exports、dependencies 传给每个 root 分析；不读 B 索引。
- [x] **G02 判定顺序**：包名 → 子路径 → 声明依赖 → exports 解析 → 文件存在；顺序固定。
- [x] **G03 失败原因**：`root-not-indexed` / `undeclared-dependency` / `exports-mismatch` / `not-found` / `outside-root`；全部 `unresolved(package-boundary)`。
- [x] **G04 边字段**：`cross-package`、`target_root_id`、`target_file`、`relationClass=certain`、`confidence=typed`、`analysisEngine=package-boundary`。
- [x] **G05 不越界**：不展开 B 符号、不做 BFS、不合并 Surface；跨包边只存 A。
- [x] **G06 架构规则**：跨包边参与模块 allow 判定；目标模块按全局 include 匹配。
- [x] **G07 夹具 F14**：2 roots / 10 文件 / ≤250 行；已声明边 + 三类失败 + 别名越界；golden。
- [x] **G08 单测/集成**：F14 双 root build；`deps` 在 A 返回 cross-package 与盲区；无跨 root 合并索引。

## H. 盲区清单

- [x] **H01 类型**：`BlindSpot` 含 category / missReason / affectedFiles / potentiallyAffectedSymbols / estimateMethod / manualCheckHint / sample / sourceQuery。
- [x] **H02 四类**：code / style / multi-root / coverage 均能产出；空类给 0 且 reason 可解释。
- [x] **H03 符号数**：能算则数字；不能算则 null + 估算方式；禁止写 0 冒充。
- [x] **H04 人工提示**：每条给可复制的 `nex` 命令或检索式。
- [x] **H05 manifest**：有界样本 + 计数；`status` 汇总；`deps` 输出当前 root。
- [x] **H06 测试**：F06（动态）、F13（样式）、F14（多根）、F17/ignore（覆盖）各断言字段齐全。

## I. 查询层与 CLI

- [x] **I01 核心查询**：`queryDependencies` 支持 file/module/style/call + reverse + explain；单 root。
- [x] **I02 输出契约**：四格式同源；`counts` 三分类 + `byConfidence` + `byType`；`coverage` / `staleness` / `warnings` / `notes` / `blindSpots` / `architecture`。
- [x] **I03 排序稳定**：路径/行/列/confidence；同输入两次逐字节一致。
- [x] **I04 错误码**：非法 type / 缺 target → E00/64；未初始化 → E01；索引不可用 → E19；同名多候选 → E04；无模块配置 → E00。
- [x] **I05 CLI 注册**：从 stub 移除 `deps`；参数、帮助、示例、`helpGroup` 与其他查询一致。
- [x] **I06 渲染**：pretty/lines/json/markdown 与 `?`/`!` 前缀已实现；`--explain` 的 deps 证据块已输出 `sourceOfTruth` 等字段。
- [x] **I07 status**：增关系图计数、`capabilities.dependencyGraph` / `callGraph` / `architectureRules`、盲区摘要。
- [x] **I08 doctor**：schema v3、四表、索引、跨包边闭合、blind spot 字段检查。
- [x] **I09 surface ownerModule**：build 写入；`api-snapshot` 保留；`surfaceHash` 不含 ownerModule；回归 Phase 03 快照。
- [x] **I10 CLI 测试**：四格式、reverse、explain、非法参数、无结果三种区分、`--root`。

## J. 夹具与 oracle

- [x] **J01 F13 新建**：CSS/SCSS/Less/Vue/TS 五类边；动态、别名、ignore；`expected/` golden；≤200 行。
- [x] **J02 F14 新建**：双 root、声明依赖、未声明、exports 不匹配、别名越界；≤250 行。
- [x] **J03 F01 扩展**：import/export/dynamic-import + direct/typed call；行数仍 ≤300。
- [x] **J04 F05 扩展**：Vue `<style src>` 与模板引用不回归；行数仍 ≤350。
- [x] **J05 F06 扩展**：dynamic import / 动态调用 unresolved / heuristic；行数仍 ≤300。
- [x] **J06 行数预算**：F01–F18 合计 ≤12000；单夹具 ≤2000 行/20 文件；新增后统计并记录。
- [x] **J07 Oracle**：依赖/调用 golden 由 `tsc`/人工核对生成，不由工具自证；样式 golden 由人工核对 at-rule。
- [~] **J08 真实样本（有界）**：已自索引 4 roots / 69 files / 1986 symbols；本仓库 exports 指向 `dist/`，Surface public 条目为 0，ownerModule 的真实项目样本仍缺；F13 夹具提供 ownerModule 证据。
- [x] **J09 负向**：缺失 exports、ignore 目标、越界别名、动态路径已覆盖；v2 库 E06 已由 writer 测试单独注入并断言。

## K. 回归、构建与 act

- [x] **K01 构建**：`npm run build`、`npm run typecheck`、`npm run lint`、`npm run format:check` 退出 0；两次 dist 哈希一致。
- [x] **K02 单测**：`npm test` 全绿；记录通过数/文件数/耗时。
- [x] **K03 回归**：F01/F05/F10/F15/F17 既有断言不回归；Phase 03 Surface 快照/差分不回归。
- [x] **K04 act**：`act -j verify --container-options "-m 4g" --action-offline-mode` 通过；Node 22.16.0 与 24.22.3 各 9 files / 79 passed（96.57s / 84.45s），两个 job 均 `Job succeeded`。
- [x] **K05 稳定性**：同 fingerprint 两次 build + 两次 deps 的 items 逐字节一致；Phase 03 快照稳定性回归通过。
- [x] **K06 写入失败**：`BuildWriter` 单事务 + ROLLBACK；新增 dependencies/calls 的失败注入测试断言四表 0 行、旧 committed 保留。
- [x] **K07 性能记录**：scan/analyze/style/graph/write/total、peakRssMB、writeBatches、行数；只代表夹具，不外推。
- [x] **K08 工作区**：`git status --porcelain` 无验证残留（`.actrc` 除外）；`.nexus/tmp/` 为空。

## L. 文档与报告

- [x] **L01 README**：状态、能力表、`deps` 命令、限制、阶段结果；不写“完整调用图”。
- [x] **L02 docs/README**：阶段索引加入 Phase 04。
- [x] **L03 runtime-api**：新增 `node:` 内置使用（如有）登记；无新增第三方依赖则注明。
- [x] **L04 AGENTS**：`.dsh/AGENTS.md` 当前状态同步（不入库）。
- [x] **L05 实施报告**：`03-implementation-report.md` 按 19.3 九项；G0–G10 证据；§5 已知问题。
- [x] **L06 自审回执**：实际磁盘代码 + `git diff`；边界/安全/异步/递归/兼容性；不得凭记忆。
- [x] **L07 规范未改**：不修改 v1.24 正文；冲突先报告。
- [x] **L08 交接**：给 Phase 05 的接口（impact 所需的依赖/调用/盲区/模块/跨包边）明确列出。
