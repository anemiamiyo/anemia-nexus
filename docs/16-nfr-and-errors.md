<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 16 章 非功能指标与错误码；原文照录，未修改技术内容。 -->

# 16. 非功能指标与错误码

## 16.1 准确率（v1.24 重写，P0-04）

以 tsserver / LSP（含 `vue-tsc`）为独立 Oracle，建立可重复的对照基准。**必须分三档统计，禁止只报一个召回率。**

| 指标 | 统计对象 | 目标（Phase 00 校准后固化） |
|---|---|---|
| `certainRecall` | `relationClass = certain` 的引用 | 验收夹具集与 Oracle 全量对照须 0 漏报；超大规模抽样（须注明抽样范围）≥ 99.5%，且不得存在整类漏报 |
| `certainPrecision` | 同上 | ≥ 99% |
| `heuristicCount` / `heuristicPrecision(抽样)` | `relationClass = heuristic` | 单独统计，不并入召回率；抽样精确率仅作参考，不设硬线 |
| `dynamicUnresolvedRate` | `dynamic-unresolved` 占全部应识别关系 | 必须 100% 被标注；允许存在，不允许隐藏 |
| `mappingSuccessRate` | 4.3.4 定义 | Phase 00 声明门槛，逐项记录 |
| `surfaceDecision` | Surface 判定 | 误报零容忍：把 internal 误判为 public 可接受（保守），反之不可接受 |

**禁止**：把三档合并成一个"总准确率"；用包含 heuristic 的分母计算 `certainRecall`；在抽样中排除困难样本却不声明。

## 16.2 性能指标（v1.24 重写，P0-05）

### 16.2.1 八类场景必须分别记录

v1.23 只给了"全量 build / 增量 update / 单查询"三档，无法定位瓶颈。v1.24 拆为八类，禁止合并汇报：

| 编号 | 场景 | 说明 |
|---|---|---|
| P1 | 冷启动全量索引 | 无 `.nexus/`，从头构建 |
| P2 | 热启动全量索引 | 有 `.nexus/cache/`，无索引 DB |
| P3 | 单文件修改后的增量 | 改 1 个文件 → update |
| P4 | 多文件批量修改 | 改 20 个文件 → update |
| P5 | 多根项目并行索引 | 全部 root 同时构建（受 5.10 调度） |
| P6 | 查询延迟 | 点查与一层邻接展开，p50 / p95 |
| P7 | MCP 请求延迟 | 含进程通信开销，p50 / p95 |
| P8 | 失败恢复耗时 | 从崩溃现场到可查询（12.3.3） |

### 16.2.2 目标值（待校准，不作为已证明能力）

| 规模（约） | P1 全量 | P3 单文件增量 | P4 批量增量 | P6 查询 p95 | P8 恢复 | 构建峰值内存 | 查询常驻 | 索引体积 |
|---|---|---|---|---|---|---|---|---|
| 5 万 LOC | ≤ 20s | ≤ 2s | ≤ 8s | ≤ 30ms | ≤ 5s | ≤ 400 MB（硬上限 550） | ≤ 60 MB | 5–15 MB |
| 20 万 LOC | ≤ 90s | ≤ 4s | ≤ 20s | ≤ 25ms | ≤ 8s | ≤ 600 MB | ≤ 80 MB | 30–45 MB |
| 30 万 LOC | ≤ 120s | ≤ 5s | ≤ 30s | ≤ 30ms | ≤ 10s | ≤ 700 MB（硬上限 900） | ≤ 100 MB | 40–60 MB |
| 100 万 LOC | ≤ 8min | ≤ 15s | ≤ 90s | ≤ 50ms | ≤ 30s | ≤ 1.5 GB（硬上限 1.8） | ≤ 200 MB | 150–250 MB |

口径说明：

- 上述数值是**待验证目标**，Phase 00 实测后固化；实测不达标时按 21.2 降级能力，不调整口径。
- `P6` 只含点查与一层邻接；多层 BFS（impact 深度 > 1）单独计时并单列。
- Vue 项目的 SFC 投影与坐标转译时间已计入 `P1`，不单列。
- 百万行档不进入 CI，由本地生成器按显式 `--scale` 跑一次并归档实测；CI 只跑 1k–10k 行回归。

### 16.2.3 每次测量必须记录的字段（缺一项即视为无效测量）

| 字段 | 说明 |
|---|---|
| `projectLoc` / `fileCount` | 规模 |
| `dependencyCount` | 依赖规模（`node_modules` 直接+间接包数） |
| `tsRatio` / `vueRatio` | TS 与 Vue 文件占比 |
| `nodeVersion` | `process.versions.node` |
| `os` / `osVersion` | 平台 |
| `cpuModel` / `cpuCores` / `availableMemMB` | 硬件 |
| `scenario` | P1–P8 |
| `durationMs` | 该场景耗时 |
| `peakRssMB` | 峰值 RSS（`process.memoryUsage().rss` 采样，采样间隔记为 50ms） |
| `sqliteSizeMB` | DB 文件大小（含 WAL） |
| `degraded` | 是否降级、降级项 |
| `failureMode` | 失败点与恢复耗时（P8 必填） |
| `buildFingerprint` | 5.11 |
| `repetitions` | 重复次数（≥ 3，取中位数与最大值） |

**禁止**：单次测量直接作为结论；用不同 Node 版本的数据横向比较；在降级状态下宣称达标而不标注 `degraded`。

## 16.3 错误码（v1.24 扩充，P2-02）

每个错误码都有稳定的 `code` 与 `category`。**分类只用于聚合与文档组织，判定必须读 `code`，不得解析自然语言。**

