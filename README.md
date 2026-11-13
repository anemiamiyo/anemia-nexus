# Anemia Nexus

> 以确定性索引为底座的**变更审计与 API 治理设施**，不是"更好的搜索工具"。
> 当前状态：**Phase 00 已完成（11/11，其中 6 项为 pass-with-limit）；规范 v1.24 已冻结；Phase 01 以 pass-with-limits 关闭；Phase 02–05 已关闭；Phase 06（增量、性能与一致性）已实现并通过 G0–G12 中的构建/一致性/恢复/调度/指纹/状态机项，性能 P3 目标未达（root 级保守重建），整体记为 pass-with-limits，等待负责人评审；MCP、复用性检测与发布验证仍未实现。**

---

## 1. 项目定位与核心目标

在超大型前端项目中，AI CLI Agent 往往只能依赖文本搜索、目录浏览和有限上下文。它读到一个符号的 3 处引用，就可能认为只有 3 处，然后修改公共签名——这是**静默漏报**，不是报错。在契约密集、强调公共 API 稳定性的仓库里，静默漏报的代价远高于报错。

Anemia Nexus 的目标是把"变更影响、公共 API 差分、复用检测"变成**可复核的事实**：人在终端能核对，CI 能拦截，Agent 能通过 MCP 取得带证据的结论。搜索只是它的下沉能力。

三条不可替代的能力（规划目标，尚未实现）：

1. **可验证的完整性**：能回答"该符号在当前覆盖范围内共 N 处引用，已全部列出"，同时给出覆盖范围与未覆盖原因。
2. **确定性可复现**：同一 commit、命令、参数与构建指纹，输出逐字节一致。
3. **增量下的身份可判定**：文件重命名、移动、barrel 重导出不必然改变符号身份；工具给出身份是否延续及置信度。

**完整性承诺的严格边界**：所谓"零漏报"仅适用于**确定性静态关系**（`relationClass = certain`），且仅在该文件位于索引范围内、分析成功完成时成立。启发式关系带置信度标注；动态关系明确不保证识别。**禁止把"未发现引用"表述为"确认不存在引用"。**

Phase 01 交付了 TS/TSX 的符号与引用索引、CLI 骨架、`status` / `doctor` 与最小查询面，并已由负责人以 pass-with-limits 关闭；Phase 02 增加 Vue 3 SFC 语义：`@vue/language-core` 投影、影子物化、坐标转译、`__VLS_` 过滤、Props/Emits/Slots 与 `propsCoverage`、四类模板引用边，以及 scip / ts / vue 三引擎的 `symbol_map`。Phase 03 增加 API Surface：五类公开证据来源（`package-exports` / `explicit-entry` / `barrel-derived` / `manual-override` / `none`）、`exportKind`、`nexus.baseline.json`、`api-snapshot`、`api-diff` 四级差分与 `@deprecated` 链路；构建写入改为单事务、迭代器分批的边算边写。Phase 04 增加文件/模块依赖图、静态调用图、架构 allow 规则、S1 样式链、跨 root 边界与 `nex deps`。Phase 05 增加 `nex impact`（风险与证据）、`nex preflight`（现有 API / 相似能力 / 依赖 / 上下文）、`nex postflight`（Git Diff / 修改符号 / Surface 差分 / 测试 / 授权检查）、`nex verify`（白名单与 `.nexus/trust.json`）、5.9 查询期根路由（root / roots / all）与测试关系表。Phase 06 增加 `nex update`（内容 Hash 变更检测、12.1 失效传播、按 root 保守重建、`--rebuild-affected` / `--files`）、12.3 提交协议补全与七注入点崩溃恢复、12.4 五态状态机、5.10 全局资源协调器与降级阶梯、5.11 `tsconfigHash` 与可复现指纹、12.2 增量=全量十项门禁、F16/F18 夹具与 P1–P8 性能采集；**文件级局部 AST 复用仍未实现**，P3 以 root 级重建口径记录并在报告中标注未达标。MCP、`print`、`doctor --repair` 与发布验证仍是 Phase 07 内容，相关命令返回 E24「未提供」，不会伪造结果。

### 1.1 适用范围与前置条件

**适用**：可被 TypeScript Compiler 解析的项目（含 TSX）；建议 10 万行以上、模块数 > 30、存在被其他代码或团队消费的公共 API；有 git 仓库。判据比行数更重要：是否存在"改动会波及外部消费方"的公共契约。

| 前置条件   | 要求                                 | 不满足的后果                                               |
| ---------- | ------------------------------------ | ---------------------------------------------------------- |
| 类型检查   | 能通过 tsc，建议 strict              | 降级为 `syntax-only`，引用/影响结论不得作确定性依据        |
| 类型完整度 | 避免 any 泛滥与隐式类型              | 只建议使用检索，不建议依赖影响分析                         |
| 路径别名   | 写入 tsconfig 或 `nexus.config.json` | 别名解析失败，跨包引用降为 heuristic                       |
| 多根工作区 | 每个 package 可独立 typecheck        | 未识别 root 不进入索引；跨 root 只允许已声明依赖 + exports |
| 版本控制   | 有 git 与可用 diff 基线              | 审计链路不可用，索引与查询仍可用                           |
| 运行环境   | Node ≥ 22.16.0                       | 启动即 E14 退出，不提供降级驱动                            |

**框架支持**：TS/TSX 开箱可用；Vue 3 限于可解析类型与四类模板边，复杂 Props/Slot 显式降级；CSS/SCSS/Less 只做文件级依赖；HTML 文件级引用为 opt-in（默认关）；Svelte、Angular 等 v1 不提供适配。

**不推荐**：中小型项目、个人/娱乐项目、实验性原型、无公共 API 契约的单人仓库、无法保证类型检查通过的项目。共同点是固定成本高于收益。

**成本口径**：固定成本上升（建索引、维护、每次增量、磁盘与内存），探索成本下降；**不以"节省 Token"作为价值主张**。

---

## 2. 主要功能与明确的非目标

### 2.1 主要功能与规划阶段（TS/Vue 索引、检索、API Surface、关系图、影响审计与增量更新已实现；其余未实现）

| 能力                             | 说明                                                                                                        | 规划阶段 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| 确定性索引                       | TypeScript / TSX / Vue 3 SFC；SCIP 为主、TS Compiler API 校验、Vue Language Core 投影                       | 01–02    |
| 代码检索                         | 符号、类型、文件、目录、导出、签名、组件 Props/Emits/Slots、引用、JSON/配置、示例与测试、废弃 API、身份历史 | 01–02    |
| API Surface 治理                 | 公共/内部/opaque 分类、公开证据来源、基线快照、语义化差分、弃用链路（Phase 03 已实现）                      | 03       |
| 关系分析                         | 文件/模块依赖、符号引用、导出重导出、静态调用、组件关系、测试关联（Phase 05 tests 表）；三分类 + 四档置信度 | 04–05    |
| 变更影响分析                     | 直接/间接依赖者、受影响 Surface/组件/类型/测试、文档、盲区清单、风险等级与证据（Phase 05 已实现）           | 05       |
| Preflight / Postflight / CI 门禁 | 变更前审计、变更后审计、`verify` 白名单、退出码门禁（Phase 05 已实现）                                      | 05       |
| 增量与一致性                     | 内容 Hash 变更检测、12.1 失效传播、`nex update`、提交协议、崩溃恢复、五态状态机、增量=全量门禁（Phase 06） | 06       |
| 性能与内存                       | P1–P8 采集器、root 级增量测量、内存预算与降级阶梯（Phase 06；P3 未达标）                                    | 06       |
| 复用性检测                       | 可解释的相似 API 检索、重复实现巡检                                                                         | 07       |
| MCP 接入                         | 8 个工具，仅 `refresh` 可写索引                                                                             | 07       |
| CLI                              | 21 个主命令 + 4 个兼容别名，`nex` / `anex` / `anemia`                                                       | 01–07    |
| 多根工作区                       | 每个 root 独立索引，跨 root 只允许已声明依赖 + exports 可解析的边                                           | 02–05    |
| 样式依赖                         | 仅文件级 `@import` / `@use` / `@forward` / `<style src>` / TS import，不做选择器                            | 04       |

