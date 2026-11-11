<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 4 章 系统总体架构；原文照录，未修改技术内容。 -->

# 4. 系统总体架构

采用分层、插件式架构，并严格执行**构建层与查询层分离**：构建层可慢、可增量、允许重计算；查询层不得修改被分析项目（索引自维护是唯一例外）、低延迟，且不得触发全项目类型检查。索引单位是 root（可独立 typecheck 的 package），由 Project Discovery 先枚举根、再按根各自跑一条构建管线（见 5.7）。

```text
Anemia Nexus
│
├── Build Layer（离线 / 可增量 / 允许慢）
│   ├── Project Discovery & Configuration Resolver
│   │   └── Config Loader（JSON 严格校验 / TS 授权执行）
│   ├── Global Resource Coordinator（全局预算 / 调度 / 取消 / 降级）
│   ├── Plugin Manager
│   ├── Analyzer Orchestrator
│   │   ├── TS Semantic Analyzer（TS Compiler API）
│   │   ├── Vue Virtual Code Analyzer（@vue/language-core）
│   │   ├── Syntax Analyzer（ts-morph，按需加载）
│   │   ├── JSON / Config Analyzer
│   │   └── SCIP Indexer Bridge
│   ├── Semantic Merger（多分析器符号映射 / 冲突裁决 / 未映射登记）
│   ├── Normalizer（统一 Schema + 关系分类 + 证据来源）
│   ├── Graph Builder（引用 / 依赖 / 调用）
│   ├── Surface Builder（API Surface 与基线）
│   ├── Incremental Engine（失效传播 / 提交协议 / 锁 / 崩溃恢复）
│   ├── Health & Metrics（覆盖率 / 峰值 RSS / 阶段耗时）
│   └── Store（SQLite 权威 + 少量人读 JSON + 构建指纹）
│
├── Query Layer（在线 / 只读 / 低延迟）
│   ├── Query Planner
│   ├── Symbol / Reference / API / Dependency / Call Query
│   ├── Impact Analyzer
│   ├── Similarity Analyzer（可解释规则优先）
│   ├── Context Builder（分层 + 完整性契约）
│   └── Staleness Guard（状态机唯一入口）
│
├── Interface Layer
│   ├── CLI（人用 + CI）
│   └── MCP Server（只读查询 + refresh）
│
└── Governance
    ├── Surface Policy（public / internal / opaque）
    ├── Baseline Manager（nexus.baseline.json）
    ├── Rule Evaluator（架构规则）
    └── Report & Exit Code
```

> 这是一张逻辑架构图，不要求 Agent 严格按照目录名实现，但模块职责必须保持独立；构建层与查询层的边界不得混淆。
>
> v1.24 相对 v1.23 的四处结构性新增：`Config Loader`（配置执行边界，18.3）、`Global Resource Coordinator`（5.10）、`Semantic Merger`（4.3）、`Health & Metrics`（12.7）。四者都是独立职责，不得塞进现有模块内部当私有函数。

## 4.1 Vue 确定性索引管线（SFC → 影子 TS → SCIP）

第 3–5 章定义的是纯 TS 契约。scip-typescript 不能直接读取 `.vue`，Vue 必须走一条独立管线；这条管线上的每一环都必须有确定性定义，否则"引用漏报率为 0"在 Vue 项目上无法被验证。以下七环缺一不可（第七环为 v1.24 新增）。

```text
.vue 源码
   │
   ├─(1) 投影：影子 TS 临时物化 + 内存映射
   ├─(2) 过滤：剔除 __VLS_* 内部符号
   ├─(3) 降级：复杂 Props / Slot 类型显式标注
   ├─(4) 建模：模板表达式引用边
   ├─(5) 转译：入库前把坐标翻成 .vue 行列
   ├─(6) 锁定：版本组合写入构建指纹，变化即全局重建
   └─(7) 映射：SCIP descriptor ↔ .vue 源码符号（见 4.3）
   │
   ▼
SCIP 索引
```

### 4.1.1 影子文件与坐标转译（构建期临时物化）

影子 TS 与行号映射都是**构建期中间态**，不是长期产物。原则：**磁盘只临时存在，SQLite 只存源码坐标**，不维护持久化的 shadow 文件树，也不维护 map.json sidecar。

