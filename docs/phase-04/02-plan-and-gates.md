# Phase 04 实施计划与验收门槛（编码前冻结）

> 依据：`docs/19-delivery-phases.md` 19.1/19.2/19.3、`docs/04-architecture.md` 4.2、`docs/05-data-model.md` 5.1/5.5/5.6/5.7、`docs/08-relations.md`、`docs/10-impact-analysis.md`、`docs/11-cli.md`、`docs/12-indexing.md`、`docs/13-audit-and-ci.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md`、`docs/20-prohibitions.md`
> 入场判定：`docs/phase-04/00-entry-and-decisions.md`
> 规范版本：v1.24（冻结）
> 冻结日期：2026-11-13
> **本文件的门槛在编码开始前冻结；不达标时按 20.6 报告，不得事后调低。**

## 1. 范围与不变量

### 1.1 本阶段范围

- 文件依赖图、模块依赖图、符号引用图加固；
- 静态调用图（TS/TSX）与三分类/四档置信；
- 架构模块与 `allow` 规则、`ownerModule`；
- S1 样式文件级依赖（五类边）；
- 跨 root 边界规则与 `unresolved(package-boundary)`；
- 盲区清单四类；
- `nex deps` 查询、`status` / `doctor` / manifest 可见性；
- schema v3 与四张新表；
- F13/F14 新夹具，F01/F05/F06 扩展；
- 文档与阶段报告。

### 1.2 不变量（违反即 gate 失败）

1. 三分类/四档映射固定按 8.1.2；`certain` 只含 `direct`/`typed`。
2. 每条关系输出七项；缺 `sourceOfTruth` 或 `missReason`（可判定时）判不通过。
3. 盲区四类均有 `affectedFiles` / `potentiallyAffectedSymbols` / `manualCheckHint`。
4. 样式不进符号链；样式边不计入 references / Surface / api-diff。
5. 跨 root 不造边；不展开 B 符号；不做跨 root BFS。
6. 架构模块只由显式 include 匹配；无配置不推断。
7. schema v3 单事务写入；失败 ROLLBACK；不新增全量副本。
8. 既有错误码、退出码、输出字段语义不变；Phase 03 的 `surfaceVersion`/`baselineVersion` 不变。
9. 不执行项目脚本、不联网、不读根外路径、不持久化影子文件。
10. 不把 `heuristic`/`unresolved` 计入确定性结论；不写“完整调用图/零漏报（无限定）”。

## 2. Gate 定义

| Gate | 判定 | 通过条件 | 证据 |
|---|---|---|---|
| **G0 Schema 与写入** | v3 可重建、可回滚 | 四表 + `files.owner_module`；索引齐全；`BuildWriter` 单事务；失败无半套行；v2 库 E06 | schema diff、writer 测试、`doctor` |
| **G1 构建** | 可构建可检查 | build/typecheck/lint/format 退出 0；两次 dist 哈希一致 | 命令输出 |
| **G2 文件依赖图** | 依赖方向与解析正确 | F01 import/export/dynamic/alias/未解析各 ≥1；外部包不建边；七项字段齐全 | 单测 + golden |
| **G3 调用图** | 三分类四档可用 | F01/F06 的 direct/typed/heuristic/unresolved 各 ≥1；每条有位置与证据；Vue 限制显式 | 单测 + 集成 |
| **G4 架构规则** | 模块与违规可解释 | allow 缺省/`[]`/列表三态；违规带 ruleId/模块/文件/行；重叠 warning；无配置 E00 | 单测 + F14 |
| **G5 S1 样式链** | 五类边全部可产出 | F13 五类边、动态 unresolved、别名 heuristic、ignore 边界；0 符号 | 集成 + golden |
| **G6 跨 root 边界** | 只按 5.7 造边 | F14 已声明边 + 未声明/exports/未索引/越界；无合并索引 | 集成 + golden |
| **G7 盲区** | 100% 标注 | 四类均产；字段齐全；符号数 0 不得冒充；提示可复制 | 单测 + `deps` 输出 |
| **G8 输出** | 四格式同源稳定 | counts/byConfidence/byType 一致；lines/json 逐字节；无 ANSI/绝对路径/时间戳 | 格式测试 |
| **G9 act CI** | 容器内复现 | `act -j verify --container-options "-m 4g"` 通过；Node 22 与 24 矩阵 | act 输出 |
| **G10 自审** | 报告与证据齐全 | 19.3 九项、任务回填、已知问题、工作区无残留 | 报告 + `git status` |

