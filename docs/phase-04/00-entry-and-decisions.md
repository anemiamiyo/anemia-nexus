# Phase 04 入场记录：关系图与架构分析

> 记录日期：2026-11-13（Asia/Shanghai）
> 依据：`docs/19-delivery-phases.md` 19.1/19.3、`docs/04-architecture.md` 4.2、`docs/05-data-model.md` 5.1/5.2/5.5/5.6/5.7、`docs/07-code-search.md`、`docs/08-relations.md`、`docs/10-impact-analysis.md`、`docs/11-cli.md`、`docs/12-indexing.md`、`docs/13-audit-and-ci.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md`、`docs/20-prohibitions.md`
> 规范版本：v1.24（冻结）
> 前置：`docs/phase-03/03-implementation-report.md`（Phase 03，pass；负责人评审回执见 `docs/phase-03/00-entry-and-decisions.md` §8）
> 状态：**负责人 2026-11-13 已书面接受 Phase 03 以 pass 关闭并批准进入 Phase 04；本文件与 `01-task-checklist.md`、`02-plan-and-gates.md` 共同构成编码前冻结基线。**

## 1. 授权与基线

| 项 | 值 |
|---|---|
| 负责人裁定 | 2026-11-13：接受 Phase 03 以 `pass` 关闭；批准进入 Phase 04；两项判断授权实施方裁定（见 `docs/phase-03/00-entry-and-decisions.md` §8） |
| 基线 commit | `29d6722c76d2b21b4c3fd1a7faddb8a8dadb5e49`（`feat(surface): 实现 Phase 03 API Surface 与基线治理`） |
| 工作区 | `git status --porcelain` 为空；`.actrc` 为负责人本地 act 配置，不纳入库 |
| Node / npm | v22.16.0 / 10.9.2（本地）；act 矩阵沿用 Node 22.16.0 与 24.22.3 |
| Schema | **升到 `SCHEMA_VERSION = 3`**；新增关系图/架构表与 `files.owner_module`；旧 v2 索引必须重建，不提供迁移 |
| 本地 CI | `act -j verify --container-options "-m 4g"`；无网络时 `--action-offline-mode` |

## 2. 本阶段范围

### 2.1 交付能力（对应 19.1 阶段 04）

1. **文件依赖图**：TS/TSX 的静态 `import` / `export ... from` / `import type` / `import = require` / 字面量 `require` / 动态 `import()`；解析到项目内文件；记录 `relationClass` / `confidence` / `analysisEngine` / 位置 / 未解析原因。
2. **模块依赖图**：按 `architecture.modules` 将文件归入架构模块；输出模块间边、违规与未归属文件；不允许用目录名冒充模块。
3. **符号引用图加固**：沿用 Phase 01–03 的 `references`，补齐三分类计数与 `partial` 语义；引用与依赖/调用共用同一 `relationClass` / `confidence` 判定口径（8.3）。
4. **静态调用图**：TS/TSX 的 `CallExpression` / `NewExpression` / 标签模板；四档 `confidence`（`direct` / `typed` / `heuristic` / `unresolved`）与三分类；调用方按最近封闭声明归属；无法解析的动态调用显式登记。
5. **架构规则**：`architecture.modules[].allow` 允许依赖清单；模块间禁止边产出违规；违规带规则、文件、行、`relationClass` / `confidence` 与证据。
6. **S1 样式文件级依赖**：CSS `@import`、SCSS `@use`、SCSS `@forward`、Vue `<style src>`、TS/JS `import "./x.css"` 五类边全部可产出；别名、动态路径、外部包、`sass:*`、未覆盖目标按 4.2 标注。
7. **跨 root 边界规则**：仅当 A 的 `package.json` 显式声明 B 且 B 的 `exports` 可解析到具体文件时，记录 `cross-package` 边；否则记 `unresolved(package-boundary)` 并写原因；不展开 B 的符号。
8. **盲区清单**：代码侧、样式侧、多根侧、覆盖侧四类；每项含 `affectedFiles`、`potentiallyAffectedSymbols`（无法计算时给上限估计与估算方式）、`manualCheckHint`。
9. **查询与可见性**：`nex deps`（文件/模块/样式/调用）；`status` / `doctor` / `manifest` 暴露关系图计数、退化与盲区摘要；`surface.json` 写入 `ownerModule`。
10. **存储与写入**：schema v3；`dependencies` / `calls` / `architecture_modules` / `architecture_violations` 四表；沿用单事务 `BuildWriter`，不新增全量副本。
11. **夹具与 golden**：F13 style-deps、F14 multi-root 新建；F01/F05/F06 增加依赖/调用/动态边断言；不突破 17.1 行数预算。
12. **文档与报告**：README、`docs/README.md`、`docs/runtime-api.md`、本阶段三份文档、实施报告。