1. **临时物化**：需要跑 SCIP 时，把受影响的 SFC 投影成 shadow TS，写入 `.nexus/tmp/vue/`；构建结束（成功或失败）立即删除该目录，下次启动先清理残留。该目录不进 git、不进包、不计入索引体积。
2. **内存映射**：映射表在生成 shadow 的同一次投影中构建，仅驻留内存，分段记录 `shadow(line,col) ↔ source(line,col)`。
3. **入库前转译**：SCIP 结果入库前，用映射把所有 occurrence 的坐标翻译成 `.vue` 坐标；`symbols` / `references` / `calls` 只写源码坐标。因此查询期完全不依赖映射表。
4. **只留指纹**：SQLite 仅增一张 `vue_file_meta`（`file_id`、`sourceHash`、`projectorVersion`、`languageCoreVersion`、`generatedAt`），不含任何影子文本或映射段。

**为什么不做持久化缓存**：单个 SFC 的投影是毫秒级，3000 个 SFC 约几十秒，约占 16.2 中 30 万档构建预算的 20%–30%，已计入该档指标；超支时按 21.2 的原则降级投影粒度，不放宽预算。影子文件一旦持久化，就会引入"陈旧缓存与源码不一致"的第二类一致性风险，这在 12.2 的门禁之外，无法被现有校验覆盖。

**空间对比**（30 万行 Vue 项目，约 3000 个 SFC）：持久化 shadow + map.json 的方案会额外占 60–120 MB；本条方案只剩 meta 表，约 1–2 MB，量级差异接近两个数量级。

**调试能力不丢失**：需要查看投影结果或映射时，用 `nex doctor --dump-vue-map <file>` 现场重新生成并打印到 stdout，不落盘。

验收：构建后 `.nexus/tmp/` 为空；异常退出后的残留能在下次启动被清理；同一构建指纹重复构建，入库后的源码坐标逐字节一致；随机 200 个符号的入库坐标与 Volar source range 一致。

### 4.1.2 Volar 内部符号过滤

虚拟 TS 混入大量 `__VLS_` 注入符号。三条规则必须同时生效：

1. **名称与位置双判**：name 命中 `__VLS_` 前缀，且定义位于 generated-only 区间（无映射段），判为内部符号。
2. **只保留可回指符号**：声明位置必须能映射回 `.vue` 源码；不能回指的一律丢弃，不论名字。
3. **引用边同理**：指向内部符号的引用边丢弃；用户代码指向用户符号的边保留。

过滤不得静默：`coverage` 增加 `filteredInternal` 计数；references 结果中一旦出现 `__VLS_` 名字，直接判 E11，不得作为正常输出。

与 vue-tsc 对齐：Phase 00 用 vue-tsc 的既有过滤规则做抽样对照，两侧对同一 SFC 的"用户符号集合"必须一致，否则视为过滤规则未对齐。

### 4.1.3 复杂类型显式降级（Props / Emits）

明确不承诺"任意复杂类型均可解析"。以下三类按已知不稳定处理：作用于整个 Props 对象的条件类型、需要完整类型分析的映射类型（如 DeepReadonly）、依赖 ambient global types 的类型。

策略是"保留原文 + 全项目上下文解析 + 显式降级"，不把第三方 type-resolver 作为默认依赖：

1. 投影保留类型原始文本，不做字面量展开。
2. 交给 TS Compiler 在完整项目上下文中解析；成功且无 any / never 污染 → `resolved`。
3. 结果含 any / never / error，或引用了索引范围外的 ambient 类型 → 标记 `heuristic`，附 reason 与原始类型文本。
4. Surface 输出必须带 `propsCoverage`（resolved/total），unresolved 逐条列出并附人工核查命令。

可选项：允许在配置中设置 `vue.typeResolver` 前置命令（opt-in）；执行须经 18.4 的命令授权流程，失败不得影响主流程，只把相关条目降级为 heuristic。

### 4.1.4 模板引用边建模

`<template>` 中的表达式是真实消费方，必须建成引用边：

| 类型 | 示例 | 边 kind | 置信度 |
|---|---|---|---|
| 组件标签 | `<Overlay>` / `<overlay>` | component-use | 能解析到导入则 certain |
| 事件与指令 | `@click="save"`、`v-if="cond"` | template-binding | 标识符 certain；成员表达式 heuristic |
| 插值 | `{{ count }}` | interpolation | certain |
| 动态参数 | `:prop="x"`、`v-bind:[k]="v"` | template-binding | 静态键 certain；动态键 unresolved |

边的 source 是映射回 `.vue` 的精确位置，target 是 script 符号的 `symbolId`，kind 取上表四个固定值。slot 内容中的表达式与事件同样建模，不得因为位于子节点而跳过。

impact 必须纳入模板边；references 在 Vue 项目中默认包含模板引用；`--no-template` 可关闭，但输出必须声明"模板边未纳入"，不得静默省略。