**19.1 阶段 04 通过条件**：盲区清单 100% 标注；heuristic/unresolved 不进入确定性结论；S1 五类边全部可产出。任一不满足 → 修复后重跑；样式链不达标不阻断 Phase 05，但必须记为遗留项。

## 3. 量化口径

### 3.1 依赖图

- F01 中 `import` / `export` / `dynamic-import` 各 ≥1；`paths` 别名 ≥1；未解析相对路径 ≥1；
- 外部 `node_modules` 依赖不产生 `dependencies` 行；
- 同一 `(source, target, line, col, dep_type)` 多重集去重后计数稳定；
- 每条 `relationClass=certain` 的边必须能给出 `sourceOfTruth` 与解析依据。

### 3.2 调用图

- `direct` / `typed` / `heuristic` / `unresolved` 各 ≥1（F01/F06 合计）；
- `heuristic` 必须带 `?` 标记；`unresolved` 必须带 `!` 与原因码；
- 调用方归属：嵌套函数取最近声明；顶层为 `null` + 文件；
- 重载按 `overloadOrdinal` 分开，不合并。

### 3.3 架构规则

- 三态用例：无 `allow`（不限制）、`allow: []`（禁止跨模块）、`allow: ["x"]`（允许 x）；
- 违规数 = 源/目标均归属、模块不同、目标不在 allow 的文件级边数；
- 重叠模块：最长匹配优先；warning 计数可复核；
- `ownerModule`：有配置时 public 条目全部可回指模块；无配置时全为 null。

### 3.4 样式链

- F13 五类边各 ≥1；`style-import` 三个来源（CSS/Less/TS）分别断言；
- 别名 heuristic ≥1；动态路径 unresolved ≥1；ignore 目标 ≥1；`sass:*` 或外部 URL ≥1；
- 样式文件 `symbols=0`、`references=0`；`files` 中有记录；
- `deps --type style --reverse` 返回消费者全集；无结果三态区分。

### 3.5 跨 root

- F14 已声明依赖 + exports 可解析 → 1 条 `certain` cross-package；
- 未声明依赖 / exports 不匹配 / root 未索引 / 别名越界 → 各 ≥1 `unresolved(package-boundary)`；
- B 的符号不出现在 A 的 `deps` 结果；不产生跨 root 合并索引；
- 跨包边参与模块规则；目标模块可解释。

### 3.6 盲区

| 类别 | 必须出现 | 字段 |
|---|---|---|
| code | 动态 import / unresolved call / 未解析依赖 | 四件套 |
| style | 动态路径 / 别名 / 外部包 / 未覆盖目标 | 四件套 |
| multi-root | 未声明依赖 / exports 不匹配 / root 未索引 | 四件套 |
| coverage | ignore / 超大小 / 读取失败 / unmapped | 四件套 |

`potentiallyAffectedSymbols` 无法精确时写 `null` + `estimateMethod`，不得写 0。

### 3.7 输出与退出码

| 场景 | 退出码 |
|---|---|
| `deps` 正常返回（含 heuristic/unresolved 提示） | 0 |
| 非法 `--type` / 缺 target | 64（E00） |
| 未初始化 | E01 |
| 索引不可用 / v2 库 | E19/E06 |
| 同名多候选 | E04 |
| 内部错误 | 70（E23） |

### 3.8 稳定性

- 同一 `buildFingerprint` 两次 build：`surface.json` 逐字节一致；`deps` 的 lines/json 逐字节一致（排除明确的时间字段）。
- 输出不含绝对路径、时间戳、ANSI；排序稳定。

## 4. 测试矩阵

| 层级 | 范围 | 断言 |
|---|---|---|
| 单元 | 依赖解析、调用分类、模块匹配、allow 规则、样式扫描、盲区构造 | 纯函数；无 SCIP / 子进程 |
| 集成 | F13 / F14 / F01 / F05 / F06 的 build + deps | 真实 SQLite + CLI；golden |
| CLI | `deps` 四格式、`--reverse`、`--type`、`--explain`、`--root` | 退出码、字段、无 ANSI |
| 稳定性 | 两次 build / 两次 deps | 逐字节一致；tmp 为空 |
| 负向 | v2 库、损坏 exports、ignore 目标、越界别名、动态路径 | 错误码/原因正确 |
| 回滚 | 写入中途失败 | 四表无半套行；旧 committed 保留 |
| 回归 | Phase 01–03 全部测试 | 不降断言 |
| act | Node 22 / 24 矩阵 | 全绿 |