### 2.2 明确的非目标（v1 不做）

- 不做 IDE、不做语言服务器、不替代 tsserver / LSP。
- 不追求全语言覆盖；v1 只承诺 TypeScript、TSX、Vue SFC、JSON 与常见配置文件；样式只做文件级依赖。
- 不宣称"完整调用图"，只提供带置信度标注的静态调用关系。
- **不做运行时追踪**：不注入探针、不采集运行时调用计数、不做覆盖率插桩。
- 不做代码生成、不做自动修复、不修改被分析项目的业务代码。
- 不以"节省 Token"作为价值主张。对外口径是：**固定成本上升，探索成本下降**。
- 不提供样式类名 / 选择器的消费方全集。
- 不做 Sass / Less 编译，不解析变量拼接后的路径，不读取项目外文件，不访问网络。
- 不提供自动迁移旧索引的承诺；Schema 不兼容时默认重建。
- 不自动写入 AGENTS.md、MCP 配置或 Skill 目录；接入物料只打印到终端。

---

## 3. 核心技术栈

| 层          | 选型                                                                                | 状态                                         |
| ----------- | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| 运行环境    | Node.js **≥ 22.16.0**（强制；低于即 E14 退出）                                      | 已配置 `engines` + `engine-strict`           |
| 开发语言    | TypeScript **5.9.3**（锁定 5.x；`@vue/language-core` 不接受 TS 7.x）                | 已安装                                       |
| 包管理      | npm workspaces                                                                      | 已配置                                       |
| 构建        | tsup 8.5.1（ESM，`target: node20` 仅语法目标）                                      | 已配置并验证                                 |
| 测试        | Vitest 5.1.0                                                                        | 已配置；产品无测试，Phase 00 有独立验证脚本  |
| 版本发布    | changesets 3.0.3                                                                    | 已安装，未启用发布流程                       |
| 代码规范    | ESLint 10 + typescript-eslint + eslint-plugin-n；Prettier 3                         | 已配置并验证                                 |
| 索引存储    | 内置 `node:sqlite`（唯一驱动，禁止第三方）                                          | Phase 01 产品链路已接入并验证                |
| 语义分析    | `@sourcegraph/scip-typescript@0.4.0`；TS Compiler API；@vue/language-core / vue-tsc | Phase 02 已接入：SFC 投影 + SCIP 影子索引    |
| 依赖 / 质量 | dependency-cruiser、Knip                                                            | 规划；尚未接入                               |
| 配置校验    | Zod（JSON Schema 派生）                                                             | 已安装；Phase 00 安全原型验证                |
| CLI / MCP   | Commander.js；`@modelcontextprotocol/server` v2                                     | CLI 骨架已实现；MCP 协议探针通过、服务未实现 |
| 并发保护    | proper-lockfile                                                                     | 已安装；调度为 Phase 00 模拟原型             |
| 样式解析    | postcss 系（只提取字符串，不编译）                                                  | 规划；尚未接入                               |

> **工程链兼容性**：tsup 9.0.0 的 `engines` 为 `^22.18.0 || ^24.11.0 || >=26.0.0`，会破坏 Node 22.16.0 下限矩阵，故固定 **tsup 8.5.1**；changesets 3.0.3 要求 npm ≥10.9.0（Node 22.16.0 自带 npm 10.9.2，满足）；ESLint 10 要求 Node ≥22.13，Vitest 5 / Vite 7 要求 ≥22.12。TypeScript 固定 5.9.3，满足 typescript-eslint 8 的 `>=4.8.4 <6.1.0` 约束。SCIP 固定 `@sourcegraph/scip-typescript@0.4.0`（TS 5.x）；最新的 0.6.x 依赖 TS 6 且要求 Node ≥22.23.4，升级须单独评审。
>
> **注意**：Phase 00 已安装分析/验证依赖（SCIP、Vue、Zod、MCP、ts-morph、proper-lockfile），并用于 `phase00/` 原型；这**不代表**产品功能已实现。`packages/*/src` 仍是占位入口。

---

## 4. 项目目录结构

```text
anemia-nexus/
├── .changeset/                     # changesets 配置
├── .dsh/                           # 项目级 AI 协作规范（git 忽略）
│   └── AGENTS.md
├── .github/workflows/ci.yml        # Node 22.16.0 / 24 双矩阵
├── docs/                           # 技术规范主体（权威来源）
│   ├── README.md                   # 文档索引与职责
│   ├── 00-…23-*.md                 # 按原章号拆分的规范
│   ├── appendix-a-d.md
│   ├── runtime-api.md              # Node API 最低版本登记
│   ├── phase-00/                   # Phase 00 范围、门槛、验证报告
│   ├── phase-01/ … phase-05/       # 各阶段入场/计划/任务/实施报告
│   └── phase-06/                   # 增量、性能与一致性（本阶段）
│       ├── 00-entry-and-decisions.md
│       ├── 01-task-checklist.md
│       ├── 02-plan-and-gates.md
│       └── 03-implementation-report.md
├── fixtures/                       # 合成夹具（F01–F18；local/ 为 git 忽略）
│   ├── F01-reexport-chain/ … F14-multi-root/
│   ├── F16-crash-recovery/         # 七注入点崩溃恢复
│   ├── F17-config-security/
│   ├── F18-scheduler/              # 3 root + 依赖顺序 + 降级
│   └── local/                      # 用户本地真实项目（git 忽略）
├── phase00/                        # Phase 00 验证原型与 results/（非产品实现）
├── packages/
│   ├── core/                       # anemia-core
│   │   ├── src/
│   │   │   ├── index/              # build / fingerprint / invalidation / equivalence / scip / mapping / declarations / symbol-id
│   │   │   ├── store/              # schema / db / commit / manifest / lock / read / history / state / recovery / workspace / inject
│   │   │   ├── discovery/          # roots / scan / ignore / tsconfig / typecheck
│   │   │   ├── graph/              # dependencies / calls / style / architecture / cross-root / blindspots
│   │   │   ├── surface/            # builder / diff / export-graph / store
│   │   │   ├── audit/              # impact / preflight / postflight / verify / similar / context / docs / git
│   │   │   ├── query/              # service / routing
│   │   │   ├── vue/                # project / shadow / declarations / references / dump / fallback
│   │   │   ├── config/             # schema / load / merge / json-schema / command-safety
│   │   │   ├── scheduler.ts        # 5.10 全局资源协调器
│   │   │   ├── status.ts / doctor.ts / init.ts / model.ts / errors.ts
│   │   │   └── index.ts            # 公共 API
│   │   └── test/                   # unit / integration / audit / vue / writer / incremental / recovery / scheduler
│   ├── cli/                        # anemia-cli：src/{cli,render,context,main}.ts；bin: nex/anex/anemia
│   ├── mcp/                        # anemia-mcp：MCP Server（Phase 07 前为占位）
│   └── adapter-vue/                # anemia-adapter-vue（占位）
├── tools/perf/                     # F11 生成器 + P1–P8 性能采集（generate.mjs / run.mjs）
├── eslint.config.js
├── tsconfig.base.json
├── vitest.config.ts
├── package.json                    # npm workspaces 根
├── LICENSE / NOTICE                # Apache-2.0
└── README.md
```

