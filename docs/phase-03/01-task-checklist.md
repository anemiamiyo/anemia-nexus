# Phase 03 完整任务清单：API Surface 与基线

> 生成日期：2026-11-12（Asia/Shanghai）
> 依据：`docs/19-delivery-phases.md` 阶段 03、`docs/06-api-surface.md`、`docs/05-data-model.md` 5.1/5.11/5.12、`docs/11-cli.md`、`docs/13-audit-and-ci.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md`、`docs/20-prohibitions.md`、`docs/21-phase-00.md`
> 入场与裁定：`docs/phase-03/00-entry-and-decisions.md`
> 状态：**已按本清单实施并回填证据；结论与逐项证据见 `03-implementation-report.md`。**
> 清单先于编码编写；本文件冻结后才开始实现。

## 0. 使用规则

- `[ ]` 未开始；`[x]` 仅在实现、测试、自审并留下证据后勾选；`[BLOCKED]` 表示等待负责人裁定或上游依赖。
- 每项“证据”必须可复核：命令、退出码、测试名、代码位置或结果文件。
- 任务顺序是依赖顺序，不是可以跳过的理由；标注“阻断”的任务未关闭时，后续任务不得开工。
- 不得用固定数据、空实现、硬编码证据来源或伪造可达性冒充 Surface 判定；不得把 `unknown` 当已判定。
- 不得降低 `docs/phase-03/02-plan-and-gates.md` 的阈值；不达标按 20.6 报告，不得调口径。

## 1. 阶段目标与边界

### 1.1 目标（依据 19.1 阶段 03、第 6 章）

1. Surface 判定含 `evidenceSource` / `primaryEvidenceSource` / `exportKind` / `isTypeOnly` / `runtimePresent` / `derived`；
2. `manual-override`、`package-exports`、`explicit-entry`、`barrel-derived`、`none` 五类证据与固定优先级；
3. `package.json` exports 的条件导出、子路径、fallback、通配；
4. `nex api-snapshot` 生成按 root 分段的 `nexus.baseline.json`，含 `surfaceHash` 与 `buildFingerprint`；
5. `nex api-diff` 的 breaking / additive / internal / ambiguous 分级、`--base`、`--fail-on`；
6. `@deprecated` 与替代符号链路；
7. `symbol` / `search` / `status` 的 Surface 可见性与能力声明；
8. F07 api-surface 夹具与自动化断言；
9. **负责人指定遗留补齐**：SQLite 边算边写/分批写入，降低构建内存峰值；
10. 阶段报告、自审、README / runtime-api / AGENTS 同步。

### 1.2 明确不做

| 能力 | 处理 |
|---|---|
| 依赖/调用图、架构模块、样式链 | Phase 04；`ownerModule` 写 null |
| impact / preflight / postflight / verify | Phase 05 |
| 增量、失效传播、21.2 全量预算达标 | Phase 06 |
| MCP、`print`、发布验证、`doctor --repair` | Phase 07 |
| 多 root 查询合并 / `--roots all` | Phase 05（5.9） |
| `status --json-schema` | 仍 E24 |
| 完整签名语义归一化（条件/映射类型全展开） | 文本归一化 + 不能判定落 ambiguous |
| 自动改写代码 / 自动删除 API / 自动升级依赖 | 永久禁止 |

### 1.3 Phase 03 gate（编码前冻结，详见 `02-plan-and-gates.md`）

G0 遗留补齐、G1 构建、G2 Surface 完整性、G3 证据与优先级、G4 快照、G5 差分、G6 弃用、G7 回归、G8 输出、G9 act CI、G10 自审。

## 2. 入场与裁定（A）

- [x] **A01 记录 Phase 02 关闭与 Phase 03 授权**：负责人接受 Phase 02 pass、批准进入 Phase 03；记录原话摘要与日期。证据：`00-entry-and-decisions.md` §1。
- [x] **A02 冻结 Phase 03 口径**：确认 `00` / 本清单 / `02` 三份文档存在且无 TODO 占位。证据：三份文档与 `git diff --stat`。
- [x] **A03 记录基线 commit 与工作区**：记录 `ea01efe`；`git status --porcelain` 仅允许负责人本地 `?? .actrc`，其余为空。证据：命令输出。
- [x] **A04 环境基线**：`node -v`、`npm -v`、`npm ci --dry-run`、`npm ls --depth=0` 退出码。证据：命令与输出摘要。
- [x] **A05 确认不引入禁用项**：无第三方 SQLite 驱动、无网络、无项目脚本执行、无持久化影子/map sidecar、无样式进 Surface。证据：依赖与代码审查。
- [x] **A06 建立实施看板**：创建 Phase 03 报告骨架（未完成项不得预填通过），记录任务到 gate 的映射。证据：`03-implementation-report.md`。
- [x] **A07 本地 CI 基线**：确认 `act -j verify --container-options "-m 4g"` 可运行，记录首次基线结果（可为失败，但必须记录）。证据：act 输出摘要与镜像/Node 版本。
- [x] **A08 记录已知限制**：`00` §6 的八项限制在实现中不得被悄悄消除或扩大。证据：报告 §已知问题。

