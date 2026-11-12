# Phase 02 实施计划与验收门槛（编码前冻结）

> 依据：`docs/19-delivery-phases.md` 19.1/19.2/19.3、`docs/04-architecture.md` 4.1/4.3、`docs/05-data-model.md` 5.11/5.12、`docs/12-indexing.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md`
> 入场判定：`docs/phase-02/00-entry-and-decisions.md`
> 规范版本：v1.24（冻结）
> 冻结日期：2026-11-12
> **本文件的阈值在编码开始前冻结；不达标时按 20.6 报告，不得事后调低。**

## 1. 范围与不变量

### 1.1 本阶段范围

- `.vue` 扫描、虚拟 TS 投影、影子物化、坐标转译、`__VLS_` 过滤；
- Props / Emits / Slots、`propsCoverage`；
- 四类模板引用边；
- Semantic Merger 与 `symbol_map`（scip / ts / vue）；
- F05 夹具与 semantic-map Vue（T09）；
- status / doctor / references / symbol 的 Vue 可见性；
- 阶段报告、自审与交接。

### 1.2 不变量（违反即 gate 失败）

1. 每个 root 独立索引；不产生跨 root 合并索引。
2. 对外身份只用 `symbolId`；SCIP 字符串、`ts.Symbol`、Volar 节点 id 只作映射引用。
3. 查询与目标符号不含 `__VLS_`。
4. 影子文本、映射段不落 DB、不落 manifest、不落输出。
5. 不把 heuristic 当 certain；不把 unresolved 当不存在。
6. 不删除既有字段、不改错误码语义、不降低既有测试断言。
7. 不执行项目脚本、不联网、不引第三方 SQLite 驱动、不持久化影子文件。

## 2. Gate 定义

| Gate | 判定 | 通过条件 | 证据 |
|---|---|---|---|
| **G1 构建** | 可构建、可类型检查 | `npm run build`、`npm run typecheck`、`npm run lint`、`npm run format:check` 退出 0；连续两次 dist 哈希一致 | 命令输出与哈希 |
| **G2 投影** | SFC 可投影且可重复 | F05 与 semantic-map Vue 全部 SFC 投影成功；同一 SFC 单次投影；两次构建影子段一致 | 测试 + 投影计数 |
| **G3 坐标** | 入库坐标正确 | V1：抽样 200 点（不足全量）源码位置存在、标识符与符号名一致、经 Volar 映射往返一致；构建后 tmp 为空；重复构建坐标逐字节一致 | 测试 V1 + tmp 断言 |
| **G4 过滤** | 内部符号不外泄 | V2：用户符号集合与 golden 0 missing / 0 extra；DB 与四格式无 `__VLS_`；`filteredInternal > 0` 或登记为 0 的原因 | 测试 V2 + SQL 扫描 |
| **G5 模板边** | 四类边齐备 | V3：组件标签、事件/指令、插值、动态参数各 ≥1；动态键 `dynamic-unresolved`；`--no-template` 有声明；删除 handler 定位正确 | 测试 V3 + CLI |
| **G6 组件模型** | Props/Emits/Slots 可用 | V4：`propsCoverage` 正常输出且分子分母可核对；unresolved 逐条 reason + 类型文本；slot never 标 heuristic | 测试 V4 + `nex symbol` |
| **G7 合并映射** | Semantic Merger 可审计 | V6：T09 全部用户符号产出 `symbol_map`；unmapped 全登记；`falseMatchCount = 0`；mappingSuccessRate 分子分母写明 | 测试 V6 + DB |
| **G8 输出** | 四格式同源且稳定 | counts/coverage/truncated/nextCursor/staleness 一致；lines/json 同指纹逐字节一致；无 ANSI、无绝对路径、无 `__VLS_` | 格式测试 |
| **G9 回归** | 既有能力不退化 | F01/F10/F15/F17 既有测试全绿；`update` / `status --json-schema` 仍 E24；非 TTY 5s 退出 | 测试输出 |
| **G10 自审** | 报告与证据齐全 | 19.3 九项结构、自审回执、已知问题、工作区无验证残留 | 报告 + `git status` |