### 2.2 明确不做

| 能力 | 处理 |
|---|---|
| `impact` / `preflight` / `postflight` / `verify` | Phase 05；本阶段只提供其所需的图与盲区数据，不实现编排与风险等级 |
| 增量 `update`、失效传播、七注入点、21.2 预算达标 | Phase 06 |
| MCP 8 工具、`print`、`doctor --repair`、发布验证 | Phase 07 |
| 多 root 查询合并、`--roots all` 分组 | Phase 05（5.9）；本阶段 `deps` 默认单 root |
| HTML `<link rel="stylesheet">` / `<style src>` | 4.2 的 v1.x opt-in，不进本阶段 gate；`style.html=false` 时明确不索引 |
| 类名 / 选择器消费方、`url()` 资源 | 永久不做（4.2 边界） |
| 测试与源码关系（8 的第 7 类） | Phase 05 随 impact 的 `tests.related` 落地；本阶段不伪造 |
| Vue `<script>` / 模板表达式的完整调用图 | Phase 04 只对 TS/TSX 产调用边；Vue 模板边仍由 Phase 02 引用图承担，脚本调用登记为限制，不宣称完整 |
| 真实百万行项目外推 | 只记录夹具与有界样本，不构成 21.2 达标声明 |
| 自动改写代码 / 自动修复架构违规 | 永久禁止 |

### 2.3 不变量（违反即 gate 失败）

1. **三分类与四档置信**：每条关系必须落在 `certain` / `heuristic` / `dynamic-unresolved` 之一，`confidence` 落在 `direct` / `typed` / `heuristic` / `unresolved` 之一；映射固定按 8.1.2，不得自创。
2. **确定性结论只来自 `certain`**：`heuristic` / `unresolved` 不得进入 `certain` 计数、不得用于“全集/零漏报”表述；所有输出按三分类分别计数。
3. **盲区可计算**：不得只写“存在盲区”；每项必须有文件数、符号数（或上限与估算方式）、人工核查命令。
4. **样式不进符号链**：样式文件只作为 File + Dependency；不产 Symbol / Reference，不进 Surface / SCIP / `api-diff`。
5. **跨 root 不造边**：不满足 5.7 两条条件的跨包引用一律 `unresolved(package-boundary)`；禁止用 `paths`、相对路径上跳或目录约定推断。
6. **架构模块不猜**：只有显式 `architecture.modules[].include` 匹配的文件才有 `ownerModule`；无配置时一律 `null`，不得用目录名推断。
7. **一条关系七项**：`relationType` / `sourceOfTruth` / `analysisVersion` / `isDeterministic` / `confidence` / `constraints` / `missReason` 在输出中齐全（8.1.3）。
8. **写入纪律**：沿用单事务、迭代器、批计数、失败 ROLLBACK；不把依赖/调用边攒成全量数组后再写。
9. **既有语义不变**：Phase 01–03 的命令、退出码、错误码、Surface 快照格式不被破坏；`surfaceVersion` 仍为 1；`baselineVersion` 仍为 1。
10. **只读与离线**：不执行项目脚本、不联网、不读项目根外路径、不持久化影子文件。

## 3. 关键技术决策（编码前冻结）

### 3.1 Schema v3 与重建策略

**决策**：`SCHEMA_VERSION` 从 2 升到 3；新增 `dependencies`、`calls`、`architecture_modules`、`architecture_violations` 四表，并在 `files` 增加 `owner_module TEXT`。不提供迁移；v2 索引在 `ensureSchema` 处以 E06 拒绝，`doctor --schema` 打印“删除该 root 的 index.db 并重建”的命令。

理由：

