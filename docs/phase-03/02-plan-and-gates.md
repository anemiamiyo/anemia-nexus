# Phase 03 实施计划与验收门槛（编码前冻结）

> 依据：`docs/19-delivery-phases.md` 19.1/19.2/19.3、`docs/06-api-surface.md`、`docs/05-data-model.md` 5.1/5.11/5.12、`docs/11-cli.md`、`docs/13-audit-and-ci.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md`、`docs/20-prohibitions.md`、`docs/21-phase-00.md`
> 入场判定：`docs/phase-03/00-entry-and-decisions.md`
> 规范版本：v1.24（冻结）
> 冻结日期：2026-11-12
> **本文件的阈值在编码开始前冻结；不达标时按 20.6 报告，不得事后调低。**

## 1. 范围与不变量

### 1.1 本阶段范围

- Surface 判定与五类公开证据；
- `package.json` exports 条件/子路径/通配与导出图可达性；
- `surface.entries` / `surface.manual` 配置；
- `api-snapshot`、`api-diff`、弃用链路；
- Surface 在 `symbol` / `search` / `status` / `doctor` 的可见性；
- F07 夹具与 golden；
- SQLite 边算边写（负责人指定遗留补齐）。

### 1.2 不变量（违反即 gate 失败）

1. 每个 root 独立 Surface；不跨 root 合并。
2. 每条 public 记录有 `primaryEvidenceSource`、完整 `evidenceSources`、`exportKind`、`isTypeOnly`、`runtimePresent`。
3. 反向误报为 0：internal / 不可达不得出现在 public entries。
4. 快照不含行号、时间戳、绝对路径；同 fingerprint 两次逐字节一致。
5. `surfaceHash` 对 entries + evidenceSources + exportKind 敏感。
6. `api-diff` 每条差分有 `evidence` 与 `rationale`；不能判定落 ambiguous。
7. 既有错误码、退出码、输出字段语义不变；`update` / `status --json-schema` 仍 E24。
8. 不执行项目脚本、不联网、不引第三方 SQLite 驱动、不持久化影子文件。
9. 写入阶段不生成全量副本；失败 ROLLBACK，旧 committed 保留。

## 2. Gate 定义

| Gate | 判定 | 通过条件 | 证据 |
|---|---|---|---|
| **G0 遗留补齐** | 写入不扩容峰值 | `BuildWriter` 单事务、迭代器分批、无全量 `references.map`/`mappingRows`/`qualityBySymbolId` 副本；失败 ROLLBACK；行为等价；报告记录限制 | 代码 + 测试 + manifest `writeBatches` + 报告 §性能 |
| **G1 构建** | 可构建、可类型检查 | `npm run build`、`npm run typecheck`、`npm run lint`、`npm run format:check` 退出 0；两次 dist 哈希一致 | 命令输出与哈希 |
| **G2 Surface 完整性** | 每条 public 可解释 | F07 public 条目 `primaryEvidenceSource` / `exportKind` 覆盖率 100%；反向误报 0；每条记录可回答“为什么 public” | 测试 + snapshot |
| **G3 证据与优先级** | 五类证据正确 | 条件导出、子路径、多层 barrel、manual 冲突、opaque、internal 各有断言；优先级符合 6.1.1 | 单测 + F07 |
| **G4 快照** | 稳定、可评审 | 同 fingerprint 两次逐字节一致；无时间戳/行号/绝对路径；`surfaceHash` 对证据变化敏感；仅写基线文件 | 哈希对比 + `git status` |
| **G5 差分** | 分级与 golden 一致 | F07 的 breaking/additive/internal/ambiguous 各 ≥1；`--fail-on` 退出码正确；每条有 evidence + rationale | 测试 + CLI |
| **G6 弃用** | 链路可用 | deprecated 仍 breaking；有继任者/无继任者/多候选三类断言；建议可复制且不改代码 | F07 + 单测 |
| **G7 回归** | 既有能力不退化 | F01/F05/F10/F15/F17 全绿；`update` / `status --json-schema` 仍 E24；Phase 02 Vue 断言不回归 | `npm test` |
| **G8 输出** | 四格式同源稳定 | counts/分组一致；lines/json 逐字节一致；无 ANSI、绝对路径、时间戳 | 格式测试 |
| **G9 act CI** | 容器内复现 | `act -j verify --container-options "-m 4g"` 通过；Node 22 与矩阵一致 | act 输出 |
| **G10 自审** | 报告与证据齐全 | 19.3 九项结构、任务回填、已知问题、工作区无验证残留 | 报告 + `git status` |

