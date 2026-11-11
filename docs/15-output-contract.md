<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 15 章 输出契约与上下文供给；原文照录，未修改技术内容。 -->

# 15. 输出契约与上下文供给

本章替代 v1.0 的"Token 优化"。核心原则：**简短不失真，但不设硬性长度上限，且绝不静默截断**。信息完整性优先于长度约束；控制膨胀的手段是分层与按需展开，而不是删除条目。

**格式原则（四条，强制）**：

| 原则 | 内容 |
|---|---|
| 单一数据源 | 所有格式由同一份查询结果渲染；禁止为排版二次查询或二次排序 |
| 装饰不进契约 | ANSI / 边框 / 分页只允许出现在 pretty；lines / json / markdown 出现 `\x1b` 即判失败（自动断言） |
| 通道隔离 | MCP 工具的 format 值域只有 lines / json，默认 lines；pretty / markdown 不出现在 MCP 命名空间、schema 与工具描述中 |
| 诚实声明终端能力 | 终端没有字号 API；字号只能"尝试"（OSC 66），默认关闭，不得对外承诺可调 |

## 15.1 三层结构

| 层 | 内容 | 约束 |
|---|---|---|
| 摘要层（默认） | 符号名、种类、位置（`path:line:col`）、Surface 归属、引用计数（按三分类）、`relationClass`、`confidence` | 必须完整覆盖全部命中项；可以短，不能漏 |
| 关系层（按需） | 引用 / 依赖 / 调用边、影响路径、盲区清单 | 必须声明展开深度与是否触达预算边界 |
| 源码层（显式） | 指定 `symbolId` 的原文片段 | 仅在 `--expand` 或 `--context-lines` 时返回 |

## 15.2 完整性字段（强制）

```json
{
  "counts": {
    "total": 128,
    "returned": 128,
    "certain": 124,
    "heuristic": 3,
    "dynamicUnresolved": 1,
    "partial": 0
  },
  "coverage": {
    "filesCovered": 97,
    "filesSkipped": 0,
    "filesIgnored": 0,
    "filesFailed": 0,
    "resolved": 124,
    "unresolved": 4,
    "unmapped": 0
  },
  "truncated": false,
  "nextCursor": null,
  "staleness": "fresh",
  "buildFingerprint": "bf_xxxxxxxx",
  "identityAmbiguous": false,
  "degraded": []
}
```

规则：

1. 任何裁剪都必须令 `truncated = true` 并提供 `nextCursor`；裁剪原因必须可读（如"超出软预算 12000 tokens，已省略源码层与文档链接，条目未删减"）。
2. `counts.partial > 0` 时，`counts.total` 必须同时给出，且结论文案必须写"当前覆盖范围内"，不得写"全集"。
3. `identityAmbiguous = true` 时，必须附 `identityCandidates[]`（5.2.4）。
4. `staleness != fresh` 时，必须附 `staleReason[]`（逐条：哪个文件 / 哪个 root / 哪次失败）。
5. 样式相关查询额外返回 `styleCoverage`：`filesDiscovered` / `filesParsed` / `filesSkipped` / `edgesResolved` / `edgesUnresolved`；被 ignore 排除的文件计入 `filesSkipped` 并单列原因，不得与解析失败混同。
6. 四格式（pretty / lines / json / markdown）同源同字段，字段集合完全一致；pretty 可以增加缩进与装饰，但不得省略上述任何字段，也不得改变条目顺序。

**禁止**：用 `total` 掩盖三分类；在 `partial > 0` 时输出"共 N 处，已全部列出"；把 `degraded` 为空数组视为"没有降级过"的唯一证据（需结合 manifest）。

## 15.3 预算策略

- `--budget-hint` 为软性提示：超预算时按"源码层 → 关系层展开深度 → 文档链接"顺序降级，**不得删除条目**。
- `--no-truncate` 显式要求完整输出；对超大结果应返回分页游标而非截断。
- 不提供"硬性最大条数"作为默认行为；如用户显式设置，必须同时输出被省略的数量与获取方式。
- **（v1.24 新增）** 分层预算的默认值：摘要层不限条数（只受分页控制），关系层默认展开深度 1，源码层默认关闭。三者的实际生效值必须写入输出头部的 `budget` 字段，便于复现。