- `packages/core` 与 `packages/cli` 已含 Phase 01–06 产品实现；`packages/mcp` 与 `packages/adapter-vue` 仍是占位入口。
- `.nexus/` 是索引目录（派生数据）：`roots/<rootId>/{index.db,manifest.json,surface.json,indexing.json,recovery-events.jsonl}`、`workspace.json`、`tmp/`、`cache/`；**不纳入版本控制**。
- `fixtures/F16-crash-recovery` 与 `fixtures/F18-scheduler` 为 Phase 06 新增；`fixtures/F11` 由 `tools/perf/generate.mjs` 现场生成，不提交。
- `nexus.baseline.json` 由 `nex api-snapshot --yes` 生成，纳入 git 后供 `api-diff` 使用。

---

## 5. 文档导航

完整索引与职责边界见 [`docs/README.md`](docs/README.md)。

| 文档                                                                                                            | 内容                                                           |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`docs/01-scope-and-positioning.md`](docs/01-scope-and-positioning.md)                                          | 适用范围、前置条件、定位、能力承诺、非目标、成功判据、设计原则 |
| [`docs/02-technical-baseline.md`](docs/02-technical-baseline.md)                                                | 产品基线、命名与命令、运行环境五层口径                         |
| [`docs/03-tech-stack-and-build.md`](docs/03-tech-stack-and-build.md)                                            | 选型、依赖准入、构建发布链路、发布验证                         |
| [`docs/04-architecture.md`](docs/04-architecture.md)                                                            | 总体架构、Vue 索引管线、样式依赖链、多分析器语义统一           |
| [`docs/05-data-model.md`](docs/05-data-model.md)                                                                | 实体、符号身份、存储、多根、资源协调、构建指纹                 |
| [`docs/06-api-surface.md`](docs/06-api-surface.md)                                                              | API 边界、证据来源、基线、差分、弃用                           |
| [`docs/07-code-search.md`](docs/07-code-search.md) – [`docs/10-impact-analysis.md`](docs/10-impact-analysis.md) | 检索、关系、复用、影响分析                                     |
| [`docs/11-cli.md`](docs/11-cli.md)                                                                              | 命令、参数、格式、退出码、非 TTY                               |
| [`docs/12-indexing.md`](docs/12-indexing.md)                                                                    | 失效、提交协议、状态机、忽略规则                               |
| [`docs/13-audit-and-ci.md`](docs/13-audit-and-ci.md)                                                            | Preflight / Postflight / CI                                    |
| [`docs/14-agent-integration.md`](docs/14-agent-integration.md)                                                  | MCP 8 工具与接入模板                                           |
| [`docs/15-output-contract.md`](docs/15-output-contract.md)                                                      | 三层输出、完整性字段、稳定格式                                 |
| [`docs/16-nfr-and-errors.md`](docs/16-nfr-and-errors.md)                                                        | 准确率、性能、错误码 E00–E24                                   |
| [`docs/17-testing.md`](docs/17-testing.md)                                                                      | 合成夹具 F01–F18、验证项、断言                                 |
| [`docs/18-security.md`](docs/18-security.md)                                                                    | 六类操作边界、降级、配置执行、自定义命令                       |
| [`docs/19-delivery-phases.md`](docs/19-delivery-phases.md)                                                      | 阶段 00–07 与交付管理                                          |
| [`docs/20-prohibitions.md`](docs/20-prohibitions.md)                                                            | 48 条 AI Agent 禁令                                            |
| [`docs/21-phase-00.md`](docs/21-phase-00.md)                                                                    | Phase 00 十组验证与内存校准                                    |
| [`docs/22-onboarding.md`](docs/22-onboarding.md)                                                                | 首次接入与失败体验                                             |
| [`docs/23-conflicts.md`](docs/23-conflicts.md)                                                                  | 跨章节冲突与消解                                               |
| [`docs/appendix-a-d.md`](docs/appendix-a-d.md)                                                                  | 兼容矩阵、文档职责、冻结清单、修订对照                         |
| [`docs/runtime-api.md`](docs/runtime-api.md)                                                                    | Node 内置 API 最低版本登记                                     |
| [`docs/phase-01/00-freeze-and-entry.md`](docs/phase-01/00-freeze-and-entry.md)                                  | 规范冻结、负责人裁定与 Phase 01 入场条件                       |
| [`docs/phase-01/01-task-checklist.md`](docs/phase-01/01-task-checklist.md)                                      | Phase 01 完整任务清单（计划基线）                              |
| [`docs/phase-01/02-plan-and-gates.md`](docs/phase-01/02-plan-and-gates.md)                                      | Phase 01 授权、Q-01/Q-02 裁定与冻结门槛                        |
| [`docs/phase-01/03-implementation-report.md`](docs/phase-01/03-implementation-report.md)                        | Phase 01 实施报告、状态矩阵、gate 结论与已知限制               |
| [`docs/phase-02/00-entry-and-decisions.md`](docs/phase-02/00-entry-and-decisions.md)                            | Phase 01 关闭裁定、Phase 02 授权、四项补齐判断与关键技术决策   |
| [`docs/phase-02/01-task-checklist.md`](docs/phase-02/01-task-checklist.md)                                      | Phase 02 完整任务清单（计划基线）                              |
| [`docs/phase-02/02-plan-and-gates.md`](docs/phase-02/02-plan-and-gates.md)                                      | Phase 02 gate、V1–V4/V6 口径、测试矩阵与风险                   |
| [`docs/phase-02/03-implementation-report.md`](docs/phase-02/03-implementation-report.md)                        | Phase 02 实施报告、证据、已知限制与自审回执                    |
| [`docs/phase-03/00-entry-and-decisions.md`](docs/phase-03/00-entry-and-decisions.md)                            | Phase 03 授权、Surface 分工、基线与 diff 口径、边算边写裁定    |
| [`docs/phase-03/01-task-checklist.md`](docs/phase-03/01-task-checklist.md)                                      | Phase 03 完整任务清单与证据要求                                |
| [`docs/phase-03/02-plan-and-gates.md`](docs/phase-03/02-plan-and-gates.md)                                      | Phase 03 gate、量化口径、测试矩阵与风险                        |
| [`docs/phase-03/03-implementation-report.md`](docs/phase-03/03-implementation-report.md)                        | Phase 03 实施报告、证据、已知限制与自审回执                    |
| [`docs/phase-04/00-entry-and-decisions.md`](docs/phase-04/00-entry-and-decisions.md)                            | Phase 04 入场、架构模块与调用图口径                            |
| [`docs/phase-04/03-implementation-report.md`](docs/phase-04/03-implementation-report.md)                        | Phase 04 实施报告与已知限制                                    |
| [`docs/phase-05/03-implementation-report.md`](docs/phase-05/03-implementation-report.md)                        | Phase 05 实施报告、impact/preflight/postflight/verify 证据     |
| [`docs/phase-06/00-entry-and-decisions.md`](docs/phase-06/00-entry-and-decisions.md)                            | Phase 06 入场、增量粒度裁定、恢复/调度/指纹决策                |
| [`docs/phase-06/01-task-checklist.md`](docs/phase-06/01-task-checklist.md)                                      | Phase 06 任务清单（编码前冻结）                                |
| [`docs/phase-06/02-plan-and-gates.md`](docs/phase-06/02-plan-and-gates.md)                                      | Phase 06 Gate、十项等价口径、性能与内存口径                    |
| [`docs/phase-06/03-implementation-report.md`](docs/phase-06/03-implementation-report.md)                        | Phase 06 实施报告、P1–P8 实测、已知限制与自审回执              |

