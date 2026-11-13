# Phase 05 入场记录：影响分析与审计

> 记录日期：2026-11-13（Asia/Shanghai）
> 依据：`docs/19-delivery-phases.md` 19.1/19.2/19.3、`docs/05-data-model.md` 5.1/5.5/5.6/5.7/5.9/5.11、`docs/06-api-surface.md` 6.4、`docs/08-relations.md` 8.1/8.2/8.3、`docs/09-reuse-detection.md` 9.1/9.2、`docs/10-impact-analysis.md`、`docs/11-cli.md`、`docs/12-indexing.md` 12.4、`docs/13-audit-and-ci.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md` 17.2、`docs/18-security.md` 18.4、`docs/20-prohibitions.md`
> 规范版本：v1.24（冻结）
> 前置：`docs/phase-04/03-implementation-report.md`（Phase 04，pass；负责人评审回执见 `docs/phase-04/00-entry-and-decisions.md`）
> 状态：**负责人 2026-11-13 批准进入 Phase 05。本文件与 `01-task-checklist.md`、`02-plan-and-gates.md` 共同构成编码前冻结基线。**

## 1. 授权与基线

| 项 | 值 |
|---|---|
| 负责人裁定 | 2026-11-13：接受 Phase 04 以 `pass` 关闭；批准进入 Phase 05 |
| 基线 commit | `92d805fb19963cf956023dc05c43a32650dd7616`（`feat(deps): 实现 Phase 04 依赖图与架构分析`） |
| 工作区 | `git status --porcelain` 为空；`.actrc` 为负责人本地 act 配置，不纳入库 |
| Node / npm | v22.16.0 / 10.9.2（本地）；act 矩阵沿用 Node 22.16.0 与 24.22.3 |
| Schema | **升到 `SCHEMA_VERSION = 4`**；新增 `tests` 表（8 第 7 类关系、5.1 Test 实体、5.6 tests 大表）；旧 v3 索引必须重建，不提供迁移 |
| 本地 CI | `act -j verify --container-options "-m 4g"`；无网络时 `--action-offline-mode` |

## 2. 本阶段范围

### 2.1 交付能力（对应 19.1 阶段 05）

1. **`nex impact`**：文件 / 符号 / 样式文件三类目标；直接与间接依赖者（含展开深度、`truncated`）、受影响公共 API、组件、类型、相关测试、相关文档、架构违规、盲区清单、建议验证命令；风险等级与逐条证据（10.1/10.3）。
2. **`nex preflight`**：识别任务涉及 API、已存在相似能力（9.1 规则集，无向量、无模型）、源码位置、依赖、架构边界、潜在影响、文档与测试、任务上下文（13.1 八项）。
3. **`nex postflight`**：Git Diff、修改文件、修改符号（识别不出标 `unidentified`）、Surface 差分（含 `evidenceSource` / `exportKind`）、依赖变化、架构规则、测试覆盖、可授权静态检查、变更报告（13.2 十一项）。
4. **`nex verify`**：受 `commands.allow` 白名单与 `.nexus/trust.json` 授权的命令编排；逐条回显命令 / cwd / 超时 / 用途；超时、1 MB 输出上限、退出码与摘要；未授权跳过标 `skipped-unauthorized`（18.4）。
5. **CI 门禁与退出码**：`--fail-on breaking|additive|ambiguous|warning|none`；0/1/2/64/70 与 E00/E12/E16/E19/E23 归因；heuristic 影响面不得自动阻断（13.2 #11）。
6. **5.9 查询期根路由**：`root` / `roots a,b` / `all` 三 scope；cwd 最长前缀匹配；无归属报 E16；`all` 按 root 分组、组间不排序不去重、同名 `globalAmbiguous`、`staleRoots`/`completeness`。
7. **测试与源码关系（8 第 7 类）**：`tests` 表 + build 期从引用/调用派生；impact 的 `tests.related` 与建议命令；`coverage.testRelations` 计数。
8. **样式目标影响**：`styleDependents` 文件级、无类名/选择器、默认 Medium、删除/重命名且有静态消费方 High、不进 Critical（4.2/10.1）。
9. **盲区**：沿用四类 + 影响面定向盲区（不可解析消费方、被忽略消费方、测试关系缺口），字段四件套齐全。
10. **夹具与 golden**：F08 refactor（10 文件 / ≤400 行，真实变更场景）、F12 dirty（5 文件 / ≤120 行，staleness/E16）；F14 扩展 5.9 多根路由断言。
11. **文档与报告**：README、`docs/README.md`、`docs/runtime-api.md`、本阶段四份文档、实施报告。

