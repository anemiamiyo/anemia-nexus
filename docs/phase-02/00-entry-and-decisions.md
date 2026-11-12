# Phase 02 入场记录：Vue 语义与引用查询

> 记录日期：2026-11-12（Asia/Shanghai）
> 依据：`docs/19-delivery-phases.md` 19.1/19.3、`docs/04-architecture.md` 4.1/4.3、`docs/05-data-model.md` 5.1/5.2/5.12、`docs/15-output-contract.md`、`docs/17-testing.md`
> 规范版本：v1.24（冻结）
> 前置：`docs/phase-01/03-implementation-report.md`（Phase 01，pass-with-limits）
> 状态：**负责人已书面接受 Phase 01 关闭，并批准进入 Phase 02；本文件同时是 Phase 02 的需求基线。**

## 1. 负责人裁定（2026-11-12）

项目负责人在本会话中书面确认：

1. 接受 Phase 01 以 **pass-with-limits** 关闭；
2. 批准进入 **Phase 02（Vue 语义与引用查询）**；
3. 允许 Phase 02 **复用** Phase 01 的 SQLite schema、SCIP 适配层与输出契约，**不改变 v1.24 技术结论**；
4. 进入 Phase 02 开发前，先明确任务需求、生成阶段文档，再按完整任务清单实施。

本记录将上述裁定固化为 Phase 02 的入场依据。`docs/phase-01/03-implementation-report.md` 追加 §12 记录同一裁定；Phase 01 报告正文不改写。

## 2. 对“是否现在补齐四项”的判断

Phase 01 报告 §10 请求负责人决定四项补齐事项。负责人授权由实施方自行判断“是否现在需要、是否影响后续”。逐项裁定如下：

| 事项 | 是否在 Phase 02 前补齐 | 判断依据 | 后续归属 |
|---|---|---|---|
| 多 root 查询合并（`symbol` / `references` 的 `--roots all`） | **否** | 19.1 把多 root 查询期路由放在 Phase 05（5.9）；Phase 02 的验收夹具 F05/T09 均为单 root；此时补齐会改动查询层的 root 聚合语义，早于依赖图与 impact，返工风险高 | Phase 05（5.9、19.1 阶段 05） |
| `status --json-schema` | **否** | 11.4 要求 JSON 模式严格遵循版本化 Schema，但 Phase 02 的 gate 不涉及该参数；Schema 需要先稳定 Phase 02 新增字段（component、coverage.filteredInternal、vue 统计），提前冻结会立即过期 | Phase 03 或 Phase 07 随输出 Schema 冻结 |
| SCIP 子进程峰值 RSS 采集 | **否** | 16.2 的八类性能场景与 21.2 的内存预算属于 Phase 06；Phase 02 只记录可观测耗时，不宣称性能达标；采集子进程 RSS 需要改动 SCIP 适配层与平台采样，属于性能阶段工作 | Phase 06（16.2、21.2、19.1 阶段 06） |
| `npm ci` 完整基线 | **是（已完成非破坏性验证）** | 完整重装会破坏已验收的 `node_modules`；`npm ci --dry-run` 退出 0 已能证明 lockfile 与 package.json 一致，足以作为基线证据 | 已记录于本文 §7；完整重装留到干净环境/发布验证 |

补充说明：Phase 02 不会把上述未补齐项标记为已完成；`status --json-schema` 仍返回 E24，多 root 查询仍返回 E24，manifest 的 `scipPeakRssMB` 仍为 `null` 并附原因。

## 3. 复用授权与边界

允许复用（不重写、不改变语义）：

- **SQLite schema**：v1 的 `files` / `symbols` / `references` / `symbol_map` / `symbol_id_history` / `build_record` 列语义不变。Phase 02 只做**加表、加可空列**的兼容性扩展（4.1.1 明确要求新增 `vue_file_meta`；5.1 要求 Component 实体），`schemaVersion` 升到 2，旧 v1 库按 5.5 的“不兼容变更默认重建”处理。
- **SCIP 适配层**：`packages/core/src/index/scip.ts` 的契约探针、子进程、超时、解析归一化继续使用；只新增“影子工程 tsconfig 与 document 分类”能力。
- **输出契约**：`QueryEnvelope` / `Counts` / `Coverage` / 四格式渲染 / 退出码 / 错误码继续使用；只做字段新增，不删字段、不改既有字段语义。