文档职责：`docs/` 是技术规范唯一权威来源；本 README 只负责安装、运行、配置、上手与能力边界；`.dsh/AGENTS.md` 只负责 AI 协作纪律，不复制错误码表或工具用法全集。

---

## 6. 开发环境要求

| 项                  | 要求                   | 说明                                                      |
| ------------------- | ---------------------- | --------------------------------------------------------- |
| Node.js             | **≥ 22.16.0**          | `node:sqlite` 的 API 可用性下限；启动时校验，不满足报 E14 |
| Node.js（开发基线） | 24 LTS                 | 2.2 定义的开发主力环境；CI 同时验证 22.16.0 与 24         |
| npm                 | 随 Node 提供（≥ 10.9） | workspaces 与 changesets 需要                             |
| Git                 | 可用                   | 审计链路与发布验证依赖                                    |
| 包管理器            | 仅 npm                 | 不使用 pnpm                                               |
| 构建器              | 仅 tsup                | 不使用 Vite 做构建                                        |

> 本机双运行时：**PowerShell 由 fnm 管理 Node v24.22.2（npm 11.19.1）**，**CMD 由 nvm-windows 管理 Node v22.16.0（npm 10.9.2）**；`.nvmrc` 写 `24`。npm 10.9.2 现已可在 CMD 中正常使用（已验证 `npm -v`、`npm ls`、`npm ci --dry-run` 均退出 0）。Phase 00/01 记录中的“npm 10.9.2 缺 `@npmcli/config`、临时改用 npm 10.9.3”是当时环境状态，现已恢复。

安装依赖（仅安装工程链；运行时不联网）：

```bash
npm install
```

如 npm 默认缓存目录不可写，可临时指定缓存路径，**不要修改全局 npm 配置**：

```bash
npm install --cache ./.npm-cache
```

---

## 7. 安装、构建、测试命令

```bash
npm install            # 安装 workspace 依赖并生成/使用 package-lock.json
npm run build          # tsup 构建全部 packages（ESM + d.ts，target node20）
npm run typecheck      # tsc --noEmit，逐 package
npm test               # Vitest；111 项（Phase 06）
npm run test:watch     # Vitest watch
npm run lint           # ESLint，含 Node 22.16.0 内置 API 越界检查
npm run format         # Prettier 写入
npm run format:check   # Prettier 检查
npm run gate:incremental # 12.2 增量=全量 + F16 恢复门禁
npm run perf           # P1–P8（默认 1 万行；写 stdout，可用 --output 落盘）
npm run changeset      # 创建 changeset（发布流程尚未启用）
npm run phase00        # Phase 00 全部验证（需要 Node 子进程权限）
```

**Phase 06 已提供 `nex` / `anex` / `anemia` 命令（构建后）：**

```bash
npm run build
node packages/cli/dist/main.js init --roots all --write-config --yes
node packages/cli/dist/main.js build
node packages/cli/dist/main.js update                                  # 内容 Hash 变更检测 + 受影响 root 更新
node packages/cli/dist/main.js update --files src/core.ts --format json # 强制把匹配文件视为变更
node packages/cli/dist/main.js update --rebuild-affected --root ui      # 对变更 root 走全量重建
node packages/cli/dist/main.js status
node packages/cli/dist/main.js doctor
node packages/cli/dist/main.js references <symbol>
node packages/cli/dist/main.js references <symbol> --no-template   # 排除 Vue 模板边并声明
node packages/cli/dist/main.js symbol <component-symbolId>
node packages/cli/dist/main.js deps src/consumer.ts                 # 文件级依赖
node packages/cli/dist/main.js deps src/styles/theme.scss --type style --reverse
node packages/cli/dist/main.js deps --type module core                # 需显式 architecture.modules
node packages/cli/dist/main.js deps --type call useOverlay --reverse  # 静态调用边
node packages/cli/dist/main.js impact src/core/useOverlay.ts --explain
node packages/cli/dist/main.js impact --symbol useOverlay --depth 2
node packages/cli/dist/main.js preflight --task "add a close button to the overlay"
node packages/cli/dist/main.js postflight --base origin/main --fail-on breaking --format json
node packages/cli/dist/main.js postflight --base HEAD~1 --report markdown
node packages/cli/dist/main.js verify --dry-run
node packages/cli/dist/main.js verify --yes --only typecheck
node packages/cli/dist/main.js search --roots all                  # 多 root 分组，组间不排序
node packages/cli/dist/main.js doctor --dump-vue-map src/App.vue   # 打印投影与映射段，不落盘
```

已实现：`init`、`build`、`update`、`status`、`doctor`（含 `--schema`、`--dump-vue-map`）、`symbol`、`references`、`search`、`deps`、`api-snapshot`、`api-diff`、`impact`、`preflight`、`postflight`、`verify`；`query` 为 `search` 的兼容别名。Phase 06 的 `update` 采用**按 root 的保守重建**：内容 Hash 变化只重建受影响 root，未变化 root 零写入；不宣称文件级局部 AST 复用。`build` / `update` 与查询均先跑 12.3.3 恢复；状态机 `fresh` / `dirty` / `indexing` / `stale` / `failed` 统一由 `staleness` 输出，源文件变化后为 `dirty`，更新成功后才回 `fresh`。`impact` / `preflight` / `postflight` 输出按 `certain` / `heuristic` / `dynamic-unresolved` 分列，每条风险/finding 带文件、行、规则与证据；`search` / `symbol` / `references` / `deps` / `impact` 支持 5.9 的 `--root` / `--roots all` 分组。其余命令（`context`、`similar`、`audit-duplicates`、`print`、`mcp`、`test`）仍返回 E24「未提供」，退出码 1；`doctor --repair` / `--mcp`、`status --json-schema` 同样仍为 E24。`verify` 只执行 `commands.allow` 中的完整命令 + 参数，授权记录在 `.nexus/trust.json`；未授权时显式 verify 报 E12，postflight 内部标 `skipped-unauthorized`。

