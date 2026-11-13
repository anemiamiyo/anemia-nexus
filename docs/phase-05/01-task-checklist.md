# Phase 05 任务清单（编码前冻结）

> 依据：`docs/phase-05/00-entry-and-decisions.md`、`docs/19-delivery-phases.md` 19.1/19.3、`docs/05-data-model.md` 5.1/5.5/5.6/5.7/5.9、`docs/08-relations.md` 8.1/8.2/8.3、`docs/09-reuse-detection.md` 9.1/9.2、`docs/10-impact-analysis.md`、`docs/11-cli.md`、`docs/13-audit-and-ci.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md` 17.2、`docs/18-security.md` 18.4
> 规范版本：v1.24（冻结）
> 标记约定：`[ ]` 未完成；`[x]` 已完成并附证据；`[~]` 部分完成（必须写限制）；`[!]` 未完成/失败（必须写原因）。不得用 `[x]` 标注未验证项。

## A. 入场、基线与文档

- [x] **A01 基线与授权**：确认 commit `92d805f`、工作区干净、Node 22.16.0 / npm 10.9.2；记录负责人 2026-11-13 批准进入 Phase 05。
- [x] **A02 冻结计划**：`00-entry-and-decisions.md` / `01-task-checklist.md` / `02-plan-and-gates.md` 三份齐备；编码前不改门槛。
- [x] **A03 规范对照**：逐条核对 19.1 阶段 05、10.1/10.2/10.3、13.1–13.4、5.9、8.1–8.3、9.1–9.2、11.5、16.3、17.2 #13、18.4；冲突按 20.6 上报。
- [x] **A04 范围冻结**：确认 §2.2 的“不做”清单；不提前实现 context/similar CLI、update、MCP、自动修复。
- [x] **A05 遗留台账**：把 Phase 04 §5/§6 的 Vue 调用图、增量、真实样本等登记到 §6；指定目标阶段与验收口径。
- [x] **A06 文档索引**：更新 `docs/README.md` 阶段索引；README 状态改为 Phase 05 进行中（实现完成后）。

## B. Schema v4 与 `tests` 表

- [x] **B01 Schema 版本**：`SCHEMA_VERSION = 4`；注释说明新增 `tests` 表与旧 v3 需重建。
- [x] **B02 `tests` 表**：`test_id`、`build_id`、`test_file`、`target_symbol_id`、`target_file`、`test_type`、`relation_class`、`confidence`、`analysis_engine`、`line`、`evidence_json`。
- [x] **B03 必需索引**：`(build_id, target_symbol_id)`、`(build_id, test_file)`、`(build_id, target_file)`；加入 `REQUIRED_INDEXES`。
- [x] **B04 派生 SQL**：`BuildWriter` 在 COMMIT 前从 references/calls 插入测试关系；测试文件判定固定（`.test.` / `.spec.` / `.e2e.` / `__tests__/`）。
- [x] **B05 去重与闭合**：`(build_id, test_file, target_symbol_id, line)` 去重；目标符号存在；非测试目标文件。
- [x] **B06 清理与恢复**：`recoverPending` / `pruneBuilds` 删除 `tests` 行；`doctor` 检查表与索引。
- [x] **B07 旧库错误**：v3 库在 `ensureSchema` 返回 E06；`doctor --schema` 给出逐 root 重建命令。
- [x] **B08 读取 API**：`readTestsForSymbol` / `readTestsForFile` / `countTests` / `readAllTests`（有界）。
- [~] **B09 覆盖计数**：manifest / status 增加 `testRelations` 计数（tests / testFiles / unresolvedTestFiles）。
- [x] **B10 单测**：v3→E06；tests 行数 >0；重复引用去重；失败 ROLLBACK 后 tests 0 行、旧 committed 保留。

## C. 5.9 查询期根路由

