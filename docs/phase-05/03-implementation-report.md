# Phase 05 实施报告：影响分析与审计

> 依据：`docs/19-delivery-phases.md` 19.1/19.3、`docs/05-data-model.md` 5.1/5.6/5.9、`docs/08-relations.md` 8.1–8.3、`docs/09-reuse-detection.md` 9.1–9.2、`docs/10-impact-analysis.md`、`docs/11-cli.md`、`docs/13-audit-and-ci.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md`、`docs/18-security.md` 18.4
> 规范版本：v1.24（冻结）
> 日期：2026-11-13（Asia/Shanghai）
> 结论：**Phase 05 的 G0–G12 已执行并通过；本地 94 项与 act 的 Node 22.16.0 / 24.22.2 双矩阵均全绿。Phase 05 记为 `pass`，等待负责人评审。** 已知限制见 §5，均以 `partial` / 限制显式登记，不冒充完成。

## 1. 授权、基线与范围

- 负责人 2026-11-13 批准进入 Phase 05；Phase 04 以 `pass` 关闭。裁定见 `docs/phase-04/03-implementation-report.md`。
- 基线 commit：`92d805f`；入场时工作区干净。
- 环境：Windows x64；Node 22.16.0；npm 10.9.2；`node:sqlite` 3.49.1；act 容器 Node 22.16.0 / 24.22.2。
- Schema：`SCHEMA_VERSION = 4`；新增 `tests` 表与三索引；v3 索引必须重建，不提供迁移。
- 实现范围：impact、preflight、postflight、verify、CI 退出码、5.9 根路由、test relations、F08/F12 夹具、F14 路由断言、文档与报告。

## 2. 实际完成内容（19.3 状态标注）

| 模块 | 状态 | 说明 |
|---|---|---|
| Schema v4 / `tests` 表 | implemented | `test_id` / `build_id` / `test_file` / `target_symbol_id` / `target_file` / `test_type` / `relation_class` / `confidence` / `analysis_engine` / `line` / `evidence_json`；三索引进 `REQUIRED_INDEXES`；v3 库 E06 |
| tests 派生 | implemented | `BuildWriter.seal()` 在 COMMIT 前用两条 `INSERT ... SELECT` 从 references/calls 派生；单事务、去重（`insert or ignore`）、失败 ROLLBACK；SQL 内派生，不二次物化 references |
| impact | implemented | 文件/符号/样式三目标；直接/间接（BFS、depth≤10、截断游标）；Surface/components/types/tests/docs/architecture/blindSpots；风险 Low/Medium/High/Critical 与逐条证据；`impactFanout`；四格式 |
| preflight | implemented | 现有 API、9.1.1 相似规则、名称抽取、源码位置、依赖、架构、impact 复用、文档/测试、core context builder；无向量/无模型 |
| postflight | implemented | Git Diff（A/M/D/R）、修改符号与 `unidentified`、Surface 差分、依赖变化、架构 introduced/pre-existing、测试覆盖、样式删除 warning、授权检查、confidence、findings、退出码 |
| verify | implemented（含限制） | `commands.allow` 完整命令 + 参数；`.nexus/trust.json` 签名失效；TTY 确认 / 非 TTY `--yes`；显式 E12、postflight 内部 skipped；超时、1 MB 上限、逐条回显；危险命令 E17 |
| 5.9 根路由 | implemented | `resolveQueryScope`；root/roots/all；cwd 最长前缀；E16 + 候选；`byRoot`、`globalAmbiguous`、`completeness`、`staleRoots`/`failedRoots`；组间不排序不去重 |
| 测试与源码关系 | implemented | `tests` 表派生；impact `tests.related`；建议命令只建议不执行 |
| 样式影响 | implemented | 只输出 `styleDependents` 文件级；默认 Medium、删除/重命名有消费方 High、不 Critical |
| 盲区 | implemented | 沿用四类 + 定向盲区（target-not-covered / unresolved-consumer / test-relations-missing）；四件套齐全 |
| 夹具 | implemented | F08 refactor（10 文件 / 109 行）、F12 dirty（5 / 30）；F14 5.9 路由断言 |
| context / similar CLI | partial | 只实现 core（`buildTaskContext` / `findSimilar` / `extractSymbolNames`）供 preflight；`nex context` 与 `nex similar` 命令仍 E24（Phase 07） |
| 增量 / MCP / print / doctor --repair | not started | Phase 06/07；仍返回 E24 |

