# Phase 02 实施报告：Vue 语义与引用查询

> 依据：`docs/19-delivery-phases.md` 19.1/19.3、`docs/phase-02/00-entry-and-decisions.md`、`docs/phase-02/01-task-checklist.md`、`docs/phase-02/02-plan-and-gates.md`
> 规范版本：v1.24（冻结）
> 日期：2026-11-12（Asia/Shanghai）
> 结论：**V1–V4、V6 与 19.1 阶段 02 gate 通过；`propsCoverage` 正常输出；映射未命中全部登记；Phase 02 记为 pass，等待负责人评审。**

## 1. 授权、基线与范围

- 项目负责人 2026-11-12 书面接受 Phase 01 以 pass-with-limits 关闭、批准进入 Phase 02，并允许复用 Phase 01 的 SQLite schema、SCIP 适配层与输出契约；裁定见 `docs/phase-02/00-entry-and-decisions.md` 与 Phase 01 报告 §12。
- 基线 commit：`35700f8`（Phase 01 关闭后、Phase 02 实现前）。
- 实现范围：`.vue` 扫描、`@vue/language-core` 投影、`.nexus/tmp/vue/` 影子物化与内存映射、坐标转译、`__VLS_` 过滤、Props/Emits/Slots 与 `propsCoverage`、四类模板引用边、Semantic Merger 与 `symbol_map`（scip/ts/vue）、F05 夹具、V1–V4/V6 自动化断言、`references --no-template`、`symbol` 组件块、`doctor --dump-vue-map`。
- 明确未实现：多 root 查询合并、`status --json-schema`、SCIP 子进程峰值 RSS、完整 `npm ci` 重装、增量/失效传播、API Surface、依赖/调用图、impact、MCP 与 `print`。未实现命令仍返回 E24。

## 2. 实际完成内容（19.3 状态标注）

| 模块 | 状态 | 说明 |
|---|---|---|
| `.vue` 扫描与语言标记 | implemented | `scan.ts` 统一发现 `.vue`；忽略/敏感文件/symlink/大小上限与 TS 一致 |
| SFC 投影 | implemented | `project.ts`：`createVueLanguagePlugin` + `script_ts`，单文件单次投影 |
| 影子物化 | implemented | `shadow.ts`：`<rel>.vue.ts` + `<rel>.d.vue.ts` + 临时 tsconfig（`rootDirs`、`allowArbitraryExtensions`） |
| 单次 SCIP | implemented | 有 `.vue` 时一次 SCIP 同时索引真实 TS 与影子；无 `.vue` 回退 Phase 01 路径 |
| 坐标转译 | implemented | SCIP UTF-8 列 → UTF-16 → Volar 映射 → `.vue` 行列；入库只写源码坐标 |
| `__VLS_` 过滤 | implemented | 名称 + 可回指双判；DB/输出无 `__VLS_`；`coverage.filteredInternal` 计数 |
| Props / Emits / Slots | implemented | `defineProps` / `withDefaults` / `defineEmits` / `defineSlots`；类型文本取源码切片 |
| propsCoverage | implemented | resolved/total + unresolved[name,typeText,reason]；any/never/error 逐条标注 |
| 模板引用边 | implemented | component-use / template-binding / interpolation / dynamic-argument；slot 内容、成员表达式、动态参数 |
| Semantic Merger | implemented | 声明位置锚 + 生成位置锚；scip/ts/vue 三引擎；unmapped/conflict 全部登记 |
| symbol_map | implemented | 每符号每引擎一行；合成组件 `vue=exact` + `scip=unmapped(synthetic-component)` |
| SQLite schema v2 | implemented | 新增 `vue_file_meta`、`components`；既有表列语义不变；旧库重建 |
| references | implemented | 默认含模板边；`--no-template` 排除并声明；counts 三分类 |
| symbol | partial | 组件块输出 props/emits/slots/propsCoverage；`surface` 仍 `unknown`（Phase 03） |
| status / doctor | implemented | `capabilities.vue=sfc-semantic`、`templateReferences`、vue 统计；`doctor --dump-vue-map` |
| F05 夹具 | implemented | 5 SFC / 8 文件；22 用户符号、23 条模板边、9 个 Props、heuristic/dynamic 用例 |
| V1 坐标断言 | implemented | 61 点（38 符号 + 23 边）全部通过 |
| V2 过滤断言 | implemented | golden 0 missing / 0 extra / 0 ghost |
| V3 模板边断言 | implemented | 组件 3、模板绑定 12、插值 6、动态参数 1；删除 handler 后该边消失 |
| V4 组件断言 | implemented | 4/4、1/1、2/4；`any`/`never`/slot-never 逐条 reason |
| V6 映射断言 | implemented | T09 全部映射；未映射登记；`falseMatchCount=0` |
| 增量 / 性能 / MCP / Surface | unsupported | 不属于 Phase 02；仍 E24 或未提供 |

