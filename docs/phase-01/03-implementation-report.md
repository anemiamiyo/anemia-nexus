# Phase 01 实施报告：骨架与 TS 索引

> 依据：`docs/19-delivery-phases.md` 19.1/19.3、`docs/phase-01/01-task-checklist.md`、`docs/phase-01/02-plan-and-gates.md`
> 规范版本：v1.24（冻结）
> 日期：2026-11-12（Asia/Shanghai）
> 结论：**G1–G8 与 19.1 阶段 gate 通过；DoD 尚未全部满足，Phase 01 记为 pass-with-limits，等待负责人评审。**

## 1. 授权、基线与范围

- 项目负责人 2026-11-12 明确启动 Phase 01 并全权负责；Q-01 / Q-02 / Q-03 裁定见 `docs/phase-01/02-plan-and-gates.md` 第 1 节。
- 基线 commit：`dce0c43b8c796de8696cc848ace50ef6c7fe47ff`。
- 实现范围：CLI 骨架、配置加载、root 探测与扫描、TS/TSX SCIP 索引、SQLite 存储、`status` / `doctor`、`symbol` / `references` / `search`、四格式输出、退出码/错误码、F01/F10/F17/F04 夹具与 tsserver Oracle。
- 明确未实现：Vue、API Surface、依赖/调用图、impact、增量、MCP、`print`、发布验证。未实现命令统一 E24。

## 2. 实际完成内容（19.3 要求的状态标注）

### 2.1 模块级结果

| 模块 | 状态 | 说明 |
|---|---|---|
| CLI 骨架与命令注册 | implemented | Commander 15；21 主命令 + 4 别名；实现 7 个，其余 E24；别名隐藏于主帮助 |
| 全局参数与校验 | implemented | `--format` / `--color` / `--width` / `--pager` / `--compact` / `--verbose` / `--quiet` / `--explain` / `--no-truncate` / `--budget-hint` / `--cursor` / `--output-file` / `--root` / `--roots` / `--yes` / `--non-interactive` / `--trust-config` |
| 输出四格式 | implemented | pretty / lines / json / markdown 同源；lines/json/markdown 无 ANSI；完整性字段一致 |
| 退出码/错误码 | implemented | 0/1/2/64/70；E00–E24 统一构造；E23 兜底 70 |
| JSON 配置 + Zod strict | implemented | `.nexus/nexus.config.json`；未知字段/双源/旧路径/高版本 E17；JSON Schema 同源派生 |
| TS 配置授权 | partial | 未授权 E18；`--trust-config` 本次进程；`.nexus/trust.json` 读取并按内容哈希失效；**Phase 01 未提供持久授权写入口** |
| 项目扫描与 ignore | implemented | 内置基线 + 配置追加 + include 反向纳入；symlink/junction 不跟随；敏感文件不读；路径越界拒绝 |
| root 探测 | implemented | package.json / pnpm / lerna / rush / code-workspace / nx / turbo；rootId 归一化与消歧；多 root E15 |
| SCIP 索引 | implemented | 固定 `@sourcegraph/scip-typescript@0.4.0`；独立子进程、超时、输出上限；内部路径隔离 + 契约探针 |
| 声明与 symbolId | implemented | 迭代 AST 遍历；rootId + kind + nameChain + structuralFingerprint；不含路径；碰撞后缀 |
| 引用与映射 | implemented | SCIP occurrence ↔ declaration；构造器归并到类；别名 specifier 对齐 tsserver；`certain` / `dynamic-unresolved` |
| SQLite 存储 | implemented | 仅 `node:sqlite`；build-scoped 表；WAL；只读查询；必需索引；事务闭合校验 |
| 提交与恢复 | implemented | `BEGIN IMMEDIATE` → pending → COMMIT → 只读校验 → committed；manifest 原子写；pending 启动回收；保留 2 个 committed |
| 锁 | implemented | proper-lockfile，按 root，30s 等待 / 10min stale |
| 查询面 | partial | `symbol` / `references` / `search` 可用；多 root 的 `symbol` / `references` 返回 E24 |
| status | implemented | uninitialized / ready；五态中的 fresh/stale/failed 只读判定；能力声明严格按 Q-02；永不返回 E01 |
| doctor | implemented | Node / 配置 / DB / schema / 索引 / manifest 一致性 / 锁 / tmp / ignore；`--schema` 可用；`--repair` / `--mcp` / `--dump-vue-map` E24 |
| 测试与 Oracle | implemented | 52 项测试；F01/F10 与 tsserver 全量对照 0 差异；F17 安全用例 |
| 性能记录 | partial | 记录扫描/分析/SCIP/映射/写入耗时与父进程峰值 RSS；**SCIP 子进程峰值未采集** |