### 4.1.5 Slot 类型与版本敏感性

language-core 的 slot 推断需显式开启，且在历史上反复出现 v-if 分支内中断、union slots 参数推断错误、动态 slot 名不解析等问题。处理方式：

- 显式开启 slot 推断，并把开关状态写入构建指纹。
- 推断为 never 或缺失时，slot 类型标记 `heuristic` 并附 reason，不视为确定性结论。
- breaking 判定不得仅凭 slot 类型变化，须 props 或 emits 同时变化才升级。
- language-core 与 vue-tsc 锁定到同一版本族；升级视为分析器版本变化，触发全局重建（12.1）。

### 4.1.6 版本锁定与 TS 约束

language-core 不接受 TypeScript 7.x，本项目锁定 TS 5.x。Phase 00 必须记录 language-core、vue-tsc、TypeScript 三者版本组合并写入项目描述文档与《构建指纹字段表》；构建指纹中的 `analyzerVersion` 同时记录三者，任一变化触发全局重建。

### 4.1.7 子里程碑与验收（对齐 19 章阶段表）

本管线的验收不是独立阶段，而是嵌在 19 章的阶段 02 与阶段 06 内。

| 子里程碑 | 所属阶段 | 通过条件 |
|---|---|---|
| V1 影子物化 + 内存映射 + 坐标转译 | 02 | 200 点入库坐标与 Volar source range 一致；重复构建坐标字节一致；构建后 tmp 为空 |
| V2 `__VLS_` 过滤 | 02 | 用户符号集合与 vue-tsc 抽样一致；references 无幽灵引用 |
| V3 四类模板引用边 | 02 | F05 断言四类边各至少 1 条；删除 handler 后 impact 能定位模板位置 |
| V4 Props 降级与 Slot 标注 | 02 | `propsCoverage` 正常输出；unresolved 可人工核查；slot never 有标注 |
| V5 增量一致性（Vue 夹具） | 06 | 12.2 门禁在 Vue 夹具跑通；增量与全量坐标逐字节一致；tmp 残留可清理 |
| V6 SCIP ↔ Vue 符号映射 | 02 | 4.3 的 T09 场景全部产出映射结果；未映射项全部登记，无静默丢弃 |

与 16.1 的关系：Vue 夹具的引用召回率以"可回指符号 + 四类模板边"为统计范围，内部符号不计入分母；基线由 F05 夹具固定，不允许用工具自身输出自证。

## 4.2 样式依赖分析链（文件级，独立于符号链）

样式文件不是 TypeScript，也不该被塞进符号模型。这里只做一条**文件级静态依赖链**：把 `.css/.scss/.less` 作为 File，把静态引用写成 Dependency；**不产出 Symbol / Reference，不进 API Surface，不进 SCIP**，MCP 工具数量不变（仍为 8）。

| 能力 | 版本 | 说明 |
|---|---|---|
| CSS/SCSS/Less 文件级依赖 | v1 必做 | @import、@use、@forward、Vue `<style src>`、TS/JS `import "./x.css"` |
| 反向查"谁引用了该样式文件" | v1 必做 | `nex deps <style-file> --reverse` 与 `nex impact <style-file>` |
| HTML `<link rel="stylesheet">` / `<style src>` | v1.x opt-in | HTML 默认不索引（`style.html=false`）；开启后标 experimental 并新增夹具，不进 v1 gate |
| 类名 / 选择器消费方 | 不做 | 不进入 references 全集，不回答".btn 被哪些组件使用" |
| `url()` 指向图片 / 字体 | 默认不做 | 避免把资源混入样式影响面；需要时另立 asset-url，不计入样式依赖 |

### 4.2.1 分析管线

```text
.css / .scss / .less
   ├─ 文件发现：contentHash + 相对 POSIX 路径
   ├─ 静态提取：@import / @use / @forward 字符串
   │             Vue <style src="...">
   │             TS/JS import "./x.css"
   │             HTML <link href> / <style src>（opt-in）
   ├─ 路径解析：相对路径 → style.aliases → 解析失败
   └─ 写入 dependencies 表：source_file_id, target_file_id, depType, relationClass, confidence
```

**只做语法层提取**：用 postcss 系拿到字符串字面量即停；**不执行 Sass/Less 编译**，不解析变量拼接后的路径，不访问网络。HTML 若开启，追加 parse5。

