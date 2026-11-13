# Phase 07 任务清单（编码前冻结）

> 依据：`docs/phase-07/00-entry-and-decisions.md`、`docs/phase-07/02-plan-and-gates.md`、`docs/19-delivery-phases.md` 19.1/19.3、`docs/09-reuse-detection.md`、`docs/11-cli.md`、`docs/14-agent-integration.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md` 17.2、`docs/22-onboarding.md`、`docs/03-tech-stack-and-build.md` 3.4
> 规范版本：v1.24（冻结）
> 标记约定：`[ ]` 未完成；`[x]` 已完成并附证据；`[~]` 部分完成（必须写限制）；`[!]` 未完成/失败（必须写原因）。不得用 `[x]` 标注未验证项。
> **本清单在编码开始前冻结；完成回填时只改标记与证据，不删条目、不降门槛。**

## A. 入场、基线与文档

- [x] **A01 基线与授权**：确认 commit `792aa83`、工作区干净、Node 22.16.0 / npm 10.9.2；记录负责人 2026-11-13 允许进入 Phase 07。
- [x] **A02 冻结计划**：`00-entry-and-decisions.md` / `01-task-checklist.md` / `02-plan-and-gates.md` 三份齐备；编码前不改门槛。
- [x] **A03 规范对照**：逐条核对 19.1 阶段 07、9.1/9.3、11.1/11.3/11.5/11.6、14.1、15 章、16.3/16.4、17.2.1、22.2/22.3、3.4；冲突按 20.6 上报。
- [x] **A04 范围冻结**：确认 §2.2「不做」清单；`nex test` 保持 E24；不提前实现跨 root 合并或自动修复。
- [x] **A05 决策登记**：D1（Phase 06 限制接受）、D2（耗时放宽）、D3（动态内存）、D4（MCP 打包）、D5（首发验证）、D6（`nex test`/`doctor --mcp`）、D7（错误输出）。
- [x] **A06 文档索引**：更新 `docs/README.md` 阶段索引；README 状态、能力表、限制、接入顺序在实现完成后同步。

## B. 动态内存预算（D3，替代固定 900 MB）

- [x] **B01 可用内存探测**：新增 `process.availableMemory()` 探测，`process.constrainedMemory()>0` 时取较小值，回退 `os.freemem()`；单位 MB、向下取整；异常不得抛出。
- [x] **B02 动态预算**：`resources.maxMemoryMB` 改为可选；缺省 `max(128, floor(available×0.5))`；显式值仍按 `min(显式, floor(available×0.5))`；不得在可用内存充足时因 900 提前降级。
- [x] **B03 可解释字段**：`computeResourceBudget` 返回 `availableMemMB` / `dynamicBudgetMB` / `configuredMaxMemoryMB` / `effectiveBudgetMB` / `source`；manifest `resources` 与 `build`/`update` 输出记录。
- [x] **B04 降级阈值**：85% 阈值改用 effectiveBudget；阶梯顺序不变；降级仍写 manifest 并查询可见。
- [x] **B05 配置迁移**：`configJsonSchema` 反映可选字段；`nex init` 新配置不写死 900；旧配置显式 900 仍生效；`configHash` 变化 → 首次 full，登记为预期一次性重建。
- [x] **B06 单测**：可用内存充足（如 8 GB）→ 预算 > 900；低内存 → 预算下降；显式 900 → 900；`constrainedMemory` 生效；`availableMemory` 抛错 → 回退 freemem；预算永不超过可用内存一半。
- [x] **B07 文档**：README 限制、`docs/runtime-api.md` 登记 `process.availableMemory()` / `process.constrainedMemory()`、阶段报告记录与 21.2.4 的偏离（负责人批准）。

## C. `nex similar`（9.1）

