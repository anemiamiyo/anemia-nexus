# Phase 03 入场记录：API Surface 与基线

> 记录日期：2026-11-12（Asia/Shanghai）
> 依据：`docs/19-delivery-phases.md` 19.1/19.3、`docs/06-api-surface.md`、`docs/05-data-model.md` 5.1/5.11/5.12、`docs/11-cli.md`、`docs/13-audit-and-ci.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md`、`docs/20-prohibitions.md`、`docs/21-phase-00.md`
> 规范版本：v1.24（冻结）
> 前置：`docs/phase-02/03-implementation-report.md`（Phase 02，pass）
> 状态：**负责人已批准进入 Phase 03；本文件与 `01-task-checklist.md`、`02-plan-and-gates.md` 共同构成编码前冻结基线。**

## 1. 负责人裁定（2026-11-12）

项目负责人在本会话中书面确认：

1. 接受 Phase 02 实施报告以 **pass** 关闭；
2. 批准进入 **Phase 03（API Surface 与基线）**；
3. 进入 Phase 03 前先编写完整任务清单，再按清单实施；
4. 同时要求补做 **SQLite 边算边写（流式/分批写入，降低构建内存峰值）**；该事项原属 Phase 06（19.1 阶段 06、21.2），本次作为**负责人指定的跨阶段遗留补齐**执行，不改变 Phase 03 的验收口径，也不降低任何既有门槛；
5. 本地 CI 使用 `act -j verify --container-options "-m 4g"` 模拟 GitHub Actions，作为合并前必跑检查之一。

本记录固化上述裁定。Phase 02 报告正文不改写；如需回执，在本文件与 Phase 03 报告中记录。

## 2. 基线与环境

| 项 | 值 |
|---|---|
| 基线 commit | `ea01efe`（`feat(vue): 为模板成员表达式与属性引用增加回退解析`） |
| 工作区 | `git status --porcelain` 仅有负责人本地 `?? .actrc`；该文件是本地 act 配置，不纳入库、不作为脏工作区失败项 |
| Node | v22.16.0（nvm-windows）；本地另有 v24.x 用于兼容验证 |
| npm | 10.9.2 |
| 本地 CI | `act -j verify --container-options "-m 4g"`；GitHub 不可达时使用 `--action-offline-mode`（见 Phase 03 报告） |
| Schema | 沿用 `SCHEMA_VERSION = 2`；Phase 03 不新增表、不改既有列语义 |

## 3. 范围与不变量

### 3.1 本阶段范围

1. Surface 判定：`public` / `internal` / `opaque`，且每条 public 记录必须带 `evidenceSource`（数组 + primary）、`exportKind`、`isTypeOnly`、`runtimePresent`、`derived`；
2. 公开证据来源：`manual-override` / `package-exports` / `explicit-entry` / `barrel-derived` / `none`，严格按 6.1.1 的优先级；
3. `package.json` `exports`（含条件导出、子路径）与配置 `surface.entries`、`surface.manual`；
4. `nex api-snapshot`：生成/更新 `nexus.baseline.json`，按 root 分段，含 `surfaceHash` 与 `buildFingerprint`；
5. `nex api-diff`：breaking / additive / internal / ambiguous 四级差分，带 `evidence` 与 `rationale`，支持 `--base <ref|file>` 与 `--fail-on`；
6. `@deprecated` 链路：stability、替代符号解析（按 symbolId，不按名称模糊匹配）、`no-successor` / 多候选 `ambiguous`、迁移建议；
7. `nex symbol` / `search` 的 Surface 归属可见，`status.capabilities.apiSurface` 诚实声明；
8. F07 api-surface 夹具与自动化断言；
9. SQLite 边算边写/分批写入（负责人指定的遗留补齐）；
10. 阶段报告、自审、README / runtime-api / AGENTS 同步。

### 3.2 明确不做