### 2.1 组件与边口径（避免误读）

- 组件成员符号（`<Component>.$props.<name>`、`$emits`、`$slots`）用于模板目标解析，**不计入 V2 用户符号集合**；分母定义见 `00-entry-and-decisions.md` §6.2。
- 合成组件符号无 SCIP 对等体：`symbol_map` 中 `vue` 为 `exact`、`scip` 为 `unmapped`（reason `synthetic-component`），不计入 `mappingSuccessRate` 分母。
- 默认值 props 在 Volar 生成代码中经 `__VLS_defaults` 别名解析；当 SCIP 目标为生成别名时，按组件已声明 prop 同名回退，**标 `heuristic`**（名称证据）。
- 动态参数键（`v-bind:[key]`）产出 `dynamic-unresolved` + `dynamic-argument-key`；目标仍记录为 key 的 script 符号，便于 `references` 可见。

## 3. 测试与验证证据

环境：Windows x64；Node **22.16.0**（CMD/nvm-windows，npm 10.9.2）与 **24.22.2**（fnm）；`node:sqlite` 3.49.1（Node 22.16）。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run build`（Node 22.16.0 / 24.22.2） | 0 / 0 | core + cli + mcp + adapter-vue ESM + d.ts；同一 Node 连续两次 dist 哈希一致（8 个产物文件 diff 为空） |
| `npm run typecheck` | 0 / 0 | Node 22.16.0 与 24.22.2 均通过 |
| `npm run lint` | 0 | 0 error |
| `npm run format:check` | 0 | Prettier 通过 |
| `npm test`（Node 22.16.0） | 0 | **58 passed (5 files)**，70.09s |
| `npm test`（Node 24.22.2） | 0 | **58 passed (5 files)**，59.66s |
| `nex init` + `nex build` F05 | 0 | 8 文件 / 47 符号 / 47 引用；Vue 5/5 投影、5 组件、23 模板边 |
| `nex init` + `nex build` semantic-map | 0 | 22 文件 / 54 符号 / 66 引用；Vue 2/2 投影、2 组件、9 模板边 |
| `vue-tsc --noEmit`（F05） | 0 | 0 error |
| `nex references handleSelect --no-template` | 0 | 模板边被排除，`notes` 含“template edges are not included” |
| `nex symbol <component-symbolId>` | 0 | `component` 块含 props/emits/slots/propsCoverage |
| `nex doctor --dump-vue-map src/App.vue` | 0 | 打印投影段与模板范围，不落盘 |
| `npm ci --dry-run` | 0 | lockfile 与 package.json 一致；未重装 node_modules |
| `npm audit --registry=https://registry.npmjs.org --audit-level=high` | 0 | 13 项（1 low / 12 moderate），无 high/critical；均在 ESLint 开发链 |
| `npm pack --dry-run -w anemia-core / anemia-cli` | 0 | 各 3 个文件（dist + package.json）；无 fixtures、`.nexus/`、source map |

### 3.1 V1–V4 / V6 判定

