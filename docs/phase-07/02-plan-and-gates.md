# Phase 07 实施计划与验收门槛（编码前冻结）

> 依据：`docs/19-delivery-phases.md` 19.1/19.2/19.3、`docs/03-tech-stack-and-build.md` 3.4、`docs/09-reuse-detection.md`、`docs/11-cli.md` 11.1–11.6、`docs/12-indexing.md` 12.3.5/12.4、`docs/14-agent-integration.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md` 16.2/16.3/16.4、`docs/17-testing.md` 17.2、`docs/22-onboarding.md`
> 入场判定：`docs/phase-07/00-entry-and-decisions.md`
> 规范版本：v1.24（冻结）
> 冻结日期：2026-11-13
> **本文件的门槛在编码开始前冻结；不达标时按 20.6 报告，不得事后调低。**

## 1. 范围与不变量

### 1.1 本阶段范围

- `nex similar`、`nex audit-duplicates`、`nex context`（CLI 与共享服务层）；
- MCP 8 工具、schema、双轨输出、error 语义、format 兜底、root 路由；
- refresh 护栏、watch、auto-bootstrap、read-only；
- `nex print mcp-config|agents|skill` 与兼容别名；
- 错误输出机器层/人读层补齐；
- `doctor` 完整版与 `--repair`、`doctor --mcp`；
- 动态可用内存预算（D3）；
- P7 MCP 延迟实测与 P1–P8 记录补齐；
- 3.4 发布验证与 `docs/release/<version>.md`；
- README、docs/README、runtime-api、四份阶段文档、实施报告、自审回执。

### 1.2 不变量（违反即 gate 失败）

1. DB 为权威，派生数据不反向覆盖。
2. MCP 固定 8 工具名；`--read-only` 仅不注册 refresh。
3. MCP 错误 `isError: true`，不 throw；CLI/MCP 同场景 `code` 一致。
4. MCP 只输出 lines/json；非法/缺省一律 lines；无 ANSI。
5. refresh 只增量；全局变化/超 200 文件/锁占用分别拒绝。
6. watch 不把旧数据标 fresh；事件只是信号。
7. `status` 永不报错；无索引为 `uninitialized` + 四组引导。
8. similar/duplicates 只输出 heuristic，附分项与人工确认。
9. `print` 永不写文件；执行后工作区无新增文件。
10. `doctor --repair` 只修 `.nexus/`；非 TTY 需 `--yes`。
11. 动态预算不放宽 16.2/21.2 实测目标；只影响调度准入与降级阈值。
12. 四格式同源；lines/json 无 ANSI/绝对路径/时间戳；裁剪有 `truncated`+`nextCursor`。
13. 只写 `.nexus/`；临时目录清空。
14. 不修改 v1.24 正文；冲突按 20.6 报告。

## 2. Gate 定义

| Gate | 判定 | 通过条件 | 证据 |
|---|---|---|---|
| **G0 similar** | 规则与输出契约 | 七项分项齐全；`rulesVersion`/`isHeuristic`/`matchBasis`/`suggestion`/`location` 均在；无候选输出 `no-similar-found` + scope/root/规则版本；`score` 0–1 两位小数；不启用向量 | 单测 + CLI 输出 |
| **G1 audit-duplicates** | 聚类与差异点 | 确定性聚类；每组参数/返回类型/实现行数差异；首行免责声明；`relationClass: heuristic`；`--threshold <0.6` 警告；只读 | 单测 + CLI 输出 |
| **G2 context** | 分层与游标 | `--task`/`--context-lines`/`--cursor` 生效；摘要/关系/源码三层；预算字段可复核；无 task 抽取失败时明确提示 | 单测 + CLI |
| **G3 MCP 协议与 8 工具** | 握手、schema、双轨 | `tools/list` 8 个；输入输出 schema；`structuredContent` + `content`；错误不 throw；status 全字段；format 兜底与无 ANSI；root 路由正确 | MCP 单测 + 冒烟 |
| **G4 refresh/watch/引导态** | 护栏与状态机 | refresh 四类拒绝 + noop；200 文件上限；锁 E08；watch 哈希确认 + 周期复核；auto-bootstrap 返回 indexing；read-only 7 工具 | 单测 + 集成 |
| **G5 print** | 三类物料 | 3 类物料内容完整；`--client` 三值；别名等价；只打印不落盘 | CLI 单测 + `git status` |
| **G6 doctor/repair** | 诊断与修复 | 完整检查项；`--repair` 需 `--yes`；只修派生数据；修复后 `status` 可读；`--mcp` 握手 | 单测 + 集成 |
| **G7 错误输出** | 16.3/16.4 | 机器层字段齐全；人读四行；不以错误码开头；同场景 CLI/MCP code 一致；默认 stdout、不落盘 | 单测 + 快照 |
| **G8 动态内存** | 预算可解释 | 默认自动；显式配置生效；可用内存充足时不提前降级；manifest/输出含 available/dynamic/config/effective；16.2/21.2 目标不变 | 单测 + 输出 |
| **G9 性能** | P7 + 记录 | P7 至少 1 条完整记录（重复 ≥3、p50/p95、字段齐全）；P1–P8 口径一致；不宣称 16.2 全部达标 | `tools/perf` JSON + 报告 |
| **G10 发布验证** | 独立安装 | 12 项逐项执行；第 5 项按 D5 标注；`npx nex/anex` 可用；MCP 握手 8 工具；临时目录清理 | `docs/release/0.0.0.md` |
| **G11 构建与回归** | 不回归 | build/typecheck/lint/format 退出 0；`npm test` 全绿；既有 Phase 01–06 断言不回归 | 命令输出 |
| **G12 文档与自审** | 可复核 | 19.3 九项、任务回填、已知问题、`git status` 无验证残留、自审回执含代码证据 | 报告 + 命令 |

