<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 6 章 API Surface 定义与基线管理；原文照录，未修改技术内容。 -->

# 6. API Surface 定义与基线管理

"API 稳定与一致"要可执行，前提是先定义清楚**什么算公共 API**。v1.23 用"是否 export"近似判定，但导出的公开程度差异很大：`package.json` 的 `exports` 声明是契约，barrel 的间接导出未必是，内部模块的 export 根本不是。v1.24 为每条 Surface 记录增加**公开证据来源**（P1-05）。

## 6.1 边界分类

| 类别 | 含义 | 允许的变更 |
|---|---|---|
| public（契约） | 对外承诺的入口与导出 | 仅允许 additive；breaking 必须显式批准并记入基线 |
| internal（实现） | 模块内部可复用但非契约 | 可改，需评估引用影响 |
| opaque（不可判定） | 动态导出、字符串索引、运行时注册 | 默认视为疑似契约，必须人工确认 |

样式文件不属于 public API，永远不进入 Surface 判定与 api-diff（见 4.2）；样式边也不计入 references 符号计数。

## 6.1.1 公开证据来源（v1.24 新增，P1-05）

### 证据来源枚举

| `evidenceSource` | 判定条件 | 默认稳定性 | 可信度 |
|---|---|---|---|
| `package-exports` | 该符号可通过 `package.json` 的 `exports` 字段（含子路径与条件导出）解析到 | 最高，视为契约 | 确定性 |
| `explicit-entry` | 位于配置 `surface.entries` 显式声明的入口文件中，且被直接导出 | 高 | 确定性 |
| `barrel-derived` | 仅通过 barrel（`export *` / 多级重导出）间接可达，无 `exports` 与显式入口支持 | 中，**必须 `derived: true`** | 确定性但优先级低 |
| `manual-override` | 由 `surface.manual` 显式标记为 public 或 internal | 覆盖前两者 | 用户声明，冲突时以声明为准，并提示冲突 |
| `none` | 以上都不满足（内部模块 export） | 判 internal | — |

### 判定优先级（唯一，不得按章节需要临时调整）

```text
manual-override > package-exports > explicit-entry > barrel-derived > internal
```

规则：

1. 一个符号命中多个来源时，记录**全部**来源（数组），并按优先级取"最强"的一条作为 `primaryEvidenceSource`。输出必须能回答"为什么它被判为 public"。
2. `barrel-derived` 的符号必须带 `derived: true`，且 `confidence` 上限为 `typed`（不得标 `direct`）。
3. 有条件导出（`exports` 的 `import`/`require`/`types`/`browser` 分支）时，逐条件记录 `condition`，同一符号在不同条件下导出形状不同 → 记录为**多条** Surface 记录，不得合并。
4. 子路径导出（`"./utils"`）必须是独立记录，`entryPath` 为子路径，不得折叠到主入口。
5. `manual-override` 与自动判定冲突时，以手动为准，但必须在 `status` 与 api-snapshot 输出中打印一条冲突提示，供评审复核。

### 导出类型必须区分（v1.24 新增）

| 字段 | 取值 | 含义 |
|---|---|---|
| `exportKind` | `type` / `value` / `both` | TypeScript 类型导出 / JS 运行时导出 / 两者皆有 |
| `isTypeOnly` | boolean | 是否 `export type` 或仅类型声明 |
| `runtimePresent` | boolean | 编译产物中是否真实存在（值导出为 true，纯类型为 false） |

规则：`isTypeOnly = true` 的符号删除时，属于 **breaking**（对 TS 消费方是类型级破坏）；`runtimePresent = false` 但被 `import { x }`（非 `import type`）使用，属于**消费方代码问题**，工具只报告不改。api-diff 必须同时输出"类型级差分"与"运行时级差分"两栏，不得只给一个"导出消失"。

## 6.2 Surface 条目

每条至少包含：