### 2.2 明确不做

| 能力 | 处理 |
|---|---|
| `nex context` 的 CLI/MCP 表面 | 本阶段只实现 preflight 共用的 core context builder；`nex context` 命令与 MCP 8 工具仍属 Phase 07。不得声称 context 命令已可用 |
| `nex similar` / `audit-duplicates` CLI | 只实现 9.1 的 core 规则引擎供 preflight 使用；两条治理命令与 MCP 属 Phase 07 |
| `update` / 失效传播 / 提交协议 / 状态机 / 全局调度器 / 构建指纹完整实现 | Phase 06；本阶段只消费现有 `staleness` 与 `buildFingerprint` |
| MCP 8 工具、`print`、`doctor --repair`、发布验证 | Phase 07 |
| 自动修复代码、自动合并重复实现、自动改写 API | 永久禁止 |
| 自动运行 `package.json` scripts、自动安装依赖、联网 | 永久禁止（18.1 C5/C6） |
| 报告自动落盘 | 13.3：默认只写 stdout；仅显式 `--output-file` |
| 跨 root BFS / 跨 root 去重 / 全包合并排序 | 5.9 禁止；impact 按 root 各自计算 |
| Vue 脚本调用图 | 仍为 Phase 04 限制；impact 的调用面只对 TS/TSX 承诺 |
| HTML 样式链接、类名/选择器消费方 | 4.2 的 v1.x opt-in / 永久不做 |

### 2.3 不变量（违反即 gate 失败）

1. **certain 口径**：影响面“漏报率为 0”只对 `relationClass = certain` 且覆盖完整、分析成功成立；heuristic / dynamic-unresolved 必须分列，不得混入确定性结论。
2. **证据制**：每条风险、差分、违规、测试关系必须给文件、行、`relationClass`、`confidence`、判定依据；不得只给结论。
3. **盲区强制**：impact / preflight / postflight 均带盲区清单；不得只写“存在盲区”。
4. **只读边界**：查询与审计命令不修改被分析项目；`verify` 仅执行授权命令；postflight 执行后 `git status --porcelain` 不得新增未跟踪文件（`.nexus/` 由 build/update 产生的除外）。
5. **Git 安全**：只用固定参数、无 shell 的 `git` 读取命令；禁止 `git reset` / `clean` / 强制 `checkout` / 自动覆盖用户修改。
6. **多 root 不合并**：查询不跨 root 读、不跨 root BFS、不把多 root 结果统一排序去重；cwd 无归属必须 E16。
7. **heuristic 不阻断**：`confidence` 存在 heuristic 时上限 `medium`；禁止自动 `--fail-on` 阻断。
8. **输出契约**：四格式同源；lines/json 无 ANSI、无绝对路径、无时间戳；裁剪必须 `truncated` + `nextCursor`。
9. **既有语义不变**：Phase 01–04 的命令、字段、退出码、Surface/基线版本不回归；`surfaceVersion` / `baselineVersion` 仍为 1。
10. **写入纪律**：`tests` 表走既有 `BuildWriter` 单事务；失败 ROLLBACK；不新增全量副本。
11. **安全边界**：verify 白名单只接受完整命令 + 参数；拒绝通配符、shell 拼接、管道、重定向、破坏性命令；未授权不执行。
12. **不冒充**：未实现、未验证、跳过项必须标 `partial` / `heuristic` / `unresolved` / `unsupported` / `failed`。

## 3. 关键技术决策（编码前冻结）

### 3.1 Schema v4 与 `tests` 表

**决策**：`SCHEMA_VERSION` 从 3 升到 4；新增 `tests` 表；v3 索引在 `ensureSchema` 处按 E06 拒绝，`doctor --schema` 打印逐 root 重建命令。不提供迁移。

`tests` 列：

```text
test_id (pk), build_id, test_file, target_symbol_id (nullable), target_file (nullable),
test_type (unit|integration|e2e|unknown), relation_class, confidence, analysis_engine,
line, evidence_json
```

