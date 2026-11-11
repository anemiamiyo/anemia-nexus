<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 10 章 变更影响分析；原文照录，未修改技术内容。 -->

# 10. 变更影响分析

这是本工具最重要的能力之一。

输入示例：

```bash
nex impact src/core/useOverlay.ts
nex impact --symbol useOverlay
```

输出应包含：

- 直接依赖者。
- 间接依赖者（含展开深度）。
- 受影响的公共 API。
- 受影响的组件。
- 相关类型。
- 相关测试。
- 相关文档。
- 潜在架构违规。
- 静态分析盲区。
- 建议验证的测试命令。

## 10.1 风险等级

| 等级 | 判定依据（不得仅按文件数量） |
|---|---|
| Low | 局部实现变更；未命中 Surface；引用均在单模块内 |
| Medium | 跨模块引用，但 Surface 未变；存在关联测试 |
| High | 命中 Surface（additive 或签名调整）；或触及核心基础设施；或存在无法解析的消费方 |
| Critical | Surface breaking；或存在 opaque 边界消费方且无法确认；或架构规则硬违规 |

每条风险必须给出可解释判定依据（命中的规则、来源位置、`relationClass`、`confidence`），不能只给结论。风险等级不得作为"是否可以修改"的授权，只作为人工判断的输入。

样式文件作为输入时，只输出文件级 `styleDependents`（`sourceFile` / `line` / `depType` / `confidence` / `analysisEngine`），不出现类名与选择器；风险默认 Medium，删除或重命名且存在静态消费方时 High，不进入 Critical。

多根仓库的 impact 按 root 各自计算；跨 root 只呈现 cross-package 边与 package-boundary 盲区，不得把未声明依赖的调用并入影响面。

## 10.2 计数口径（v1.24 新增，P1-06 落地）

| 指标名 | 含义 | 禁止的表述 |
|---|---|---|
| `staticCallEdgeCount` | 静态分析发现的调用边数量 | 调用频率、运行时热度、真实使用次数、热门 API |
| `referenceCount.certain` | 确定性引用条数 | "总引用数"（当存在 heuristic 或 unmapped 时） |
| `referenceCount.heuristic` | 启发式引用条数 | — |
| `referenceCount.dynamicUnresolved` | 明确无法解析的动态引用条数 | — |
| `impactFanout` | 受影响的唯一符号数 | 影响面大小（未定义口径的说法） |

**硬约束**：任何输出（CLI、JSON、MCP、报告、文档）中出现"调用频率""使用热度""真实调用次数"字样，一律判为缺陷。排序可以按 `staticCallEdgeCount`，但排序理由必须写明"按静态调用边数量排序，不代表运行时频率"。

## 10.3 impact 的输出字段

```text
impact(target)
├── target: { symbolId | filePath, rootId }
├── direct: { count, items[] }
├── indirect: { depth, count, items[], truncated }
├── surface: { affected[], diffLevel }
├── components: { affected[] }
├── types: { affected[] }
├── tests: { related[], suggestedCommands[] }
├── architecture: { violations[] }
├── blindSpots: { items[]（8.2 结构） }
├── counts: { certain, heuristic, dynamicUnresolved, partial }
└── staleness: fresh | dirty | indexing | stale | failed
```

`truncated = true` 时必须给 `nextCursor`（15.2）。`staleness != fresh` 时首行必须声明"结论基于 X 时刻索引，工作区已有 Y 处未索引改动"。

---