本项目是 Node 库与 CLI，不是前端应用，**没有常驻 dev server**。开发期使用 `npm run test:watch`、编辑器类型检查、`npm run build` 与 `node packages/cli/dist/main.js`；CLI 不启动任何后台常驻进程。

### 7.1 安装后的手动接入（Phase 07 提供；当前 `print` 仍返回 E24）

以下四步来自 21.1，**工具实现后才可执行**；工具只打印接入物料，不代写任何配置文件：

1. **MCP**：运行 `nex print mcp-config --client dsh`，把打印出的 JSON 合并到平台 MCP 配置，重启平台。
2. **AGENTS.md**：运行 `nex print agents`，把片段粘贴到项目根 `AGENTS.md`；已存在则追加，不覆盖原内容。
3. **Skill**：从仓库下载 `skills/nexus`，复制到平台 skills 目录（dsh 为 `~/.dsh/skills/nexus`，以平台文档为准）。
4. **验证**：`nex status` 应返回 `state: uninitialized` 或 `ready`；已完成 build 的项目应为 `ready` 且 `staleness: fresh`。

工具不提供 `--write-*` / `--install` 参数；MCP 配置、AGENTS 片段与 Skill 一律只打印到终端。

---

## 8. 当前初始化状态

### 8.1 已完成

- [x] 将任务书 v1.24 按章节拆分为 25 个规范文件，正文与原文逐字节一致（已校验），并建立 [`docs/README.md`](docs/README.md) 索引。
- [x] 建立 [`.dsh/AGENTS.md`](.dsh/AGENTS.md) 项目级 AI 协作规范，并加入 `.gitignore`。
- [x] 建立 npm workspaces 骨架：`anemia-core`、`anemia-cli`、`anemia-mcp`、`anemia-adapter-vue`（均为占位入口）。
- [x] 配置 TypeScript 5.x、tsup（ESM / node20 / dts）、Vitest、ESLint（含 `n/no-unsupported-features/node-builtins` @ 22.16.0）、Prettier、changesets、GitHub Actions 双 Node 矩阵。
- [x] 生成 `package-lock.json`，全部版本精确锁定。
- [x] 落地 **Apache-2.0** 许可证与 NOTICE；根与 4 个子包写入 `license` 字段。
- [x] 完成 **Phase 00**：11 项验证全部退出码 0，证据写入 `phase00/results/`，报告见 [`docs/phase-00/02-validation-report.md`](docs/phase-00/02-validation-report.md)。
- [x] 建立 Phase 00 夹具：`fixtures/semantic-map`（T01–T09）、`fixtures/F15-identity`（八场景）。
- [x] 完成 **Phase 01**：CLI 骨架与 `init` / `build` / `status` / `doctor` / `symbol` / `references` / `search`；Zod JSON 配置与授权 TS 配置子进程；root 探测与隔离扫描；SCIP 0.4.0 + `node:sqlite` 的 TS/TSX 索引；四格式输出、退出码与错误码框架。
- [x] 建立 Phase 01 夹具：`fixtures/F01-reexport-chain`、`fixtures/F10-negative`、`fixtures/F17-config-security`、`fixtures/F04-multi-root`，以及独立 tsserver Oracle（`tools/oracle/`）。
- [x] 双 Node 验证：Node 22.16.0 与 24.22.2 下 build / typecheck / 52 项测试 / CLI 基础链路全部通过。
- [x] 完成 **Phase 02**：`@vue/language-core@3.3.14` SFC 投影、`.nexus/tmp/vue/` 影子物化与内存映射、shadow → `.vue` 坐标转译、`__VLS_` 内部符号过滤、Props/Emits/Slots 与 `propsCoverage`、四类模板引用边、Semantic Merger 与 `symbol_map`（scip / ts / vue）、`doctor --dump-vue-map`。
- [x] 建立 Phase 02 夹具：`fixtures/F05-vue-sfc`（5 个 SFC、23 条模板边、9 个 Props、4 类边与动态参数/成员表达式），并扩展 `fixtures/semantic-map` 的 T09 断言。
- [x] 阶段 02 gate：V1–V4、V6 自动化断言通过；Vue 符号 0 `__VLS_` 泄漏；`falseMatchCount = 0`。完整证据见 [`docs/phase-02/03-implementation-report.md`](docs/phase-02/03-implementation-report.md)。
- [x] 完成 **Phase 03**：Surface 五类证据与优先级、`exportKind`/`isTypeOnly`/`runtimePresent`、按 root 的 `surface.json`、`nexus.baseline.json`、`api-snapshot`、`api-diff`（breaking/additive/internal/ambiguous）、`@deprecated` 继任者链路、F07 夹具。
- [x] 负责人指定遗留补齐：SQLite 单事务 + 迭代器分批边算边写，移除 `references.map` / `mappingRows` / `qualityBySymbolId` 全量副本，历史表改为 SQL 临时表；`writeBatches` 写入 manifest。
- [x] Phase 03 验证：`npm test` 73 项；F07 evidenceSource/exportKind 覆盖率 100%；反向误报 0；基线两次逐字节一致；`act -j verify --container-options "-m 4g" --action-offline-mode` 结果见报告。
- [x] **Phase 03 已由负责人 2026-11-13 以 pass 关闭**；同时批准进入 **Phase 04（关系图与架构分析）**，裁定见 [`docs/phase-03/00-entry-and-decisions.md`](docs/phase-03/00-entry-and-decisions.md) §8。
- [x] **Phase 04 已由负责人 2026-11-13 以 pass 关闭**：文件/模块依赖图、静态调用图、架构模块与 `allow` 规则、S1 样式链、跨 root 边界、盲区清单、`nex deps`、schema v3；本地 79 项 + act Node 22/24 双矩阵 79 项通过。报告见 [`docs/phase-04/03-implementation-report.md`](docs/phase-04/03-implementation-report.md)。
- [x] **Phase 05 已由负责人以 pass 关闭**：`nex impact` / `preflight` / `postflight` / `verify`、5.9 根路由、`tests` 表（schema v4）、F08/F12 夹具与 F14 路由断言；certain 口径 F08 消费方 0 漏报；执行前后 `git status` 无新增残留。报告见 [`docs/phase-05/03-implementation-report.md`](docs/phase-05/03-implementation-report.md)。
- [x] **Phase 06 已实现（pass-with-limits）**：内容 Hash 变更检测与 12.1 失效表、`nex update`（按 root 保守重建、`--rebuild-affected` / `--files`）、12.3 提交协议补全与七注入点恢复、12.4 五态状态机、5.10 资源协调器与降级阶梯、5.11 `tsconfigHash`、12.2 十项等价门禁、F16/F18 夹具、`tools/perf` P1–P8 采集；本地 111 项 + act Node 22.16.0 / 24.x 双矩阵 111 项通过。**P3/P6 未达 16.2 目标**，F18 默认串行；详见 [`docs/phase-06/03-implementation-report.md`](docs/phase-06/03-implementation-report.md)。

### 8.2 Phase 00 验证结果