- 5.1 已把 Dependency / CallRelation / ArchitectureModule 列为实体；5.6 要求 `dependencies` / `calls` 的查询索引。把它们放 JSON 会让 `deps` 与 impact 的邻接查询退化为整片反序列化，违反 5.6 的“机器查的进库”。
- 新增表属不兼容变更（旧库缺表），按 5.5 默认策略重建；索引是派生物，不做自动迁移。
- `surface.json` 仍不落库（Phase 03 裁定不变）；`ownerModule` 只是派生字段。

**5.6 索引口径的实现说明**：5.6 写的是 `dependencies(source_file_id)` / `dependencies(target_file_id)`。本阶段以项目相对 POSIX 路径列 `source_file` / `target_file` 承担同一查询语义并建立等价索引，原因：跨 root 目标文件不在本 root 的 `files` 表中，无法用同一 `file_id` 外键表达；路径是 5.4 已规定的稳定对外坐标。`calls` 仍按 `caller_symbol_id` / `callee_symbol_id` 建索引。`doctor` 校验实际存在的等价索引；报告如实登记该口径差异，不冒充与 5.6 逐字相同。

### 3.2 架构模块与规则

配置（全局，不放进 `roots.<rootId>` 覆盖）：

```json
{
  "architecture": {
    "modules": [
      { "name": "core", "include": ["packages/core/src/**"], "allow": ["shared"] },
      { "name": "shared", "include": ["packages/shared/src/**"], "allow": [] }
    ]
  }
}
```

- `include` 必须是项目相对 POSIX glob，禁止绝对路径、`..`、盘符；`allow` 是模块名数组。
- **归属**：文件按项目相对路径匹配。多个模块同时匹配时，取“最长匹配模式”者；同长按模块名升序；并输出 `architecture-module-overlap` warning。不得用目录名推断。
- **allow 语义**：省略 `allow` = 不限制；`allow: []` = 只允许模块内，禁止依赖其他模块；`allow: ["x"]` = 允许模块内与 x。未归属文件不参与规则判定，只进盲区“未归属文件”。
- **违规**：文件级依赖的源、目标都归属模块，模块不同，且源模块有 `allow` 且目标模块不在其中 → 一条 `architecture_violations`，`severity=error`，`ruleId=arch/<from>->/<to>`。
- **跨 root**：目标模块用同一份全局 `include` 对项目相对路径匹配；跨包边同样参与规则判定。
- **ownerModule**：`surface.json` / baseline 的 `SurfaceEntry.ownerModule` 取符号文件的模块名；无匹配为 `null`。`ownerModule` 不进入 `surfaceHash`（避免架构配置变化被误报为 API 变化），但写入文件与基线供人工复核。

### 3.3 文件依赖图

- 只从 TS/TSX 的 AST 提取：`ImportDeclaration`、`ExportDeclaration`（含 `export * from` / `export { x } from`）、`ImportEqualsDeclaration`、字面量 `require()`、`import()`。
- 用 TS `resolveModuleName` + 已加载 `tsconfig.options` 解析；相对路径、`paths` 别名、`baseUrl` 均以编译器结果为准。
- 解析到本 root 内文件 → `dep_type` 为 `import` / `import-type` / `export` / `require` / `dynamic-import`，`relationClass=certain`（`dynamic-import` 按 8.1 固定 `dynamic-unresolved`，即使字面量可解析），`confidence=typed`，`analysisEngine=ts-ast`。
- 解析到项目内其他 root → 进入 3.6 的跨 root 判定；不直接当普通依赖。
- 解析到项目根外 / `node_modules` / `lib.*.d.ts` → 外部依赖，不建边、不计盲区。
- 项目内相对路径解析失败 → `unresolved_reason=not-found`；`paths` 未命中 → `alias-unresolved`；目标被 ignore → `ignored`；目标超大小限制 → `skipped-size`。统一 `relationClass=dynamic-unresolved`、`confidence=unresolved`。
- `sourceOfTruth=ts-ast`；`analysisVersion` 取 `ANALYZER_VERSION.typescript`；`constraints` 记录 `types-resolved` / `paths` 等；`missReason` 取枚举（8.1.3）。

### 3.4 静态调用图