不允许：

- 改写 v1.24 的实体、错误码、状态名、关系三分类与四档置信度；
- 用 Vue 专用结构替换统一 Normalizer 输出；
- 引入第三方 SQLite 驱动、持久化影子文件或 map.json sidecar（20.5-24）；
- 把 `ts.Symbol` 或 SCIP 字符串当作对外身份（4.3.1）。

## 4. Phase 02 目标与产出

目标是完成 19.1 阶段 02：

1. `@vue/language-core` 虚拟 TS 投影；
2. 影子物化（`.nexus/tmp/vue/`）与内存映射；
3. 入库前坐标转译（shadow → `.vue` 源码坐标）；
4. `__VLS_` 内部符号过滤（名称 + 可回指双判）；
5. Props / Emits / Slots 抽取与 `propsCoverage`；
6. 四类模板引用边（组件标签、事件/指令绑定、插值、动态参数）；
7. 4.3 的 Semantic Merger 与 `symbol_map`（scip / ts / vue 三引擎）；
8. F05 夹具、V1–V4 与 V6 的自动化断言；
9. status / doctor / references / symbol 的 Vue 可见性；
10. 阶段实施报告与自审回执。

产出文档：

- `docs/phase-02/00-entry-and-decisions.md`（本文件）
- `docs/phase-02/01-task-checklist.md`
- `docs/phase-02/02-plan-and-gates.md`
- `docs/phase-02/03-implementation-report.md`（实现完成后）
- Phase 01 报告 §12 裁定回执
- README / runtime-api / AGENTS 同步更新

## 5. 关键技术决策（实施前冻结）

### 5.1 投影

- 唯一路径：`@vue/language-core@3.3.14` 的 `createVueLanguagePlugin` + `createVirtualCode`，取 `script_ts` 嵌入代码作为影子源文本；**不使用** `phase00/` 原型代码。
- 映射：使用语言的 `mappings`（`generatedOffsets` / `sourceOffsets` / `lengths` / `generatedLengths`）构建偏移映射；仅驻留内存。
- 同一 SFC 只投影一次；投影失败不产出半套语义结论。

### 5.2 影子工程与 SCIP

- 影子目录固定为 `.nexus/tmp/vue/<build-token>/`，镜像 root 相对目录结构：
  - `<rel>.vue.ts`：投影后的 TS；
  - `<rel>.d.vue.ts`：`export *` + `export default` 转发 shim，使 `import X from './X.vue'` 在 `allowArbitraryExtensions` 下可解析。
- 生成临时 tsconfig（写在影子目录，不写项目配置）：
  - `files` = 真实 tsconfig 的 `fileNames` ∪ 影子文件 ∪ shim；
  - `rootDirs` = `[shadowRoot, rootAbs]`，使影子文件的相对 import 解析到真实源码；
  - `compilerOptions` 继承真实 tsconfig 的语义相关字段（target / module / moduleResolution / strict / jsx / baseUrl / paths / types / typeRoots / lib 等），并加 `allowArbitraryExtensions: true`、`noEmit: true`。
- 每个 root 在有 `.vue` 文件时执行**一次** SCIP：`--cwd <rootAbs> -p <shadowTsconfig>`。真实 TS document 的路径与普通构建一致；影子 document 路径以 `.nexus/tmp/vue/` 前缀识别。**不**为 Vue 单开第二次 SCIP。
- 已知限制：镜像只覆盖可解析到影子 shim 的 `import '*.vue'`；真实 TS 文件 import `.vue` 时是否解析由 `allowArbitraryExtensions` + shim 决定，若真实 tsconfig 的 include 不覆盖该 `.vue`，该边仍缺失。此项登记为 Phase 02 限制，不冒充已解决。

### 5.3 坐标转译与 `__VLS_` 过滤