| 组                  | 结果            | 关键指标                                                                                         |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| G1 SCIP↔TS          | pass            | 43/43 声明 exact；falseMatch 0                                                                   |
| G2 Vue              | pass-with-limit | 6/6 用户符号；component-use / event / directive / prop / interpolation 边齐全；`vue-tsc` 0 error |
| G3 重导出/合并/跨包 | pass            | 6/6 场景                                                                                         |
| G4 身份迁移         | pass            | 8/8 场景                                                                                         |
| G5 崩溃恢复         | pass-with-limit | 7/7 注入点 + 2 非法态                                                                            |
| G6 双 Node          | pass            | 22.16.0 / 24.22.2 的 install、build、test、API 探针全部通过                                      |
| G7 RSS              | pass-with-limit | 50k：中位 301.8 MB；300k：中位 652.0 MB；查询常驻约 36–37 MB                                     |
| G8 调度             | pass-with-limit | 五级降级顺序、取消、失败隔离、旧索引保留                                                         |
| G9 配置安全         | pass-with-limit | 7/7 恶意用例 + E18                                                                               |
| G10 全量/增量       | pass-with-limit | 10/10 字段相等；复用 12/20 文件                                                                  |
| MCP 协议探针        | pass            | 双 Node 版本 initialize → tools/list → echo；协议 2025-11-25                                     |

工程检查仍通过：`npm run typecheck`、`npm run lint`、`npm run build`、`npm run format:check`、`npm test`（52 项）。**Phase 00 的 pass-with-limit 限制必须与结果一起引用，不能只写“通过”。**

### 8.2.1 Phase 01 验证结果

| Gate          | 结果 | 关键证据                                                                                                 |
| ------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| G1 构建       | pass | Node 22.16.0 / 24.22.2 下 build、typecheck、lint、format:check 退出 0；连续两次构建产物哈希一致          |
| G2 单仓库索引 | pass | F01 上 `init` + `build` 退出 0，生成独立 root 索引与 manifest                                            |
| G3 引用正确性 | pass | F01 20 个公共符号、F10 11 个公共符号与 tsserver Oracle 全量对照，0 漏报 / 0 误报                         |
| G4 输出一致   | pass | F01 `references add` 的 pretty / lines / json / markdown 条目数一致，均为 7；lines/json/markdown 无 ANSI |
| G5 非 TTY     | pass | 无输入管道下所有命令 5s 内退出；缺参数 64；`--yes` 路径成功                                              |
| G6 配置安全   | pass | F17 未授权 E18、越界读写/网络/子进程被拒；项目 scripts 未执行；恶意命令 E17                              |
| G7 双 Node    | pass | 22.16.0 / 24.22.2 的 build、typecheck、52 项测试、CLI 基础链路                                           |
| G8 自审       | pass | 实施报告、测试证据、已知问题、自审回执齐全；工作区无验证残留                                             |

完整报告见 [`docs/phase-01/03-implementation-report.md`](docs/phase-01/03-implementation-report.md)。

### 8.2.2 Phase 02 验证结果

| Gate           | 结果 | 关键证据                                                                                         |
| -------------- | ---- | ------------------------------------------------------------------------------------------------ |
| G1 构建        | pass | build / typecheck / lint / format:check 退出 0；两次构建 dist 哈希一致                           |
| G2 投影        | pass | F05 5/5 SFC、semantic-map 2/2 投影成功；同 SFC 单次投影                                          |
| G3 坐标 V1     | pass | `.vue` 符号 + 模板边共 59 点全部通过源码位置、标识符文本与 Volar 往返；构建后 `.nexus/tmp/` 为空 |
| G4 过滤 V2     | pass | F05 / semantic-map 用户符号集合与 golden 0 missing / 0 extra；DB 无 `__VLS_`                     |
| G5 模板边 V3   | pass | 组件标签 3、模板绑定 12、插值 6、动态参数 1；成员表达式 heuristic；删除 handler 后边消失         |
| G6 组件模型 V4 | pass | `propsCoverage` 4/4、1/1、2/4；`any` / `never` 逐条 reason；slot never heuristic                 |
| G7 合并映射 V6 | pass | T09 全部用户符号产出 `symbol_map`；合成组件登记 unmapped；`falseMatchCount = 0`                  |
| G8 输出        | pass | 四格式字段一致；`--no-template` 声明；无 ANSI / 绝对路径 / `__VLS_`                              |
| G9 回归        | pass | F01/F10/F15/F17 既有 52 项 + 新增 6 项全绿；`update` / `status --json-schema` 仍 E24             |
| G10 自审       | pass | 报告、证据、已知问题、自审回执齐全；工作区无验证残留                                             |

### 8.2.3 Phase 03 验证结果

| Gate              | 结果 | 关键证据                                                                                                                                                                       |
| ----------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G0 边算边写       | pass | `BuildWriter` 单事务 + 迭代器分批；`references.map` / `mappingRows` / `qualityBySymbolId` 全量副本移除；历史表 SQL 临时表；F07 `writeBatches=1`，writer 测试 1200 行/回滚      |
| G1 构建           | pass | `npm run build`、`typecheck`、`lint`、`format:check` 退出 0                                                                                                                    |
| G2 Surface 完整性 | pass | F07 33 条 public 记录，`primaryEvidenceSource` / `exportKind` 覆盖率 100%；internal 不进入 public                                                                              |
| G3 证据与优先级   | pass | 条件 `types/import/require`、子路径 `./utils`、通配 `./advanced/feature`、多层 barrel、manual override 均有断言                                                                |
| G4 快照           | pass | 同 fingerprint 两次 `nexus.baseline.json` 逐字节一致；证据来源变化后 `surfaceHash` 必变；无时间戳/行号/绝对路径                                                                |
| G5 差分           | pass | breaking / additive / internal / ambiguous 各 ≥1；`--fail-on` 命中 1、仅 ambiguous 警告 2、干净 0                                                                              |
| G6 弃用           | pass | `oldAdd` resolved 到 `add`；`doomed` no-successor + removalVersion；deprecated 删除仍 breaking                                                                                 |
| G7 回归           | pass | `npm test` 73 项；F01/F05/F10/F15/F17 不回归；`update` / `status --json-schema` 仍 E24                                                                                         |
| G8 输出           | pass | 四格式同源；无 ANSI / 绝对路径 / 时间戳；lines/json 稳定                                                                                                                       |
| G9 act CI         | pass | `act -j verify --container-options "-m 4g" --action-offline-mode`：Node 22.16.0 与 24.22.3 两个矩阵各 73 项通过（首次不加 `--action-offline-mode` 因 GitHub 连接失败，见报告） |
| G10 自审          | pass | 报告、任务回填、已知限制、自审回执齐全；工作区仅负责人 `.actrc` 与本轮变更                                                                                                     |

### 8.2.4 Phase 06 验证结果