**19.1 阶段 02 通过条件**：4.1.7 的 V1–V4、V6 全部通过；`propsCoverage` 正常输出；映射未命中全部登记。任一不满足 → 修复后重跑；映射率不达标按 20.3 上报，不得降低门槛。

## 3. V1–V4 / V6 的量化口径

### 3.1 V1 坐标（200 点）

样本：F05 中由 `.vue` 产生的符号 + 引用，按 `(path, line, col)` 排序后用固定种子抽样 `min(200, N)` 个；记录实际 N。

每点断言：

1. `path` 存在于 `.vue` 文件集；`line/col` 落在文件范围内。
2. 源码在该位置开始的标识符文本等于符号名（允许 `$`/Unicode 标识符；不允许多字符错位）。
3. 重新投影该文件，用 Volar 的 `SourceMap` 以“入库源码 offset → generated offset → source offset”往返，结果等于原 offset；若该位置是合成符号（组件），跳过并在报告中单列数量。
4. 重复构建（同源）后该点坐标逐字节一致。

样本不足 200 时以实际 N 记录，并在报告中说明原因；不得用映射段本身冒充“符号/引用”。

### 3.2 V2 用户符号集合

- 口径见 `00-entry-and-decisions.md` §6.2：script 顶层声明（import/变量/函数/类/接口/类型/枚举/命名空间），排除组件合成符号、组件成员、`__VLS_`。
- 对照源：`fixtures/F05-vue-sfc/expected/symbols.json` 与 `fixtures/semantic-map/vue/expected/symbols.json`（由 language-core 投影 + vue-tsc 抽样人工核对生成，不由本工具自证）。
- 判定：`missing = 0`、`extra = 0`、`ghost = 0`；差异逐条列出。

### 3.3 V3 四类模板边

F05 必须同时满足：

| 类别 | 最小条数 | 判定 |
|---|---|---|
| 组件标签 `component-use` | ≥1 | target 为 script 符号；位置在标签名起始 |
| 事件/指令 `template-binding` | ≥2（事件 + 指令各 1） | 表达式标识符位置；relationClass=certain（标识符） |
| 插值 `interpolation` | ≥2（含 1 条 slot 内容内） | 位置在 `{{ }}` 内 |
| 动态参数 | ≥1 动态键 + ≥1 静态键 | 动态键 relationClass=dynamic-unresolved、reason=dynamic-argument-key；静态键 certain |

附加：删除 F05 中某 `@click` 的 handler 声明后，引用查询仍能把该边定位到模板位置（测试模拟删除并重建，断言边消失/定位变化符合预期；不实现 impact）。

### 3.4 V4 组件模型

- F05 至少 2 个组件有 Props，1 个有 Emits，1 个有 Slots。
- `propsCoverage.total` 等于抽取到的 prop 数；`resolved + unresolved.length = total`；`unresolved` 每项含 `name`、`typeText`、`reason`。
- 至少 1 个 prop 因 any/never/error 或 ambient 越界被标 heuristic（F05 内置该用例）。
- 至少 1 个 slot 推断为 never 或被显式降级，标 heuristic + reason（F05 内置该用例）。

### 3.5 V6 映射

- semantic-map/vue 的 T09 用户符号集合中，除组件合成符号外，每个符号在 `symbol_map` 至少有 `scip` 或 `vue` 一行；
- 组件合成符号登记 `engine=scip, match_quality=unmapped, reason=synthetic-component`，并登记 `engine=vue, match_quality=exact`；
- 所有 `unmapped` 行有 reason 且进入 `unmappedReasons` 计数；
- `falseMatchCount = 0`；
- `mappingSuccessRate = (exact + structural) / 应有映射数`，分母排除合成组件符号并在报告中写明。

## 4. 测试矩阵

| 层级 | 范围 | 断言 |
|---|---|---|
| 单元 | 投影段、UTF-8/UTF-16、CRLF、过滤、组件抽取、模板分类、成员表达式、动态键 | 纯函数；无 SCIP 子进程 |
| 集成 | F05、semantic-map Vue、F01、F10、F15、F17 | 真实 build + SCIP + SQLite + 查询 |
| CLI | `references`、`symbol`、`status`、`doctor --dump-vue-map`、`--no-template` | 退出码、四格式、非 TTY |
| 稳定性 | 同源两次构建、两次查询 | 逐字节一致；tmp 为空 |
| 负向 | 投影失败、非法 SFC、无脚本、越界/敏感文件、损坏 DB | 错误码与降级正确 |