| 字段 | 说明 |
|---|---|
| `name` | 规范化名称（含子路径前缀时写全，如 `pkg/utils#debounce`） |
| `normalizedSignature` | 规范化签名（去掉格式与注释差异，保留类型语义） |
| `kind` | `value` / `type` / `component` / `composable` / `config` |
| `exportKind` | 见 6.1.1 |
| `entryPath` | 入口文件相对路径（子路径导出时为子路径） |
| `condition` | 条件导出分支，无则 null |
| `evidenceSource` / `primaryEvidenceSource` | 见 6.1.1 |
| `derived` | 是否 barrel 推导 |
| `stability` | `stable` / `experimental` / `deprecated` |
| `since` | 首次进入 Surface 的版本或 commit |
| `ownerModule` | 所属架构模块（8 章） |
| `docLink` | 文档链接（可空） |
| `symbolId` | 5.2 的身份 |
| `identityConfidence` | 该符号当前身份置信度 |

Vue 组件条目额外携带 `propsCoverage`（`resolved` / `total`）与未解析 props 的逐条清单（见 4.1.3）。`propsCoverage < 1` 时该条目整体 `stability` 不得标 `stable`，必须标 `experimental` 或附 `partial` 标记——这是防止"类型没解析出来却当成稳定契约"的硬约束。

## 6.3 基线文件与快照

- `nex api-snapshot` 生成 `nexus.baseline.json`，写入 git；文件内包含 `surfaceHash` 与生成时的 `buildFingerprint`。
- 基线文件的 diff 必须在 code review 中可见，任何 breaking 变更都要在 PR 里显式呈现。
- 快照只记录 Surface 与签名，不记录行号与时间戳，避免无意义抖动。
- **v1.24 新增**：快照按 root 分段（`roots: { ui: [...], docs: [...] }`），不做跨 root 合并；单 root 项目也保留该结构，保证升级不破坏格式。
- **v1.24 新增**：`surfaceHash` 必须对"条目集合 + 每条记录的 `evidenceSource` + `exportKind`"求哈希。证据来源变化（例如从 barrel-derived 升级为 package-exports）本身就是契约变化，必须体现在哈希里。

## 6.4 差分分级

| 等级 | 典型情形 |
|---|---|
| breaking | 删除或重命名公共导出；参数由可选变必填；参数顺序变化；返回类型收窄；泛型约束收紧；组件 Props/Emits 移除或改类型；重导出入口消失；**纯类型导出被删除**；**子路径导出被移除**；**条件导出分支消失** |
| additive | 新增导出；新增可选参数；类型放宽；新增重载；新增插槽；**新增子路径导出**；**新增 `evidenceSource` 更高的暴露方式**（如从 barrel 升级为 exports 声明，属契约变更，按 additive 记录但必须提示） |
| internal | 仅影响 internal 层，未触及 Surface |
| ambiguous | 命中 opaque 边界或签名无法规范化比较，需人工判定；**`barrel-derived` 且无法确认是否被外部消费** |

命令：`nex api-diff [--base <ref|file>] [--fail-on breaking|additive|ambiguous]`。CI 中默认 `--fail-on breaking`。

输出要求：每条差分必须带 `evidence`（命中的 Surface 记录、`evidenceSource`、`exportKind`）与 `rationale`（为什么判为这个等级），不能只给结论。无法判定的必须落 `ambiguous`，不得默认归入 breaking 或 internal。

## 6.5 弃用链路

废弃 API 必须能给出替代方案：读取 `@deprecated` 注解文本，解析替代符号引用，输出"旧 → 新"的迁移对；无法解析替代符号时标记 `no-successor`，并计入影响分析的高风险项。

规则：

- `@deprecated` 存在但符号仍在 Surface → `stability = deprecated`，api-diff 中删除它仍算 breaking（除非同时有 `removalVersion` 且当前版本已过）。
- 替代符号解析必须走 `symbolId`，不得按名称模糊匹配；多个候选时输出候选清单并标 `ambiguous`。
- 弃用链路的输出必须给"迁移命令建议"（可复制），但**不得自动改写代码**。

---