| 项 | 结果 | 证据 |
|---|---|---|
| V1 影子物化 + 映射 + 坐标 | **pass** | 61 点（38 个非组件 Vue 符号 + 23 条模板边）：源码位置存在、标识符文本与名称末段一致、经 Volar 映射往返一致；构建后 `.nexus/tmp/` 为空；同源重建 Vue 行逐字段一致 |
| V2 `__VLS_` 过滤 | **pass** | F05 用户符号集合 22 项、semantic-map 6 项与 golden 完全一致；DB `symbols` 无 `__VLS_`；`coverage.filteredInternal` F05 = 238 |
| V3 四类模板边 | **pass** | F05：component-use 3、template-binding 12、interpolation 6、dynamic-argument 1（`dynamic-unresolved`）；成员表达式 `Formatter.save` heuristic；删除 `@select` 后边 23→22 且仅该边消失 |
| V4 Props/Slot | **pass** | `propsCoverage`：ChildCard 4/4、ListPanel 1/1、UnresolvedProps 2/4；`any`→`type-any`、`never`→`type-never`、slot never→`slot-never` |
| V6 SCIP ↔ Vue 映射 | **pass** | semantic-map T09：11 Vue 符号（9 非组件 + 2 组件）均有 `symbol_map`；组件 `vue=exact` + `scip=unmapped(synthetic-component)`；`falseMatchCount=0` |
| 19.1 阶段 02 gate | **pass** | 上述 V1–V4/V6 全部通过；`propsCoverage` 正常；映射未命中全部登记 |
| G9 回归 | **pass** | F01/F10/F15/F17 既有 52 项 + 新增 6 项全绿；`update` / `status --json-schema` 仍 E24 |

### 3.2 用户符号与边明细（F05）

- 用户符号（22）：App.vue 13（4 组件/组合式导入、`Formatter` 类型导入、`count`/`increment`/`formatter`/`key`/`payload`/`title`、`handleSelect`）；ChildCard.vue 5（`Formatter`、`CardProps`、`props`、`emit`、`fire`）；EdgeCase.vue 2（`version`、`message`）；UnresolvedProps.vue 2（`Deep`、`WeirdProps`）；ListPanel.vue 0。
- 模板边（23）：App 17、ChildCard 3、ListPanel 1、UnresolvedProps 1、EdgeCase 1；其中 certain 20、heuristic 2、dynamic-unresolved 1。
- 组件（5）：App、ChildCard、EdgeCase、ListPanel、UnresolvedProps；Props 合计 9（resolved 7）。

## 4. 性能记录（只代表小夹具，不构成 16.2 达标声明）

| 指标 | F05 | semantic-map |
|---|---|---|
| 文件 / 符号 / 引用 | 8 / 47 / 47 | 22 / 54 / 66 |
| 总耗时 | **2074 ms**（多次 2026–2078 ms；本轮记录 2074 ms） | **2523 ms** |
| scan / vue / scip / map / write | 4 / 555 / 1187 / 6 / 17 ms | 11 / 785 / 1404 / 5 / 16 ms |
| 父进程峰值 RSS（manifest 采样） | 139.7 MB | 138.5 MB |
| CLI workspace 峰值 RSS | 227.5 MB | 269.4 MB |
| SCIP 子进程峰值 | **null**（不可观测，带原因） | **null** |
| index.db / WAL | 241,664 B / 0 B | 233,472 B / 0 B |
| Vue 文件 / 投影 / 组件 | 5 / 5 / 5 | 2 / 2 / 2 |
| filteredInternal / 模板边 | 238 / 23 | 94 / 9 |
| mappingSuccessRate / falseMatch | 1.0 / 0 | 1.0 / 0 |

**不得**把本表外推为 5 万 / 30 万 / 百万行达标；SCIP 峰值、真实项目规模与增量性能未验证。父进程 manifest RSS 与 CLI workspace RSS 是不同采样窗口，均不冒充 SCIP 峰值。

## 5. 已知问题与未完成事项