### 2.2 检查表分组状态

| 分组 | 状态 | 主要缺口 |
|---|---|---|
| A 入场与基线 | partial | `npm ci` 未执行（npm 10.9.2 不可用），其余完成 |
| B 包边界与构建 | implemented | — |
| C CLI 骨架 | partial | 无外部分页器；无显式 SIGINT→取消传播模型（依赖默认终止 + DB 原子性） |
| D 配置与 init | partial | 持久 trust 写入口未提供；init 多文件非全量事务；`followTsReferences` 未实现 |
| E 扫描与 root | partial | 根集合 exclude 已支持；`followTsReferences` / 配置变化增量重建未实现 |
| F 存储与提交 | partial | 损坏库查询返回 E01 而非 E07；manifest 滞后仅诊断不自动重写；F15 完整迁移未做 |
| G TS/TSX 索引 | partial | heuristic 边未产生（Phase 01 只有 SCIP certain）；写入先聚数组再批量插入；G15 非流式 |
| H 查询最小面 | partial | 多 root symbol/references E24；cursor 只做 offset，无 nextCursor；dirty/indexing 运行期无转换 |
| I status / doctor | implemented | — |
| J 安全边界 | partial | 非 OS 级网络沙箱；verify 未实现（只有命令白名单校验模型） |
| K 测试与夹具 | partial | F01–F18 中仅建 4 个夹具；无 CLI golden 快照文件；测试总时长约 70s（双 Node 各一次） |
| L 性能与可观测性 | partial | SCIP 峰值缺失；环境字段未含 CPU/内存 |
| M 文档与交付 | partial | 报告与自审已交付；等待负责人评审（M11） |

## 3. 测试与验证证据