- [x] **C01 Core 服务**：新增 `runSimilar`，复用 `prepareContext` / `selectScope` / `findSimilar`；按 root 查询，不合并索引。
- [x] **C02 目标解析**：支持 symbolId、name、nameChain；歧义 E04（列候选）、不存在 E05（区分未覆盖）；自然语言描述按 9.2 抽取，失败明确提示。
- [x] **C03 输出契约**：每条含 `candidate` / `score` / `scoreBreakdown` / `rulesVersion` / `isHeuristic: true` / `matchBasis` / `suggestion` / `location`；`score` 两位小数；`--explain` 展开分项。
- [x] **C04 无候选**：输出 `no-similar-found`，附 scope、roots、`rulesVersion`；不得只返回空数组。
- [x] **C05 CLI**：注册 `similar <query>`，`--top`（1–50）、`--scope public|all`、`--explain`；四格式同源；退出码 0/1/2 符合 11.5。
- [x] **C06 测试**：F07/F05 上命中与无候选各 ≥1；同一输入两次输出逐字节一致；`suggestion` 分档边界；不出现「等价/可删除」表述。

## D. `nex audit-duplicates`（9.3）

- [x] **D01 Core 服务**：全量符号读取（按 root），用 9.1.1 规则两两打分；不读网络、不用向量。
- [x] **D02 聚类**：分数 ≥ threshold 连边，连通分量；组内按 symbolId 排序、组间按最高分降序；确定性。
- [x] **D03 差异点**：每组给参数差异、返回类型差异、实现行数差异；不能只给相似度。
- [x] **D04 输出约束**：首行免责声明「相似不等于等价，需人工确认」；`relationClass: heuristic`；只报告、不修改代码。
- [x] **D05 CLI**：注册 `audit-duplicates`，`--threshold`（0–1，默认 0.8）、`--scope all|public`；<0.6 warning + 退出码 2；非法值 64。
- [x] **D06 测试**：构造重复/近似/不同三组；阈值变化影响分组；只读断言（`git status` 不变）。

## E. `nex context`（15 章 / 11.3）

- [x] **E01 Core**：基于 `buildTaskContext` 提供 CLI 入口；`--task`、`--target`/`--symbol`、`--depth`、`--context-lines`、`--cursor`。
- [x] **E02 分层**：摘要层默认、关系层按 depth、源码层仅在显式参数时；`budget` 字段写实际生效值。
- [x] **E03 游标**：`nextCursor` 可续读；`--cursor` 合法性与越界处理；非法游标 E00。
- [x] **E04 抽取失败**：无 target 且任务文本抽取不到符号时，明确输出原因与所需参数，不静默跳过。
- [x] **E05 测试**：F01/F05 上四格式字段一致；游标二次读取不丢条目不重复；无 ANSI。

## F. MCP 协议与基础设施

- [x] **F01 包结构**：`packages/mcp` 导出 `createMcpServer` / `startMcpServer`；`packages/cli` 的 `nex mcp` 调用；不复制查询逻辑。
- [x] **F02 依赖与构建**：mcp 依赖 `anemia-core`、`@modelcontextprotocol/server@2.4.0`、`zod@4.6.7`；cli 依赖 `anemia-mcp`；构建顺序 core → mcp → cli；tsup external 更新。
- [x] **F03 stdio 传输**：`serveStdio` + `McpServer` + 高层 `registerTool`；`nex mcp` 期间 stdout 只走 JSON-RPC，禁止普通输出。
- [x] **F04 双轨输出**：每个工具同时返回 `content`（紧凑文本）与 `structuredContent`（结构数据）；客户端不支持结构化时退回文本不崩溃。
- [x] **F05 schema**：输入输出都声明；`outputSchema` 可被 `tools/list` 读取；工具名与字段固定。
- [x] **F06 错误语义**：所有工具错误 `isError: true`，不 throw；E01–E24 语义与修复命令可达模型；同一场景 CLI/MCP code 一致。
- [x] **F07 format 兜底**：`format` 为 `lines|json` 默认 lines；缺省/pretty/markdown/xml/空串 → lines + `formatFallback: true` + `formatReason`；无 ANSI。
- [x] **F08 root 路由**：可选 `root`/`roots`；缺省 activeRoot；多 root 且未显式指定 → E16 + 候选；结果按 root 分组，不合并。
- [x] **F09 引导态**：无索引时 `status` 返回 `uninitialized` + 环境检查 / 下一步命令 / 预估耗时 / 接入物料命令；其他工具返回引导而非 E01；多 root 列候选。
- [x] **F10 测试**：内存传输单测（initialize、tools/list、8 次调用）；stdio 冒烟（隔离临时目录、≤30s、只读、清理）。