| Gate | 结果 | 关键证据 |
| --- | --- | --- |
| G0 变更检测/失效表 | pass | 12.1 规则表；A/M/D/R；mtime 同内容不触发；config/tsconfig → full |
| G1 Update/提交 | pass | 无变化零写；增量重建；失败保留旧 committed；锁与恢复 |
| G2 增量=全量 | pass | 十项全等；F08 四类变更；10k 夹具 `buildFingerprint` 相同 |
| G3 崩溃恢复 | pass | F16 七注入点；manifest-repaired / pending-discarded / stale-surface |
| G4 状态机 | pass | 五态转换表；dirty/indexing；doctor 非法转换 |
| G5 调度与降级 | pass（串行） | 预算/权重/依赖顺序/五级阶梯/E20/取消无提交/旧索引保留 |
| G6 指纹 | pass | 字段齐全；`tsconfigHash` 规范化；同输入可复现；platform/gitCommit 不单独触发 |
| G7 构建与回归 | pass | build/typecheck/lint/format:check 退出 0；111 项测试全绿 |
| G8 性能与内存 | **partial** | P1/P2/P4/P5/P6/P8 有记录；P3 1k/5k/10k 为 2.48/3.49/5.31s，**超 2s**；P6 10k p95 46.5ms **超 30ms**；P7 `not-available` |
| G9 输出与 CLI | pass | update 四格式同源；无 ANSI/绝对路径/时间戳；退出码 0/1/64 |
| G10 act | pass | `act -j verify --container-options "-m 4g" --action-offline-mode`：Node 22.16.0 / 24.x 双矩阵各 111 项，`Job succeeded` ×2 |
| G11 文档 | pass | README（含目录结构）、docs/README、runtime-api、phase-06 四份文档、报告 |
| G12 自审 | pass（报告层） | 任务回填、已知问题、自审回执、`git status` 无验证残留 |

**性能实测摘要**（3 次中位/最大）：

| 场景 | 1k 行 | 5k 行 | 10k 行 | 5 万行档目标 | 结论 |
| --- | --- | --- | --- | --- | --- |
| P1 冷启动全量 | 2.43/2.46s | 3.25/3.25s | 4.09/4.10s | ≤ 20s | pass |
| P3 单文件增量 | 2.48/2.50s | 3.49/3.50s | 5.31/5.33s | ≤ 2s | **未达标** |
| P4 20 文件增量 | 2.48/2.48s | 3.47/3.47s | 5.27/5.33s | ≤ 8s | pass |
| P5 多 root | 4.51s（3 root 串行） | — | — | 无数值目标 | 记录（串行） |
| P6 查询 p50/p95 | 9.6/10.2ms | 25.9/27.0ms | 44.3/46.5ms | ≤ 30ms | **未达标（10k）** |
| P7 MCP | — | — | — | — | not-available（Phase 07） |
| P8 崩溃恢复 | 12ms | — | — | ≤ 5s | pass |

峰值 RSS：1k 192.4 MB；5k 211.1 MB；10k 227.7 MB（5 万行档目标 ≤400 MB，硬上限 550 MB）。SQLite（含 WAL）：1.38 / 6.11 / 12.06 MB。**50k/300k/1M 未测，不外推。**

### 8.3 明确未完成

- **Phase 06 已实现（pass-with-limits），等待负责人评审；尚未进入 Phase 07**。Phase 06 的 `update` / 恢复 / 状态机 / 调度器 / 指纹与 12.2 门禁已提供；MCP 8 工具、`print` 物料、`doctor --repair`、`nex test` 与发布验证仍未完成，相关命令返回 E24。
- **文件级增量未实现**：`update` 以 root 为保守重建单位；单文件修改会重建整个 root。P3 目标（5 万行 ≤ 2s）在 1k/5k/10k 实测中未达到，报告已显式标注。
- **多 root 并行未启用**：调度器计算并发上限，但默认并发位 1（内存安全）；F18 以串行口径记录，不宣称并行加速。
- **P7（MCP 延迟）不可用**：MCP server 属 Phase 07；性能报告将其记为 `not-available`，不以 0 或伪造值代替。
- `packages/mcp` / `packages/adapter-vue` 仍是占位入口；`nexus.baseline.json` 由项目按需生成并提交，本仓库根未提交默认基线。
- `status --json-schema`、`doctor --repair` / `--mcp`、`print`、`mcp`、`context`、`similar`、`audit-duplicates`、`test` 仍返回 E24；`--pager` 不启动外部分页器。
- Vue 语义仅覆盖 Phase 02 范围：真实 TS 文件 import `.vue` 的跨语言边可能缺失；复杂 Props / Slot 未解析时显式 heuristic；`vue.typeResolver` 不执行。
- 未执行发布验证（`npm pack` 12 项）与 changesets 发布流程；包仍为 `private: true`。
- SCIP 子进程峰值 RSS 未采集（`scipPeakRssMB: null` 并带原因）；F16 使用 SIGKILL 自终止而非物理断电；G8 内存压力为模拟；G9 非 OS 级网络沙箱；百万行档按负责人批准未验证。

---

## 9. 后续开发阶段

阶段划分与门禁以 [`docs/19-delivery-phases.md`](docs/19-delivery-phases.md) 为准：

| 阶段 | 名称                 | 进入条件                                     |
| ---- | -------------------- | -------------------------------------------- |
| 00   | 可行性验证与定位校验 | **已完成**（11/11，含 6 项 pass-with-limit） |
| 01   | 骨架与 TS 索引       | **已关闭**（pass-with-limits，负责人接受）   |
| 02   | Vue 语义与引用查询   | **pass；V1–V4/V6 通过，已获准进入 Phase 03** |
| 03   | API Surface 与基线   | **已关闭**（pass；负责人 2026-11-13 接受）   |
| 04   | 关系图与架构分析     | **已关闭**（pass；G0–G10 通过）              |
| 05   | 影响分析与审计       | **已关闭**（pass；G0–G12 通过）                    |
| 06   | 增量、性能与一致性   | **pass-with-limits；等待负责人评审**（P3 未达标）  |
| 07   | 复用性、MCP 与交付   | Phase 06 通过                                |

**Phase 00 的结论具有否决权**：任一 P0 项无法验证通过，必须停止并提交架构调整申请，不得"先做着看"。Phase 00–05 已关闭；Phase 06 已实现并通过一致性/恢复/调度/指纹/状态机门禁，但 P3 性能目标未达，按 `pass-with-limits` 等待负责人裁定；**未经书面批准不得进入 Phase 07**。

未来接入顺序（工具实现后，按 21.1）：安装 → 手动接入（MCP / AGENTS.md / Skill）→ `nex init` → `nex build` → `nex status`。工具只打印接入物料，不代写任何配置文件。

---

## 10. 能力边界与承诺口径

| 概念                 | 含义                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `certain`            | 在支持的语言、语法、配置与依赖范围内，可由 TS / Vue 语义判定的关系；覆盖完整且分析成功时承诺 0 漏报 |
| `heuristic`          | 由名称、结构、路径、相似度推断；必须标注，不承诺完整                                                |
| `dynamic-unresolved` | 动态 import、运行时拼接路径、反射、运行时注册等；明确不保证识别，输出 `!` + reason                  |
| `partial`            | 映射不完整或覆盖不完整；此时禁止使用"全集""已全部列出"                                              |
| 索引五态             | `fresh` / `dirty` / `indexing` / `stale` / `failed`；非 fresh 必须声明影响                          |