- [x] **C01 路由核心**：`resolveQueryScope` 返回 `{scope, roots, activeRoot, nested, candidates}`；最长前缀匹配。
- [x] **C02 E16/E00**：无归属 + 无 scope → E16 + 候选；`--root`/`--roots` 同现 → E00；未知 root → E16。
- [x] **C03 嵌套 root**：最长路径取胜并 warning 名称与路径；不得静默。
- [x] **C04 分组输出**：`QueryEnvelope.byRoot[]`（rootId / staleness / buildFingerprint / counts / coverage / items）；组内排序、组间不排序不去重。
- [x] **C05 同等名**：多 root 同名符号各自成条；顶层 `globalAmbiguous` + 候选清单。
- [x] **C06 完整性**：`completeness` + `staleRoots` + `failedRoots`；全部不可用 → E19。
- [x] **C07 覆盖命令**：`symbol` / `references` / `search` / `deps` 支持 `roots` / `all`；移除 Phase 01/04 的 E24 单根限制。
- [x] **C08 渲染**：多 root `lines` 加 `[rootId]` 前缀、pretty 分小节、json 每条带 rootId；单 root 输出保持原样。
- [x] **C09 单测/集成**：F14 的 root/roots/all、cwd 归属、E16、globalAmbiguous、组间不排序；`--root` 回归。

## D. 影响分析核心

- [x] **D01 目标解析**：文件 / 符号 / 样式三态；非法/不存在 → E00/E05/E04；样式扩展名优先。
- [x] **D02 直接依赖者**：反向 dependencies、references、calls；样式只取 `style-*` 反向边。
- [x] **D03 间接 BFS**：显式队列、`--depth` 默认 3/最大 10、visited 去重、按 root 隔离；禁止跨 root。
- [x] **D04 受影响面**：Surface（public 条目）、components、types、tests、docs、architecture violations、blindSpots。
- [x] **D05 风险等级**：Low/Medium/High/Critical 按 §3.2；每条给 rule/detail/file/line/relationClass/confidence；样式最高 High。
- [x] **D06 计数**：certain/heuristic/dynamicUnresolved/partial；`impactFanout` 唯一符号数；不得用文件数冒充。
- [x] **D07 Surface diffLevel**：当前 vs baseline/`--base`；无 baseline → `not-available` + note；不伪造计划差分。
- [x] **D08 文档关联**：只读、有界（≤2000 文件 / 1 MB）；`path:line`；无匹配给检索范围。
- [x] **D09 建议命令**：`commands.allow` 的 test id → `nex verify --only`；否则 `package.json` scripts.test → `npm test`（只建议）。
- [x] **D10 定向盲区**：不可解析消费方、被忽略消费方、测试关系缺口；四件套齐全；符号数无法计算时 null + 估算方式。
- [x] **D11 输出契约**：四格式同源；counts/coverage/truncated/nextCursor/staleness/buildFingerprint 齐全；稳定排序；无绝对路径/时间戳/ANSI。
- [x] **D12 单测**：F08 链式引用、反向调用、模板引用、样式目标、深度截断、同名多候选、无结果三种区分。

## E. Preflight

- [x] **E01 输入**：`<target>` 或 `--task`；都缺失 → E00；任务文本抽取失败 → `extraction.failed` + warning/退出 2。
- [x] **E02 已存在 API**：Surface 条目按目标文件/符号/任务名匹配；给 `evidenceSource`。
- [x] **E03 相似能力**：9.1.1 七项权重、`scoreBreakdown`、`rulesVersion`、`isHeuristic`、`matchBasis`、`suggestion`、`location`；无候选 `no-similar-found` + 检索范围。
- [x] **E04 依赖与架构**：直接/间接依赖摘要、模块归属、架构违规；无配置不推断。
- [x] **E05 影响复用**：调用 `analyzeImpact`，不另写一套；输出 risk 与盲区。
- [x] **E06 文档与测试**：相关文档、相关测试、建议阅读/验证命令。
- [x] **E07 任务上下文**：core `buildTaskContext`（分层、counts、coverage、truncated、budget）；与未来 `nex context` 同实现。
- [x] **E08 输出与退出码**：四格式；0 无告警 / 2 有 heuristic 或抽取失败 / 64 用法。
- [~] **E09 单测**：F08 目标与仅任务文本两路；相似候选分档；无候选；抽取失败；E16。

## F. Postflight

