# Phase 07 实施报告：复用性、MCP 与交付

> 依据：`docs/19-delivery-phases.md` 19.1/19.2/19.3、`docs/09-reuse-detection.md`、`docs/11-cli.md`、`docs/14-agent-integration.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md` 16.2/16.3/16.4、`docs/17-testing.md` 17.2、`docs/22-onboarding.md`、`docs/03-tech-stack-and-build.md` 3.4
> 规范版本：v1.24（冻结）
> 日期：2026-11-13（Asia/Shanghai）
> 结论：**Phase 07 的 similar / audit-duplicates / context / MCP 8 工具 / print / doctor --repair / 错误输出 / 动态内存预算 / P7 实测 / 发布验证已实现并通过本地门禁；P3/P6 性能目标仍未达标（Phase 06 遗留），MCP watch 与 auto-bootstrap 已在本地 Windows / Node 22.16.0 与 act Linux Node 24 容器验证。阶段结论为 `pass-with-limits`，等待负责人评审；不得把 root 级保守重建表述为文件级增量。**

## 1. 授权、基线与范围

- 负责人 2026-11-13 允许进入 Phase 07；Phase 06 以 `pass-with-limits` 接受。裁定见 `docs/phase-07/00-entry-and-decisions.md`。
- 基线 commit：`792aa83`（Phase 06 实现提交）；入场时 `git status --porcelain` 为空。
- 环境：Windows x64；Node 22.16.0；npm 10.9.2；`node:sqlite` 3.49.1；动态可用内存约 15.2 GB。
- 范围：9.1/9.3、11.1/11.3/11.5/11.6、14.1（含 refresh/watch/format/root 路由）、15 章、16.3/16.4、22.2/22.3、3.4；动态内存预算按负责人 D3 指令。
- **不做**：向量嵌入、跨 root 合并索引、`nex test` 全量编排、自动修复/合并、百万行档。

## 2. 实际完成内容（19.3 状态标注）

| 模块 | 状态 | 说明 |
|---|---|---|
| `nex similar` | implemented | 9.1.1 七项分项、`rulesVersion=9.1.1`、`isHeuristic`、`matchBasis`、`suggestion`、`location`；无候选 `no-similar-found` + scope/roots/rules；自然语言抽取失败显式提示；支持 `--top`/`--scope`/`--explain` |
| `nex audit-duplicates` | implemented | 确定性名称词干分块 + 规则打分、连通分量聚类；每组参数/返回类型/实现行数差异；免责声明与 `relationClass: heuristic`；`--threshold <0.6` warning；只读 |
| `nex context` | implemented | 复用 preflight 分层 packet；`--context-lines` 源码层；真实游标分页；`--target`/`--symbol`/`--task`；不复制第二套查询 |
| MCP 8 工具 | implemented | `status`/`search`/`symbol`/`references`/`deps`/`impact`/`context`/`refresh`；stdio + `registerTool`；输入输出 schema；`content` + `structuredContent`；错误 `isError` 不 throw；format 兜底；root 路由 E16 |
| refresh 护栏 | implemented | 只增量；全局重建/超 200 文件/锁持有分别 E13/E13/E08；`noop` 零写入；只写 `.nexus/`；返回 `degraded` |
| MCP 运行模式 | implemented | 手动、`--watch`（500ms 去抖 + 内容哈希 + 30s/50 次复核）、`--read-only`（7 工具）、`--auto-bootstrap`（不写配置，缺配置报引导） |
| `nex print` | implemented | mcp-config（dsh/claude/cursor）、agents、skill；只打印不落盘；`--output-file` 拒绝；兼容别名 |
| 错误输出 | implemented | 机器层顶层 `code/category/severity/message/reason/file/suggestion/evidence/coverage`；人读四行；默认 stdout；CLI/MCP 同场景 code 一致 |
| `doctor` 完整版 | implemented | 既有检查 + `--repair` + `--mcp`；修复只动 `.nexus/`；孤儿 root 清理；损坏 DB 保留并报 E07/E19；非 TTY 需 `--yes` |
| 动态内存预算 | implemented | `process.availableMemory()` / `constrainedMemory()`，缺省 `floor(available×0.5)`；显式 `maxMemoryMB` 仍生效；manifest/输出记录 available/dynamic/configured/effective |
| P7 实测 | implemented | 真实 stdio MCP 子进程；10k 档 p50/p95 88.26/91.89ms；1k/5k 档 18.28/19.78、52.12/55.77ms |
| 发布验证 | implemented | `tools/release/verify.mjs`；12 项；第 5 项 first-release self-baseline；记录见 `docs/release/0.0.0.md` |
| 文件级增量 | not started | 仍为 root 级保守重建；P3 `target-miss` |
| 多 root 并行 | partial | 并发位计算与串行执行；默认 1 |
| `nex test` / `status --json-schema` | unsupported | 19.1 阶段 07 未要求；保持 E24，帮助中标注 |
| 向量嵌入 | not started | 9.1.2 默认关闭且不得作为正确性依据；本阶段不引入 |