- 只对 TS/TSX 的 `CallExpression` / `NewExpression` / 标签模板提取；显式栈遍历，禁止递归。
- 调用方：按源码偏移取最近封闭的 `DeclarationRecord`；顶层调用 `caller_symbol_id=null`，仍写 `caller_file`。
- 被调方：`Identifier` / 属性访问 / 字符串字面量下标 → `checker.getSymbolAtLocation` + `getAliasedSymbol`；声明位置映射到 `symbolId`。同一位置的声明合并按既有重载序号处理，不合并。
- 四档判定：
  - `direct`：被调声明与调用方在同一文件（或同一容器）；
  - `typed`：跨文件且经 checker / alias 解析到唯一声明；
  - `heuristic`：checker 未解析，但同文件内恰有一个同名声明（`?` 标记，`relationClass=heuristic`）；
  - `unresolved`：动态下标、`eval`、`Function`、`require(expr)`、`call/apply` 目标不可判定、类型为 `any` 且无唯一同名候选（`!` 标记 + 原因码）。
- 指向外部库 / `lib.*` 的调用不建边（不是项目内静态调用图的一部分），不记 unresolved 噪声；只有在“本应解析到项目内却失败”时记 unresolved。
- `sourceOfTruth=ts-ast`；`analysisVersion=ANALYZER_VERSION.typescript`；`constraints` 记录 `vue-script-not-analyzed`（当 root 含 Vue 时）与 `cross-root-not-expanded`。

### 3.5 S1 样式文件级依赖

- 样式文件类型：`.css` / `.scss` / `.less`（`style.extensions` 可配）；作为 `files` 记录，`language` 取扩展名，不进入 TS Program、不产符号。
- 提取方式：**只做语法层字符串提取，不执行 Sass/Less 编译**。Phase 04 使用自带的有限扫描器（去注释、保留位置、识别 `@import` / `@use` / `@forward` / `url()` 字符串），不使用 `postcss-scss` / `postcss-less`（未在锁定依赖集中，新增依赖需走 3.2 三重门槛；本阶段不引入）。这是一处与 3.3 “postcss 系”字面表述的偏差，记录在 §7，Phase 06 若需要更复杂语法再评审替换。
- 五类边：`style-import`（CSS/Less `@import`，TS/JS `import "./x.css"` 的 `analysisEngine=script-side`）、`style-use`（SCSS `@use`）、`style-forward`（SCSS `@forward`）、`style-src`（Vue `<style src>`）、`style-link`（HTML，opt-in，不进入 gate）。
- 解析：相对路径 → `style.aliases` 前缀 → 失败。字面量且文件存在 → `direct`；经 alias / `~` / `@` 解释 → `heuristic`；动态拼接、变量、`sass:*`、外部 URL、包名外链 → `unresolved` + reason。
- 目标必须已扫描且在 root 内；目标被 ignore → `ignored`；目标缺失 → `not-found`；别名未命中 → `alias-unresolved`；越出 root → `outside-root`。
- 无结果时 `deps` 必须区分“确认不存在 / 文件未覆盖 / 别名未解析”（7.3）。
- 样式边不参与 `references` 计数、Surface、`api-diff`；impact 的最高等级按 4.2 为 High，不进 Critical。

### 3.6 跨 root 边界

- 构建时把全部选中 root 的 `package.json`（name + exports + dependencies）传给每个 root 的分析阶段；不依赖 B 的索引，只读 B 的清单与文件存在性。
- 判定顺序（固定）：
  1. 解析 import 说明符到“包名 + 子路径”；
  2. 找到同名 root B；找不到 → `root-not-indexed`；
  3. A 的 `dependencies` / `devDependencies` / `peerDependencies` 未声明 B → `undeclared-dependency`；
  4. B 的 `exports` 无法把子路径解析到 B 内具体文件 → `exports-mismatch`；
  5. 目标文件不存在 / 越出 B → `not-found` / `outside-root`。
- 1–5 全部满足 → `dep_type=cross-package`、`relationClass=certain`、`confidence=typed`、`analysisEngine=package-boundary`，写 `target_root_id` 与 `target_file`；否则 `relationClass=dynamic-unresolved`、`confidence=unresolved` + reason。
- 不展开 B 的符号、不做 BFS、不合并 Surface；跨包边只存于 A 的 build。
- 跨包边参与架构规则判定；目标模块按全局 `architecture.modules` 对项目相对路径匹配。

### 3.7 查询与 CLI