**19.1 阶段 03 通过条件**：Surface 判定无反向误报；每条记录能回答“为什么 public”；差分分级与人工判定一致；`evidenceSource` 缺失即判不通过。任一不满足 → 修复后重跑；不得降低门槛。

## 3. 量化口径

### 3.1 Surface 完整性

- F07 public 条目数 N（预期 ≥8）；`primaryEvidenceSource` 非空 = N；`exportKind` 合法 = N；`symbolId` 存在 = N；
- `evidenceSources` 至少 1 项且均属五类枚举；`derived` 与“是否经历 re-export”一致；
- `internal` 条目不得出现在 public entries；用 internal 符号集合断言交集为 0；
- `opaque` 条目默认不进 public；若人工 override 为 public，必须带 `manual-override` 证据。

### 3.2 证据来源与优先级

| 场景 | 期望 primary | 期望其他证据 |
|---|---|---|
| 符号由 package exports 直接导出 | `package-exports` | 可能 `barrel-derived` 若经 barrel |
| 符号在 `surface.entries` 文件且直接导出 | `explicit-entry` | — |
| 符号仅经 barrel 可达且无 exports/entry 支持 | `barrel-derived` + `derived=true` | — |
| 人工标记 public | `manual-override` | 自动证据保留，输出冲突提示 |
| 普通模块导出 | `none` → internal | — |
| 动态/运行时注册导出 | `opaque` | 不伪造 public |

- 条件导出：同一符号在不同 `condition` 下产出多条记录，不得合并；
- 子路径：`./utils` 必须独立 `entryPath`，不得折叠到主入口；
- `manual-override` 冲突：`manualOverrideConflict=true`，primary 为 manual，warning 可见。

### 3.3 快照与哈希

- `surfaceHash` 输入：按 `(name, entryPath, condition)` 排序的条目，字段含 `name`、`normalizedSignature`、`kind`、`exportKind`、`entryPath`、`condition`、`evidenceSources`、`primaryEvidenceSource`、`derived`、`stability`、`symbolId`（不含行号/时间）；
- 改变 `package.json` exports（如从 barrel 升级为 exports）→ 哈希必变；
- 快照 JSON 末尾单换行；缩进 2；键顺序稳定（stable stringify 或固定构造）。

### 3.4 差分分级用例（F07 golden）

| 变更 | 期望 |
|---|---|
| 删除 public 函数 | breaking |
| 新增 public 函数 | additive |
| 删除纯类型导出 | breaking（type-level） |
| `exportKind` value → type | breaking |
| `exportKind` type → both | additive |
| 新增可选参数 | additive |
| 参数由可选变必填 / 返回类型收窄 | breaking |
| 无法归一化签名 | ambiguous |
| 证据来源 barrel-derived → package-exports | additive |
| 证据来源 package-exports → barrel-derived | ambiguous |
| 仅 internal 符号签名变化 | internal |
| 删除子路径导出 / 条件分支消失 | breaking |
| 删除 deprecated 且 `removalVersion` 未过 | breaking |

### 3.5 退出码

| 场景 | 退出码 |
|---|---|
| api-diff 无命中 | 0 |
| `--fail-on` 命中 | 1 |
| 仅有 warning（如 evidence 降级提示但未在 fail-on 内） | 2 |
| 参数非法 / 非 TTY 缺 `--yes` | 64（E00） |
| 索引/基线不可用 | E01/E19 对应码 |
| 内部错误 | 70（E23） |

## 4. 测试矩阵

