# Phase 05 实施计划与验收门槛（编码前冻结）

> 依据：`docs/19-delivery-phases.md` 19.1/19.2/19.3、`docs/05-data-model.md` 5.1/5.5/5.6/5.7/5.9、`docs/08-relations.md` 8.1–8.3、`docs/09-reuse-detection.md` 9.1–9.2、`docs/10-impact-analysis.md`、`docs/11-cli.md`、`docs/13-audit-and-ci.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md`、`docs/18-security.md` 18.4、`docs/20-prohibitions.md`
> 入场判定：`docs/phase-05/00-entry-and-decisions.md`
> 规范版本：v1.24（冻结）
> 冻结日期：2026-11-13
> **本文件的门槛在编码开始前冻结；不达标时按 20.6 报告，不得事后调低。**

## 1. 范围与不变量

### 1.1 本阶段范围

- impact（文件/符号/样式）、风险等级与证据；
- preflight（13.1 八项）与 core context builder；
- postflight（13.2 十一项）与 Git Diff；
- verify 与命令白名单/信任文件；
- CI 门禁与 0/1/2/64/70 退出码；
- 5.9 查询期根路由（root/roots/all、E16、分组输出）；
- 测试与源码关系（`tests` 表，schema v4）；
- 针对性盲区与四格式输出；
- F08/F12 新夹具、F14 扩展；
- 文档与阶段报告。

### 1.2 不变量（违反即 gate 失败）

1. `certain` 口径 0 漏报只对覆盖完整、分析成功的 certain 关系成立；heuristic/unresolved 分列。
2. 每条风险/finding/差分/违规/测试关系有文件、行、规则、`relationClass`、`confidence`、证据。
3. impact/preflight/postflight 均输出盲区；四件套齐全；符号数不能算时 null + 估算方式。
4. 查询/审计不修改被分析项目；postflight 后无新增未跟踪文件；verify 只执行白名单命令。
5. 多 root 不合并、不跨 root BFS、不跨 root 排序去重；cwd 无归属 E16。
6. heuristic finding `blockable:false`，不得自动阻断。
7. 四格式同源；lines/json 无 ANSI/绝对路径/时间戳；裁剪有 `truncated` + `nextCursor`。
8. 既有命令、字段、退出码、`surfaceVersion`/`baselineVersion` 不回归。
9. `tests` 表单事务写入；失败 ROLLBACK；不新增全量副本。
10. verify 白名单拒绝通配符、shell 拼接、管道、重定向、破坏性命令；未授权不执行。
11. 不把 `nex context` / `nex similar` / MCP 未实现能力写成已实现。
12. 不修改 v1.24 规范正文；冲突按 20.6 暂停并报告。

## 2. Gate 定义

| Gate | 判定 | 通过条件 | 证据 |
|---|---|---|---|
| **G0 Schema 与写入** | v4 可重建、可回滚 | `tests` 表 + 三索引；SQL 派生；单事务；失败无半套行；v3 库 E06 | schema diff、writer 测试、`doctor` |
| **G1 构建** | 可构建可检查 | build/typecheck/lint/format 退出 0；两次 dist 哈希一致 | 命令输出 |
| **G2 影响面** | 直接/间接/深度正确 | F08 四层链 certain 消费方全命中；深度/truncated；符号/文件/样式三态；无跨 root BFS | 单测 + golden |
| **G3 风险与证据** | 等级可解释 | Low/Medium/High/Critical 各 ≥1；每条 reasons 有 rule/file/line/relationClass/confidence；样式不 Critical | 单测 + F08 |
| **G4 盲区与计数** | 不混口径 | 四类 + 定向盲区字段齐全；counts 三分类；`impactFanout` 唯一符号数；partial 正确 | 单测 + 输出 |
| **G5 Preflight** | 13.1 八项 | 现有 API/相似/位置/依赖/架构/影响/文档测试/上下文齐全；相似七项分项；抽取失败可见 | 集成 + golden |
| **G6 Postflight** | 13.2 十一项 | Git Diff、符号、Surface、依赖、架构、测试、verify、报告、样式、confidence 齐全；unidentified 不跳过 | 集成 + golden |
| **G7 Verify 与安全** | 白名单与授权 | 未授权跳过/显式 E12；超时/截断；危险命令 E17；cwd 根内；无 shell 注入 | 单测 + 安全负向 |
| **G8 退出码与门禁** | 0/1/2/64/70 | `--fail-on` 各档；heuristic 不阻断；样式默认 2、`--fail-on warning`→1；E16/E19 | CLI 测试 |
| **G9 5.9 路由** | 三 scope 正确 | root/roots/all；cwd 归属；E16；分组不排序不去重；globalAmbiguous；staleRoots | F14 + 单测 |
| **G10 输出** | 四格式同源稳定 | 字段一致；lines/json 逐字节；无 ANSI/绝对路径/时间戳；多 root 前缀 | 格式测试 |
| **G11 act CI** | 容器内复现 | `act -j verify --container-options "-m 4g"` 通过；Node 22/24 | act 输出 |
| **G12 自审** | 报告与证据齐全 | 19.3 九项、任务回填、已知问题、工作区无残留 | 报告 + `git status` |