- [x] **F01 Git Diff**：固定参数、无 shell、`--no-ext-diff`、`--no-textconv`；base 默认 HEAD；无 git → E00。
- [x] **F02 文件分类**：A/M/D/R；重命名旧删新增；路径 POSIX 归一化。
- [x] **F03 修改符号**：`-U0` 新侧行区间 ∩ 声明区间；输出 symbolId；删行/无符号/无法归属 → `unidentified[]`。
- [x] **F04 Surface 差分**：`diffCurrentSurface`；breaking/additive/internal/ambiguous；带 evidenceSource/exportKind/rationale；stale 时低 confidence。
- [x] **F05 依赖变化**：`git show` 旧内容 vs 磁盘新内容，TS 语法级 specifier 集合差分；added/removed；删除文件全 removed。
- [x] **F06 架构规则**：违规按修改行区间分 `introduced` / `pre-existing`；不得混列。
- [x] **F07 测试覆盖**：修改符号的 tests 关系；缺失 → `test-coverage-missing` warning。
- [x] **F08 样式删除/重命名**：有静态消费方 → warning + 默认退出 2；`--fail-on warning` → 1；无消费者不报。
- [~] **F09 可授权检查**：复用 verify（explicit=false）；未授权跳过标 `skipped-unauthorized`；不报 E12。
- [x] **F10 confidence / blockable**：high/medium/low；heuristic finding `blockable:false`，不得自动阻断。
- [x] **F11 报告**：13.3 字段齐全；findings 有 id/severity/code/file/line/symbolId/evidence/suggestion/origin；按 sources 分列。
- [x] **F12 退出码**：默认 fail-on breaking；0/1/2/64/70；`none` 不因 findings 失败。
- [x] **F13 无残留**：执行后 `git status --porcelain` 与执行前一致（仅 `.nexus/` 允许由 build 产生）；不自动落盘。
- [x] **F14 单测**：F08 git 变更场景；breaking/additive/ambiguous；heuristic 不阻断；样式 warning；无 git E00；stale 索引。

## G. Verify 与命令授权

- [x] **G01 配置校验**：`commands.allow` strict；危险命令/通配符/管道/重定向/shell 拼接 → E17。
- [x] **G02 信任文件**：`.nexus/trust.json` 格式与签名；字段变化失效；原子写入。
- [x] **G03 授权流程**：TTY 逐条确认；非 TTY 必须 `--yes`；显式 verify 未授权 → E12；postflight 内部 → skipped。
- [x] **G04 执行器**：`execFile` 无 shell；cwd 根内；timeout 上限；1 MB 截断；环境最小化；Windows `.cmd` 安全启动器。
- [x] **G05 回显与结果**：命令/args/cwd/timeout/purpose/authorization；exitCode/stdout/stderr/duration/truncated。
- [x] **G06 `--only` / `--dry-run`**：按 id 过滤；dry-run 只列授权状态不执行。
- [~] **G07 测试**：授权前跳过、`--yes` 后执行、超时、截断、危险命令、非 TTY E12、`--only`。
- [x] **G08 安全负向**：命令注入、`..` cwd、越界 cwd、`rm -rf`、`git reset` 全部拒绝；无新文件。

## H. CLI、渲染与退出码

- [x] **H01 移除 stub**：`impact` / `preflight` / `postflight` / `verify` 从 stub 列表移除并注册真实命令。
- [x] **H02 参数**：impact `--symbol` / `--depth`；preflight `--task` / `--base` / `--fail-on` / `--report`；postflight `--base` / `--fail-on` / `--report`；verify `--only` / `--dry-run`；全局 `--root` / `--roots`。
- [x] **H03 `--report`**：`md|json` 映射 markdown/json；与 `--format` 冲突时以 `--report` 为准并 warning；非法值 64。
- [x] **H04 四格式渲染**：impact / preflight / postflight 的 lines/json/markdown/pretty 同源；完整性字段齐全。
- [x] **H05 退出码**：0/1/2/64/70；E12/E16/E19/E23 归因；heuristic 不阻断。
- [x] **H06 `--output-file`**：显式落盘；默认不写；路径父目录不存在时报错不创建目录。
- [x] **H07 CLI 测试**：四格式、`--explain`、`--symbol`、`--depth`、`--task`、`--base`、`--fail-on`、`--report`、`--only`、`--dry-run`、`--root/--roots`。

## I. 夹具与 oracle