**置信度**：字面量相对路径且文件存在 → `direct`；经 `style.aliases` 解析，或 `~`/`@` 前缀可被配置解释 → `heuristic`；动态拼接、变量路径、Sass 内置模块 `sass:*`、外部 URL → `unresolved` 并附 reason，且必须计入 coverage。

**边类型**：`style-import`（CSS @import / Less @import）、`style-use`（SCSS @use）、`style-forward`（SCSS @forward）、`style-src`（Vue style src）、`style-link`（HTML，opt-in）、`style-import`（TS/JS 侧 import，`analysisEngine` 标 `script-side`）。

**配置**（JSON）：

```json
{
  "style": {
    "aliases": { "@styles": "src/styles" },
    "extensions": [".css", ".scss", ".less"],
    "html": false
  }
}
```

**查询**：`nex deps <style-file> --reverse` 返回文件级消费者全集；`nex deps <file> --type style` 只看样式边；`nex impact <style-file>` 只输出 `styleDependents`，不出现类名/选择器。无结果时必须区分"确认不存在 / 文件未覆盖（被忽略或未解析）/ 别名未解析"。

**能力声明**：status 返回 `capabilities`，字段为 `styleDependency: "file-level"`、`styleSelector: "none"`、`htmlFileRef: "experimental-off"`，防止调用方误以为存在选择器级能力。

**不进符号链**：样式边不计入 references 符号计数，不参与 api-diff 与 Surface 判定；影响等级最高 High（删除/重命名且有静态消费方），不进 Critical。

## 4.3 多分析器语义统一（v1.24 新增，P0-01）

### 4.3.1 三个分析器不是同一个语义环境

必须先承认事实，再谈整合：SCIP、TS Compiler API、Vue Language Core 各有独立的运行上下文。

| 维度 | SCIP 链路（scip-typescript） | TS Compiler API 链路 | Vue 链路（@vue/language-core） |
|---|---|---|---|
| 输入 | 磁盘源码 + tsconfig | 磁盘源码（含虚拟文件） | `.vue` 源码 + 投影出的 shadow TS |
| TypeScript 版本 | 由 scip-typescript 自带依赖决定，**可能与本项目的 TS 版本不同** | 本项目锁定的 TS 5.x | 必须与本项目 TS 版本兼容（4.1.6） |
| 项目配置 | 读取目标项目 tsconfig；对 paths / references 的解析由其内部实现决定 | 本项目构造的 `Program`，配置由 Config Loader 提供 | 复用 TS Program，但文件集合被 SFC 投影改变 |
| 符号表示 | `symbol` 字符串（descriptor：package + scheme + 路径 + 名称链） | `ts.Symbol` 实例（内存对象，无跨进程稳定性） | `ts.Symbol` 实例 + Volar 虚拟节点 |
| 位置口径 | 0-based line/col（UTF-8 byte 偏移用于 occurrence） | 0-based line，col 以 UTF-16 code unit 计 | shadow 坐标，需映射回源码 |
| 生命周期 | 一次性产物（index.scip） | 进程内，随 Program 释放 | 进程内，随投影器释放 |

三条结论（写进代码注释与架构文档，不得违反）：

1. `ts.Symbol` 是**进程内对象**，不能跨进程、跨构建、跨版本作为身份依据。身份必须落在 5.2 定义的 `symbolId` 上。
2. SCIP 的 symbol 字符串里**含有路径成分**，与"身份不依赖路径"的目标天然冲突；映射时必须走 5.2 的 `declarationLocator`，不得直接把 SCIP symbol 当主键。
3. Vue 的符号只在投影上下文里成立，映射回 `.vue` 后必须重新做一次"是否可回指"判定（4.1.2）。

### 4.3.2 映射策略：以声明位置为锚，不以名称为锚

符号映射的唯一锚点是 `declarationLocator`（5.2），匹配流程固定为四步，顺序不得调整：

```text
step 1  文件级对齐：同一 rootId + 同一相对路径 + 同一 sourceHash
          ↓ 失败 → 文件被移动/重命名 → 走 5.2 身份迁移流程，本轮不映射
step 2  声明级对齐：声明起始位置（行,列）+ 声明种类（fn/class/var/interface/type/enum/ns）
          ↓ 多点命中（同一位置有重载或声明合并）→ step 3
step 3  结构级对齐：名称链 + 参数个数 + 类型文本归一化哈希
          ↓ 仍多义 → 保留歧义，登记 ambiguous，不强行取一
step 4  交叉校验：SCIP descriptor 的名称链与 step 2/3 结果一致性检查
          ↓ 不一致 → 记 conflict，按 4.3.3 优先级裁决
```

映射表落库（每 root 一份）：