| 能力 | 处理 |
|---|---|
| 依赖图 / 调用图 / 架构规则 / 样式链 | Phase 04 |
| impact / preflight / postflight / verify | Phase 05 |
| 增量、失效传播、崩溃七注入点、完整 21.2 预算达标 | Phase 06 |
| MCP 工具、`print`、发布验证、`doctor --repair` | Phase 07 |
| 多 root 查询合并 / `--roots all` | Phase 05（5.9） |
| `status --json-schema` | 仍 E24；随输出 Schema 冻结在后续阶段 |
| 完整语义签名归一化（条件类型、映射类型全展开） | 本阶段用可复核的文本归一化；不能确定时落 `ambiguous`，不猜 |
| 自动改写代码 / 自动升级依赖 / 自动删除弃用 API | 永久禁止 |
| 样式文件进入 Surface / 样式边计入 references | 永久禁止（4.2、20.5） |

### 3.3 不变量（违反即 gate 失败）

1. 每个 root 独立 Surface，不跨 root 合并；
2. 每条 public 记录必须能回答“为什么是 public”：`primaryEvidenceSource` 非空，`evidenceSources` 与证据字段可复核；
3. 反向误报零容忍：internal / 不可达符号不得标 public；不确定时标 `opaque` 或 `internal`，不得猜 public；
4. 快照只记录 Surface 与签名，不写行号、时间戳、绝对路径；同一 `buildFingerprint` 两次快照逐字节一致；
5. `surfaceHash` 必须覆盖条目集合 + `evidenceSource` + `exportKind`；证据来源变化必须改变哈希；
6. `api-diff` 不能只给结论：每条差分带 `evidence` 与 `rationale`；不能判定的落 `ambiguous`；
7. `@deprecated` 替代符号只能按 `symbolId` 解析；多候选保留候选列表，不强行选择；
8. 不新增第三方 SQLite 驱动；不把写入结果攒成巨型数组后再 `JSON.stringify`；
9. 既有错误码、退出码、输出字段语义不变；`update` / `status --json-schema` 仍 E24。

## 4. 关键技术决策（编码前冻结）

### 4.1 Surface 的存放位置

**决策**：Surface 是构建派生物，按 root 写入 `.nexus/roots/<rootId>/surface.json`；`build` 在 DB 提交后、manifest 更新前原子写入；manifest 记录 `surfaceHash` 与 `surfaceEntries`。

理由：

- Surface 依赖 source、`package.json`、配置与 Vue 组件覆盖度，属于构建产物；放 DB 需要新表/迁移，而 5.5 规定不兼容变更才升版本，本阶段无必要；
- 按 root 分文件与 5.7 的索引隔离一致，避免跨 root 合并；
- `api-snapshot` / `api-diff` / `symbol` 只读该文件；文件缺失或与 manifest `buildId` 不一致时返回 `unknown` + warning，不伪造。

**协议顺序**：12.3.2 第 8/9 步之后写 surface.json（原子 rename），再写 manifest；manifest 是 Surface 是否可信的权威指针。

### 4.2 证据来源判定

- 先解析 `package.json` 的 `exports`（字符串、条件对象、子路径、数组 fallback、`*` 通配）；
- 对每个导出目标文件建立**导出图**：直接导出、局部 alias、`export { x } from`、`export * from`、`export * as ns from`、`export { default as X }`；
- 从 exports 目标 / `surface.entries` 出发做可达性遍历；同一符号可命中多个来源，全部记录，按 6.1.1 优先级取 primary；
- `package-exports` 记录 `entryPath`（子路径形式）与 `condition`（无则 null）；条件分支不同形状时按条件拆成多条记录；
- `manual-override` 优先级最高；冲突时必须输出 `manualOverrideConflict: true` 与提示；
- 仅通过 barrel 间接可达的符号 `derived: true`，并在 `evidenceSources` 追加 `barrel-derived`；primary 仍按优先级；
- 无法静态判定的动态导出（`export =`、运行时注册、字符串索引）标 `opaque`，默认不进入 public 快照，输出 `opaque` 清单供人工确认；
- `none` 的导出符号判 `internal`；未导出符号不进入 Surface。