- SCIP occurrence 的列按 UTF-8 byte 计；投影映射按 UTF-16 code unit 计。转译必须做 byte→UTF-16 换算后再映射到源码 offset，最后以源码 UTF-16 行列入库。
- 入库坐标只写 `.vue` 源码坐标；影子文本、映射段、token 不写入 DB、不写入 manifest。
- 过滤三规则（4.1.2）：
  1. name 前缀 `__VLS_` 且无法回指 → 内部；
  2. 声明位置不能映射回 `.vue` 源码 → 丢弃，不论名字；
  3. 引用边目标为内部符号 → 丢弃。
- 计数：`coverage.filteredInternal`；references 输出出现 `__VLS_` 即构建失败（E11）。

### 5.4 组件模型

- 每个 SFC 生成一个 `component` 符号：名称取文件名去 `.vue`；`declarationLocator` 锚定 `<script` 起始位置；无 SCIP 对等体，映射表登记 `engine=vue / match_quality=exact` 与 `engine=scip / unmapped / reason=synthetic-component`。
- Props / Emits / Slots 既写入 `components` 表，也作为组件成员符号（`nameChain = <组件名>.<成员名>`）参与引用目标解析；组件成员**不计入** V2 的“用户符号集合”（该口径与 Phase 00 的 golden 一致，见 §6.2）。
- `propsCoverage = { resolved, total, unresolved[] }`；类型含 any / never / error 或无法在完整 Program 中解析时标 `heuristic` 并附 reason，不当作确定结论。
- 未解析的模板标识符若与组件已声明 prop 同名，按 prop 目标回退解析，并**一律标 `heuristic`**（名称证据，falsifiable）；该规则不用于连接同名 template-local 变量。
- `withDefaults` / 复杂 Props 按 4.1.3 降级，不引入第三方 type-resolver；`vue.typeResolver` 在 Phase 02 返回明确“不支持”警告，不静默执行。

### 5.5 模板引用边

- 边的 source 是映射回 `.vue` 的精确位置；target 是 script 符号的 `symbolId`；kind 取 4.1.4 的固定值：`component-use` / `template-binding` / `interpolation`。
- 四类来源分别断言：组件标签、事件/指令绑定、插值、动态参数。动态参数静态键按 `template-binding` + `certain`；动态键按 `template-binding` + `dynamic-unresolved`（`reason=dynamic-argument-key`）。
- 成员表达式（`obj.save`）的成员标识符按 `heuristic`；同表达式根标识符按 `certain`。
- `--no-template` 排除模板边，并在输出 `notes` 中声明“模板边未纳入”。
- 引用记录以 `role = template:<kind>` 标记，供过滤与渲染；`reason` 仍取 15.6 固定枚举。

### 5.6 Semantic Merger

- 以 `declarationLocator`（path + sourceHash + 名称位置 + kind + 名称链）为锚，按 4.3.2 四步顺序匹配；Vue 声明额外携带**生成位置锚**（仅内存）用于 SCIP 定义匹配。
- `symbol_map` 每符号每引擎至多一行：`scip` / `ts` / `vue`；`unmapped` 与 `ambiguous` 是数据，不是空值。
- 冲突按 4.3.3 裁决：名称链不一致时以 TS Program 为准并降置信度；缺失一方不补齐；重载按序号区分。
- `falseMatchCount` 必须为 0；未映射原因按 `unmappedReasons` 分类计数。

## 6. 验收口径（与 4.1.7 对齐）

### 6.1 V1–V4 / V6