## 15.4 排序与裁剪规则

排序权重建议：图距离（越近越前）、是否命中 Surface、引用频次（写 `staticReferenceCount`，不写"热度"）、是否近期改动、是否作者相关。

裁剪只能整类省略并计入 coverage，不得在同一列表内部分删除条目。跨 root 查询的组内排序保持上述规则，组间不排序（5.9）。

## 15.5 输出稳定性要求

- 禁止输出时间戳、绝对路径、随机顺序、内存地址。
- Map / Set 遍历必须先显式排序；浮点与数字格式统一；路径分隔符统一为 `/`。
- 同一 `buildFingerprint` + 同一参数，输出必须逐字节一致，并纳入自动化测试。lines 与 json 必须逐字节稳定；pretty 只在 `NO_COLOR=1` 且固定 `COLUMNS` 的受控环境下纳入 golden。
- 摘要中若引用 `buildFingerprint`，只输出前 12 位（完整值在 `--verbose` 与 manifest 中）。

## 15.6 紧凑行格式

```text
path:line:col  kind  symbolId  reason  relationClass  conf
src/core/useOverlay.ts:42:10  fn  s_7f3k9m2q1x8b4c6d  direct-caller  certain  typed
```

- `reason` 取固定枚举（`direct-caller`、`same-module`、`public-api`、`test`、`barrel`、`template-binding`、`component-use`、`interpolation`、`style-import`、`cross-package`、`heuristic-match` 等），便于 Agent 自查引用是否合理。
- **（v1.24 改动）** 第三列由 v1.23 的"含路径的 stableId"改为 `symbolId`（不含路径，5.2.2）。位置信息已由第一列 `path:line:col` 提供，身份与位置不再混在一列。
- `relationClass` 与 `conf` 两列都必须出现：前者是能力边界，后者是本次解析证据强度（8.1）。
- `!` / `?` 前缀保留用于快速识别：`!` = dynamic-unresolved，`?` = heuristic。前缀不替代后两列的显式值。
- pretty 的行首字段与 lines 完全一致，仅增加缩进与装饰，便于人机对照。

## 15.7 人类可读渲染层（pretty，仅 CLI）

**通道边界**：pretty 只存在于 CLI 通道。它由 TTY 默认或 `--format pretty` 显式请求触发；MCP 通道既不暴露该值，也不回落至该值（14.1.5）。

**页面结构**：一屏四段，自上而下为「结论行 → 关键条目 → 覆盖与盲区 → 下一步建议」。结论行一句话回答"查到了什么、是否完整、数据有多新"；关键条目按 15.4 的排序权重取前 N 条，折叠不下时整类省略并在覆盖段说明，不做半截列表。

**颜色与可访问性**：语义色只用三档（成功 / 警告 / 失败），颜色不承载唯一信息——每条着色文本都同时带文字标记（如 `warning:`），保证 `NO_COLOR=1` 或色觉障碍下不丢信息。使用 Node 22 内置 `util.styleText`，零依赖。

**宽度与折叠**：默认宽度 `min(COLUMNS, 120)`，`--width` 可覆盖；超宽字段按"末尾省略 + 保留 `symbolId`"折叠，不换行破坏 `path:line:col` 的可复制性。

**进度与分页**：`--pager auto|off` 仅在 pretty 且 TTY 时生效；非 TTY 强制 off。长任务进度只写 stderr，不进入 stdout 结果。

**字号（诚实声明）**：终端没有字号 API，工具不承诺字号可调；仅在用户显式开启时尝试 OSC 66，失败静默忽略，不报错误、不改变输出内容。

**配置字段**：`output: { format, color, width, pager }`。`format` 非 `auto` 时覆盖 TTY 默认；`--format` 与环境变量优先级更高。`output` 只影响渲染层，不改变任何查询语义与字段集合。

**错误形态**：pretty 的错误输出即 16.4 的四行格式，不出现堆栈、不出现内部路径。

---