环境：Windows x64；Node **22.16.0** 与 **24.22.2**；SQLite（Node 内置）**3.49.1**（Node 22.16）。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run build`（Node 22.16.0 / 24.22.2） | 0 / 0 | core + cli ESM + d.ts；连续两次构建 dist 哈希一致 |
| `npm run typecheck` | 0 / 0 | 覆盖 core + cli |
| `npm run lint` | 0 | 0 error |
| `npm run format:check` | 0 | Prettier 通过 |
| `npm test` | 0 / 0 | **52 passed (4 files)**，Node 22.16.0 与 24.22.2 |
| `node packages/cli/dist/main.js --help` | 0 | 六组命令 + 兼容别名附注；别名不在主列表 |
| `nex init --roots all --write-config --yes` | 0 | 生成配置、workspace.json、root 目录 |
| `nex build` | 0 | F01：10 文件 / 21 符号 / 83 引用；指纹 `bf_b72lqvwvutvf5s6snvdd`（Node 22.16） |
| `nex status` | 0 | `ready` / `fresh`；能力声明与 Q-02 一致 |
| `nex references add` | 0 | 7 条，全部 `certain` |
| tsserver Oracle 对照 | 0 | F01：20 个公共符号 0 missing / 0 extra；F10：11 个公共符号 0 / 0 |
| F17 安全用例 | 0 | 未授权 E18；越界读写/网络/子进程被拒；项目 scripts 未执行；恶意命令 E17 |
| 非 TTY | 0 | 全部命令 5s 内退出；缺参数 64；无 hang |
| 四格式一致 | 0 | F01 `references add` 条目数 7（pretty/lines/json/markdown）；无 ANSI |
| `npm pack --dry-run -w anemia-core / anemia-cli` | 0 | 各 3 个文件（dist + package.json）；无 `.nexus/`、fixtures、source map |
| `npm audit`（官方 registry） | 0 | 13 项（1 low / 12 moderate），无 high / critical；均在 ESLint 开发链 |

### 3.1 性能记录（只代表小夹具，不作 16.2 达标声明）

| 指标 | 值 |
|---|---|
| F01 构建总耗时 | 1073 ms（scan 5 / analyze 306 / SCIP 742 / map 2 / write 16） |
| 父进程峰值 RSS | 132.5 MB |
| SCIP 子进程峰值 | **null**（不可观测，manifest 带原因） |
| index.db / WAL | 163,840 B / 0 B |
| 文件 / 符号 / 引用 | 10 / 21 / 83（certain 50，unresolved 33，unmapped 0） |
| mappingSuccessRate | 1.0（21/21 exact，falseMatch 0） |

**不得**把本表外推为 5 万 / 30 万 / 百万行达标；SCIP 峰值与真实项目规模未验证。

## 4. Gate 结论

| Gate | 结论 | 证据 |
|---|---|---|
| G1 构建 | **pass** | build/typecheck/lint/format 退出 0；两次构建哈希一致 |
| G2 单仓库索引 | **pass** | F01 `init` + `build` 0；独立 root DB + manifest |
| G3 引用正确性 | **pass** | F01/F10 与 tsserver Oracle 全量 0/0 |
| G4 输出一致 | **pass** | 四格式条目数一致、完整性字段一致、无 ANSI |
| G5 非 TTY | **pass** | 5s 内退出；缺参数 64；无 hang |
| G6 配置安全 | **pass** | 18.4.3 用例全部通过；无越界读写/网络/脚本 |
| G7 双 Node | **pass** | 22.16.0 / 24.22.2 的 build、typecheck、52 测试、CLI 链路 |
| G8 自审 | **pass** | 报告、证据、已知问题、自审回执齐全；工作区无验证残留 |

**19.1 阶段 01 通过条件**：单仓库可 build、引用与 tsserver 抽样一致、pretty 与 lines 条目数一致、非 TTY 默认 lines、F17 安全用例通过——**全部满足**。

**DoD 未全部满足**：多 root 的 `symbol` / `references` 查询、`status --json-schema`、外部分页器、完整 F15 迁移、F16 七注入点与真实增量不在本阶段完成。因此 Phase 01 结论为 **pass-with-limits**，不得宣称 DoD 全部完成，也不得据此自动进入 Phase 02。

## 5. 已知问题与未完成事项

1. **多 root 查询面**：`symbol` / `references` 仅单 root，多 root 返回 E24；`search --roots all` 已按 root 分组。影响：多包仓库查询需逐 root 调用。
2. **`status --json-schema`**：Phase 01 返回 E24；配置 Schema 可通过 `doctor --schema` 获得。
3. **SCIP 峰值 RSS**：子进程不可观测；manifest 记 `scipPeakRssMB: null` 与原因，不得用父进程值替代。
4. **写入方式**：符号/引用先形成数组再批量插入，未做到逐条流式写入；小夹具无问题，大项目内存行为未验证（G15 partial）。
5. **损坏库错误码**：`openReadStore` 无法打开时查询返回 E01；更准确的 E07 只在 `doctor` 中报告。未在 Phase 01 修复。
6. **持久 TS 信任**：`.nexus/trust.json` 只读；Phase 01 没有定义写它的命令，`--trust-config` 仅本次进程。
7. **TS 配置语法**：`--experimental-strip-types` 仅支持可擦除语法；enum / namespace 值可能失败。
8. **init 原子性**：config / example / workspace / root 目录分别写入；中途失败可能留下部分文件（不会留下半截 JSON）。
9. **分页/预算**：`--pager` 不启动外部分页器；`--budget-hint` 只记录；默认不截断（因此 `nextCursor` 恒为 null）；`--cursor` 只应用 offset。
10. **无增量**：`update` 返回 E24；`dirty` / `indexing` 运行期转换未实现。
11. **`npm ci` 未执行**：见 §3；安装使用 npm 10.9.3 CLI + 现有 lockfile。
12. **Node 24 来源**：通过 npm `node@24.22.2` 包下载到 `.dsh/`（git 忽略），未改项目依赖或用户全局配置。
13. **F15/F16**：身份迁移仅实现同位置稳定 ID + 基本历史；F16 七注入点与真实崩溃恢复留 Phase 06。

## 6. 依赖与架构变化

- 新增直接依赖：`commander@15.1.0`（CLI）、`@sourcegraph/scip-typescript@0.4.0`（core，固定）、`proper-lockfile@4.1.2`、`zod@4.6.7`、`typescript@5.9.3`（core 运行时）。
- 无第三方 SQLite 驱动；无新增分析引擎。
- 存储表按 build 分区（`files` / `symbols` / `references` / `symbol_map` 均带 `build_id`），保留最近 2 个 committed；这是为崩溃恢复与“失败保留旧索引”服务的实现选择，不改变 5.x 的实体语义。
- `tools/oracle/` 为独立验证脚本，不进入产品依赖。
- 未修改 `docs/` 的技术结论；新增 `docs/phase-01/02-plan-and-gates.md` 与本报告。

## 7. 对后续阶段影响

- Phase 02 可直接复用：配置/扫描/root 路由、SQLite schema、SCIP 适配层、输出契约、错误码与 CLI 框架。
- Phase 02 需要补：Vue 投影、`semanticCoverage` 的 null 语义、模板边与 `__VLS_` 过滤；不得复用 `phase00/` 原型代码。
- Phase 05/06 需要补：多 root 查询合并、增量与失效传播、五态状态机的运行期转换、SCIP 峰值采集。
- Phase 07 需要补：MCP 8 工具、`print` 物料、发布验证；本阶段所有 E24 命令届时才可变为实现。

## 8. 文档同步

- `README.md`：状态、命令、Phase 01 结果与限制已更新。
- `.dsh/AGENTS.md`：当前状态与可用命令已更新（不纳入 git）。
- `docs/runtime-api.md`：登记 `node:sqlite`、`registerHooks`、Permission Model、`--experimental-strip-types`、`readline`、测试用 `cpSync`。
- `docs/phase-01/02-plan-and-gates.md`：追加执行结果、A06/A07 偏差。
- 本报告：新增。
- 未修改 v1.24 规范正文；Q-01/Q-02 的负责人裁定记录在计划文档，不改写 11/14 章。

## 9. 自审回执

**审查范围：**

- 变更文件：`packages/core/src/**`、`packages/cli/src/**`、`packages/*/test/**`、`tools/oracle/**`、`packages/*/package.json`、`packages/*/tsup.config.ts`、根 `package.json`、`tsconfig.typecheck.json`、`vitest.config.ts`、`eslint.config.js`、`README.md`、`docs/runtime-api.md`、`docs/phase-01/*.md`、`fixtures/F01/F10/F17/F04`、`.github/workflows/ci.yml`（未改）。
- 新增 / 修改的 API：`buildWorkspace`、`runInit`、`statusReport`、`runDoctor`、`querySymbol` / `queryReferences` / `querySearch`、`commitBuild` / `recoverPending`、CLI `run()`；内部 API 见 `packages/core/src/index.ts`。
- 关键调用点：CLI action → core service；`buildWorkspace` → `analyzeRoot` → `runScipIndex` / `mapSymbolsAndReferences` → `commitBuild` → `writeManifestAtomic`；查询 → `statusReport` → `openReadStore`。

**边界与安全审查：**

| API / 文件 | 风险场景 | 结论 | 代码证据 |
|---|---|---|---|
| `config/load.ts` | 双源/旧路径/未知字段/高版本/危险命令 | 已处理（E17） | `packages/core/src/config/load.ts:114` |
| `config/ts-loader.ts` | 未授权执行、越界读写、网络、子进程、超时 | 已处理（E18/E17；Permission Model + registerHooks + 5s + IPC） | `packages/core/src/config/ts-loader.ts:167`、`:186` |
| `discovery/scan.ts` | 路径穿越、symlink、敏感文件、超大文件 | 已处理（realpath 边界、symlink 跳过、`.env*`/密钥过滤、2MB 上限） | `packages/core/src/discovery/scan.ts:100` |
| `discovery/ignore.ts` | 内置基线被清空、文件穿过被忽略目录 | 已处理（追加式合并、祖先目录检查、include 反向纳入） | `packages/core/src/discovery/ignore.ts:48` |
| `discovery/roots.ts` | 多 root 静默选择、rootId 冲突、exclude | 已处理（E15、确定性消歧、exclude） | `packages/core/src/discovery/roots.ts:324` |
| `index/scip.ts` | 内部路径变更、SCIP 失败/超时、输出非法 | 已处理（契约探针、E11、30min 超时、1MB 输出上限） | `packages/core/src/index/scip.ts:122` |
| `index/mapping.ts` | SCIP protobuf 不可信、构造器/别名映射、未映射边 | 已处理（运行时校验、构造器归并、alias 合成、unmapped 显式记录） | `packages/core/src/index/mapping.ts:253` |
| `store/commit.ts` | 部分提交、崩溃恢复、保留旧索引、SQL 注入 | 已处理（build 分区、BEGIN IMMEDIATE、闭合校验、pending 回收、参数化） | `packages/core/src/store/commit.ts:125`、`:203`、`:403` |
| `store/manifest.ts` | 非原子写、损坏 manifest | 已处理（临时文件 + fsync + rename；读取校验） | `packages/core/src/store/manifest.ts` |
| `store/lock.ts` | 并发写、锁泄漏 | 已处理（proper-lockfile，finally 释放） | `packages/core/src/store/lock.ts` |
| `cli/cli.ts` | 参数注入、退出码、E24 假成功、非 TTY 阻塞 | 已处理（集中 exitCode、Commander 校验、E24 显式、非 TTY 64） | `packages/cli/src/cli.ts:721` |
| `cli/render.ts` | ANSI 泄漏、pretty 二次查询 | 已处理（仅 pretty 用 styleText；同一 data 渲染；测试断言） | `packages/cli/src/render.ts` |
| `init.ts` | 未确认落盘、覆盖、TS 双源 | 已处理（--write-config + --yes、force 二次确认、拒绝 .ts 双源）；**多文件非全量事务为已知缺陷** | `packages/core/src/init.ts:156` |

**递归检查：**

- 是否存在递归：否（新增产品代码无递归）。
- 是否已转换为迭代：AST/JSON/目录遍历均使用显式栈或循环；`declarations.ts`、`stable-json.ts`、`scan.ts`、`roots.ts`。
- 如保留递归：无。TypeScript 编译器内部实现不在本仓库代码范围。

**测试结果：**

- 类型检查：Node 22.16.0 与 24.22.2 均通过（`tsc --noEmit -p tsconfig.typecheck.json`）。
- Lint：`npx eslint packages tools` 通过（0 error）。
- 单元 / 集成测试：`npx vitest run` → 52 passed（Node 22.16.0 与 24.22.2 各一次）。
- 构建：`npm run build` 通过；连续两次 dist 哈希一致。
- 未执行项目及原因：`npm ci`（npm 10.9.2 不可用）、百万行性能与真实 RSS（按 D4/D7 延后）、真实 kill -9（Phase 06）。

**已知缺陷：**

见 §5 的 1–13 项；均为已披露限制或后续阶段工作，不存在未披露的本阶段正确性缺陷。

**兼容性影响：**

- 新增 `.nexus/` 配置与索引目录，不修改用户源码。
- SQLite schema v1 为本阶段最终形态；后续不兼容变更需升 `schemaVersion` 并重建。
- 未改变公开 CLI 语义（Phase 01 首次提供）；未实现命令以 E24 明确拒绝，不提供回退假数据。

**最终结论：**

**通过（pass-with-limits）**：G1–G8 与 19.1 阶段 gate 通过；DoD 未全部满足的项已逐条披露。Phase 01 不自动进入 Phase 02，等待负责人书面评审。

## 10. 负责人评审请求

请负责人决定：

1. 是否接受 Phase 01 以 **pass-with-limits** 关闭，并批准进入 Phase 02；
2. 是否要求在本阶段补齐多 root 查询、`status --json-schema`、SCIP 峰值采集或 `npm ci` 基线后再评审；
3. 是否允许在 Phase 02 复用本阶段的 SQLite schema、SCIP 适配层与输出契约（不改变 v1.24 技术结论）。