| 列 | 含义 |
|---|---|
| `symbol_id` | 5.2 的 `symbolId` |
| `engine` | `scip` / `ts` / `vue` |
| `engine_ref` | 该引擎内的原生引用（SCIP symbol 字符串 / TS 声明文件+位置哈希 / Volar 节点 id） |
| `match_quality` | `exact` / `structural` / `conflict` / `ambiguous` / `unmapped` |
| `evidence` | 判定依据（命中的 step 与比较字段） |
| `analyzer_version` | 该引擎的版本串 |

四类结果都必须落库，**`unmapped` 与 `ambiguous` 不是"没有数据"，而是有记录的数据**。查询期遇到 `unmapped`，按 8.1 输出 `unresolved(mapping)` 并带原因，不得当成"不存在"。

### 4.3.3 冲突裁决与失败处理

| 场景 | 裁决 | 输出标记 |
|---|---|---|
| SCIP 与 TS 对同一位置给出不同名称链 | 以 TS Compiler API（本项目锁定的 Program）为准 | `match_quality=conflict`，`confidence` 降一档，`evidence` 记录两侧值 |
| SCIP 有 occurrence，TS 无对应声明 | 判 SCIP 侧为 `unmapped`，不构造符号 | `unresolved(mapping)`，计入 coverage.unmapped |
| TS 有声明，SCIP 无 occurrence | 符号保留，引用边缺失 | 该符号的引用计数标 `partial`，禁止输出"共 N 处，已全部列出" |
| Vue 投影符号无法回指源码 | 丢弃该符号（4.1.2） | `coverage.filteredInternal` 计数 |
| 同一位置多声明（重载 / 声明合并） | 按重载序号区分，不合并为一个符号 | `@<ordinal>` 后缀，`ambiguous=false` |
| SCIP 生成整体失败 | 整条 SCIP 链路降级（18.2） | 首行声明 `mode: syntax-only`，Surface 与引用结论降为 heuristic |

**禁止**：任一侧缺失时用另一侧"补齐"并当作确定性结果；把 `conflict` 静默取一个；在映射率不足时调低阈值让报表好看。

### 4.3.4 验证方法（Phase 00 必须完成）

建立独立的最小测试仓库 `fixtures/semantic-map/`（不放进 F01–F18 行数配额，单独计算，总量 ≤ 1500 行），覆盖 P0-01 要求的全部场景：

| 编号 | 场景 | 断言 |
|---|---|---|
| T01 | 普通函数 / 类 / 变量 / 接口 | 三引擎均 mapping，`match_quality=exact` |
| T02 | Barrel 多层重导出 | 重导出链末端符号身份唯一，链上每跳都有边 |
| T03 | `export { A as B }` 别名 | 别名不产生第二个符号；引用指向 A 的 `symbolId` |
| T04 | `import type` 与值 import | 两者边 kind 不同，均不与对方合并 |
| T05 | 声明合并（interface / namespace） | 合并为一个符号，成员完整，`ambiguous=false` |
| T06 | 函数重载 | 每个重载独立 `@ordinal`，调用点指向选中的重载 |
| T07 | 泛型类型与泛型实例 | 类型参数不被误当符号；实例化引用指向泛型声明 |
| T08 | 跨目录、跨 package 引用 | 同 root 内 exact；跨 root 只按 5.7 规则 |
| T09 | Vue SFC（script / template / props / emit / 组件引用） | 全部可回指；模板边四类齐备 |
| T10 | 文件删除 / 重命名 / 模块路径变化 | 不产生重复符号；身份迁移按 5.2 判定并给出置信度 |

必交报告字段：

| 字段 | 口径 |
|---|---|
| `mappingSuccessRate` | `exact + structural` 占全部应有映射的比例，分子分母定义必须写明 |
| `falseMatchCount` | 两引擎指向不同声明却被判为同一符号的数量（目标 0） |
| `missedMatchCount` | 应有映射却记为 `unmapped` 的数量 |
| `conflictCount` | 名称链不一致的数量，附逐条样例 |
| `unmappedReasons` | 按原因分类计数（配置不一致 / 版本不一致 / 虚拟文件 / 语法不支持 / 其他） |
| `oracleAgreement` | 与独立 Oracle（tsserver + vue-tsc）的一致率 |

**通过条件**：T01–T10 全部有自动化断言；`falseMatchCount = 0`；`mappingSuccessRate` 达到 Phase 00 预先声明的门槛（门槛值在验证前写定，不允许事后调整）；不支持的场景全部显式登记，不得静默丢弃。---