- 索引：`(build_id, target_symbol_id)`、`(build_id, test_file)`、`(build_id, target_file)`。
- 派生：`BuildWriter` 在写入 references/calls 后、COMMIT 前执行两条 `INSERT ... SELECT`：
  - 引用：`references.source_file` 为测试文件、`target_symbol_id` 非空、目标符号文件非测试文件；
  - 调用：`calls.caller_file` 为测试文件、`callee_symbol_id` 非空。
- 测试文件判定（固定、可解释）：路径含 `.test.` / `.spec.` / `.e2e.`，或含 `__tests__/`。`test_type`：`.e2e.` → `e2e`；`__tests__/` 或 `integration` → `integration`；其余 `unit`。
- 无法解析到目标符号的测试文件不伪造关系；在 `coverage.testRelations.unresolvedTestFiles` 计数并进盲区（测试侧）。
- 理由：5.6 明确 `tests` 属 SQLite 大表；5.1 的 Test 实体需要“测试文件 / 关联符号 / 测试类型 / 覆盖置信度”；Phase 04 已把该关系列为 Phase 05 交付。SQL 内派生避免把 references 二次物化成全量数组。

**与 12.2 的关系**：`tests` 参与增量/全量等价比较；本阶段只做全量构建，Phase 06 补增量门禁。

### 3.2 `nex impact` 语义

- **目标解析**：`<path>`（含 `/`、以 `.` 开头、或 `fileCovered` 命中）→ 文件；`--symbol <name|symbolId>` 或 `s_` 前缀 → 符号；样式扩展名（`.css/.scss/.less`）→ 样式文件。
- **直接依赖者**：
  - 文件目标：`dependencies` 中 `target_file = 目标` 的源文件；以及 `references` 中目标符号位于该文件、源文件不同的消费符号；
  - 符号目标：`references` 指向该符号的消费位置、`calls` 中 `callee = 目标` 的调用方；
  - 样式目标：只取 `style-*` 反向边，输出 `styleDependents`（`sourceFile` / `line` / `depType` / `confidence` / `analysisEngine`）。
- **间接依赖者**：以直接项为起点，按“反向文件依赖 → 反向引用到该文件符号 → 反向调用”三层边做 BFS；`--depth` 默认 3、最大 10；`truncated = true` 时必须给 `nextCursor`（实现为 `impact:<depth>:<offset>` 的稳定游标，Phase 05 支持按深度续读）。
- **不跨 root BFS**：跨包只呈现目标 root 已记录的 `is_cross_root` 出边与多根盲区；不展开目标 root 符号。
- **counts**：按三分类统计影响项；`partial = 1` 当且仅当存在 `mappingQuality = unmapped` 的受影响符号或 staleness != fresh。
- **`impactFanout`**：受影响唯一符号数（符号目标含目标自身，文件目标为文件中被引用符号数）；不把文件数命名为影响面。
- **风险等级（可操作化，逐条给证据）**：

| 等级 | 判定（满足任一） |
|---|---|
| Critical | 当前索引相对 baseline 的 Surface 差分含 `breaking` 且受影响的 public 符号命中；或存在 opaque 边界消费方且无法确认；或目标相关架构违规 `severity=error` |
| High | 命中 public Surface 条目（非 breaking）；或目标文件被 ≥2 个架构模块引用（核心基础设施的操作化定义）；或存在无法解析的 certain 消费方；或样式删除/重命名且有静态消费方 |
| Medium | 跨模块引用且 Surface 未变；或存在关联测试；或样式默认 |
| Low | 引用均在单模块内、未命中 Surface、无跨模块边 |

- 每条风险 `reasons[]` 含 `rule` / `detail` / `file` / `line` / `relationClass` / `confidence`；样式目标最高 High，不进入 Critical。
- **Surface `diffLevel` 口径**：取“当前索引 vs baseline/`--base`”的 `diffCurrentSurface` 分级，并标 `basis: "current-vs-baseline"`；没有 baseline 时 `diffLevel: "not-available"` 且给 note。不得把“计划中的变更”伪造成已发生的差分。
- **文档**：查询期只读扫描 `README.md`、`docs/**/*.md`、root 内 `*.md`（最多 2000 文件、单文件 1 MB），按符号名 / 目标路径匹配，输出 `path:line`；不建文档索引。
- **建议命令**：`commands.allow` 中 id 含 `test` 的条目 → `nex verify --only <id>`；否则若 `package.json` 有 `scripts.test` → 建议 `npm test`（只建议，不执行）。

