<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 8 章 关系分析能力；原文照录，未修改技术内容。 -->

# 8. 关系分析能力

必须分别建立：

1. 文件依赖关系。
2. 模块依赖关系。
3. 符号引用关系。
4. 导出和重新导出关系。
5. 静态函数调用关系。
6. 组件与 Composable 关系。
7. 测试与源代码关系。

## 8.1 关系三分类 + 四档置信度（v1.24 重写，P0-04）

### 8.1.1 三分类：回答"这条关系在原理上能否被静态确定"

| `relationClass` | 定义 | 适用范围 | 承诺 |
|---|---|---|---|
| `certain` | 在明确支持的语言、语法、配置与依赖范围内，由 TypeScript / Vue 语义分析可判定的关系 | 同文件标识符引用、类型解析后的成员访问、显式 import/export、Vue 四类模板边的可解析部分、CSS 字面量相对路径 | 在覆盖完整且分析成功时，**0 漏报** |
| `heuristic` | 通过名称、结构、路径、相似度或其他间接证据推断的关系 | 同名匹配、字符串字面量推断、barrel 名称推断、动态键的部分解析、别名启发式 | 必须标注，**不承诺完整** |
| `dynamic-unresolved` | 依赖运行时状态、反射、动态路径、外部注册或运行时生成行为 | 动态 import、模板字符串拼接路径、`require(expr)`、provide/inject、事件总线、字符串 key 路由、装饰器/DI、`eval`、运行时注册的插件、外部生成未纳入索引的文件 | 明确不保证识别；输出 `!` 前缀 + reason 码 |

**关键约束**：`relationClass` 不是"置信度"，而是"能力边界"。一条 `certain` 关系的 `confidence` 可能是 `typed`（经类型解析）而不带任何标记；一条 `heuristic` 关系的 `confidence` 必然是 `heuristic`。任何查询承诺只对 `certain` 生效。

### 8.1.2 四档 confidence（沿用 v1.23，明确与上表的关系）

| 等级 | 判定条件 | 输出标记 |
|---|---|---|
| `direct` | 同文件或同容器内的直接标识符调用 | 无标记 |
| `typed` | 经类型解析的成员调用（含跨文件、重载选择确定） | 无标记，带 `analysisEngine` |
| `heuristic` | 依赖同名匹配、字符串字面量、导出名推断 | `?` 前缀 |
| `unresolved` | 动态 import、字符串 key 路由、provide/inject、事件总线、装饰器、DI 容器、eval | `!` 前缀 + 原因码 |

映射关系（实现时按此判定，不得自创）：`direct`/`typed` → `relationClass = certain`；`heuristic` → `relationClass = heuristic`；`unresolved` → `relationClass = dynamic-unresolved`。

### 8.1.3 每条关系必须记录的七项

| 字段 | 说明 |
|---|---|
| `relationType` | 文件依赖 / 符号引用 / 调用 / 导出 / 模板边 / 样式边 / 跨包边 |
| `sourceOfTruth` | 数据来源（哪个分析器的哪次输出） |
| `analysisVersion` | 分析器版本（五元组中的对应项） |
| `isDeterministic` | 由 `relationClass` 派生，布尔 |
| `confidence` | 8.1.2 的四档 |
| `constraints` | 分析限制（如"types 未解析"、"跨 root 未展开"） |
| `missReason` | 未能识别的原因（可判定时填写，枚举见 8.2） |

`missReason` 枚举：`dynamic-import` / `dynamic-path` / `reflection` / `runtime-registration` / `string-key` / `di-container` / `event-bus` / `framework-convention` / `out-of-scope` / `ignored` / `analysis-failed` / `mapping` / `package-boundary` / `unknown`。

## 8.2 盲区清单（强制输出）

影响分析与上下文供给必须附带盲区清单，至少覆盖：

**代码侧**：动态 import、运行时注册、字符串键查找、依赖注入、事件总线、模板字符串拼接路径、框架约定（自动导入、约定式路由）、反射与 eval。

**样式侧**：动态样式路径、未配置的样式别名、Sass 内置模块（`sass:*`）、CSS Modules 的类名映射。

**多根侧**：未声明依赖的跨包引用、越界的 packages 路径别名、未建立索引的 root。

**覆盖侧（v1.24 新增）**：被 ignore 排除的文件、因体积被跳过的文件、分析失败的文件、`mapping = unmapped` 的符号。

每项必须给出三件事：

| 字段 | 要求 |
|---|---|
| `affectedFiles` | 涉及文件数（不是"一些文件"） |
| `potentiallyAffectedSymbols` | 可能影响的符号数（无法计算时给上限估计与估算方式） |
| `manualCheckHint` | 建议的人工核查方式（可复制的命令或检索式） |

> 不能把文件 import 图直接称为完整调用图。宁可少给，也不能错给。

## 8.3 关系输出的一致性规则（v1.24 新增）

1. 同一条边在不同命令（references / impact / deps / context）中必须有一致的 `relationClass` 与 `confidence`，由同一份 Normalizer 输出产生，禁止各命令自行判定。
2. `references` 的计数必须按三分类分别给出（`certain` / `heuristic` / `dynamic-unresolved`），不得只给一个总数。
3. 当某符号存在 `unmapped` 映射时，该符号的引用计数必须标 `partial: true`，且 `counts.total` 旁必须显示 `counts.partial`。
4. 任何"全集"字样只允许出现在 `certain` 且 `partial = false` 时；否则必须写作"当前覆盖范围内"。---