1. **TS→Vue 跨语言边**：真实 TS 文件 `import './X.vue'` 的边依赖影子 shim 与 `allowArbitraryExtensions`；未被 tsconfig include 覆盖的 `.vue` 仍可能缺失。登记为限制，Phase 06 评估。
2. **默认值 Props 回退为 heuristic**：`__VLS_defaults` 别名无法直接映射到 prop 类型成员，按同名 prop 回退；同名 template-local 变量可能误判，故不标 certain。
3. **Slot 参数文本**：`paramsType` 使用 checker 参数类型拼接（如 `{ props: { title: string; } }`），不是源码原文；仅作诊断用途。
4. **组件同名歧义**：`nex symbol <组件名>` 在 import 绑定与组件合成符号同名时返回 E04；需用 symbolId。组件合成符号命名只取 basename，不含路径。
5. **`vue.typeResolver` 不执行**：配置非空时仅告警 `vue-type-resolver-unsupported`，不运行命令；Phase 02 未实现 opt-in 执行。
6. **多 root 查询 / `status --json-schema` / SCIP 峰值 / 完整 `npm ci`**：按 `00-entry-and-decisions.md` §2 不在本阶段补齐。
7. **真实增量**：`update` 仍 E24；Vue 全量结果作为 Phase 06 增量等价基线，未验证增量。
8. **影子写放大**：影子工程按真实 tsconfig `fileNames` 生成 `files` 清单并写 SFC 副本；大 root 的临时写放大未优化。
9. **`filteredInternal` 定义**：统计被丢弃的 Volar 生成/内部出现次数（非唯一符号数），分母口径已在 manifest 与报告写明。
10. **组件 `signature`**：为 props/emits/slots 摘要字符串（≤500 字符），不是完整类型签名；完整信息在 `component` 块。
11. **真实项目规模**：仅 F05 与 semantic-map 合成夹具；未接入真实 Vue 项目，不宣称 0 漏报。
12. **`npm ci`**：完整重装仍未执行；非破坏性 `--dry-run` 退出 0。

## 6. 依赖与架构变化

- core 新增直接依赖：`@vue/language-core@3.3.14`、`@vue/compiler-sfc@3.5.45`、`@vue/compiler-dom@3.5.45`（精确版本；MIT；官方 registry audit 无 high/critical；`@vue/language-core` 由 Phase 00 已验证）。
- `package-lock.json` 同步：Vue 相关包由 `dev` 转为生产依赖，core workspace 依赖登记更新。
- 新增模块：`packages/core/src/vue/{project,shadow,declarations,references,dump}.ts`；`build.ts` 增加 Vue 管线；`schema.ts` v2；`read.ts` 组件/vue meta 读取；`query/service.ts` 组件与模板过滤；`cli.ts` `--no-template`、`diagnose` 参数与 `--dump-vue-map`。
- 无第三方 SQLite 驱动；无持久化 shadow/map.json；无网络；未执行项目脚本。
- 指纹：`analyzerVersion.vueLanguageCore` / `vueTsc` 从 null 变为锁定版本；schemaVersion 1→2。旧索引需重建（5.5 默认策略）。

## 7. 对后续阶段影响

- Phase 03 可复用：`components` 表、`symbol_map`（vue/scip/ts）、`propsCoverage`、模板边与 `references` 过滤、`symbol` 组件块、`schemaVersion=2`。Surface 判定仍需补 `evidenceSource` / `exportKind`，`surface` 目前 `unknown`。
- Phase 04 可复用模板边与 `analysisEngine` 字段；样式链、依赖/调用图仍需新增。
- Phase 05 需补：多 root 查询合并、模板边纳入 impact、盲区清单。
- Phase 06 需补：增量与失效传播、Vue 投影缓存/写放大优化、SCIP 峰值、增量=全量门禁。
- Phase 07 需补：MCP 工具、`print`、发布验证；`doctor --repair` / `--mcp` 仍 E24。

## 8. 文档同步

- `README.md`：状态、命令、Phase 02 gate、限制与未完成项更新。
- `.dsh/AGENTS.md`：当前状态、命令、阶段纪律更新（不纳入 git）。
- `docs/phase-01/03-implementation-report.md`：追加 §12 负责人裁定，不改写原结论。
- `docs/phase-02/{00,01,02}.md`：新增；本报告为 03。
- `docs/runtime-api.md`：未新增 Node 内置 API；本轮使用 `node:fs` / `node:path` / `node:sqlite` 均为既有登记。
- 未修改 v1.24 规范正文；组件/模板/Schema 口径均引用 4.1/4.3/5.1/5.12。