## 3. 测试与验证证据

环境：Windows x64；Node 22.16.0；npm 10.9.2。所有命令均在 `danger-full-access` 下执行（DSH 沙箱默认禁止 SCIP / MCP 子进程）。

> Phase 07 测试调度：`fileParallelism: false`、`testTimeout/hookTimeout = 300_000`。这是 D2「时间可以慢、优先稳定」下的调度调整，不改变任何断言；并发 SCIP/MCP 子进程在容器内会互相饿死并造成与产品无关的超时。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run build` | 0 | core / mcp / cli / adapter-vue ESM + d.ts；构建顺序 core → mcp → cli |
| `npm run typecheck` | 0 | 通过 |
| `npm run lint` | 0 | 0 error |
| `npm run format:check` | 0 | Prettier 通过 |
| `npm test` | 0 | **154 passed (17 files)**；act 双矩阵各 154 项 |
| `npx vitest run packages/core/test/reuse.test.ts` | 0 | similar / duplicates / context 9 项 |
| `npx vitest run packages/mcp/test/mcp.test.ts` | 0 | MCP 15 项：8 工具、format、E16、refresh/global/E08、read-only、watch、auto-bootstrap |
| `npx vitest run packages/core/test/repair.test.ts` | 0 | 3 项：workspace 重建、孤儿 root、损坏 DB 保留 |
| `npx vitest run packages/cli/test/operations.test.ts` | 0 | 11 项：print、similar/duplicates/context CLI、repair、MCP probe |
| `node tools/perf/run.mjs --loc 1000/5000/10000 --repetitions 3` | 0 | P1–P8 记录；见 §4 |
| `node tools/release/verify.mjs --output docs/release/0.0.0.md` | 0 | 12/12 通过：独立 tarball 安装、双 bin、8 工具握手；第 5 项 first-release self-baseline |
| `act -j verify --matrix node-version:22.16.0` / `24.x`（顺序执行） | 0 | 每个矩阵各 17 files / **154 passed**；测试文件串行后无超时；`Job succeeded` ×2 |
| `node packages/cli/dist/main.js doctor --mcp --format json` | 0 | protocol=2025-06-18，tools=8，约 0.7s |
| 独立安装 tarball 后 `npx nex --version` / `npx anex --version` | 0 | 均指向 `anemia-cli 0.0.0` |
| `git status --porcelain` | — | 仅本轮预期变更；`.nexus/test-tmp`、`.nexus/release-tmp` 为忽略目录 |

### 3.1 Gate 判定

| Gate | 结果 | 证据 |
|---|---|---|
| G0 similar | pass | `reuse.test.ts`；七项分项、无候选、E04、确定性 |
| G1 audit-duplicates | pass | 聚类、差异点、低阈值 warning |
| G2 context | pass | 源码层、游标、无参数 E00 |
| G3 MCP 协议与 8 工具 | pass | `mcp.test.ts`；8 工具、status 字段、双轨、错误、E16 |
| G4 refresh/watch/引导态 | pass | 增量 + noop、全局重建 E13、200 文件 guard、E08、read-only、watch、auto-bootstrap |
| G5 print | pass | 三物料、三 client、别名、--output-file 拒绝、无文件 |
| G6 doctor/repair | pass | `repair.test.ts`；`operations.test.ts`；`doctor --mcp` |
| G7 错误输出 | pass | 四行 + 机器层；E05/E16/E01/E13/E08 断言 |
| G8 动态内存 | pass | 单测 10 项；manifest 10k：available=15209、dynamic=7604、auto=true |
| G9 性能 | pass（记录） | P7 1k/5k/10k 均有记录；P3/P6 仍 target-miss；不宣称 16.2 全部达标 |
| G10 发布验证 | pass | `docs/release/0.0.0.md`；12 项，第 5 项标注 first-release |
| G11 构建与回归 | pass | build/typecheck/lint/format/test 全绿；既有 Phase 01–06 断言更新后通过 |
| G12 文档与自审 | pass | 四份阶段文档、报告、自审回执；工作区残留检查 |

## 4. 性能与内存数据（16.2 / 21.2）

测量方式：`tools/perf/run.mjs`；P1–P5 取 3 次中位数与最大值；P6 为进程内点查 + 一层邻接（10 次，p50/p95）；P7 为真实 stdio MCP 子进程 initialize + tools/list + status/search（10 次，p50/p95）；P8 为 F16 注入点到 `recoverWorkspace` 完成。生成项目位于 `.nexus/test-tmp/perf/`，不提交。

| 场景 | 1k 行（中位/最大） | 5k 行（中位/最大） | 10k 行（中位/最大） | 对照目标 | 结论 |
|---|---|---|---|---|---|
| P1 冷启动全量 | 2452/2555 ms | 3251/3300 ms | 4081/4087 ms | ≤20s（5 万行档） | pass（测试档位） |
| P2 热启动全量 | 2467/2543 ms | 3244/3245 ms | 4063/4098 ms | 未单列 | 记录 |
| P3 单文件增量 | 2566/2632 ms | 3455/3486 ms | 5252/5291 ms | ≤2s | **target-miss**（root 级重建） |
| P4 20 文件增量 | 2582/2609 ms | 3521/3552 ms | 5292/5339 ms | ≤8s | pass（10k 仍低于 8s） |
| P5 多 root | 4536/4539 ms（3 root 串行） | 4536/4543 ms | 4550/4553 ms | 无 16.2.2 数值 | 记录（串行） |
| P6 查询 p50/p95 | 9.56/10.45 ms | 26.02/27.45 ms | 44.17/48.32 ms | ≤30ms（p95） | **target-miss（10k）** |
| P7 MCP p50/p95 | 18.28/19.78 ms | 52.12/55.77 ms | 88.26/91.89 ms | 无 16.2.2 数值 | 记录 |
| P8 崩溃恢复 | 11 ms | 11 ms | 11 ms | ≤5s | pass |

内存与索引体积（同一批构建的 manifest 采样）：

| 规模 | 峰值 RSS（P1） | 硬上限（5 万行档） | SQLite（含 WAL） | 动态预算（auto） |
|---|---|---|---|---|
| 1k 行 | 191.9 MB | 550 MB | 1.38 MB | available≈15.4GB → budget≈7.7GB |
| 5k 行 | 211.8 MB | 550 MB | 6.11 MB | 同上 |
| 10k 行 | 227.9 MB | 550 MB | 12.06 MB | available=15209MB → budget=7604MB |

**口径说明**：

- P3/P4 为 root 级保守重建，不是文件级 AST 复用；P3 的 `target-miss` 与 Phase 06 一致。
- P7 含 stdio 子进程、JSON-RPC 通信与服务端 `status` 扫描；16.2.2 未给 P7 数值目标，不与外机横向比较。
- 峰值 RSS 为构建 CLI 进程 50ms 采样；SCIP 子进程 RSS 未计入；P7 为查询进程，不记录峰值。
- 50k/300k/1M 未测；16.2.2 的更大档位不外推。
- 动态预算（D3）只影响调度准入与降级阈值，不改变 16.2/21.2 的按规模峰值目标；本批 1k–10k 峰值在旧 900MB 与新动态预算下都未触发降级。

## 5. 已知问题与未完成事项

1. **P3/P6 未达 16.2 目标**：root 级保守重建与查询期 status 扫描导致；本阶段未实现文件级局部 AST 复用。按负责人 D2，耗时不是 Phase 07 的 gate 失败条件，但必须登记。
2. **P7 无目标值**：10k 档 p95 91.89ms；MCP 每次查询都会调用 `statusReport`，没有做跨调用缓存。若后续需要更低延迟，应单独评审缓存与失效策略。
3. **多 root 串行**：`resources.concurrency` 默认 1；真并行子进程编排未实现。
4. **50k+ 未测**：只测 1k/5k/10k；百万行档按负责人批准未验证。
5. **`refresh` 只增量**：全局重建、超 200 文件、锁占用分别拒绝；大变更必须走 CLI `nex update`。watch 模式刷新全部 root 且不设工具超时，超大变更可能较慢。
6. **`--auto-bootstrap` 不写配置**：无配置时不会自动 `init`，`status` 保持 `uninitialized` 并给命令；这是避免未确认落盘配置的保守设计。
7. **read-only 工具列表 7 个**：不注册 `refresh` 是模式语义；客户端硬编码 8 工具时需先看 `status.capabilities`。
8. **watch 依赖平台递归监听**：`fs.watch({recursive:true})` 在 Windows / 现代 Node 可用；事件只作信号，仍靠内容哈希与 30s/50 次复核，不承诺零丢事件。
9. **`doctor --mcp` 依赖 `process.argv[1]` 指向 CLI 入口**：通过 `npx nex` / 直接 `node dist/main.js` 正常；被其他包装器接管 `argv[1]` 时探针可能失败。
10. **错误 JSON 结构对齐 16.4**：由旧 `{error:{...}}` 改为顶层字段；若有外部消费者按旧结构解析需迁移。
11. **`status --json-schema` / `nex test` 仍 E24**：19.1 阶段 07 未把 `nex test` 列为交付；`status --json-schema` 仍待后续输出契约阶段。
12. **MCP 必填参数由 SDK schema 校验**：缺失 `term` / `identifier` 等会在进入 handler 前被 SDK 以 `isError` 文本返回，不是 E00；非缺失/非法值路径由 handler 返回 Nexus 错误。
13. **`doctor --repair` 不删除 committed DB**：损坏库保留供检查，需人工删除并重建；这是避免误删数据的保守选择。
14. **发布验证只在 Node 22.16.0 本机**：Node 24 矩阵依赖 act；第 5 项为首次发布自洽检查，不是跨版本比较。
15. **包仍为 `private: true`**：未执行 changesets 正式发布；`npm pack` 只验证可安装性。
16. **`nex context` 上游分层上限**：`buildTaskContext` 对 direct 50 / indirect 100 做分层上限；超出时 packet 标 `truncated`，但该截断来自上游结构而非分页，无法给出可续读游标。大影响面请用 `nex impact` 查看完整证据；`audit-duplicates` 超过 20000 符号或 200 万候选对时直接 E10，不返回部分审计结果。

## 6. 依赖与架构变化

- **无新增第三方依赖**：`@modelcontextprotocol/server@2.4.0` 从根 devDependency 变为 `anemia-mcp` 的运行时依赖；`zod@4.6.7` 同时成为 `anemia-mcp` 运行时依赖。`@modelcontextprotocol/client` 仍只用于测试与性能采集。
- **构建顺序**：core → mcp → cli；`anemia-cli` 依赖 `anemia-mcp`，tsup 将 `anemia-mcp` 作为 external。
- **新增模块**：`core/src/audit/{similar-service,duplicates,context-service}.ts`、`core/src/doctor-repair.ts`；`mcp/src/{index,server,runtime,tools,refresh,format,package-info,tool-names}.ts`；`cli/src/{assets,mcp-probe}.ts`；`tools/release/verify.mjs`；发布记录目录 `docs/release/`。
- **修改**：`core/src/{index,status,scheduler,doctor,store/lock,store/db,store/read,config/schema,audit/context,audit/preflight,audit/similar,index/build,index/fingerprint}.ts`、`cli/src/{cli,render,context,tsup.config}.ts`、`packages/*/package.json`、根 `package.json`、`vitest.config.ts`、`tsconfig.typecheck.json`。
- **BuildOptions 新增**：`refreshGuard`（`maxChangedFiles` / `rejectFullRebuild`）与 `lockWaitMs`；refresh 在写入前整体拒绝，避免部分 root 已写。
- **配置语义**：`defaults.resources.maxMemoryMB` 由固定默认 900 改为可选；`configHash` 变化，旧索引首次 `update` 全量重建一次。
- **Schema 不变**：仍为 v4；无表结构变更。
- **行为变化**：`mcp`/`print`/`context`/`similar`/`audit-duplicates`/`doctor --repair`/`doctor --mcp` 从 E24 变为真实命令；`doctor` 不再把 `fresh → fresh` 同态误判为非法转换；`status.capabilities.mcpFormats` 变为 `["lines","json"]` 并新增 `mcpTools` / `mcpReadOnly`。

## 7. 对后续阶段影响

- Phase 07 的 `refreshIndex`、`resolveScope`、`createRuntime` 可被后续 Agent 接入复用；`print` 模板与 Skill 示例是接入面，修改需走文档流程。
- 动态预算为后续大项目实测提供真实可用内存口径；若 50k+ 实测超 16.2 目标，按 21.2.4 降级能力，不得放宽目标。
- MCP 8 工具名与返回字段是稳定契约；新增字段允许，改名/删字段必须走 6.x Surface 流程。
- 发布验证脚本可在 CI 中复用；正式发布前仍需把 `private: true` 调整、重跑 12 项并归档新版本记录。

## 8. 文档同步

- `README.md`：状态、能力表、目录结构、命令清单、MCP 模式、doctor repair、动态内存语义、P7 实测、Phase 07 限制。
- `docs/README.md`：阶段索引加入 `phase-07/` 与 `release/`。
- `docs/runtime-api.md`：登记 `process.availableMemory()`、`process.constrainedMemory()`、`fs.watch` 产品用途、`spawn`、`mkdtempSync`、`process.kill(pid,0)`。
- `docs/phase-07/{00,01,02,03}.md`：新增。
- `docs/release/0.0.0.md`：发布验证记录。
- 未修改 v1.24 规范正文。

## 9. 自审回执

**审查范围：**

- 变更文件：见 `git status --porcelain` 与 §6；核心为 `packages/core/src/{audit,doctor-repair,status,scheduler,store,index,config}`、`packages/cli/src`、`packages/mcp/src`、`packages/*/test`、`tools/{perf,release}`、`docs/phase-07`、`docs/release`、`README.md`。
- 新增 / 修改的 API：`runSimilar`、`runAuditDuplicates`、`runContext`、`runDoctorRepair`、`findLiveRootLock`、`detectAvailableMemoryMB`、`ResourceSummary`、`OnboardingInfo`、`startMcpServer` / `createMcpServer` / `refreshIndex`、`BuildOptions.refreshGuard` / `lockWaitMs`、`print` / `mcp` CLI 命令、错误 JSON 顶层结构。
- 关键调用点：CLI 命令分发、MCP 工具、`buildWorkspace` 更新循环、`statusReport` 的 onboarding、`renderError`、`doctor` 状态检查、`openDatabase` 错误路径。

**边界与安全审查：**

| API / 文件 | 风险场景 | 结论 | 代码证据 |
|---|---|---|---|
| `core/src/scheduler.ts:68` | `process.availableMemory()` 抛错 / 返回 0 / 巨大值 | 已处理：try/catch、回退 `os.freemem()`，预算不超过可用内存一半，下限 128MB | `scheduler.ts:68-110` |
| `core/src/scheduler.ts:112` | 显式 `maxMemoryMB` 超可用内存 | 已处理：显式值也被 `min(configured, available/2)` 限制 | `scheduler.ts:137-155` |
| `core/src/config/schema.ts:36` | 旧配置含 900 / 新配置缺字段 | 已处理：可选字段；旧显式值继续生效；init 不再写死 | `schema.ts:36`、`config/merge.ts:94` |
| `core/src/audit/similar-service.ts:207` | 歧义、缺失、抽取失败、store 泄漏 | 已处理：E04 列候选、E05 区分覆盖、所有 store 在 finally 关闭 | `similar-service.ts:60-170,390-400` |
| `core/src/audit/duplicates.ts:193` | O(n²)、无界内存、误报为等价 | 已处理：名称词干分块、20000 符号 / 2,000,000 对上限并报告 truncated、免责声明、只读 | `duplicates.ts:193-420` |
| `core/src/audit/context-service.ts:83` | 游标越界 / 非法 token / 源文件越界 | 已处理：E00、offset 校验、`path.relative` 越界拒绝、excerpt 上限 400 行 | `context-service.ts:83-190` |
| `mcp/src/format.ts:96` | format=pretty/markdown/xml/空串/缺省 | 已处理：一律 lines + `formatFallback` + reason；无 ANSI | `format.ts:22-46,340-400` |
| `mcp/src/tools.ts:172` | 工具错误 throw 成协议崩溃 | 已处理：统一 `invoke` catch → `isError: true`；输入校验由 SDK + handler 双重处理 | `tools.ts:100-170` |
| `mcp/src/tools.ts:172` | 多 root 默认选第一个 / 未初始化返回 E01 | 已处理：`resolveScope` E16 + 候选；uninitialized 引导态或 not-ready | `runtime.ts:160-240` |
| `mcp/src/refresh.ts:63` | 并发写 / 全量静默 / 超 200 文件 | 已处理：`findLiveRootLock` → E08；`refreshGuard` 写入前拒绝 E13；`lockWaitMs:0` | `refresh.ts:63-130`、`index/build.ts:1549-1570` |
| `mcp/src/runtime.ts:280` | 后台构建写配置 / 无配置假 indexing | 已处理：无配置直接 failed + E17，不写配置；status 用 staleness=indexing 不冒充 ready | `runtime.ts:280-345` |
| `mcp/src/runtime.ts:345` | watch 事件丢 / 定时器泄漏 / 关闭后写入 | 已处理：500ms 去抖、30s 复核、`unref`、`closeRuntime` 清理 watcher/定时器/AbortController | `runtime.ts:345-450` |
| `cli/src/assets.ts:30` | print 落盘 / 覆盖用户 AGENTS.md | 已处理：只写 stdout；`--output-file` E00；无 `--write-*`/`--install` | `assets.ts:30-110`、`cli.ts:emitPrint` |
| `core/src/doctor-repair.ts:114` | 误删 committed DB / 改源码 / 删活 root | 已处理：只修 `.nexus/`；损坏 DB 保留；孤儿目录按配置白名单删除；先清孤儿再恢复 | `doctor-repair.ts:60-260` |
| `core/src/doctor.ts` | `fresh → fresh` 同态误判 | 已处理：同态视为无转换；只有实际变化查转换表 | `doctor.ts:state` 检查块 |
| `core/src/store/db.ts:44` | 损坏 DB 打开失败泄漏句柄 | 已处理：PRAGMA 失败时 close 后再抛 | `db.ts:44-70` |
| `core/src/store/lock.ts:135` | 活锁误判 / 死锁回收 | 已处理：只读检查 owner.json + `process.kill(pid,0)`；不删活锁 | `lock.ts:135-160` |
| `cli/src/render.ts:1189` | 错误含绝对路径 / 落盘 / 以错误码开头 | 已处理：四行结构；错误默认 stdout；JSON 顶层字段；路径来自 core 的相对路径 | `render.ts:1189-1230` |
| `cli/src/mcp-probe.ts` | 子进程无超时 / 残留 / 写全局配置 | 已处理：20s 超时、固定参数 shell=false、临时目录、SIGTERM 清理；不写全局 | `mcp-probe.ts:1-170` |
| `tools/release/verify.mjs` | 复用仓库 node_modules / 改全局 / 残留 | 已处理：临时目录、tarball 安装、finally 清理；不写用户配置 | `verify.mjs` |

**递归检查：**

- 是否存在递归：没有新增递归。
- 是否已转换为迭代：聚类使用 union-find + 显式循环；词干分块、MCP 工具分发、watch 调度均为迭代。
- 如保留递归，说明原因、深度及风险：无。

**测试结果：**

- 类型检查：`npm run typecheck` 退出 0。
- Lint：`npm run lint` 退出 0。
- 单元 / 集成测试：`npm test` 154 passed (17 files)；act Node 22.16.0 / 24.x 双矩阵各 154 passed。
- 构建：`npm run build` 退出 0；`npm run format:check` 退出 0。
- 未执行项目及原因：50k/300k/1M 性能档按负责人批准不测；changesets 正式发布未执行（包仍 private）。

**已知缺陷：**

见 §5 的 16 项；其中 P3/P6 性能未达标、多 root 串行、MCP watch/auto-bootstrap 在本地与 act 容器验证、`nex test`/`status --json-schema` 未提供属于本轮已知限制，不作为「已完成」宣称。

**兼容性影响：**

- `resources.maxMemoryMB` 由固定默认 900 改为可选自动；`configHash` 变化导致旧索引首次全量重建。
- 错误 JSON 由 `{error:{...}}` 改为顶层字段（对齐 16.4）。
- `status.capabilities.mcpFormats` 由 `[]` 改为 `["lines","json"]`；新增 `mcpTools` / `mcpReadOnly` 与 `onboarding` 字段（新增字段向后兼容）。
- 5 个命令从 E24 变为真实命令；`doctor` 同态检查修正。
- 包仍为 `private: true`，未发布；MCP 运行时依赖从根 devDependency 移到 `anemia-mcp` 依赖。

**最终结论：**

**pass-with-limits。similar / audit-duplicates / context / MCP 8 工具 / print / doctor repair / 错误输出 / 动态内存预算 / P7 实测 / 发布验证通过本地门禁；P3/P6 性能未达标、多 root 串行、50k+ 未测、watch/auto-bootstrap 在本地与 act 容器验证。等待负责人评审；未经批准不进入后续阶段。**