### 4.3 Surface 条目与签名

- `name`：主入口为规范化导出名；子路径为 `<包名><子路径>#<导出名>`（如 `pkg/utils#debounce`）；
- `normalizedSignature`：去注释/空白差异，保留类型语义；无法稳定归一化时标 `ambiguous`；
- `kind`：`value` / `type` / `component` / `composable` / `config`；
- `exportKind`：`type` / `value` / `both`；`isTypeOnly` 与 `runtimePresent` 由声明与导出形态推导；
- `stability`：`stable` / `experimental` / `deprecated`；Vue 组件 `propsCoverage < 1` 时不得标 `stable`；
- `since`：优先保留既有基线中的值；新条目取根 `package.json` 的 `version`；仍无则 `unknown`，不写时间戳；
- `ownerModule`：Phase 04 才有架构模块，本阶段写 `null` 并注明，不用目录名冒充；
- `docLink`：仅当 JSDoc 有可验证 URL 时写入，否则 `null`。

### 4.4 基线文件格式

`nexus.baseline.json`（项目根，纳入 git）：

```json
{
  "baselineVersion": 1,
  "surfaceHash": "<跨 root 汇总哈希>",
  "roots": {
    "<rootId>": {
      "rootPath": "packages/ui",
      "packageName": "@acme/ui",
      "buildFingerprint": "bf_...",
      "surfaceHash": "sh_...",
      "entries": [],
      "internal": [],
      "deprecated": [],
      "opaque": []
    }
  }
}
```

- `entries` 只含 public 条目；`internal` 记录导出的 internal 符号（name / symbolId / signature / exportKind / path），用于 `api-diff` 的 `internal` 分级，不参与 `surfaceHash`；
- 快照不写行号、时间戳、绝对路径、构建耗时；
- `surfaceHash` 对 entries 的规范化 JSON（按 name/condition/entryPath 排序）+ evidenceSource + exportKind 求哈希；
- 覆盖已有基线：TTY 确认；非 TTY 必须 `--yes`，否则 E00/退出 64；`api-snapshot` 只允许写该基线文件，不得创建其他文件。

### 4.5 api-diff 分级与退出码

- 默认 `--base nexus.baseline.json`；参数可为文件路径或 git ref（`git show <ref>:nexus.baseline.json`）；
- 判定：
  - 删除 public 条目、纯类型导出删除、子路径/条件分支消失、组件 Props/Emits/Slots 移除、导出类型收窄（value→type 或 both→type）→ `breaking`；
  - 新增 public 条目、新增可选参数、新增 Props/Slots、证据来源升级（barrel-derived → package-exports / explicit-entry）→ `additive`；
  - 仅 internal 层变化 → `internal`；
  - 签名无法稳定比较、opaque 边界、证据来源降级、barrel-derived 无法确认外部消费 → `ambiguous`；
- `--fail-on breaking|additive|ambiguous` 默认 `breaking`；命中即退出 1；仅有 warning 退出 2；无命中退出 0；
- 每条差分带 `evidence`（旧/新 Surface 记录、evidenceSource、exportKind）与 `rationale`；
- 四格式（pretty/lines/json/markdown）字段集合一致，JSON/lines 逐字节稳定，不含 ANSI。

### 4.6 deprecated 链路

- 从 JSDoc `@deprecated`、`@see`、`{@link}` 提取替代符号名；
- 分两步解析：先在当前 root 的 Surface/internal/public 记录中按 `name` / `nameChain` 找候选，再用声明位置与 `symbolId` 复核；多候选 → `ambiguous` + 候选列表；无候选 → `no-successor`；
- 输出 `oldSymbolId` / `newSymbolId` / `reason` / `removalVersion` / `suggestion`（可复制的迁移命令），不自动改代码；
- 删除 deprecated 条目仍算 `breaking`，除非 `removalVersion` 已过且基线声明了移除。

### 4.7 SQLite 边算边写（负责人指定补齐）