## G. MCP 8 工具

- [x] **G01 status**：14.1 必含字段齐全；`self` 含 serverVersion/packageName/binaryPath/projectRoot/nodeVersion；`capabilities.mcpFormats = ['lines','json']`；`lastIntegrityCheck`；`degraded`；永不报错。
- [x] **G02 search**：term/type/path/public/internal；返回 counts/coverage/staleness。
- [x] **G03 symbol**：identifier；签名、可见性、Surface、身份置信度、组件 Props/Emits/Slots；歧义/不存在错误。
- [x] **G04 references**：三分类计数；`includeHeuristic`/`noTemplate`；`certain` 口径不合并 heuristic。
- [x] **G05 deps**：file/module/style/call；reverse；`styleDependents`/`styleCoverage`；架构模块与违规。
- [x] **G06 impact**：target 或 symbol；风险、直接/间接、测试、盲区；E16 多 root 歧义。
- [x] **G07 context**：task/target/symbol/depth/cursor/contextLines；返回 budget + nextCursor；与 CLI 同源。
- [x] **G08 refresh**：`indexMutation: true`；changed/filesUpdated/buildFingerprint/staleness/degraded；`changed: 0, noop: true`；只写 `.nexus/`。
- [x] **G09 幂等**：同一指纹 + 参数，两次 `structuredContent` 逐字节一致；refresh 无变化零写入。
- [x] **G10 测试**：8 工具各 ≥1 成功用例 + 错误用例；字段断言；无 ANSI；不返回 pretty/markdown。

## H. refresh 护栏、watch、auto-bootstrap、read-only

- [x] **H01 全局重建拒绝**：tsconfig/路径别名/分析器/Schema/symbolId 算法/package.json 与锁文件变化 → 拒绝并提示「请在终端执行 nex update」。
- [x] **H02 规模上限**：默认 200 改动文件（含样式文件）→ 超限拒绝并建议 CLI。
- [x] **H03 锁**：与 CLI `update` 共用 `withRootLock`；持锁返回 E08，不并发写。
- [x] **H04 noop**：`buildFingerprint` 未变化 → `changed: 0, noop: true`，零写入。
- [x] **H05 只写 `.nexus/`**：执行后 `git status --porcelain` 为空；不新建目录。
- [x] **H06 watch**：`--watch` 递归监听 + 500ms 去抖；事件仅信号，内容哈希确认后进入 indexing；30s / 50 次查询周期复核；漏事件补一次增量；查询返回 indexing 进度不冒充 fresh。
- [x] **H07 auto-bootstrap**：`--auto-bootstrap` 后台异步构建；`status` 返回 indexing + 进度；其余工具返回「未就绪、预计还需 X 秒」而非错误码；默认关闭。
- [x] **H08 read-only**：`--read-only` 不监听、不注册 refresh、永不写索引；工具列表 7 个；不得偷偷 build。
- [x] **H09 测试**：四类拒绝、超限、E08、noop、watch 哈希确认、auto-bootstrap 状态、read-only 7 工具。

## I. `nex print <asset>`

- [x] **I01 mcp-config**：输出可合并 JSON；`--client dsh|claude|cursor` 三值；非法值 64；不写文件。
- [x] **I02 agents**：输出 14.2 七条纪律模板（含配置纪律、格式纪律）；可直接粘贴；不覆盖用户文件。
- [x] **I03 skill**：输出 Skill 示例流程（起步检查、查询选择、变更前审计、失败引导）；不复述错误码表。
- [x] **I04 兼容别名**：`mcp-config` → `print mcp-config`、`agents` → `print agents`、`skill` → `print skill`；帮助主列表不展示别名。
- [x] **I05 只打印**：三类命令执行后 `git status --porcelain` 为空；无 `--write-*`/`--install`/`--apply` 参数。
- [x] **I06 测试**：三物料内容断言、三 client、别名等价、非法 asset 64、无 ANSI（pretty 除外）。

## J. 错误输出规范（16.3/16.4）