- 新增 `nex deps [target]`：
  - `--type <file|module|style|call>`，默认 `file`；
  - `--reverse` 查入边；
  - `--explain` 输出 `relationClass` / `confidence` / evidence / constraints / missReason；
  - 非法 `--type` → E00 / 64；无 target → E00 / 64；未初始化 → E01；索引不可用 → E19。
- `file`：按项目相对路径查 `dependencies`；目标可为文件或目录（目录前缀）。
- `style`：只查 `style-*` 边；`--reverse` 即“谁引用了该样式文件”。
- `module`：按模块名查模块间边与违规；无 `architecture.modules` → E00，提示先配置，不返回空图冒充成功。
- `call`：目标为 symbolId 或唯一名称；默认列出被调方（outgoing），`--reverse` 列出调用方（incoming）；同名多候选 → E04。
- 输出四格式同源：`counts` 按三分类；`byConfidence`；`byType`；`blindSpots`；`architecture`（模块/违规）；`coverage`；`staleness`；`warnings`；`notes`。
- `status` 增 `dependencies` / `calls` / `styleEdges` / `crossRootEdges` / `architectureViolations` 计数与 `capabilities.dependencyGraph` / `callGraph` / `architectureRules`；`doctor` 增 schema/索引/图完整性检查。
- `surface.json` 的 `ownerModule` 由 build 写入；baseline 同步。

### 3.8 盲区清单

- 四类：`code`（动态 import、动态调用、未解析依赖）、`style`（动态路径、别名、外部包、未覆盖目标）、`multi-root`（未声明依赖、exports 不匹配、root 未索引、别名越界）、`coverage`（ignore、超大小、读取失败、mapping unmapped）。
- 每条：`category` / `missReason` / `affectedFiles` / `potentiallyAffectedSymbols`（数字或 `null` + `estimateMethod`）/ `manualCheckHint` / `sample`（≤10）/ `sourceQuery`。
- 写入 manifest（有界样本 + 计数）；`status` 汇总；`deps` 输出当前 root 的完整分类计数与样本。
- 无法计算符号数时不得写 0：写 `null` + 估算方式（如“按每个受影响文件的最大声明数上限估计”），并在 `notes` 说明。

## 4. 验收口径

### 4.1 19.1 阶段 04 通过条件

1. **盲区清单 100% 标注**：四类盲区均有 `affectedFiles` / `potentiallyAffectedSymbols` / `manualCheckHint`；
2. **heuristic / unresolved 不进入确定性结论**：`counts.certain` 只统计 `relationClass=certain`；任何“全集/零漏报”文案只出现在 `certain` 且 `partial=0`；
3. **S1 五类边全部可产出**：F13 中 `style-import`（CSS/Less/TS 三来源）、`style-use`、`style-forward`、`style-src` 均有断言；
4. **调用图三分类四档**：F01/F06 至少各 1 条 `direct` / `typed` / `heuristic` / `unresolved`；
5. **跨 root 边界**：F14 的已声明依赖成立、未声明依赖 / exports 不匹配 / root 未索引 / 别名越界均 `unresolved(package-boundary)`；
6. **架构规则**：F14 或新增配置夹具至少 1 条违规，带模块、文件、行、证据；无配置时 `ownerModule=null` 且 `deps --type module` 明确报错；
7. **既有能力不回归**：Phase 01–03 全部测试与 act 矩阵通过。

### 4.2 量化门槛

- F13：10 文件 / ≤200 行；五类边各 ≥1；动态路径 unresolved ≥1；别名 heuristic ≥1；ignore 边界 ≥1；样式文件 0 符号。
- F14：2 roots / 10 文件 / ≤250 行；已声明依赖边 ≥1；三类失败原因各 ≥1；无跨 root 合并索引。
- 调用图：F01 或 F06 中 `direct` / `typed` / `heuristic` / `unresolved` 各 ≥1；每条有 `relationClass` + `confidence` + 位置。
- 依赖图：F01 中 import / export / dynamic-import 各 ≥1；未解析原因可复核。
- 盲区：四类均非空且字段齐全；每个盲区都有可复制的人工核查命令。
- Snapshot 稳定性：同 `buildFingerprint` 两次 build，`surface.json`、`deps` 的 lines/json 逐字节一致（除 `builtAt` 等明确排除项）。
- 写入：`writeBatches` 存在；失败 ROLLBACK 后 `dependencies` / `calls` 计数为 0 或旧 committed 保留。