**19.1 阶段 05 通过条件**：真实变更场景漏报率为 0（certain 口径）；报告含证据与盲区；E16 失败态正确。任一不满足 → 修复后重跑；不得以“人工确认”替代漏报率为 0。

## 3. 量化口径

### 3.1 Impact

- F08 的 `certain` 消费方 golden 集合必须 100% 出现在 `direct`/`indirect`；`heuristic`/`dynamic-unresolved` 单独列，不计入 0 漏报承诺。
- 直接/间接每项含 `rootId`、`path`、`line`、`relationClass`、`confidence`、`reason`、`depth`。
- `--depth` 默认 3、最大 10；超过深度或上限时 `truncated=true` + `nextCursor`。
- `impactFanout` = 受影响唯一符号数；不得把文件数写成“影响面”。
- 样式目标：`styleDependents` 非空；无类名/选择器；风险 ≤ High。

### 3.2 风险

| 等级 | 必须出现 ≥1 | 证据要求 |
|---|---|---|
| Low | F08 单模块文件 | rule + 引用范围 |
| Medium | F08 跨模块文件 / 样式 | rule + 模块 + 测试 |
| High | F08 public 符号 / 多模块基础设施 / 样式删除 | rule + Surface/模块 + 消费方 |
| Critical | F08 breaking 或架构违规 | rule + baseline 差分/违规 |

### 3.3 Preflight

- 相似候选 ≥2，且同一输入两次运行 `score`/`scoreBreakdown` 逐字节一致；
- 无候选时 `no-similar-found` + `scope`/`root`/`rulesVersion`；
- 仅任务文本且抽取失败：`extraction.failed=true` + 可读 message + 退出码 2；
- context packet 带 `counts`/`coverage`/`truncated`/`nextCursor`/`staleness`/`budget`；
- 目标不存在 → E05；无 root → E16；用法错误 → 64。

### 3.4 Postflight

- breaking / additive / ambiguous 各 ≥1（F08 构造）；
- `findings` 每条有 id/severity/code/file/line/symbolId/evidence/suggestion/origin；
- 修改符号识别率：F08 中有符号文件 100% 命中；无符号文件进 `unidentified`；
- `surfaceDiff` 四条数组齐全，字段带 `evidenceSource`/`exportKind`；
- 依赖变化：新增/删除各 ≥1；
- 架构违规区分 introduced/pre-existing 各 ≥1；
- 样式删除 warning + 默认退出 2；`--fail-on warning` → 1；
- heuristic finding 在 `--fail-on warning` 下退出码仍 2；
- 执行前后 `git status --porcelain` 一致（仅 `.nexus/` 允许由 build 产生）。

### 3.5 Verify

| 用例 | 期望 |
|---|---|
| 未授权 + 非 TTY + 无 `--yes`（显式 verify） | E12 / 退出 1 |
| 未授权 + postflight 内部 | `skipped-unauthorized`，不影响退出码归因 |
| `--yes` 后执行 | 退出码与进程一致；trust.json 记录 |
| 超时 | `timedOut:true` + 摘要；不挂起 |
| 输出 >1 MB | `truncated:true` + 1 MB 上限 |
| `rm -rf` / `git reset` / `a; b` / `a | b` | E17 拒绝 |
| cwd `..` / 绝对路径 / 根外 | E17/E09 拒绝 |
| `--dry-run` | 不启动子进程；列出授权状态 |
| `--only` | 只跑指定 id |

### 3.6 5.9 路由

- cwd 在 root 内 → 只读该 root；cwd 在仓库根且无 scope → E16 + 候选（rootId / rootPath / indexed）；
- `--root` 与 `--roots` 同现 → 64（E00）；
- `all`：按 root 分组，组间不排序不去重；同名 `globalAmbiguous=true` + 候选；
- 全部 fresh → `completeness=complete`；否则 `partial` + `staleRoots[]`；
- failed root 不读，列 `failedRoots[]`；全部不可用 → E19；
- lines 多 root 前缀 `[rootId]`；单 root 省略。

### 3.7 输出与退出码

| 场景 | 退出码 |
|---|---|
| impact/preflight/postflight 无阻断无告警 | 0 |
| `--fail-on` 命中 | 1 |
| 仅告警（heuristic、stale、unidentified、样式 warning） | 2 |
| 用法/互斥/无归属/无 git 前置 | 64（E00/E16） |
| 显式 verify 未授权 | 1（E12） |
| 索引不存在/不可用 | 1（E01/E19） |
| 内部错误 | 70（E23） |

## 4. 测试矩阵