## 9. 自审回执

**审查范围：**

- 变更文件：见 `git status --porcelain`；核心为 `packages/core/src/vue/*`、`packages/core/src/index/build.ts`、`store/{schema,commit,read,manifest,db}.ts`、`query/service.ts`、`status.ts`、`discovery/scan.ts`、`model.ts`、`index/{analyzer,fingerprint,mapping,scip}.ts`、`packages/cli/src/{cli,render}.ts`、`packages/core/test/vue.test.ts`、`fixtures/F05-vue-sfc/**`、`docs/phase-02/**`、`README.md`、Phase 01 报告 §12、`package-lock.json`。
- 新增 / 修改的 API：`projectVueFile`、`generatedToSource`、`sourceToGenerated`、`templateRangeAt`、`writeShadowProject`、`shadowCompilerOptions`、`collectVueSymbols`、`mapVueSymbolsAndReferences`、`dumpVueMap`、`readComponent`、`readVueFileMeta`、`queryReferences(..., includeTemplate)`、`Coverage.filteredInternal`、`ComponentRecord` / `VueAnalysisSummary`、`SCHEMA_VERSION=2`。
- 关键调用点：CLI `build` → `buildWorkspace` → `analyzeRoot` → `projectVueFile` / `writeShadowProject` / `runScipIndex` / `collectVueSymbols` / `mapVueSymbolsAndReferences` → `commitBuild` → manifest；CLI `references` → `queryReferences` → `readReferencesTo`；CLI `doctor --dump-vue-map` → `dumpVueMap`。

**边界与安全审查：**

| API / 文件 | 风险场景 | 结论 | 代码证据 |
|---|---|---|---|
| `vue/project.ts` | 恶意/超大 SFC、解析异常、绝对路径、Unicode 列 | 已处理：只读已扫描文件、大小上限、异常返回 error、UTF-8→UTF-16 | `packages/core/src/vue/project.ts:107`、`:237` |
| `vue/shadow.ts` | 影子文件残留、路径越界、tsconfig 注入 | 已处理：`rmSync`+finally、路径仅由 root 相对路径生成、tsconfig 写入临时目录 | `packages/core/src/vue/shadow.ts:73`、`:125` |
| `vue/declarations.ts` | `__VLS_` 泄漏、不可回指声明、宏、withDefaults | 已处理：名称+回指双判、内部计数、宏过滤、默认值启发式 | `packages/core/src/vue/declarations.ts:450`、`:469`、`:495` |
| `vue/references.ts` | 生成别名、动态键、成员表达式、重复边、幽灵引用 | 已处理：SCIP 锚 + prop 回退（heuristic）、动态 unresolved、去重、`__VLS_` 过滤 | `packages/core/src/vue/references.ts:135`、`:169` |
| `vue/dump.ts` | 绝对路径、跨 root、超大输出 | 已处理：项目相对路径、root 最长前缀、生成文本上限 | `packages/core/src/vue/dump.ts:58` |
| `index/build.ts` | SCIP 失败、tmp 残留、TS 回退、指纹 | 已处理：try/finally 清理、无 Vue 回退 Phase 01、degraded 记录 | `packages/core/src/index/build.ts:427`、`:571` |
| `store/schema.ts` | 旧库兼容、影子数据落库 | 已处理：v2 显式重建、只存 meta/组件/源码坐标 | `packages/core/src/store/schema.ts:8`、`:138`、`:151` |
| `store/commit.ts` | 部分提交、清理、新表 | 已处理：同一事务、pending 回收/保留策略清理新表 | `packages/core/src/store/commit.ts`（components/vue_file_meta 插入与删除） |
| `query/service.ts` | 模板过滤、组件读取、E24 | 已处理：`includeTemplate` 默认 true、notes 声明、组件缺失不伪造 | `packages/core/src/query/service.ts:438`、`:462`、`:489` |
| `cli.ts` | 参数注入、非 TTY、dump 输出 | 已处理：Commander 枚举、非 TTY 64、dump 只写 stdout | `packages/cli/src/cli.ts:442` |
| `model.ts` | 新增字段破坏消费方 | 显式声明：字段只增不删；`filteredInternal` 必填在内部构造 | `packages/core/src/model.ts:100` |