## 5. 负责人裁定的落地

- Phase 03 关闭为 **pass**；`docs/phase-03/00-entry-and-decisions.md` §8 为准。
- §5 三项不阻断关闭；本阶段只承接“真实项目 Surface 有界样本”作为证据债（见 §6）。
- `surface.json` 继续作为派生视图、不升 schema；本阶段新增 `ownerModule` 派生字段，不改变 `surfaceVersion`，不把 Surface 写入 DB。

## 6. 跨阶段遗留台账

| 项 | 来源 | 目标阶段 | 本阶段动作 | 不得冒充 |
|---|---|---|---|---|
| 分析阶段与写入完全重叠 | Phase 03 §5/§4 限制 | Phase 06 | 本阶段新增四表仍走 `BuildWriter` 单事务，不新增全量副本；分析阶段仍保留必要的文件/声明结构 | 不得写成“已重叠” |
| 真实项目 Surface 有界样本 | Phase 03 §5 | Phase 04（证据）/ Phase 06（规模） | 改动 `ownerModule` 后，对 `fixtures/local/` 可用样本或本仓库自索引做一次有界抽样；记录文件数、Surface 条目、反向误报；不可用则如实记 `not-run` 与原因 | 不得用合成夹具代替“真实项目样本” |
| git ref 基线前置条件 | Phase 03 §5 | 文档即可 | 保持现状，不再补做 | 不得宣称任意目录可用 |
| 测试与源码关系（8 第 7 类） | 08 章 | Phase 05 | 本阶段不实现；`deps` 的 import 边为 Phase 05 提供输入 | 不得声称已建立测试关系 |
| Vue 脚本/模板调用图 | 08 章 | Phase 05/06 评估 | 只对 TS/TSX 产调用边；Vue 模板边仍为引用，脚本调用登记为限制 | 不得宣称 Vue 调用图完整 |
| postcss 系样式解析 | 03 章 3.3 | Phase 06 评估 | 使用有限扫描器；只保证 4.2 五类字面量边 | 不得写成“完整 Sass/Less 解析” |
| 多 root 查询合并 | 5.9 | Phase 05 | `deps` 默认单 root；跨包边随 A 返回 | 不得合并为单表 |

## 7. 已知限制（实现前登记）

1. 调用图只覆盖 TS/TSX 的静态调用；Vue `<script>` 与模板表达式不产 CallRelation，模板引用仍按 Phase 02 的引用边处理。
2. 样式只做字面量提取，不编译 Sass/Less，不解析变量拼接；`postcss-scss` / `postcss-less` 未引入。
3. 架构规则只有 `allow` 允许清单，没有命名规则 DSL、层号、循环依赖规则；循环检测仅作为 `deps` 的观察项，不作为 gate。
4. 跨 root 只按已声明依赖 + exports 解析；不读取 B 的索引，因此不校验 B 的实际符号可达性。
5. 5.6 的 `source_file_id` / `target_file_id` 以路径列 + 等价索引实现（见 3.1），属口径差异。
6. `deps --type module` 需要显式 `architecture.modules`；无配置不猜测。
7. 盲区中的 `potentiallyAffectedSymbols` 在无法精确计算时为 `null` + 估算方式；不得写 0 冒充“无影响”。
8. schema v3 需要重建；本阶段不提供迁移、不做自动删除。
9. 真实百万行/大项目性能不外推；本阶段只记录夹具与有界样本。
10. 依赖/调用边与 `references` 的 `relationClass` 口径由同一 Normalizer 规则产出；若发现不一致，以 8.1 为准修复，不各命令各自判定。

## 8. 文档与代码同步纪律

- 本文件冻结 Phase 04 的范围、口径与限制；实现中与 v1.24 冲突时按 20.6 暂停并报告，不自行改写规范。
- 任何验收口径变更必须先更新本文件与 `02-plan-and-gates.md`，再改代码。
- 实施结果只写入 `03-implementation-report.md`，不得把计划回填为已完成。
- README / `docs/README.md` / `docs/runtime-api.md` / `.dsh/AGENTS.md`（不入库）随能力变化同步；不修改 v1.24 规范正文。