- [x] **J01 机器层**：`code`/`category`/`severity`/`message`/`reason`/`file`/`suggestion`/`evidence`/`coverage`；JSON 错误可解析。
- [x] **J02 人读层**：固定四行；第一行结论；第二行可复制命令（优先 npx）；第三行前提检查；第四行常见坑；不以错误码开头。
- [x] **J03 通道**：错误默认 stdout；不写项目文件、不建 report/logs/debug 目录；`--output-file` 显式才落盘。
- [x] **J04 一致性**：同一失败场景 CLI 与 MCP 的 `code` 一致；E14 为最先出现的失败态；`status` 不返回 E01。
- [x] **J05 测试**：无索引、歧义、非法参数、损坏索引各 ≥1；四行结构与 code 断言；无绝对路径/时间戳。

## K. `doctor` 完整版 + `--repair` + `--mcp`

- [x] **K01 检查项补全**：环境/配置/工作区/每个 root 的 manifest/state/marker/surface/db/integrity/schema/indexes/committed/lock/ignore；孤儿 root 目录与 recovery events。
- [x] **K02 `--repair` 前置**：非 TTY 必须 `--yes`，否则 64；TTY 一次确认；`--repair` 只允许 `.nexus/`。
- [x] **K03 修复动作**：`recoverWorkspace({repair:true})`；manifest 从 DB 重写；surface/workspace 重建或标 stale；pending 定向删除；tmp 清空；孤儿 root 目录删除；非法状态按 12.4 恢复。
- [x] **K04 安全边界**：不修改源码、配置、`nexus.baseline.json`；不删除 committed DB；不跨 root 误删；修复结果逐项报告。
- [x] **K05 `--mcp`**：隔离临时目录 stdio 握手 + `tools/list`，输出协商版本/工具数/耗时；失败 fail；不写全局配置。
- [x] **K06 退出码**：pass 0 / warn 2 / fail 1；repair 失败 1；用法 64。
- [x] **K07 测试**：正常项目、pending 残留、manifest 滞后、孤儿目录、非法状态、缺 `--yes`、修复后 `status` 可读。

## L. 性能（16.2 / P7）

- [x] **L01 P7 采集**：MCP stdio 子进程，initialize + 一次 `status`/`search`，重复 ≥3，记录 p50/p95 与 16.2.3 全字段。
- [x] **L02 记录补齐**：P1–P8 各 ≥1 条完整记录；P3/P6 继续标 `target-miss`；P7 不再 `not-available`；不宣称 16.2 全部达标。
- [x] **L03 动态内存记录**：每次构建记录 available/dynamic/configured/effective；降级状态与预算可解释。
- [x] **L04 报告**：中位数+最大值；进程重启；环境版本；50k+ 未测声明。

## M. 3.4 发布验证

- [x] **M01 工具**：新增 `tools/release/verify.mjs`；`npm pack` 产物 + 系统临时目录；不复用仓库 `node_modules`。
- [x] **M02 12 项执行**：构建、单测、集成、类型检查、API 检查、exports、package.json exports、文件清单、README 命令抽检、Node 22.16.0、CLI 启动、MCP 启动。
- [x] **M03 第 5 项口径**：按 D5 自洽基线 + `first-release` 标注；不得冒充跨版本比较。
- [x] **M04 安装验证**：干净临时目录安装 tarball 后 `npx nex --version` / `npx anex --version` / `nex mcp` 握手 8 工具。
- [x] **M05 清理**：删除临时目录；不修改全局配置；仓库 `git status` 不新增文件。
- [x] **M06 记录**：`docs/release/0.0.0.md` 逐项记录命令、退出码、耗时、环境版本与结论。

## N. 测试、构建与回归

- [x] **N01 新增单测**：similar、duplicates、context、MCP 8 工具、format 兜底、refresh 护栏、watch、print、doctor repair、动态内存。
- [x] **N02 MCP 冒烟**：隔离临时目录、≤30s、只读、清理；默认不在普通 `npm test` 运行（标记 skip）或使用内存传输。
- [x] **N03 构建**：`npm run build` / `typecheck` / `lint` / `format:check` 退出 0。
- [x] **N04 全量测试**：`npm test` 全绿；记录通过数/文件数/耗时。
- [x] **N05 回归**：Phase 01–06 既有断言不回归；F01/F05/F07/F08/F10/F14/F15/F16/F17/F18 覆盖。
- [x] **N06 工作区**：无验证残留；`.nexus/tmp/` 为空；`git status` 只含本轮预期变更。
- [x] **N07 act**：环境允许时 `act -j verify` 通过 Node 22.16.0 / 24.x；不可用时如实记录。