**递归检查：**

- 是否存在递归：产品新增代码使用显式栈/队列与循环；`collectVueSymbols`、`references`、`shadow`、`dump` 无递归。
- 是否已转换为迭代：是（AST/模板遍历、组件成员遍历均为 `for` / `while` + 显式栈）。
- 如保留递归：无。`@vue/language-core` / `@vue/compiler-dom` 内部实现不在本仓库代码范围。

**测试结果：**

- 类型检查：Node 22.16.0 与 24.22.2 均通过（`tsc --noEmit -p tsconfig.typecheck.json`）。
- Lint：`npx eslint packages tools` 通过（0 error）。
- 单元 / 集成测试：`npx vitest run` → **58 passed (5 files)**（Node 22.16.0 70.09s；Node 24.22.2 59.66s）。
- 构建：Node 22/24 全包构建通过；Node 22 连续两次 dist 哈希一致。
- 未执行项目及原因：`npm ci` 完整重装（非破坏性 `--dry-run` 通过）、真实百万行/30 万行项目、真实 kill -9、SCIP 子进程 RSS、MCP/发布验证（均非 Phase 02 范围）。

**已知缺陷：**

见 §5 的 12 项；均为已披露限制或后续阶段工作，不存在未披露的本阶段正确性缺陷。

**兼容性影响：**

- 新增 `.nexus/` schema v2 与 Vue 表；Phase 01 索引需重建（索引是派生物，`doctor` 给重建建议）。
- 公开 CLI 参数新增 `--no-template` 行为（此前为占位语义）与 `doctor --dump-vue-map`；未删除既有参数。
- 输出契约只加字段（`coverage.filteredInternal`、`component`、`vue`、`manifest.stats.falseMatchCount`），未改既有字段语义。
- 未修改用户源码或项目配置；`.nexus/tmp` 构建后清空。

## 10. 负责人评审请求

请负责人决定：

1. 是否接受 Phase 02 以 **pass** 关闭，并批准进入 Phase 03（API Surface 与基线）；
2. 是否要求先补齐 §5 的任一项（尤其 TS→Vue 跨语言边、真实项目样本）再评审；
3. 是否允许 Phase 03 复用本阶段的 `components`、`symbol_map`、`propsCoverage` 与 `schemaVersion=2`（不改 v1.24 技术结论）。

## 11. 附录：任务清单执行结果

| 分组 | 结果 | 主要证据 |
|---|---|---|
| A 入场与裁定 | 完成 | 00 文档、Phase 01 §12、`npm ci --dry-run` |
| B 依赖/构建/版本 | 完成 | package.json、ANALYZER_VERSION、Node 22/24 build+typecheck |
| C 扫描与投影 | 完成 | F05 5/5 投影；`scan.ts` / `project.ts` |
| D 影子与 SCIP | 完成 | 单次 SCIP、tmp 清空、无持久化 |
| E 坐标/过滤/身份 | 完成 | V1/V2；两次构建一致 |
| F 组件模型 | 完成 | V4；5 组件、9 props、2/4 unresolved |
| G 模板边 | 完成 | V3；23 边、四类齐备、删除 handler 用例 |
| H Semantic Merger | 完成 | V6；`falseMatchCount=0` |
| I 存储/Schema | 完成 | schema v2、components/vue_file_meta、事务/清理 |
| J 查询/输出/CLI | 完成 | references/symbol/status/doctor；`--no-template` |
| K status/doctor/能力 | 完成 | capabilities、dump-vue-map、E24 保持 |
| L 夹具/Oracle | 完成 | F05 golden、semantic-map T09、`vue-tsc` 0 |
| M 测试/门禁 | 完成 | 58 项、V1–V4/V6、格式/ANSI/非 TTY |
| N 性能/可观测 | 完成（小夹具） | 耗时/RSS/DB/coverage；不宣称 16.2 |
| O 文档/报告/自审 | 完成 | README、AGENTS、本报告、自审回执 |