## 3. 遗留补齐：SQLite 边算边写（P，负责人指定）

> 来源：`docs/21-phase-00.md`“边算边写”要求、Phase 01 G15（partial）、21.2。原属 Phase 06；本次负责人明确要求补齐。不得以本项为由降低 Phase 03 其他 gate。

- [x] **P01 现状证据**：记录当前实现“先聚数组再批量插入”的代码位置与 Phase 01 报告 G15 原文；给出峰值风险说明。证据：`03-implementation-report.md` §遗留补齐。
- [x] **P02 写入器 API**：新增 `BuildWriter`（或等价）封装 `BEGIN IMMEDIATE`、pending 记录、prepared statement 复用、批计数、`seal()`；错误路径 ROLLBACK；连接关闭。证据：代码 + 单测。
- [x] **P03 单事务协议**：数据 + `build_record(pending)` 同一事务；闭合校验、必需索引、分母非零、指纹字段齐全后 COMMIT；再验证 pending、翻 committed、prune K=2。证据：代码 + 集成测试。
- [x] **P04 迭代器写入**：`commitBuild` 接受 `Iterable`/生成器；`files` / `symbols` / `references` / `symbol_map` / `components` / `vue_file_meta` 逐批写入，不构造全量副本。证据：代码审查 + 计数测试。
- [x] **P05 消除副本**：移除 `references.map({...})`、`mappingRows()` 全量数组、`qualityBySymbolId` 全量 Map、`symbols.map` 全量 Set 等可避免副本；改为惰性生成。证据：diff + `rg` 检查。
- [x] **P06 历史维护 SQL 化**：当前 build 的 symbol_id 写入临时表；用 SQL 完成 retire / active 插入，不在 JS 构造全量 Set。证据：代码 + DB 断言。
- [x] **P07 分批与释放**：默认批大小 500（可配/常量），每批后不保留行对象引用；构建计数只保留整数；峰值采样与 `writeBatches` 写入 manifest。证据：manifest + 采样记录。
- [x] **P08 失败原子性**：写入中途抛错 → ROLLBACK、无 pending/半套行、旧 committed 保留；`.nexus/tmp` 清空。证据：负向测试。
- [x] **P09 行为不变**：同源同配置两次构建的 `buildFingerprint`、行数、`symbolId`、引用五元组、manifest 关键字段与改造前一致（用 golden 对比）。证据：测试 + 对比脚本/记录。
- [x] **P10 内存证据**：用合成规模夹具记录改造前后峰值 RSS 或至少记录批次/副本消除证据；不得把 F05 小数据外推 21.2 达标。证据：报告 §性能。
- [x] **P11 限制登记**：分析阶段仍保留声明/映射结构；未做到 SCIP 解析与 SQLite 写入完全重叠。证据：报告 §已知问题。

## 4. 配置、模型与接口（B）

- [x] **B01 配置 Schema**：新增 `surface`：`entries`（项目相对路径数组）、`manual`（`symbolId?` / `nameChain?` / `name` + `exposure: public|internal` + `reason?`）、`baselinePath`（默认 `nexus.baseline.json`，项目相对、禁止绝对/`..`）；root override 可覆盖。证据：`config/schema.ts` + 单测。
- [x] **B02 配置合并**：`surface` 进入 `EffectiveRootConfig` 与 `configHash`；默认值与 root 覆盖优先级正确；非法配置 E17。证据：`merge.ts` + 单测。
- [x] **B03 模型类型**：新增 `SurfaceEvidenceSource`、`SurfaceEntry`、`SurfaceSnapshot`、`SurfaceDiffItem`、`DeprecatedChain` 类型；字段只增不删。证据：`model.ts` 或 `surface/types.ts`。
- [x] **B04 不升 Schema**：沿用 `SCHEMA_VERSION=2`；不新增表、不改既有列；旧库无需重建。证据：`schema.ts` diff + 集成回归。
- [x] **B05 指纹**：`surfaceHash` 不进入 `buildFingerprint`（Surface 是派生物）；manifest 记录 `surfaceHash` / `surfaceEntries`；指纹字段不变。证据：`fingerprint.ts` + manifest。
- [x] **B06 导出面**：core `index.ts` 导出新 API；CLI 通过包入口使用，不深引内部文件。证据：`packages/core/src/index.ts`。