### 3.3 `nex preflight` 语义

- 输入：位置参数 `<target>` 或 `--task <text>`（至少一个；都没有 E00）。
- 复用：preflight 的 impact 部分直接调用 `analyzeImpact`，context 部分直接调用 `buildTaskContext`；不另写一套（13.1 #8）。
- 已存在能力：调用 9.1.1 的确定性规则（名称词干 0.30、参数个数 0.15、参数类型 0.20、返回类型 0.15、模块位置 0.10、导出范围 0.05、结构特征 0.05），输出 `scoreBreakdown` / `rulesVersion` / `isHeuristic: true` / `matchBasis` / `suggestion` / `location`。
- 名称抽取：无目标符号时对任务文本做可解释关键词抽取（标识符切分、停用词、现有符号表命中）；抽取失败时输出 `extraction: { failed: true, message }`，继续其余可执行部分，并令退出码 2（warning），不得静默跳过。
- 无向量、无 embedding、无模型；`similar.embedding` 配置不进入本阶段。
- 输出：`existingApis` / `similar` / `sources` / `dependencies` / `architecture` / `impact` / `docs` / `tests` / `context` / `blindSpots` / `suggestedCommands` / `risk` / 完整性字段。

### 3.4 `nex postflight` 语义

- **Git Diff**：`git -C <projectRoot> diff --name-status -M --no-ext-diff --no-textconv <base>`；`base` 默认 `HEAD`；支持 `HEAD~1`、分支、commit。仅读取。无 git 仓库 / 非 git ref → E00 + 可复制命令，不尝试兜底。
- **修改符号**：
  - 重命名按 `R` 处理：旧路径符号记为删除，新路径符号记为新增；
  - 修改文件用 `git diff -U0` 解析新侧行区间；与 `symbols.declarationLocator` 区间相交者记为修改符号；
  - 无符号文件、仅删除行、无法归属的区间 → `unidentified[]`（文件 + 原因），不得跳过；
  - 符号识别以 `symbolId` 输出；未识别时 `symbolId: null`。
- **Surface 差分**：`diffCurrentSurface({ projectRoot, loadedConfig, base })`，输出 `breaking/additive/internal/ambiguous`；每条带 `evidenceSource` / `exportKind` / `rationale`。索引不 fresh 时标 `confidence: low` + finding `index-stale`。
- **依赖变化**：对每个 A/M/R 文件，用 `git show <base>:<oldPath>` 与磁盘新内容做 TS 语法级 import/export specifier 集合差分，输出 `added[]` / `removed[]`；不使用 checker，`analysisEngine = ts-ast-syntax`。删除文件全部记 removed。
- **架构规则**：读取当前 `architecture_violations`；违规行落在修改行区间 → `introduced`，否则 `pre-existing`；两者分列（13.4）。
- **测试覆盖**：`tests` 表按目标符号查；无关联测试的修改符号 → `test-coverage-missing` warning（不阻断）。
- **样式删除/重命名**：被删除或重命名的样式文件若在索引中有静态消费方（反向 `style-*` 边，或 unresolved 的 `not-found` 且 specifier basename 匹配），输出 warning 并默认退出 2；`--fail-on warning` 升级为 1；无消费者不报。
- **可授权检查**：复用 `verify`，`explicit=false`；未授权 → `skipped-unauthorized`，不报 E12、不阻断。
- **confidence**：high（全部 certain、fresh、无 unidentified）；medium（存在 heuristic 影响项）；low（存在 dynamic-unresolved、staleness != fresh、unidentified 或 verify 失败）。存在 heuristic 时**禁止**任何 finding 自动触发 `--fail-on`（`blockable: false`）。
- **报告**：字段与 13.3 一致（`base` / `buildFingerprint` / `staleness` / `mode` / `confidence` / `findings` / `surfaceDiff` / `coverage` / `blindSpots` / `verification`），另加 `changed` / `dependencyChanges` / `risk` / `exit`。
- **退出码**：默认 `--fail-on breaking`；0 无阻断无告警；1 有阻断；2 仅告警；64 用法；70 内部。`none` → 不因 findings 失败（内部错误仍 70）。