| 层级 | 范围 | 断言 |
|---|---|---|
| 单元 | 目标解析、反向 BFS、风险规则、测试文件判定、相似评分、diff 行区间、命令校验 | 纯函数；无子进程/网络 |
| 集成 | F08 build + impact/preflight/postflight；F14 路由；F12 staleness | 真实 SQLite + CLI；golden |
| CLI | 四格式、`--explain`、`--symbol`、`--depth`、`--task`、`--base`、`--fail-on`、`--report`、`--only`、`--dry-run`、`--root/--roots` | 退出码、字段、无 ANSI |
| 安全 | 危险命令、注入、越界 cwd、未授权、截断、超时 | E17/E12/无新文件 |
| Git | 临时 git 仓库的 A/M/D/R；无 git；base 不存在 | E00；无破坏性命令 |
| 稳定性 | 两次 build/impact/postflight | 逐字节一致；tmp 为空 |
| 回滚 | tests 表写入失败 | 四表 + tests 无半套行；旧 committed 保留 |
| 回归 | Phase 01–04 全部测试 | 不降断言 |
| act | Node 22 / 24 矩阵 | 全绿 |

测试必须离线；F08 ≤400 行、F12 ≤120 行；F01–F18 合计 ≤12000 行。

## 5. Oracle 定义

| 用途 | Oracle | 说明 |
|---|---|---|
| impact 消费方 | tsserver / 人工核对 | golden 固化在 F08 `expected/` |
| 风险等级 | 人工按 10.1 判定 | 每条给规则证据 |
| preflight 相似 | 9.1.1 规则手算 | 分项逐项核对 |
| postflight Surface | baseline + 人工核对 | breaking/additive/ambiguous |
| 修改符号 | Git 行区间 + 声明区间 | 人工核对 F08 |
| 架构违规 | 配置 allow + 人工核对 | introduced/pre-existing |
| 测试关系 | 测试文件 import/call + 人工核对 | 不由工具自证 |
| 5.9 路由 | 5.9 表 + 人工核对 | E16/globalAmbiguous |

## 6. 性能与内存记录

- 记录 impact 的 `resolveMs` / `directMs` / `indirectMs` / `totalMs` / 深度 / 项数；
- postflight 的 git / parse / surface / verify 各段耗时；
- 查询 p50/p95（点查与一层邻接）；`peakRssMB`（父进程 50ms 采样）；
- 只代表 F08/F12/F14 与本仓库有界样本，**不外推 21.2 任何规模档**；
- 增量/内存预算/全局调度器仍属 Phase 06。

## 7. 失败处理

| 失败 | 处理 |
|---|---|
| certain 消费方漏报 | 修复后才能关闭 Phase 05；不得人工确认替代 |
| heuristic 被计入 certain | 立即修复计数口径 |
| 风险无证据 | 补 rule/file/line/relationClass/confidence |
| 盲区字段缺失 | 补四件套；符号数算不出写 null + 估算方式 |
| `git status` 新增文件 | 定位写入点；改为 stdout；删除残留 |
| 危险命令被执行 | 立即停止；补 E17 校验；安全负向回归 |
| verify 挂起 | 超时 + kill；非 TTY 5s 内退出 |
| 多 root 全局排序 | 改为按 root 分组；补 F14 断言 |
| E16 缺失 | 补无归属分支 + 候选清单 |
| schema 不兼容 | E06 + 重建命令；不得迁移 |
| 写入失败 | ROLLBACK；旧 committed 保留 |
| act 失败 | 修复后重跑；不得以本地通过替代 |
| 回归失败 | 修复后才能关闭 Phase 05 |

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 反向 BFS 漏边 | 影响面漏报 | 三类边统一入口 + visited + F08 golden + 0 漏报门禁 |
| 多 root 结果混排 | 违反 5.9 | 单一 router + byRoot + F14 断言 |
| Git Diff 解析错误 | 修改符号误判 | `-U0` + 区间相交 + unidentified 兜底；人工 golden |
| Surface 差分基于 stale 索引 | 误报 | stale → confidence low + finding；不自动 build |
| verify 命令注入 | 安全 | 白名单 + 元字符拒绝 + 无 shell + 安全负向 |
| Windows `.cmd` | 兼容性 | 固定 ComSpec 启动器 + 严格引用；测试覆盖 |
| heuristic 自动阻断 | 误杀正常变更 | `blockable:false` + 退出码测试 |
| 文档文本匹配噪声 | 误报 | 有界、只读、给检索范围、标 heuristic |
| tests 表增大 build | 性能 | SQL 内派生、索引、批计数；只记录有界样本 |
| 5.9 改造破坏既有查询 | 回归 | 单 root 路径保持原输出；全量回归 |

## 9. 交付判定

Phase 05 关闭必须同时满足：

1. G0–G12 通过；
2. `npm test` 全绿（Node 22.16.0；act 内 Node 22.16.0 与 24.22.3）；
3. F01/F05/F10/F15/F17 既有断言不回归；Phase 03/04 Surface 与 deps 断言不回归；
4. 19.1 三条通过条件逐条有证据：certain 漏报率 0、报告含证据与盲区、E16 正确；
5. 报告与自审回执齐全，`git status --porcelain` 无验证残留（负责人 `.actrc` 除外）；
6. 所有未完成项以 `partial / heuristic / unresolved / unsupported / failed` 标注，不冒充 completed。

不满足时 Phase 05 记为 **pass-with-limits** 或 **fail**，不得自动进入 Phase 06。