## 3. 测试与验证证据

环境：Windows x64；Node 22.16.0；npm 10.9.2。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run build` | 0 | core / cli / mcp / adapter-vue ESM + d.ts；连续两次构建哈希一致：core `cb42b961…`，cli `6afaf141…` |
| `npm run typecheck` | 0 | 通过 |
| `npm run lint` | 0 | 0 error |
| `npm run format:check` | 0 | Prettier 通过 |
| `npm test`（本地 Node 22.16.0） | 0 | **94 passed (10 files)**，84.68s |
| `act -j verify --container-options "-m 4g" --action-offline-mode` | 0 | Node 22.16.0：10 files / **94 passed** / 84.82s；Node 24.22.2：10 files / **94 passed** / 89.19s；两个 job 均 `Job succeeded` |
| F08 impact 文件 | 0 | `src/core.ts` 的 5/5 预期消费方（overlay / button / panel / app / button.test）全部命中；`--depth 4` 覆盖四层链 |
| F08 impact 符号 | 0 | `useOverlay`：Surface 条目 >0；`button.test.ts` 进 tests.related；`OverlayProps` 进 types；risk ≥ Medium |
| F08 impact 样式 | 0 | `theme.scss` 只输出 file-level `styleDependents`；risk ≤ High |
| F08 preflight | 0 | 现有 API >0；`rulesVersion=9.1.1`；sources >0；context budget=summary；任务抽取失败用例退出 2 |
| F08 postflight | 0 | 真实 git 变更：breaking Surface finding；changed files/symbols >0；`git status --porcelain` 前后一致；退出 1 |
| F14 5.9 路由 | 0 | `roots all` 有 `byRoot`，组内 `rootId` 一致；workspace root 无 scope → E16 / 64；`--root` + `--roots` → E00 |
| verify | 0 | 未授权显式 verify → E12；`--yes` 后执行并写 `trust.json`；危险 `rm` 配置 → E17 |
| schema v3 库 | — | `ensureSchema` 返回 E06；writer 测试断言 v3 → E06 |
| `git status --porcelain` | — | 仅本轮预期变更；`.nexus/test-tmp` 清空；`.nexus/tmp` 为空 |

### 3.1 Gate 判定

| Gate | 结果 | 证据 |
|---|---|---|
| G0 Schema 与写入 | pass | schema v4、tests 表/索引、SQL 派生、writer 单测、v3 E06 |
| G1 构建 | pass | build / typecheck / lint / format；两次 dist 哈希一致 |
| G2 影响面 | pass | F08 文件/符号/样式三态；5/5 certain 消费方；深度与截断字段 |
| G3 风险与证据 | pass | F08 Low/Medium/High/Critical 用例；每条 reason 有 rule/detail；样式不 Critical |
| G4 盲区与计数 | pass | 四类 + 定向盲区；counts 三分类；`impactFanout` 唯一符号数 |
| G5 Preflight | pass | 现有 API / similar / sources / deps / architecture / impact / docs+tests / context 均输出 |
| G6 Postflight | pass | Git Diff、changed symbols、Surface、deps、arch、tests、style warning、verify、report |
| G7 Verify 与安全 | pass（限制） | 授权/拒绝/危险命令；超时与截断实现但本轮未单独计时测试（§5） |
| G8 退出码 | pass | impact/preflight 2、postflight 1/2、E16 64、E00 64、E23 70 |
| G9 5.9 路由 | pass | F14 byRoot / globalAmbiguous / E16 / E00 |
| G10 输出 | pass | 四格式同源；lines 无 ANSI；多 root `[rootId]` 前缀；JSON 每条 rootId |
| G11 act CI | pass | Node 22.16.0 / 24.22.2 双矩阵 94 项；`Job succeeded` ×2 |
| G12 自审 | pass（报告层） | 本报告、任务回填、已知问题、工作区无验证残留 |

## 4. 性能与内存记录（只代表夹具/有界样本）

| 场景 | 指标 | 值 |
|---|---|---|
| F08 impact（文件，depth 4） | 测试内建库+查询 | 约 2.1s（含 init/build，非独立基准） |
| F08 impact（符号） | 同上 | 约 1.8s |
| F08 impact（样式） | 同上 | 约 1.7s |
| F08 preflight | 同上 | 约 1.7s |
| F08 postflight（git 变更） | 同上 | 约 5.6s（含 Git、Surface diff、测试） |
| act 双矩阵 | 全量测试 | 84.82s / 89.19s |

**边界**：以上是 F08 小夹具与本地测试的合并耗时，**不构成 16.2 任何规模档达标声明**；未测百万行、未测增量、未测查询 p50/p95、未测独立 peak RSS。Phase 06 负责 16.2 与 21.2。

## 5. 已知问题与未完成事项

1. **`nex context` / `nex similar` 命令未暴露**：只实现 core builder / 9.1.1 规则供 preflight 使用；CLI/MCP 属 Phase 07。不得声称命令可用。
2. **postflight 不自动 build/update**：索引 stale 时 changed symbols 与样式消费方可能不完整，报告标 `low` confidence 与盲区；要求用户先 `nex build`。
3. **文档关联是查询期文本匹配**：只扫 `*.md`（≤2000 文件 / 1 MB），不建文档索引，不保证语义相关。
4. **测试关系只来自 references/calls**：动态测试发现、字符串路径、运行时注册不承诺；无关系时进定向盲区。
5. **verify 的 Windows `.cmd` 启动器**：为 `npm` / `tsc` 等 shim 使用固定 `ComSpec` 包装并严格拒绝元字符；不是用户可注入 shell。超时/1 MB 截断已实现，但本轮未单独构造超时/超限用例。
6. **impact 默认 depth 3**：四层以上链需显式 `--depth`；F08 用 4。间接面截断时给 `nextCursor`。
7. **样式能力仍文件级**：无选择器/类名消费方；删除/重命名 warning 已实现，但未构造独立夹具用例。
8. **架构规则仍 allow-list**：Phase 04 限制不变；impact 的“核心基础设施”按“被 ≥2 模块引用”操作化。
9. **schema v4 需重建**：v3 索引 E06；不迁移、不自动删除。
10. **F08 golden 未固化**：消费方断言在 `packages/core/test/audit.test.ts` 内，`expected/` 目录未创建；不得把它称为独立 golden。
11. **性能不外推**：只记录夹具与有界样本；未跑百万行、增量、内存预算。

## 6. 依赖与架构变化

- 无新增第三方依赖；新增使用 `node:child_process.execFile`（无 shell）与 `node:readline`（TTY 确认），已登记 `docs/runtime-api.md`。
- 新增模块：`packages/core/src/audit/{impact,preflight,postflight,verify,similar,context,docs,git}.ts`、`packages/core/src/query/routing.ts`、`packages/core/src/config/command-safety.ts`。
- 修改：`store/{schema,commit,read,manifest}.ts`、`index/build.ts`、`model.ts`、`query/service.ts`、`status.ts`、`config/schema.ts`、`index.ts`、`cli/{cli,render}.ts`、`exit-codes.ts`。
- Schema v4：新增 `tests` 表；`surfaceVersion` / `baselineVersion` 仍为 1；既有字段语义不变。
- 行为变化：E16 退出码由 1 改为 64（作为“缺必需参数”的用法错误）；`QueryEnvelope` 增可选 `scope` / `byRoot` / `globalAmbiguous` / `staleRoots` / `failedRoots` / `completeness`，既有字段不变。

## 7. 对后续阶段影响

- **Phase 06** 可复用：`tests` 表与 `readTestsFor*`、impact 的直接/间接数据结构、5.9 `byRoot` 路由、`staleness` 消费方式、verify 的 `skipped-unauthorized` 语义。
- **Phase 06 仍需补**：增量=全量十项比较、F16 七注入点、12.3 提交协议完整校验、12.4 状态机转换、5.10 调度器、5.11 指纹、16.2 性能与 21.2 内存。
- **Phase 07**：`nex context` / `nex similar` 命令直接调用本阶段 core；MCP 8 工具的 `impact` / `context` 复用 `analyzeImpact` / `buildTaskContext`；`print` / `doctor --repair` 未开始。
- **风险**：postflight 依赖 fresh 索引；Phase 06 的 update 完成后应默认在 postflight 前提示 freshness。

## 8. 文档同步

- `README.md`：状态、能力表、Phase 05 命令与限制。
- `docs/README.md`：阶段索引加入 `phase-05/`。
- `docs/runtime-api.md`：登记 `execFile` 与 verify 的 readline 用途。
- `docs/phase-05/{00,01,02,03}.md`：新增。
- 未修改 v1.24 规范正文。

## 9. 自审回执

**审查范围：**

- 变更文件：见 `git status --porcelain`；核心为 `packages/core/src/audit/*`、`query/{service,routing}.ts`、`store/{schema,commit,read,manifest}.ts`、`index/build.ts`、`config/{schema,command-safety}.ts`、`cli/{cli,render}.ts`、`core/test/{audit,writer}.test.ts`、`cli/test/cli.test.ts`、`fixtures/F08-refactor`、`fixtures/F12-dirty`、`docs/phase-05/*`。
- 新增 API：`analyzeImpact` / `impactData`、`runPreflight`、`runPostflight`、`runVerify` / `readTrust` / `writeTrust`、`buildTaskContext`、`findSimilar` / `extractSymbolNames`、`resolveQueryScope`、`tests` 读取函数。
- 关键调用点：`query*` → `resolveQueryScope` → 逐 root 查询 → `groupedEnvelope`；`impact` → `prepareContext` / 反向边 BFS / `diffCurrentSurface`；`preflight` → `analyzeImpact` + `findSimilar` + `buildTaskContext`；`postflight` → `git` + `diffCurrentSurface` + `runVerify`；`buildWorkspace` → `commitBuild` → `populateTests`。

**边界与安全审查：**

| API / 文件 | 风险场景 | 结论 | 代码证据 |
|---|---|---|---|
| `audit/git.ts` | 用户 `--base` 注入、破坏性 git | 固定参数、`isGitRef`、无 shell、不执行 reset/clean/checkout | `git.ts` |
| `audit/verify.ts` | shell 注入、越界 cwd、危险命令 | 完整命令 + 参数、E17、cwd 根内、`shell:false`、`ComSpec` 仅 `.cmd` 且引号拒绝元字符 | `verify.ts`、`command-safety.ts` |
| `config/schema.ts` | 恶意 `commands.allow` | Zod superRefine + `load.ts` 二次校验 → E17 | `schema.ts`、`commands.ts` |
| `audit/impact.ts` | heuristic 混入 certain、跨 root BFS | 三分类分列；按 root 独立、不跨 root；样式不 Critical | `impact.ts` |
| `audit/postflight.ts` | 自动写文件、stale 误报 | 只读 Git；不自动 build；stale → low + 盲区；`git status` 测试前后一致 | `postflight.ts` |
| `query/routing.ts` | 多 root 合并/默认猜 root | E16 + 候选；`byRoot` 不排序不去重；`--root`/`--roots` 互斥 | `routing.ts` |
| `store/commit.ts` | tests 半提交/孤儿 | 单事务；`insert or ignore`；`assertClosure` 增 test target 校验 | `commit.ts` |

**递归检查：**

- 是否存在递归：无新增递归；BFS 使用显式队列，代码遍历使用显式栈/循环。
- 是否已转换为迭代：impact BFS、Git Diff 解析、文档目录遍历均为迭代。
- 如保留递归：仅 TypeScript AST 访问沿用既有 `forEachChild` 递归（与 Phase 01–04 一致），非本阶段新增。

**测试结果：**

- 类型检查：`npm run typecheck` 退出 0。
- Lint：`npm run lint` 退出 0。
- 单元 / 集成测试：`npm test` **94 passed (10 files)**。
- 构建：`npm run build` 退出 0；两次 dist 哈希一致。
- act：Node 22.16.0 / 24.22.2 双矩阵 **94 passed**，`Job succeeded` ×2。
- 未执行项目及原因：百万行 / 增量 / 独立 p50/p95 / peak RSS（Phase 06）；`context` / `similar` CLI（Phase 07）；verify 超时/截断未单独计时（§5）。

**已知缺陷：**

- context/similar CLI 未暴露；postflight 不自动 build；文档文本匹配；测试关系只覆盖 references/calls；`.cmd` 启动器限制；impact 默认 depth 3；样式无选择器；schema v4 需重建；性能不外推。均见 §5。

**兼容性影响：**

- 破坏性：schema v4（v3 索引必须重建）；E16 退出码改为 64。
- 非破坏性：既有命令/字段语义不变；`QueryEnvelope` 仅增可选字段；`surfaceVersion` / `baselineVersion` 不变。

**最终结论：**

**pass（G0–G12 通过；已知限制见 §5）。等待负责人评审，未经批准不进入 Phase 06。**