### 3.5 `nex verify` 语义与授权

- 输入：`--only <id,id>`（缺省全部）、`--dry-run`、`--yes`、`--non-interactive`。
- 白名单来源：配置 `commands.allow`；Zod strict + 运行时二次校验：禁止通配符、`; | & > < \``、`$(`、换行、`..` 越界 cwd；禁止 `rm`、`git reset`、`git clean`、`git checkout --`、`sudo`、`curl | sh`、`sh -c`、`cmd /c`、`powershell -c` 等；命中 E17。
- 授权：`.nexus/trust.json` 记录 `{version, commands:[{id, signature, source, authorizedAt}]}`；`signature = sha256(id + cmd + args + cwd + timeoutMs)`。字段任一变化即失效。
  - TTY：逐条确认；非 TTY：必须 `--yes`；
  - `nex verify` 显式执行且未授权 / 无 `--yes` → E12；
  - postflight 内部调用未授权 → `skipped-unauthorized`，不报 E12。
- 执行：`cwd` 限制在项目根内；`timeoutMs` 上限 600000；输出截断 1 MB 并标 `truncated`；不使用 shell，不继承注入环境变量；Windows 下 `.cmd/.bat` 通过严格引用的 `ComSpec` 启动器执行（见 §5 限制），参数含 shell 元字符一律拒绝。
- 每条回显：`id` / `cmd` / `args` / `cwd` / `timeoutMs` / `purpose` / `authorization`；结果含 `exitCode` / `stdoutSummary` / `stderrSummary` / `durationMs` / `truncated`。

### 3.6 5.9 查询期根路由

- **三概念分离**：`rootId`（索引单元）、`activeRoot`（cwd 最长前缀匹配或显式参数）、`scope`（`root` / `roots` / `all`）。
- **cwd**：最长前缀匹配；落在仓库根或 root 外 → `activeRoot = null`；未给 scope → E16 + 候选 root（含是否已建索引）；嵌套 root → 最长路径取胜 + warning。
- **scope**：`root` 只查 activeRoot；`roots a,b` 并行/顺序查指定 root；`all` 查全部可查询 root。`--root` 与 `--roots` 同现 → E00。
- **输出**：多 root 时结果按 root 分组（`byRoot[]`），组内保持既有排序，组间不排序、不去重；`lines` 每行加 `[rootId]` 前缀；`json` 每条带 `rootId`；`pretty` 分小节。同名符号跨 root 各自成条，顶层 `globalAmbiguous: true` + 候选清单。
- **完整性**：`completeness = complete` 仅当全部 root `fresh`；否则 `partial` + `staleRoots[]`。failed root 不读，列 `failedRoots[]`；全部不可用 → E19。
- **查询命令覆盖**：`symbol` / `references` / `search` / `deps` / `impact` / `preflight` / `postflight` 均接受 `--root` / `--roots`；`status` 已有。
- **预算**：按 root 均分；软预算只降级层次，不删条目；不引入硬性条数上限。

### 3.7 退出码与门禁

| 场景 | 退出码 |
|---|---|
| 查询/审计无阻断、无告警 | 0 |
| `--fail-on` 命中（breaking/additive/ambiguous/warning） | 1 |
| 仅告警（heuristic 影响面、样式警告、staleness、unidentified） | 2 |
| 用法/参数/无归属/无 git 前置 | 64（E00/E16） |
| 未授权 verify（显式） | 1（E12） |
| 索引不可用 | 1（E01/E19） |
| 内部错误 | 70（E23） |

heuristic 影响项的 finding 一律 `blockable: false`，即使 `--fail-on warning` 也不得把它升级为 1（13.2 #11）。

## 4. 验收口径

### 4.1 19.1 阶段 05 通过条件

1. **真实变更场景漏报率为 0（certain 口径）**：F08 的 golden 消费方集合全部出现在 impact 直接/间接结果；任何遗漏即 gate 失败，不得以“人工确认”替代。
2. **报告含证据与盲区**：impact / preflight / postflight 的每条风险与 finding 有文件、行、规则、`relationClass` / `confidence`；盲区四件套齐全。
3. **E16 失败态正确**：cwd 在仓库根且未给 scope → E16 + 候选；`--root`/`--roots` 互斥 → E00；all 模式分组、不排序、不去重、`globalAmbiguous` 正确。