| 码 | category | 含义 | 处理提示 |
|---|---|---|---|
| E00 | `param` | 参数或用法错误（含互斥参数同现、非法枚举、非 TTY 缺必需参数） | 列出合法值与缺失参数；退出码 64 |
| E01 | `index` | 索引不存在 | 提示执行 init 与 build（同时走 22.2 引导态） |
| E02 | `index` | 索引过期（无法可靠回答） | 提示执行 update，并说明过期原因 |
| E03 | `config` | tsconfig 无效或无法解析 | 给出失败文件与错误位置，说明已降级 |
| E04 | `index` | 符号歧义（多个同名候选） | 列出候选及区分方式 |
| E05 | `index` | 符号不存在 | 必须区分「确认不存在」与「索引未覆盖」 |
| E06 | `db` | Schema 版本不匹配 | 给出重建命令 |
| E07 | `db` | 索引损坏 | 指出损坏位置，建议删除并重建该 root |
| E08 | `resource` | 并发锁占用 | 给出持锁进程与等待/回收建议 |
| E09 | `permission` | 路径不在项目范围内 | 说明允许范围与 `--include` 用法 |
| E10 | `resource` | 输出超出预算（未截断） | 给出游标与降级参数 |
| E11 | `analyzer` | 分析器内部错误 | 给出引擎名、文件、可复现最小输入 |
| E12 | `permission` | verify 命令未授权 | 说明需要用户确认的白名单（18.4） |
| E13 | `index` | 增量超出工具调用范围 | 说明触发了全局重建条件或文件数上限，给出终端命令 |
| E14 | `env` | Node 版本不满足（低于 22.16.0） | 打印当前版本、所需版本与升级方式；不尝试降级或第三方驱动 |
| E15 | `config` | 构建期：工作区根集合无法确定 | 列出候选根及来源，要求 `--roots` 或 `workspaces.roots` |
| E16 | `config` | 查询期：调用上下文无法归属单一 root | 列出候选 root 与是否已建索引，要求显式指定 |
| E17 | `config` | 配置非法（Schema 校验失败 / 未知字段 / 双源 / 版本过高） | 指出字段路径与期望类型；双源时列出两个文件 |
| E18 | `permission` | 配置文件需授权执行（TS 配置未授权） | 给出授权命令与"这是可执行代码"的明确说明 |
| E19 | `db` | 索引状态不可用（DB 与 manifest 不可调和 / 无 committed 记录） | 给出 `doctor --repair` 与重建命令，禁止返回旧数据 |
| E20 | `resource` | 资源不足（内存预算 / 并发位不足 / 已降级仍超限） | 给出当前预算、峰值、降级建议与可调配置项 |
| E21 | `index` | 身份不确定（`low` 置信迁移或存在多候选） | 列出候选与证据，要求人工确认；不得自动合并 |
| E22 | `permission` | 文件或目录权限不足 | 指出路径与所需权限，不尝试提权 |
| E23 | `internal` | 内部错误（未分类兜底） | 附 `buildFingerprint`、复现步骤、可上报的诊断命令；退出码 70 |
| E24 | `unsupported` | 请求的能力不在 v1 支持范围 | 明确说明"未提供"，给出替代做法或关闭相关索引的建议 |

补充规则：

1. **样式解析失败不新增错误码**：统一走 `E11`，`engine` 字段标 `style-dependency-analyzer`，附失败文件、失败节点与可复现最小输入。动态路径与未配置别名属于 unresolved，不是错误。
2. **E01 不得由 `status` 返回**：`status` 永远返回 `state: uninitialized`（22.2），只有查询类工具才报 E01。
3. 同一响应只允许一个主错误码；附带问题写入 `warnings[]`，`warnings[].code` 复用同一枚举，但不得改变退出码归因。
4. 错误码表是**稳定契约**：新增允许，重命名与改变语义禁止；确需变更必须升主版本并在 CHANGELOG 记录迁移方式。

## 16.4 错误输出规范（默认写 stdout，不落盘）

错误必须分两层输出：机器层保留结构化字段，人读层必须给动作。人读层不得以错误码开头，不得出现无对应操作的术语。

人读层固定四行（即 pretty 的错误形态；颜色不改变四行结构）：

1. 一句人话结论：发生了什么、影响是什么（例如「索引不存在，查询结果不可用」）。
2. 一条可直接复制的命令，优先 npx 形式，保证尚未安装也能执行。
3. 前提检查：Node 版本、配置文件、git 状态、类型检查结果。
4. 常见坑：例如命令撞名时改用备用命令 `anex`；TS 配置未授权时会拒绝执行。

示例（人读层）：

```text
索引不存在，当前无法给出可复核的引用结论。
请执行：npx anemia-nexus init --yes && npx anemia-nexus build
预计 45 秒（约 30 万行）；Node 22.16 已就绪（满足 node:sqlite 强制要求），tsconfig 已找到，git 可用。
若提示命令不是本工具，请改用备用命令 anex。
```

机器层（`--format json`）：

```json
{
  "code": "E01",
  "category": "index",
  "severity": "error",
  "message": "index not found",
  "reason": "no committed build_record in .nexus/roots/ui/index.db",
  "file": ".nexus/roots/ui/index.db",
  "suggestion": "npx anemia-nexus init --yes && npx anemia-nexus build",
  "evidence": { "checkedPaths": ["..."], "nodeVersion": "22.16.0" },
  "coverage": null
}
```

禁止事项：不得把错误、堆栈或诊断报告写入项目文件，不得自动创建 report、logs、debug 等目录；需要留档时由用户显式指定 `--output-file`，且默认路径不放在项目内。

---