## 5. Surface Builder（C）

- [x] **C01 导出图**：用 TS AST 建立每文件导出表：直接导出、局部 alias、`export { x } from`、`export * from`、`export * as ns`、`export { default as X }`、重载声明合并。证据：`surface/export-graph.ts` + 单测。
- [x] **C02 模块解析**：相对路径、扩展名（`.ts/.tsx/.vue`）、`index.*`、tsconfig `paths`/`baseUrl`；解析失败不猜，记 `unresolved` 原因。证据：单测 + F07。
- [x] **C03 package.json exports**：解析字符串、对象条件、子路径、数组 fallback、`*` 通配；每个条件生成独立 entry 记录；无效 exports 记 warning，不崩溃。证据：单测 + F07。
- [x] **C04 可达性**：从 exports 目标与 `surface.entries` 出发遍历导出图；环检测；同一符号多来源全部记录；`derived` 正确。证据：单测 + F07。
- [x] **C05 证据判定**：五类证据与固定优先级；`manual-override` 冲突提示；`none` → internal；动态导出 → opaque。证据：单测。
- [x] **C06 exportKind**：`type` / `value` / `both`；`isTypeOnly` 与 `runtimePresent` 与声明一致；`export type` 与 `export { type X }` 覆盖。证据：单测 + F07。
- [x] **C07 SurfaceEntry 字段**：`name`、`normalizedSignature`、`kind`、`entryPath`、`condition`、`evidenceSources`、`primaryEvidenceSource`、`derived`、`stability`、`since`、`ownerModule`、`docLink`、`symbolId`、`identityConfidence`、`propsCoverage`。证据：类型 + snapshot。
- [x] **C08 Vue 组件**：组件条目附 `propsCoverage` 与 unresolved 清单；coverage < 1 时 stability 不得 stable。证据：F05 + F07。
- [x] **C09 反向误报防护**：internal / 不可达符号断言不进入 public entries；不确定时 opaque/internal。证据：F07 负向断言。
- [x] **C10 确定性**：entries 按 `name/condition/entryPath` 稳定排序；Map/Set 遍历前排序；无时间戳/行号/绝对路径。证据：两次构建逐字节对比。
- [x] **C11 surfaceHash**：对 entries + evidenceSources + exportKind 求哈希；证据来源变化必变；internal 不参与。证据：单测。
- [x] **C12 构建集成**：`build` 在 commit 后、manifest 前原子写 `surface.json`；失败不更新 manifest；构建结果/进度含 Surface 计数。证据：`build.ts` + 集成测试。
- [x] **C13 校验与降级**：package.json 缺失/非法、entry 文件缺失、导出图不可解析时记 warning/degraded，不产出假 public；Surface 失败不破坏索引。证据：负向测试。

## 6. 快照与差分（D/E）