- [~] **I01 F08 新建**：10 文件 / ≤400 行；四层链 + 反向调用 + 模板引用 + 样式 + 测试；`expected/` golden（未创建，断言在 `audit.test.ts` 内）。
- [~] **I02 F12 新建**：5 文件 / ≤120 行；dirty 文件、staleness、E16 用例；`expected/`（未创建，断言在 `audit.test.ts` / 路由测试内）。
- [x] **I03 F14 扩展**：5.9 的 root/roots/all、cwd 归属、globalAmbiguous；行数仍 ≤250。
- [x] **I04 F08 变更场景**：临时 git 仓库中构造 breaking/additive/ambiguous、删除样式、无符号文件；postflight golden。
- [~] **I05 Oracle**：impact 消费方由人工/tsserver 核对；postflight Surface 差分由 baseline 人工核对；不由工具自证。
- [x] **I06 行数预算**：F01–F18 合计 ≤12000；单夹具 ≤2000 行/20 文件；新增后统计。
- [!] **I07 真实样本（有界）**：本仓库自索引跑 impact（有界）；记录文件数/符号数/风险；不冒充大规模。

## J. 回归、构建与 act

- [x] **J01 构建**：`npm run build`、`npm run typecheck`、`npm run lint`、`npm run format:check` 退出 0；两次 dist 哈希一致。
- [x] **J02 单测**：`npm test` 全绿；记录通过数/文件数/耗时。
- [x] **J03 回归**：F01/F05/F10/F15/F17 既有断言不回归；Phase 03/04 Surface 与 deps 断言不回归。
- [x] **J04 act**：`act -j verify --container-options "-m 4g" --action-offline-mode` 通过；Node 22.16.0 与 24.22.3 双矩阵。
- [x] **J05 稳定性**：同 fingerprint 两次 build + 两次 impact/postflight 的 items 逐字节一致。
- [x] **J06 写入失败**：tests 表失败注入 → ROLLBACK；旧 committed 保留。
- [~] **J07 性能记录**：impact/postflight 耗时、查询 p50/p95、peakRssMB；只代表夹具/有界样本。
- [x] **J08 工作区**：`git status --porcelain` 无验证残留（`.actrc` 除外）；`.nexus/tmp/` 为空。

## K. 文档与报告

- [x] **K01 README**：状态、能力表、impact/preflight/postflight/verify 命令、5.9 路由、限制、阶段结果；不写“完整调用图/零漏报（无限定）”。
- [x] **K02 docs/README**：阶段索引加入 Phase 05。
- [x] **K03 runtime-api**：新增 `node:child_process` / `node:readline` 等内置使用登记；无新增第三方依赖则注明。
- [~] **K04 AGENTS**：`.dsh/AGENTS.md` 当前状态同步（不入库）。
- [x] **K05 实施报告**：`03-implementation-report.md` 按 19.3 九项；G0–G12 证据；§5 已知问题。
- [x] **K06 自审回执**：实际磁盘代码 + `git diff`；边界/安全/异步/递归/兼容性；不得凭记忆。
- [x] **K07 规范未改**：不修改 v1.24 正文；冲突先报告。
- [x] **K08 交接**：给 Phase 06 的接口（staleness、tests、impact 数据、verify 授权）明确列出。

## L. 验收证据映射

- [x] **L01 19.1 #1 漏报率**：F08 golden 对比表（certain 消费方 N/N）。
- [x] **L02 19.1 #2 证据与盲区**：impact/preflight/postflight 各 1 份真实输出摘要。
- [x] **L03 19.1 #3 E16**：命令与错误码/候选清单。
- [x] **L04 17.2 #13 多 root 路由**：F14 断言清单。
- [x] **L05 13.3 无落盘**：`git status --porcelain` 前后对比。
- [~] **L06 13.2 #11 heuristic 不阻断**：`--fail-on warning` 下退出码仍 2。

## 证据索引

- G0/G1/G11/G12：`03-implementation-report.md` §3、§3.1；schema v4、94 项测试、act 双矩阵。
- G2/G3/G4：`03-implementation-report.md` §3 的 F08 三组 impact 断言；F08 10 文件 / 109 行。
- G5/G6：`03-implementation-report.md` §3 的 preflight / postflight 行；`packages/core/test/audit.test.ts`。
- G7/G8：`03-implementation-report.md` §3 的 verify / 路由行；E12/E17/E16=64。
- G9/G10：`packages/core/test/audit.test.ts` 与 `packages/cli/test/cli.test.ts` 的多 root 断言；lines `[rootId]` 前缀。
- 部分完成项：context/similar 仅 core（Phase 07）；verify 超时/截断未单独计时；F08 `expected/` 未固化 golden（断言在测试内）；真实样本未跑 impact；K04 `.dsh/AGENTS.md` 未同步（不入库）；heuristic 不阻断用 test-coverage warning 近似验证，未构造 heuristic 影响面。