**19.1 阶段 07 通过条件**：8 个 MCP 工具幂等可复现；未初始化场景 ≤3 个动作拿到首个索引结果；四格式字段一致；MCP 回落断言通过；`npm pack` 独立安装验证 12 项全通过。

**本阶段对「通过条件」的口径（编码前冻结）**：

- 「幂等可复现」：同一 `buildFingerprint` + 同一参数，两次 MCP 调用 `structuredContent` 逐字节一致；`refresh` 无变化时 `changed: 0, noop: true` 且不写文件。
- 「3 个动作内」：`nex status` 看到引导块 → 复制 `nex init --write-config --yes` → 复制 `nex build`；自动化断言引导块含这两条完整命令。
- 「四格式字段一致」：`counts`/`coverage`/`truncated`/`nextCursor`/`staleness` 四格式值相同。
- 「MCP 回落断言」：format 缺省/pretty/markdown/xml/空串 → lines，`formatFallback: true`，无 ANSI，不 `isError`。
- 「12 项全通过」：第 5 项因首次发布按 D5 记 `first-release-self-check`；其余 11 项必须真实退出 0。若任一项失败，结论为 `fail`，不得发布。

## 3. 量化口径

### 3.1 动态内存（D3）

| 字段 | 口径 |
|---|---|
| `availableMemMB` | `min(process.availableMemory(), process.constrainedMemory()>0 ? constrained : ∞)`，回退 `os.freemem()`；单位 MB，向下取整 |
| `dynamicBudgetMB` | `max(128, floor(availableMemMB × 0.5))` |
| `configuredMaxMemoryMB` | 显式配置值；未设置为 `null`（自动） |
| `effectiveBudgetMB` | `configured == null ? dynamicBudgetMB : min(configured, floor(availableMemMB × 0.5))` |
| 降级阈值 | 单 root 峰值 ≥ 85% × effectiveBudgetMB，按 5.10.4 阶梯 |
| 记录位置 | manifest `resources`、`build`/`update` 输出 `resources`、`status` 的 root/全局摘要 |

### 3.2 相似度与聚类

- 分项权重严格按 9.1.1：0.30 / 0.15 / 0.20 / 0.15 / 0.10 / 0.05 / 0.05。
- 分档：≥0.80 `reuse`；0.55–0.79 `extend`；<0.55 `new`。
- 聚类：无向图（分数 ≥ threshold 连边），连通分量按 `symbolId` 排序；每组成员 ≥2；组间按最高分降序；差异点逐组输出。
- `--threshold` 默认 0.8；<0.6 时输出 warning（退出码 2），仍执行。

### 3.3 MCP 工具契约

| 工具 | 必填参数 | 可选参数 | 关键返回 |
|---|---|---|---|
| `status` | 无 | `root`/`roots` | state/staleness/buildFingerprint/roots/coverage/capabilities/self/lastIntegrityCheck/degraded/guidance |
| `search` | `term` | `root`/`roots`/`type`/`path`/`public`/`internal`/`format` | 符号条目 + counts/coverage |
| `symbol` | `identifier` | `root`/`roots`/`history`/`format` | 符号详情 + 组件信息 |
| `references` | `identifier` | `root`/`roots`/`includeHeuristic`/`noTemplate`/`format` | 引用条目 + 三分类计数 |
| `deps` | 无 | `target`/`type`/`reverse`/`root`/`roots`/`format` | 依赖/调用/模块/样式边 |
| `impact` | `target` 或 `symbol` | `depth`/`root`/`roots`/`format` | 影响、风险、测试、盲区 |
| `context` | 无 | `task`/`target`/`symbol`/`depth`/`root`/`roots`/`cursor`/`contextLines`/`format` | 分层上下文 + 预算 + nextCursor |
| `refresh` | 无 | `root`/`timeoutMs` | changed/filesUpdated/buildFingerprint/staleness/degraded/noop/indexMutation |

- `format` 为 `z.enum(['lines','json']).default('lines')`；服务端对非法值兜底 lines。
- 所有查询工具返回 `coverage` 与 `staleness`；`status` 例外地以自身字段表达。
- `refresh` 在 `--read-only` 下不注册。

### 3.4 错误输出

- 机器层字段：`code`、`category`、`severity`、`message`、`reason`、`file`、`suggestion`、`evidence`、`coverage`。
- 人读四行：结论 / 可复制命令 / 前提检查 / 常见坑；不以错误码开头。
- 退出码：0 / 1 / 2 / 64 / 70；E23 → 70。

### 3.5 发布验证 12 项

按 3.4 表逐项执行并记录命令、退出码、耗时、环境版本。禁止用开发工作区结果替代独立安装结果。

## 4. 风险与暂停条件

出现以下任一情况，暂停编码并按 20.6 报告，不自行降低门槛：

1. MCP 传输/握手在本机或目标 Node 版本不可用，且无法用官方 SDK v2 解决。
2. 8 工具中任一无法复用现有查询逻辑，必须复制第二套查询规则。
3. refresh 无法与 CLI 共用锁，或必须绕过锁才能增量。
4. watch 无法在 Windows 递归监听下满足「事件仅信号 + 周期复核」。
5. `doctor --repair` 需要删除 committed DB 或修改源码才能修复。
6. 发布冒烟必须修改全局配置或依赖仓库 `node_modules` 才能通过。
7. 动态预算与 16.2/21.2 的实测口径出现无法同时满足的冲突。