## O. 文档、报告与自审

- [x] **O01 README**：能力表、MCP 接入、print 物料、限制（P3/P6/P7/串行/50k+）、动态内存语义。
- [x] **O02 docs/README**：phase-07 索引；`runtime-api` 新 API；必要时登记 `23-conflicts`。
- [x] **O03 实施报告**：19.3 九项、按 implemented/partial/heuristic/unresolved/unsupported/failed 标注、命令与退出码、性能数据、已知问题、未完成事项、依赖与架构变化、对后续影响、文档同步、gate 结论。
- [x] **O04 自审回执**：AGENTS.md §6.5 完整格式；边界与安全表含文件行号证据；递归检查；测试结果；已知缺陷；兼容性影响；最终结论。
- [x] **O05 任务回填**：本清单逐项回填 `[x]`/`[~]`/`[!]` 与证据；不删除失败项。
- [x] **O06 残留检查**：`git diff --check`；`git status --porcelain`；`.nexus/tmp/` 为空；不提交未授权内容。

## P. 19.1 阶段 07 通过条件自查

- [x] **P01** 8 个 MCP 工具幂等可复现（同指纹同参数逐字节一致）。
- [x] **P02** 未初始化场景 ≤3 个动作拿到首个索引结果（引导块含完整命令）。
- [x] **P03** 四格式字段一致（counts/coverage/truncated/nextCursor/staleness）。
- [x] **P04** MCP format 回落断言通过（缺省/非法均 lines、无 ANSI、不 isError）。
- [x] **P05** `npm pack` 独立安装验证 12 项完成；第 5 项按 D5 标注。
- [x] **P06** 动态内存预算生效且不改变 16.2/21.2 实测口径。
- [x] **P07** 自审回执与实施报告齐备；未把 partial 写成已完成。

## Q. 完成证据（2026-11-13 回填）

- **A/B**：`docs/phase-07/{00,01,02,03}.md`；`packages/core/src/config/schema.ts:36`；`packages/core/src/scheduler.ts:68,112`；`packages/core/test/scheduler.test.ts`（10 项）。
- **C/D/E**：`packages/core/src/audit/{similar-service,duplicates,context-service}.ts`；`packages/core/test/reuse.test.ts`（9 项）；`packages/cli/test/operations.test.ts`。
- **F/G/H**：`packages/mcp/src/{tools,runtime,refresh,format,server}.ts`；`packages/mcp/test/mcp.test.ts`（15 项）；`packages/core/src/store/lock.ts:135`；`packages/core/src/index/build.ts:1549`。
- **I**：`packages/cli/src/assets.ts`；`packages/cli/test/operations.test.ts`（print 5 项）。
- **J**：`packages/cli/src/render.ts:1181`；`packages/mcp/src/format.ts`；E05/E16/E01/E13/E08 断言。
- **K**：`packages/core/src/doctor-repair.ts:114`；`packages/core/test/repair.test.ts`（3 项）；`packages/cli/src/mcp-probe.ts`；`doctor --mcp` 实测 protocol=2025-06-18、tools=8。
- **L**：`.nexus/test-tmp/perf-{1k,5k,10k}.json`；P7 p50/p95 18.28/19.78、52.12/55.77、88.26/91.89ms；P3/P6 仍 `target-miss`。
- **M**：`tools/release/verify.mjs`；`docs/release/0.0.0.md`（12 项，第 5 项 first-release self-baseline）。
- **N**：`npm run build` / `typecheck` / `lint` / `format:check` 退出 0；`npm test` **154 passed (17 files)**；`act -j verify` 顺序执行 Node 22.16.0 / 24.x，各 154 passed、`Job succeeded` ×2。
- **O/P**：`README.md`、`docs/README.md`、`docs/runtime-api.md`、本目录四份文档、§9 自审回执；工作区仅本轮预期变更。