| 层级 | 范围 | 断言 |
|---|---|---|
| 单元 | exports 解析、导出图、可达性、优先级、exportKind、签名归一化、surfaceHash、diff 规则、JSDoc 解析 | 纯函数；无 SCIP 子进程 |
| 集成 | F07 build + surface.json + api-snapshot + api-diff；F01/F05 回归 | 真实 build + SQLite + CLI |
| CLI | api-snapshot/api-diff 四格式、--base、--fail-on、--yes、非 TTY | 退出码、字段、无 ANSI |
| 稳定性 | 同源两次 build/snapshot、两次 diff | 逐字节一致；tmp 为空 |
| 负向 | 损坏基线、缺失 entry、非法 exports、internal 反向、写入中途失败 | 错误码与降级正确 |
| 遗留 | 写入迭代器/批计数、内存采样、ROLLBACK | 行为等价、无副本 |

测试必须离线；不得下载夹具；F07 ≤250 行；F01–F18 总计 ≤12000 行。

## 5. Oracle 定义

| 用途 | Oracle | 说明 |
|---|---|---|
| 导出关系 | TypeScript AST（`ts.createSourceFile`）+ 人工核对 | golden 固化在 `expected/` |
| 条件/子路径 | Node `exports` 语义 + 人工核对 | 不由 Surface Builder 自证 |
| 签名 | `tsc` 声明文本 + 人工核对 | 无法判定落 ambiguous |
| 差分分级 | 人工 golden（本阶段冻结） | 与 6.4 表一致 |
| 弃用继任者 | JSDoc + 人工核对 | 多候选保留 |
| 回归 | Phase 01/02 既有测试 | 不降断言 |

## 6. 性能与内存记录

- 记录：scanMs / analyzeMs / vueMs / scipMs / mapMs / writeMs / totalMs；`peakRssMB`（父进程 50ms 采样）；`sqliteSizeMB`（DB + WAL）；
- 写入：`writeBatches`、行数、批大小；改造前后对比（同源）；
- 不得把 F05/F07 小数据外推 21.2 任何规模档；`scipPeakRssMB` 仍 null + 原因；
- 21.2 全量预算达标留 Phase 06；本阶段只证明“写入阶段不扩大峰值”。

## 7. 失败处理

| 失败 | 处理 |
|---|---|
| exports 不可解析 | warning + opaque/unresolved；不伪造 public |
| entry 文件缺失 | warning；该来源不计；不得当 internal |
| 反向误报 | gate 失败，修复后重跑 |
| 快照不确定/抖动 | 修复排序与字段；不得用时间戳掩盖 |
| 差分与 golden 不符 | 修复规则或 golden 说明；不得改 golden 迎合实现 |
| deprecated 多候选 | 保留候选 + ambiguous；不得强选 |
| 写入失败 | ROLLBACK；旧 committed 保留；无半套行 |
| act CI 失败 | 修复后重跑；不得以本地通过替代 |
| 回归失败 | 修复后才能关闭 Phase 03 |

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `exports` 条件语义复杂 | 误判 public | 保守：不能静态判定 → opaque；golden 人工核对 |
| 导出图与 TS 解析偏差 | 漏/多 Surface | AST + 模块解析；不可解析记原因；反向误报零容忍 |
| 签名归一化过度/不足 | diff 不稳定 | 文本归一化 + 无法判定 ambiguous |
| Surface 与 Index 不同步 | symbol 显示错误 | manifest 指向 buildId；不一致 → unknown + warning |
| 写入改造引入回归 | 数据错误 | 行为等价测试；失败 ROLLBACK；旧索引保留 |
| 内存优化被夸大 | 误导评审 | 只声明写入阶段；分析阶段限制登记 |
| act 镜像差异 | 本地通过 CI 失败 | 以 act 的 Node 22 为准；记录镜像版本 |

## 9. 交付判定

Phase 03 关闭必须同时满足：

1. G0–G10 通过；
2. `npm test` 全绿（Node 22.16.0；act 内同版本）；
3. F01/F05/F10/F15/F17 既有断言不回归；
4. 报告与自审回执齐全，`git status --porcelain` 无验证残留（负责人 `.actrc` 除外）；
5. 所有未完成项以 `partial / heuristic / unresolved / unsupported / failed` 标注，不冒充 completed。

不满足时 Phase 03 记为 **pass-with-limits** 或 **fail**，不得自动进入 Phase 04。