| 项 | Phase 02 判定 |
|---|---|
| V1 影子物化 + 内存映射 + 坐标转译 | 构建后 `.nexus/tmp/` 为空；同指纹重复构建入库坐标逐字节一致；抽样 200 个 `.vue` 来源坐标（不足则全量并记录数量）满足：源码位置存在、标识符文本与符号名一致、经 Volar 映射往返一致 |
| V2 `__VLS_` 过滤 | F05/semantic-map Vue 的用户符号集合与 golden 逐项一致；DB 与输出无 `__VLS_` 幽灵引用；`filteredInternal` 有计数 |
| V3 四类模板边 | F05 对组件标签、事件/指令绑定、插值、动态参数四类各至少 1 条；删除 handler 后引用定位到模板位置（以夹具断言模拟）；动态键为 `dynamic-unresolved` |
| V4 Props 降级与 Slot 标注 | `nex symbol <组件>` 输出 `propsCoverage`；unresolved 逐条附 reason 与类型文本；slot 推断为 never 时标 `heuristic` |
| V6 SCIP ↔ Vue 映射 | T09（semantic-map/vue）全部用户符号产出 `symbol_map`；未映射项（含 synthetic component）全部登记；`falseMatchCount = 0` |

### 6.2 “用户符号集合”的分母定义

为避免 V2 口径漂移，本阶段明确：

- 用户符号集合 = `.vue` 文件 script 中的顶层声明（import 绑定、变量、函数、类、接口、类型别名、枚举、命名空间），名称不以 `__VLS_` 开头、不是 Vue 宏；
- **不含**：组件合成符号、Props / Emits / Slots 成员符号、影子内部符号；
- 该定义与 Phase 00 `g2-vue.json` 的 golden 一致，作为 F05 与 semantic-map Vue 的对照口径。组件成员单独在 `components` 表与 `symbol` 输出中核对。

### 6.3 19.1 阶段 gate

V1–V4、V6 全部通过；`propsCoverage` 正常输出；映射未命中全部登记；无 `__VLS_` 泄漏；F01/F10 的 TS 既有断言不回归。

## 7. 入场检查记录

| 检查 | 命令 | 结果 |
|---|---|---|
| 工作区 | `git status --porcelain` | 空（入场时） |
| 基线 commit | `git log --oneline -1` | `35700f8 docs: 修正 Node/npm 运行时归属与版权人记录` |
| Node | `node -v` | v22.16.0（CMD/nvm-windows；PowerShell 侧另有 v24.22.2） |
| npm | `npm -v` | 10.9.2 |
| lockfile 基线 | `npm ci --dry-run` | 退出 0；新增 75 个平台包、变更 1 个包，均为 dry-run，不写 node_modules |
| 依赖版本 | `package.json` | `@vue/language-core@3.3.14`、`@vue/compiler-sfc@3.5.45`、`vue@3.5.45`、`vue-tsc@3.3.14`、`typescript@5.9.3` |
| SQLite | `node:sqlite`（Node 22.16） | 3.49.1 |

`npm ci` 完整重装仍不在本阶段执行；理由与非破坏性证据见 §2。

## 8. 已知限制（进入实现前登记）

1. 多 root 查询、`status --json-schema`、SCIP 峰值、完整 `npm ci` 不在本阶段（§2）。
2. 真实 TS 文件 import `.vue` 的跨语言边可能缺失（§5.2）。
3. 模板边的成员表达式判定基于源码文本与 AST 局部规则，复杂表达式可能降为 heuristic 或 unresolved。
4. 复杂 Props（条件类型、映射类型、ambient 类型）按 heuristic 降级，不承诺全部 resolved。
5. `vue.typeResolver` 不执行；配置该字段时构建告警并继续。
6. Phase 02 不做增量（`update` 仍 E24）；F05 的全量结果作为增量等价基线留到 Phase 06。
7. SCIP 子进程 RSS 仍不可观测，manifest 记 `null` 与原因。
8. 影子工程包含真实 tsconfig 的 `fileNames`；超大 root 的临时写放大未优化，Phase 06 处理。
9. `@vue/language-core` 的 Volar 内部结构可能随版本变化；升级必须单独立项并触发全局重建（4.1.6）。

## 9. 文档与代码的同步纪律

- 本文件冻结 Phase 02 的范围、口径与限制；实现中发现与 v1.24 冲突时按 20.6 暂停并报告，不自行改写规范。
- 任何验收口径变更必须先更新本文件与 `02-plan-and-gates.md`，再改代码。
- 实施结果只写入 `03-implementation-report.md`，不得回填为“计划已完成”。