- 以 `BuildWriter` 替代“先复制全量数组再一次性插入”：
  - 单事务 `BEGIN IMMEDIATE` 内插入 `build_record(pending)` 与数据；
  - prepared statement 复用，按批（默认 500 行）计数；
  - `symbols` / `references` / `symbol_map` / `components` / `vue_file_meta` 以同步迭代器逐批写入，禁止 `references.map(...)`、`mappingRows` 全量数组、`qualityBySymbolId` 全量 Map 等副本；
  - 历史维护改为 SQL + 临时表（当前 build 的 symbol_id 集合），不再在 JS 中构造全量 Set；
  - 写完一批后允许 V8 回收已消费对象；构建计数只保留整数。
- 与 12.3.2 一致：数据 + pending 记录同一事务；闭合校验、必需索引、分母非零、指纹字段齐全后 COMMIT；再验证 pending、翻 committed、prune（K=2）。
- 仍保留分析阶段必要的声明/映射结构（身份分配需要全局声明集）；本阶段承诺**写入阶段不扩大峰值**，并把“分析阶段与写入完全重叠”登记为限制（Phase 06 评估），不宣称 21.2 全量达标。
- 证据：写入批次计数、峰值 RSS 采样、内存对照说明；不得用固定小数据证明大项目。

## 5. 验收口径

### 5.1 19.1 阶段 03 通过条件

1. Surface 判定无反向误报（internal/不可达不得标 public）；
2. 每条 public 记录都能回答“为什么是 public”（`primaryEvidenceSource` + 全部证据 + `exportKind`）；
3. `api-diff` 分级与 F07 人工 golden 一致；
4. `evidenceSource` 缺失即判不通过。

### 5.2 量化门槛

- F07：8 文件 / ≤250 行；至少覆盖 1 个条件导出、1 个子路径导出、1 条多层 barrel、1 个 `@deprecated` 有继任者、1 个 `no-successor`、1 个重载、1 个 opaque 边界；
- public 条目 `primaryEvidenceSource` 覆盖率 = 100%，`exportKind` 覆盖率 = 100%；
- 反向误报 = 0（用 internal 符号集合断言：不得出现在 public entries）；
- `surfaceHash` 对证据来源变化敏感（fixture 人为改 `exports` 后哈希必变）；
- 同 `buildFingerprint` 两次 snapshot 逐字节一致；不得含时间戳、绝对路径、行号；
- `api-diff` 对 F07 的 golden 差分集合完全一致（breaking / additive / internal / ambiguous 各 ≥1）；
- `api-snapshot` 后 `git status --porcelain` 只允许 `nexus.baseline.json` 变化；
- 既有 F01/F05/F10/F15/F17 断言不回归；`update` / `status --json-schema` 仍 E24。

## 6. 已知限制（实现前登记）

1. `ownerModule` 为空，Phase 04 补；
2. 签名归一化是文本级，复杂条件/映射类型可能落 `ambiguous`，不猜；
3. `opaque` 判定基于静态语法，动态注册/运行时导出需人工确认；
4. 不实现跨 root Surface 合并；多 root 快照按 root 分段；
5. 不实现 `--fail-on` 的 CI 集成与 postflight 联动（Phase 05）；
6. SQLite 写入阶段不扩容峰值，但分析阶段仍保留声明/映射结构；21.2 全量预算留 Phase 06；
7. `status --json-schema` 仍 E24；
8. 完整 `npm ci` 重装不在本阶段；以 `npm ci --dry-run` 与 act 容器内 `npm ci` 记录为证。

## 7. 文档与代码同步纪律

- 本文件冻结 Phase 03 的范围、口径与限制；实现中与 v1.24 冲突时按 20.6 暂停并报告，不自行改写规范。
- 任何验收口径变更必须先更新本文件与 `02-plan-and-gates.md`，再改代码。
- 实施结果只写入 `03-implementation-report.md`，不得把计划回填为已完成。
- `docs/21-phase-00.md` 的“边算边写”要求在本阶段按 §4.7 执行，并在报告中单列证据与剩余限制。