- [x] **D01 `api-snapshot` 命令**：读取当前 root 的 surface.json，按 root 分段写 `nexus.baseline.json`；保留既有 `since`；含 `surfaceHash` / `buildFingerprint`；只写基线文件。证据：CLI 集成测试。
- [x] **D02 覆盖语义**：TTY 确认；非 TTY 必须 `--yes`，否则 E00/64；`--output-file` 若支持必须显式且不默认落盘；覆盖后工作区仅基线变化。证据：CLI 测试。
- [x] **D03 基线校验**：读取基线时校验 `baselineVersion`、root 结构、字段类型；损坏 → 明确错误，不静默重建。证据：负向测试。
- [x] **D04 基线确定性**：同 fingerprint 两次 snapshot 逐字节一致；无时间戳/行号/绝对路径；JSON 末尾换行统一。证据：哈希对比。
- [x] **D05 `api-diff` 当前面**：读取当前 surface + 基线（文件或 `git show <ref>:nexus.baseline.json`）；ref 不存在/文件缺失 → E00 或 E01，给可执行建议。证据：CLI 测试。
- [x] **D06 差分键**：`rootId + name + entryPath + condition`；缺失两侧分别进 breaking/additive；internal 用 `internal` 记录。证据：单测。
- [x] **D07 分级规则**：按 `00` §4.5 实现 breaking/additive/internal/ambiguous；签名变化不能判定落 ambiguous；证据来源升级 additive、降级 ambiguous。证据：单测 + F07 golden。
- [x] **D08 差分证据**：每条含 `code`、`severity`、`before`/`after`、`evidence`（记录/证据来源/exportKind）、`rationale`；不只有结论。证据：输出断言。
- [x] **D09 fail-on 与退出码**：`--fail-on breaking|additive|ambiguous` 默认 breaking；命中 1、仅 warning 2、无命中 0；非法值 64/E00；非 TTY 不阻塞。证据：CLI 测试。
- [x] **D10 四格式一致**：pretty/lines/json/markdown 字段集合一致；lines/json 无 ANSI、逐字节稳定；counts 与分组计数可核对。证据：格式测试。
- [x] **D11 不写工作区**：`api-diff` 只读；`api-snapshot` 只写基线；执行后 `git status` 断言。证据：测试。

## 7. 弃用链路（F）

- [x] **F01 JSDoc 提取**：`@deprecated`、`@see`、`{@link}`、`@removal`/`removalVersion`；仅读已扫描源码。证据：单测 + F07。
- [x] **F02 stability**：deprecated 符号 `stability=deprecated`；仍在 Surface；api-diff 删除仍 breaking。证据：F07。
- [x] **F03 替代解析**：按 `symbolId` 解析，不按名称模糊匹配；候选排序稳定；多候选 → ambiguous + 候选列表；无候选 → `no-successor`。证据：单测 + F07。
- [x] **F04 输出**：`oldSymbolId` / `newSymbolId` / `reason` / `removalVersion` / `suggestion`；建议可复制，不自动改写。证据：snapshot/diff 输出。
- [x] **F05 removalVersion**：当前版本已过且基线声明移除时才可不算 breaking；否则删除仍 breaking。证据：单测。

## 8. 查询、CLI 与输出（G）

- [x] **G01 `symbol.surface`**：由 `unknown` 改为 `public|internal|opaque|unknown`；新增 `api` 字段（name/entryPath/condition/evidenceSources/primaryEvidenceSource/derived/exportKind/stability/since/successor）；缺 surface.json 时 unknown + warning。证据：CLI 测试。
- [x] **G02 `search`**：public/internal 过滤使用 Surface 判定；结果含 surface 字段；不破坏既有排序。证据：测试。
- [x] **G03 `status`**：`capabilities.apiSurface='evidence-sources'`、`snapshot` 存在性、`surfaceHash` 前缀、Surface 计数；未构建时不伪造。证据：status JSON。
- [x] **G04 `doctor`**：检查 surface.json 与 manifest buildId/hash 一致、baseline 可解析、entry 文件存在；只报告不自动修复。证据：doctor 测试。
- [x] **G05 CLI 注册**：`api-snapshot [--yes] [--root]`、`api-diff [--base] [--fail-on]`；从 stubs 移除；帮助文本与 11.3 一致。证据：`cli.ts` + `--help`。
- [x] **G06 渲染**：四格式同源；pretty 结论行 + 条目；markdown 表格；lines 紧凑；JSON 严格字段。证据：渲染测试。
- [x] **G07 错误与退出码**：E00/E01/E17/E19 正确；api-diff 命中退出 1；警告 2；非 TTY 5s 内退出。证据：CLI 测试。
- [x] **G08 输出稳定**：无 ANSI、绝对路径、时间戳；同 fingerprint + 参数逐字节一致；路径统一 `/`。证据：golden。
- [x] **G09 回归**：`update` / `status --json-schema` 仍 E24；`--format` 非法 64；既有命令输出字段不删。证据：测试。

## 9. F07 夹具与测试（H/I/J）