### 4.2 量化门槛

- F08：10 文件 / ≤400 行；四层引用链 + 测试 + 样式；impact direct/indirect certain 消费方全命中；`unidentified` 仅出现在测试刻意构造的无符号文件。
- F12：5 文件 / ≤120 行；dirty 文件使 impact/postflight 标 `stale`，不声称完整；E16 用例。
- F14：5.9 路由断言（root / roots / all；cwd 归属；E16；`globalAmbiguous`；组间不排序）。
- verify：授权前跳过、授权后成功、超时、1 MB 截断、危险命令 E17、非 TTY 无 `--yes` E12。
- postflight：`git status --porcelain` 执行前后一致（仅 `.nexus/` 允许由 build 产生）；breaking/additive/ambiguous 各 ≥1；heuristic 不阻断；样式删除 warning + 默认 2 / `--fail-on warning` → 1。
- 稳定性：同 `buildFingerprint` 两次 impact/postflight 的 lines/json 逐字节一致（排除 `builtAt` 等明确排除项）。

## 5. 已知限制（实现前登记）

1. **`nex context` 与 `nex similar` 命令不在本阶段**：只提供 core 实现；preflight 可使用，CLI/MCP 表面留 Phase 07。
2. **impact 的调用面只覆盖 TS/TSX**：Vue `<script>` / 模板调用不产 CallRelation；模板引用仍计入引用面，不宣称完整调用图。
3. **文档关联是查询期文本匹配**：不建文档索引，不保证语义相关；无匹配时给检索范围。
4. **Surface `diffLevel` 是当前索引 vs baseline**：不是“计划变更”的预测；无 baseline 时 `not-available`。
5. **postflight 依赖已构建索引**：不自动 build；索引 stale 时样件/符号识别可能不完整，标低 confidence 与盲区。
6. **测试关系只来自引用与调用边**：动态注册、字符串路径、运行时测试发现不承诺；未解析测试文件进盲区。
7. **Windows `.cmd` 启动器**：为执行 `npm` / `tsc` 等 `.cmd` shim，使用固定 `ComSpec` 包装并对参数做严格元字符拒绝；不是用户可注入的 shell，限制登记在报告。
8. **架构规则仍只有 allow-list**：Phase 04 限制不变；impact 的“核心基础设施”按“被 ≥2 模块引用”操作化，不是运行时重要性。
9. **性能**：只记录夹具与有界样本；百万行/增量/内存预算仍属 Phase 06。
10. **schema v4 需重建**：v3 索引 E06；不迁移、不自动删除。

## 6. 跨阶段遗留台账

| 项 | 来源 | 目标阶段 | 本阶段动作 | 不得冒充 |
|---|---|---|---|---|
| `nex context` CLI/MCP | 11.1 / 14.1 | Phase 07 | 只实现 core `buildTaskContext` 供 preflight；命令仍 E24 | 不得写成“context 命令已实现” |
| `similar` / `audit-duplicates` | 9.3 / 11.1 | Phase 07 | 只实现 9.1.1 core 规则供 preflight | 不得写成“治理命令已完成” |
| 增量 `update` / 12.2 等价 / F16 | Phase 04 §6 | Phase 06 | postflight 只读取 `staleness`，不自动更新 | 不得声称增量可用 |
| 全局调度器 / 内存预算 | 5.10 / 21.2 | Phase 06 | 只记录 impact/postflight 耗时 | 不得外推规模档 |
| Vue 脚本调用图 | Phase 04 §5 | Phase 06 评估 | 保持限制，不伪造 | 不得宣称 Vue 调用完整 |
| 真实项目 impact 样本 | 16.1 | Phase 06 | 用 F08 + 本仓库有界自索引做证据，记录边界 | 不得用夹具冒充大规模 |

## 7. 文档与代码同步纪律

- 本文件冻结 Phase 05 的范围、口径与限制；实现中与 v1.24 冲突时按 20.6 暂停并报告，不自行改写规范。
- 任何验收口径变更必须先更新本文件与 `02-plan-and-gates.md`，再改代码。
- 实施结果只写入 `03-implementation-report.md`，不得把计划回填为已完成。
- README / `docs/README.md` / `docs/runtime-api.md` / `.dsh/AGENTS.md`（不入库）随能力变化同步；不修改 v1.24 规范正文。