测试必须离线；F13 ≤200 行、F14 ≤250 行；F01–F18 合计 ≤12000 行。

## 5. Oracle 定义

| 用途 | Oracle | 说明 |
|---|---|---|
| 文件依赖 | TS `resolveModuleName` + 人工核对 | golden 固化在 `expected/` |
| 调用边 | TS checker + 人工核对 | 动态/重载逐条核对 |
| 架构模块 | 配置 include + 人工核对 | 重叠与最长匹配用例 |
| 样式边 | at-rule 字面量 + 人工核对 | 不由工具自证 |
| 跨 root | package.json `exports` + Node 解析语义 | 人工核对 |
| 盲区 | 覆盖统计 + 人工核对 | 四类各至少 1 例 |

## 6. 性能与内存记录

- 记录 scanMs / analyzeMs / vueMs / scipMs / graphMs / writeMs / totalMs；
- `peakRssMB`（父进程 50ms 采样）；`writeBatches`、行数、批大小；
- 样式扫描与图构建的耗时单列；
- 不得把 F13/F14 小数据外推 21.2 任何规模档；`scipPeakRssMB` 仍 null + 原因；
- 21.2 全量预算达标留 Phase 06；本阶段只证明写入不扩大峰值与图构建无全量副本。

## 7. 失败处理

| 失败 | 处理 |
|---|---|
| 依赖解析失败 | 记 unresolved + reason；不得静默丢弃 |
| 调用无法解析 | 记 unresolved + reason；不得猜 typed |
| 模块重叠 | warning + 最长匹配；不得静默 |
| allow 违规 | 记违规；不得自动改写代码 |
| 样式路径动态 | unresolved + reason；不得猜目标 |
| 跨 root 不满足条件 | `unresolved(package-boundary)`；不得造边 |
| schema 不兼容 | E06 + 重建命令；不得迁移 |
| 写入失败 | ROLLBACK；旧 committed 保留；无半套行 |
| act 失败 | 修复后重跑；不得以本地通过替代 |
| 回归失败 | 修复后才能关闭 Phase 04 |

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| TS checker 调用解析误判 | 假调用边 | 只接受唯一声明；歧义落 unresolved；golden 人工核对 |
| 动态 import 分类争议 | 与 8.1 不一致 | 固定按 8.1 记 dynamic-unresolved，即使字面量可解析 |
| 样式扫描器覆盖不足 | 漏边 | 只承诺五类字面量；F13 覆盖；限制登记 |
| 架构规则过简 | 无法表达层规则 | `allow` 清单已满足 19.1；复杂 DSL 留后续评审 |
| 跨 root 依赖 B 未构建 | 边存在但 B 不可用 | 只按 package.json/exports；B 失败进盲区，不声称完整 |
| schema v3 破坏旧库 | 用户需重建 | E06 + doctor 命令；文档明确 |
| 写入新表扩大内存 | 峰值上升 | 迭代器 + 批计数；失败回滚；报告记录 |
| 与 Surface ownerModule 耦合 | 快照抖动 | ownerModule 不进 surfaceHash；配置变化走 configHash |

## 9. 交付判定

Phase 04 关闭必须同时满足：

1. G0–G10 通过；
2. `npm test` 全绿（Node 22.16.0；act 内 Node 22.16.0 与 24.22.3）；
3. F01/F05/F10/F15/F17 既有断言不回归；Phase 03 Surface 断言不回归；
4. 报告与自审回执齐全，`git status --porcelain` 无验证残留（负责人 `.actrc` 除外）；
5. 所有未完成项以 `partial / heuristic / unresolved / unsupported / failed` 标注，不冒充 completed；
6. 19.1 阶段 04 三条通过条件逐条有证据。

不满足时 Phase 04 记为 **pass-with-limits** 或 **fail**，不得自动进入 Phase 05。