- [x] **H01 F07 结构**：`fixtures/F07-api-surface`，8 文件 / ≤250 行；`package.json` 含条件导出与子路径；`tsconfig.json`；`expected/` golden 与 README。证据：目录与行数。
- [x] **H02 覆盖点**：直接导出、多层 barrel、条件导出、子路径、通配 fallback、`export type`、重载、`@deprecated` 有继任者、`no-successor`、opaque 边界、internal 导出。证据：fixture 源码 + README 映射。
- [x] **H03 golden 独立**：golden 由人工核对（基于 TS AST/tsc 语义），不由被测 Surface Builder 自证；记录生成方法与核对人/日期。证据：README + `expected/`。
- [x] **H04 快照测试**：构建 F07 → `api-snapshot` → golden 逐字节/逐字段一致；两次快照一致。证据：测试名与输出。
- [x] **H05 差分测试**：构造 before/after 基线，断言 breaking/additive/internal/ambiguous 各 ≥1、fail-on 退出码、证据与 rationale 完整。证据：测试。
- [x] **H06 反向测试**：internal 符号改签名/删除 → internal 或允许的 breaking 判定符合规则；不得误标 public；损坏基线/缺失 entry/非法 exports 的负向用例。证据：测试。
- [x] **H07 单测**：exports 解析、导出图、优先级、exportKind、hash、diff 规则、弃用解析、签名归一化。证据：测试清单。
- [x] **H08 集成测试**：真实 build + SQLite + surface.json + CLI api-snapshot/api-diff。证据：测试。
- [x] **H09 回归测试**：F01/F05/F10/F15/F17 全绿；Phase 02 Vue 断言不回归。证据：`npm test`。
- [x] **I01 测试预算**：单次全量测试 ≤8 分钟；F07 与新增测试不引入网络/大文件。证据：测试耗时。
- [x] **J01 非 TTY**：`api-snapshot` 无 `--yes` 退出 64 且 5s 内；`api-diff` 管道正常。证据：CLI 测试。
- [x] **J02 安全**：不执行项目脚本、不读越界文件、不跟随 symlink 逃逸、不写 report/logs/debug。证据：安全测试。

## 10. 构建、CI 与文档（K）

- [x] **K01 构建**：`npm run build` 全包退出 0；`node:sqlite` external；ESM 与 d.ts 正常。
- [x] **K02 类型检查**：`npm run typecheck` 退出 0。
- [x] **K03 Lint/格式**：`npm run lint`、`npm run format:check` 退出 0；Prettier 无改动。
- [x] **K04 双 Node**：Node 22.16.0 与 24.x 各完成 build/typecheck/测试（至少 Node 22 + act 内 Node 22；24 可用本地记录）。
- [x] **K05 构建可复现**：同一源码连续两次 build，dist 哈希一致；同 fingerprint 两次 snapshot 一致。
- [x] **K06 act CI**：`act -j verify --container-options "-m 4g"` 通过；记录耗时、Node、失败重试；不得只跑部分步骤。证据：act 输出摘要。
- [x] **K07 干净工作区**：验证后 `git status --porcelain` 仅允许负责人 `.actrc` 与显式基线/文档变更；`.nexus/tmp` 为空。
- [x] **K08 README**：命令、能力、限制、Phase 03 状态更新；不宣称未实现能力。
- [x] **K09 runtime-api / AGENTS**：无新增 Node 内置 API（除既有 node:sqlite/fs/path/child_process）；AGENTS 当前状态同步（不纳入 git 时注明）。
- [x] **K10 阶段报告**：按 19.3 九项写 `03-implementation-report.md`，回填所有任务证据，明确 pass / pass-with-limits / fail。
- [x] **K11 自审**：变更文件、API、递归检查、安全边界、测试结果、已知缺陷、兼容性影响；不得漏项。
- [x] **K12 交接**：列出对 Phase 04/05/06 的影响与遗留项；不把 Phase 04 能力写成已完成。

## 11. 失败处理

| 失败 | 处理 |
|---|---|
| exports 无法解析 | 记 warning + `opaque`/`unresolved`，不伪造 public；gate 视覆盖率判定 |
| entry 文件缺失 | warning + 该来源不计；不得静默当 internal |
| 签名无法归一化 | `ambiguous` + rationale；不得归 breaking/additive |
| 反向误报 | gate 失败，修复后重跑；不得降低判定 |
| 快照不确定 | 修复排序/字段；不得用时间戳或随机顺序“解决” |
| diff 分级与 golden 不符 | 修复规则或 golden 说明；不得改 golden 迎合实现 |
| 弃用替代多候选 | 保留候选 + ambiguous；不得强行选一个 |
| 写入中途失败 | ROLLBACK；旧 committed 保留；不得留下半套行 |
| act CI 失败 | 修复后重跑；不得以“本地通过”替代 |
| 回归失败 | 修复后才能关闭 Phase 03；不得跳过 |