测试必须离线；不得下载夹具；F05 行数 ≤350，F01–F18 总计 ≤12000。

## 5. Oracle 定义

| 用途 | Oracle | 说明 |
|---|---|---|
| Vue 用户符号集合 | `@vue/language-core` 投影 + `vue-tsc` 抽样核对 | 与 Phase 00 `g2-vue` 同源规则；golden 固化到 `expected/` |
| 坐标 | Volar `SourceMap` / 投影映射段 | 4.1.1 明示“与 Volar source range 一致” |
| 模板边 | `@vue/compiler-dom` 模板 AST + 人工核对 golden | 边必须落在 AST 对应节点范围内 |
| TS 引用回归 | tsserver `findReferences`（Phase 01 Oracle） | F01/F10 既有断言 |
| 映射正确性 | 声明位置 + 名称链 + 结构指纹 | 不由工具自身输出自证；falseMatch 用两侧声明位置核对 |

## 6. 性能与环境记录

本阶段不宣称 16.2 达标，只记录：

- projectLoc / fileCount / dependencyCount / tsRatio / vueRatio；
- nodeVersion / os / cpuModel / cpuCores / availableMemMB；
- scanMs / projectMs / shadowWriteMs / scipMs / mapMs / writeMs / totalMs；
- peakRssMB（父进程，50ms 采样）；`scipPeakRssMB = null` + 原因；
- sqliteSizeMB（DB + WAL）；
- buildFingerprint；
- repetitions ≥ 3（F05 小夹具可 3 次，记录中位数与最大值）。

不得把 F05 的数据外推为 16.2 的任何规模档。

## 7. 失败处理

| 失败 | 处理 |
|---|---|
| 投影失败（单文件） | 记 `filesFailed` + `degraded: vue-projection-failed`，继续其他文件；该文件符号不进索引，不伪造 |
| 影子 SCIP 失败 | 返回 E11；保留旧索引；Vue 全链路不可用，不使用“只看 TS”冒充完成 |
| 映射率不达标 | 按 20.3 提交架构问题报告；不降低阈值 |
| 四类边缺一类 | gate 失败，修复后重跑 |
| 组件类型无法解析 | heuristic + reason；`propsCoverage` 反映；不得当作 resolved |
| 输出出现 `__VLS_` | 判 E11/gate 失败；不得过滤后“看起来干净”而保留数据 |
| 回归失败 | 修复后才能关闭 Phase 02；不得以“Phase 02 新功能优先”跳过 |

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Volar 内部 API 变化 | 投影/映射失效 | 锁定 3.3.14；启动/构建契约探针；升级单独立项（4.1.6） |
| 影子工程与真实 tsconfig 语义偏差 | TS 结果变化 | 继承关键 compilerOptions；F01/F10 回归；rootDirs 仅追加 |
| 模板映射重复/错位 | 边位置错 | 去重 + AST 范围校验 + V1 抽样 |
| 复杂 Props 无法解析 | propsCoverage 偏低 | 显式 heuristic + reason；不降低 resolved 定义 |
| 组件成员符号污染用户符号集合 | V2 误判 | 明确分母口径；成员单独存储 |
| 影子写放大 | 大项目慢 | Phase 02 记录限制；Phase 06 优化 |
| 真实 TS→Vue 跨语言边缺失 | 引用不全 | 登记为限制；不宣称 Vue 项目 0 漏报；Phase 06 评估 |

## 9. 交付判定

Phase 02 关闭必须同时满足：

1. G1–G10 通过（含 V1–V4、V6）；
2. `npm test` 全绿（Node 22.16.0 与 Node 24.x 各一次）；
3. F01/F10 既有 TS 断言不回归；
4. 报告与自审回执齐全，`git status --porcelain` 无验证残留；
5. 所有未完成项以 `partial / heuristic / unresolved / unsupported / failed` 标注，不冒充 completed。

不满足时 Phase 02 记为 **pass-with-limits** 或 **fail**，不得自动进入 Phase 03。