对外文案禁止出现："完整调用图"、"零漏检 / 100% 准确"（无限定）、"始终实时"、"符号 ID 永不变"、"节省 Token"、"自动修复索引"。

---

## 11. 安全与隐私边界

以下为**产品约束（Phase 01–06 已按此实现，后续阶段继续遵守）**：

- 默认只读、默认离线；打开项目、扫描目录、建立索引、响应查询、启动 MCP 均不得执行被分析项目的代码。
- 配置文件默认是 `.nexus/nexus.config.json`（纯数据，Zod `strict()`）；`.ts` 配置是可执行代码，必须显式授权，且在独立子进程中加载、禁网、限时。
- 不隐式运行 `package.json` 的 `prepare` / `postinstall` / 构建脚本，不自动安装依赖，不执行任意 shell 命令。
- 不读取项目根之外的文件；默认排除 `.env*`、密钥、证书、依赖与构建产物。
- `verify` 的自定义命令只能来自显式授权白名单，逐条回显、超时、输出大小上限。
- `doctor --repair` 只修 Nexus 自身数据，不改源码与项目配置。

Phase 00 验证只在合成夹具中执行了受限配置与恶意用例；未执行任何真实业务项目代码，未修改用户全局配置。

---

## 12. 已知限制与待确认事项

规范 v1.24 已冻结。Phase 00 与 Phase 01 的完整限制分别见 [`docs/phase-00/02-validation-report.md`](docs/phase-00/02-validation-report.md) 与 [`docs/phase-01/03-implementation-report.md`](docs/phase-01/03-implementation-report.md)。

Phase 06 新增加的限制：

- **增量粒度为 root**：`update` 对受影响 root 做完整重建；单文件修改仍需重建该 root。P3 在 1k/5k/10k 行实测均超过 2s，未达到 16.2 的 5 万行目标；不得把它表述为文件级增量。
- **多 root 默认串行**：调度器计算 `min(配置, 内存/预估峰值, CPU-1)` 的并发位，但默认 `resources.concurrency = 1`；F18/P5 记录的是串行耗时。真并行子进程编排留待后续评审。
- **P7 不可用**：MCP 属 Phase 07，性能报告记 `not-available`；不得用 0 或推测值填补。
- **50k/300k/1M 档未验证**：本阶段只测 1k/5k/10k；16.2/21.2 的更大档位不外推。
- **P8 使用 SIGKILL 自终止**：模拟断电，不等价于物理断电；恢复以 DB/manifest 最终状态与旧索引可读为准。
- **SCIP 子进程峰值 RSS 不可观测**：manifest 记录 `scipPeakRssMB: null` 与原因；父进程 RSS 不得当作 SCIP 峰值。
- **恢复后的 manifest 标记 stale**：当 manifest 由 DB 重建时（`recovered: true`），状态为 `stale`，必须执行一次 `update`/`build` 才回到 `fresh`；这是保守设计，不伪造 freshness。
- **查询期 freshness 使用 stat 快路径**：`statHash`（path/size/mtime）一致时跳过内容 Hash 以控制查询延迟；构建/更新仍以 `filesHash` 为权威。外部工具若保留 size 与 mtime 改写内容，查询可能暂时误判 fresh，直到下一次 `update`/`build`。
- **`status` 的 `dirty` 语义变更**：源文件变化后状态由旧版 `stale` 改为 12.4 规定的 `dirty`；Phase 05 断言已同步。
- **根集合移除不自动删目录**：`update` 不会删除已移除 root 的 `.nexus/roots/<id>`；`doctor` 可诊断，清理留给 Phase 07 `doctor --repair`。新增 root 只建自己的索引，已有 root 不因 `rootSetHash` 变化而重建（17.2 #15）。
- **`resources` 配置新增**：`defaults.resources.maxMemoryMB` / `concurrency`；旧索引首次 `update` 会因 `configHash` 变化做一次完整重建。
- Vue 语义仅覆盖 Phase 02 范围；多 root 查询已支持（Phase 05），但跨 root BFS 仍禁止。
- `--pager` 不启动外部分页器；`--budget-hint` 只记录，不做裁剪；默认不做分页（无静默截断）。
- 双 Node 验证按本机运行时归属执行：PowerShell / fnm 提供 Node 24.22.2，CMD / nvm-windows 提供 Node 22.16.0；不修改项目依赖或用户全局配置。

规范第 0.3 节事项的当前状态：

| 事项                            | Phase 00 后的状态                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| SCIP 与 TS/Vue 语义映射正确性   | 43/43 声明 exact；T01–T09 场景通过；仍限声明级与合成夹具，Vue golden 为人工期望集     |
| 三档内存预算（400/700/1500 MB） | 50k 中位 301.8 MB、300k 中位 652.0 MB 通过；**百万行档按 D4 未测**；G7 未含 SCIP 峰值 |
| 符号身份迁移算法                | 5.2.8 八场景原型 8/8；未接入生产索引                                                  |
| TS 配置授权流程 UX              | E18 / 授权执行原型通过；非 TTY 与交互体验未验证                                       |
| 百万行档性能                    | 按负责人批准不验证，由后续真实项目实测替代                                            |

Phase 00 历史限制（保留记录，已被后续阶段部分覆盖）：

- SCIP 固定 0.4.0；升级到 0.6.x 会引入 TS 6 / Node ≥22.23.4 冲突，需单独决策。
- G5 使用 `process.exit(137)` 模拟崩溃，未用真实 kill -9。
- G8 内存压力为确定性模拟，未接真实 RSS。
- G9 不是 OS 级网络沙箱。
- G10 的引用/依赖/调用边在 Phase 00 为全局重算；Phase 06 已补 12.1 失效表与 root 级保守重建，但文件级局部复用仍未实现。

待确认：

- Phase 06 是否以 `pass-with-limits` 通过并授权进入 Phase 07（P3 性能未达标；**当前等待**）。
- 4 个 workspace 包仍为 `private: true`；Phase 07 发布前需按 changesets 流程调整。
- `npm ci` 完整重装在本地未重跑；Phase 03 以 `npm ci --dry-run` 与 act 容器内 `npm ci` 作为基线，历史记录见 Phase 01 报告 §11。

如发现文档冲突、关键配置缺失或规范无法落实，应按 [`docs/20-prohibitions.md`](docs/20-prohibitions.md) 的 20.6 提交《架构问题报告》，**不得自行作出架构级决策**。

---

## 13. 文档与变更纪律

- `docs/` 是技术规范的唯一权威来源；本 README 与 `.dsh/AGENTS.md` 均不得与其冲突。
- 原始任务书不存放在本仓库；`docs/` 由 v1.24 拆分而来，正文未改写。
- 修改架构、数据模型、公开接口或验收口径，必须经项目负责人确认并形成版本记录；实现者不得就地改写规范。
- 跨章节概念变更必须同步 [`docs/23-conflicts.md`](docs/23-conflicts.md) 或对应章节。
- 阶段报告必须注明所依据的规范版本（v1.24），并按 `docs/19-delivery-phases.md` 19.3 的清单交付。
- 本项目使用 [Apache License 2.0](LICENSE)，版权人为 `anemiamiyo <anemia114514@gmail.com>`（见 [NOTICE](NOTICE)）。
