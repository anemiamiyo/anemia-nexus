# Phase 07 入场记录：复用性、MCP 与交付

> 记录日期：2026-11-13（Asia/Shanghai）
> 依据：`docs/19-delivery-phases.md` 19.1/19.2/19.3、`docs/09-reuse-detection.md`、`docs/11-cli.md`、`docs/14-agent-integration.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md` 16.3/16.4、`docs/17-testing.md` 17.2、`docs/22-onboarding.md`、`docs/03-tech-stack-and-build.md` 3.4、`docs/12-indexing.md` 12.3.5、`docs/18-security.md`、`docs/20-prohibitions.md`
> 规范版本：v1.24（冻结）
> 前置：`docs/phase-06/03-implementation-report.md`（Phase 06，`pass-with-limits`，负责人 2026-11-13 允许进入 Phase 07）
> 状态：**负责人 2026-11-13 允许进入 Phase 07。本文件与 `01-task-checklist.md`、`02-plan-and-gates.md` 共同构成编码前冻结基线。**

## 1. 授权与基线

| 项 | 值 |
|---|---|
| 负责人裁定 | 2026-11-13：接受 Phase 06 以 `pass-with-limits` 关闭；**允许进入 Phase 07** |
| 基线 commit | `792aa83`（`feat(phase-06): 实现增量索引、崩溃恢复、调度器与性能采集`） |
| 工作区 | 入场时 `git status --porcelain` 为空 |
| Node / npm | v22.16.0 / 10.9.2（本地） |
| Schema | **保持 `SCHEMA_VERSION = 4`**；本阶段不新增表、不改既有列 |
| 本地执行环境 | DSH 沙箱默认禁止 Node 子进程；SCIP 构建、act、发布冒烟需在 `danger-full-access` 下执行（只影响验证，不改变产品行为） |
| 冻结文件 | 本文件、`01-task-checklist.md`、`02-plan-and-gates.md`；编码开始后不得调低门槛 |
| 提交纪律 | 未获负责人指示不创建 commit、不推送；本阶段结束时如实报告工作区变更 |

## 2. 本阶段范围

### 2.1 交付能力（对应 19.1 阶段 07）

1. **`nex similar`（9.1）**：确定性规则集、七项分项得分、`rulesVersion`、`isHeuristic`、`matchBasis`、`suggestion`、`location`；无候选输出 `no-similar-found` 并附 scope/root/规则版本；不启用向量嵌入。
2. **`nex audit-duplicates`（9.3）**：全量符号聚类、每组差异点（参数/返回类型/实现行数）、`relationClass: heuristic`、首行免责声明、`--threshold <0.6` 警告；只报告，不修改代码。
3. **`nex context`（15 章 / 11.3）**：分层上下文供给，支持 `--task`、`--context-lines`、`--cursor`；仅供 CLI 与 MCP `context` 工具复用同一实现。
4. **MCP 8 工具（14.1）**：`status` / `search` / `symbol` / `references` / `deps` / `impact` / `context` / `refresh`；参数最少、幂等、可裁剪；返回带 `coverage` 与 `staleness`；输入输出同时声明 schema；双轨输出；错误 `isError: true` 不 throw；format 仅 `lines|json`，默认 lines，非法值服务端兜底。
5. **refresh 护栏（14.1.1）**：只增量；200 文件上限；与 CLI 共用 root 锁（持锁 E08）；`buildFingerprint` 未变化时 `noop: true` 零写入；全局重建条件拒绝并提示 CLI；只写 `.nexus/`；返回 `degraded`。
6. **MCP 运行模式（14.1.2）**：手动、`--watch`、`--read-only`、`--auto-bootstrap`；`indexing` 不冒充 `fresh`；watch 采用「事件仅作信号 + 内容哈希确认 + 周期复核」。
7. **`nex print <asset>` 与兼容别名（14.3）**：`mcp-config`（`--client dsh|claude|cursor`）、`agents`、`skill`；只打印到 stdout，**永不写文件**；`mcp-config` / `agents` / `skill` 别名保留。
8. **错误输出规范（16.3/16.4）**：机器层 `code`/`category`/`reason`/`file`/`suggestion`/`evidence`/`coverage`；人读层四行、不以错误码开头、默认 stdout、不落盘；E01 不由 `status` 返回；同一失败场景 CLI/MCP `code` 一致。
9. **`doctor` 完整版 + `--repair`（11.3/12.3.3/12.4）**：诊断项补全；`--repair` 只修 Nexus 自身数据（恢复、manifest/surface/workspace 重建、pending/tmp/孤儿 root 目录清理），必须 `--yes`，不碰项目源码与配置。
10. **动态内存预算（负责人指令，替代 Phase 06 的固定 900 MB 默认）**：默认预算由可用内存动态计算；显式 `resources.maxMemoryMB` 仍生效；内存充足时不得因静态上限提前降级。
11. **性能与发布（16.2 / 3.4）**：P7 MCP 请求延迟实测并归档；补全 P1–P8 记录口径；`npm pack` 产物 + 干净临时目录完成 12 项发布验证，输出《发布验证记录》。
12. **文档与报告**：README（能力、限制、接入）、`docs/README.md` 索引、`docs/runtime-api.md`、阶段四份文档、实施报告、自审回执。

### 2.2 明确不做

| 能力 | 处理 |
|---|---|
| 向量嵌入相似度（9.1.2） | 不做。默认关闭且不得成为正确性依据；本阶段不引入任何本地模型或向量依赖 |
| 跨 root 合并索引 / 跨 root BFS | 永久禁止（5.7/5.9）；MCP 多 root 只做边界聚合，结果按 root 分组 |
| `nex test` 全量测试编排 | 19.1 阶段 07 未列；保持 `E24`「未提供」，不得用夹具假跑冒充；发布冒烟另由 `tools/release/verify.mjs` 执行 |
| 写 AGENTS.md / MCP 配置 / skill 目录 | 永久禁止；`print` 只打印 |
| 自动修复索引内容 / 自动合并重复实现 | 永久禁止；`doctor --repair` 只修 Nexus 派生数据 |
| 后台常驻服务 / 端口监听 | 不做；MCP 只走 stdio 子进程 |
| 百万行档性能与内存 | 不进 CI；只记录 1k/5k/10k 与 P7 实测，50k+ 不外推 |

### 2.3 不变量（违反即 gate 失败）

1. **DB 为权威**；manifest/surface/workspace 为派生，不得反向覆盖。
2. **MCP 工具名与返回字段是稳定契约**；固定 8 个工具名，不新增第 9 个。
3. **MCP 错误不 throw**：一律 `isError: true`，CLI 与 MCP 同一失败场景 `code` 一致。
4. **MCP 通道只允许 lines/json**；入参非法或缺省一律 lines，并标 `formatFallback`；任何轨道不得含 ANSI。
5. **refresh 只增量**；全局重建条件、超 200 文件、锁占用分别拒绝，不静默降级为全量。
6. **watch 不得把旧数据标 fresh**；事件只是信号，内容哈希确认后才能进入 `indexing`。
7. **`status` 永不报错**；无索引返回 `state: uninitialized` 与四组引导信息，不返回 E01。
8. **similar / audit-duplicates 只输出启发式**；不得表述为「等价」「重复可删除」，必须给分项与人工确认提示。
9. **`print` 只读**：执行后工作区不得新增任何文件。
10. **`doctor --repair` 只修 `.nexus/`**：不修改源码、配置、`nexus.baseline.json`；非 TTY 必须 `--yes`，否则 64。
11. **动态内存预算不改变实测口径**：16.2/21.2 的按规模峰值目标仍按原文记录；动态值只用于调度准入与降级阈值，不得用「机器内存够用」解释超目标。
12. **输出契约**：四格式同源；lines/json 无 ANSI、无绝对路径、无时间戳；裁剪有 `truncated` + `nextCursor`。
13. **只写 `.nexus/`**：`build`/`update`/`refresh`/`doctor --repair` 之外不写项目文件；临时目录结束时清空。
14. **不修改 v1.24 正文**；冲突按 20.6 报告，不自行改写规范。

## 3. 负责人决策（编码前冻结）

### 3.1 D1：Phase 06 限制的接受

负责人接受 Phase 06 的 `pass-with-limits`：P3 单文件增量 `target-miss`（root 级保守重建）、P6 10k 档 p95 超 30 ms、P7 未提供、多 root 串行、50k+ 未测。上述限制继续登记在 README 与实施报告，不得在 Phase 07 表述为已达标。

### 3.2 D2：耗时与性能口径

负责人明确「耗时不必卡太死，时间可以慢，优先保证正确性和稳定性」。因此：

- Phase 07 **不以墙钟时间作为 gate 失败条件**；P7 只要求字段完整、重复 ≥3、中位数与最大值可复核。
- 不因耗时放宽正确性断言；崩溃恢复、增量等价、引用分类等正确性门槛不降。
- 测试中的等待使用「条件轮询 + 宽超时」，不使用脆弱的固定 sleep 或严格耗时断言。

### 3.3 D3：动态内存预算（替代固定 900 MB 默认）

**决策**：`resources.maxMemoryMB` 默认值从固定 `900` 改为「未设置即自动」，按当前可用内存动态计算全局预算。

- 可用内存优先取 `process.availableMemory()`（Node 22.16.0 已稳定支持，见 `docs/runtime-api.md`）；若 `process.constrainedMemory()` 返回正的 cgroup/容器上限，则取二者较小值；取不到时回退 `os.freemem()`。
- 自动预算 = `floor(可用内存 MB × 0.5)`，下限 128 MB；显式 `resources.maxMemoryMB` 存在时取 `min(显式值, floor(可用内存 MB × 0.5))`，仍不得超过可用内存的一半。
- 降级触发按**有效预算**计算；内存充足时不得因静态 900 MB 提前进入 `calls-off` / `serialize`。
- 可用内存、动态预算、显式配置与实际预算一并写入 manifest `resources` 与 `update`/`build` 输出，保证可解释（5.12）。

**与 21.2.4 的关系**：21.2.4 的「禁止以机器内存够用为由放宽预算」针对的是**按规模峰值目标**。本决策不修改 16.2.2 / 21.2.1 的任何目标值，只取消调度器的静态默认上限；构建峰值仍按 16.2.3/21.2.2 实测并逐项对照。该偏离由负责人在 2026-11-13 明确指示，登记于此，不写入 v1.24 正文。

**迁移影响**：`resources` 的 Schema 由「必填默认 900」改为「可选、缺省自动」，`configHash` 变化；旧配置若显式写了 `900` 仍按 900 生效（用户显式选择），`nex init` 新生成的配置不再写入该字段。首次 `update` 判 `config-changed` 重建，属预期一次性行为。

### 3.4 D4：MCP 实现与打包

- 使用官方 SDK v2 拆分包：服务端 `@modelcontextprotocol/server`（stdio）、`serveStdio` + 高层 `registerTool`；客户端 `@modelcontextprotocol/client` 仅 devDependency 用于内存/stdio 单测。
- `packages/mcp` 提供 `startMcpServer()` / `createMcpServer()`；`packages/cli` 的 `nex mcp` 调用它，**不复制第二套查询逻辑**。
- 构建顺序改为 core → mcp → cli；MCP 包自包含，不依赖 CLI chunk；CLI 将 `anemia-mcp` 作为 external。
- `--read-only` 不注册 `refresh`（工具列表 7 个）；这是模式差异，不改变默认 8 工具的契约。
- `--watch` 与 `--auto-bootstrap` 默认关闭；`--auto-bootstrap` 在后台异步构建，`status` 返回 `indexing` 与进度，其余工具返回未就绪提示而非错误码（22.2）。

### 3.5 D5：发布验证的边界

- 版本为 `0.0.0`，**没有上一发布版**。3.4 第 5 项「对上一发布版无未批准 breaking」按「用当前基线生成自身基线并 `api-diff` 无 breaking」执行，同时在《发布验证记录》中明确标注「first-release：无上一发布版，此项为自洽检查，不等同于跨版本比较」。
- 其余 11 项必须真实通过；任一项失败不得发布，也不得改检查清单放行。
- 冒烟在系统临时目录完成，安装 `npm pack` 产物，不复用仓库 `node_modules`，不修改任何全局配置。

### 3.6 D6：`nex test` 与 `doctor --mcp`

- `nex test` 不在 19.1 阶段 07 交付清单内，保持 `E24`，并在帮助中标注「未提供」。
- `doctor --mcp` 必须提供：在隔离临时目录对构建后的 MCP 入口做一次 stdio 握手 + `tools/list`，输出协商版本、工具数、耗时；失败为 `fail`，不写入用户配置。

### 3.7 D7：错误输出与四格式

- 机器层与 16.3/16.4 对齐；人读层固定四行，第一条为结论、第二条为可复制命令、第三条为前提检查、第四条为常见坑。
- `renderError` 已存在的四行结构保留并补齐 `file`/`evidence` 字段；错误默认写 stdout，不落盘。
- 四格式字段一致性用自动化断言：`counts`、`coverage`、`truncated`、`nextCursor`、`staleness` 在四种格式中值相同。

## 4. 复用接口（Phase 07 直接使用，不重写）

- 查询：`prepareContext`、`selectScope`、`querySymbol`、`queryReferences`、`querySearch`、`queryDependencies`、`analyzeImpact`、`buildTaskContext`。
- 索引：`buildWorkspace({ mode: 'update' })`、`withRootLock`、`recoverWorkspace`、`deriveRootState`、`readIndexingMarker`。
- 资源：`computeResourceBudget`、`computeRootWeights`、`GlobalResourceCoordinator`（本阶段按 D3 调整默认预算来源）。
- 输出：`renderOutput` / `renderError`、四格式渲染器。
- 相似：`findSimilar`、`extractSymbolNames`、`scoreCandidate`、`SIMILARITY_RULES_VERSION`。

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| MCP stdio 与 CLI stdout 混用 | 协议被日志污染 | `nex mcp` 全程 `skipRender`；进度只写 stderr；`mcp` 入口不调用任何 `writeStdout` |
| watch 事件在 Windows 递归监听的差异 | 漏事件 | 事件仅作信号；内容哈希确认；30s / 50 次查询周期复核 |
| 动态可用内存波动 | 预算抖动 | 预算在单次 build/update 开始时快照一次；测试注入固定值 |
| `process.availableMemory()` 在受限容器内偏大 | 超卖 | 同时读 `process.constrainedMemory()` 取较小值 |
| 发布冒烟 `anemia-core@0.0.0` 无法从 registry 解析 | 安装失败 | 冒烟同时安装 core/mcp/cli tarball；若 npm 仍解析失败，打包时把 workspace 依赖改为精确版本并在记录中说明 |
| 新增 MCP 依赖进入运行时 | 包体积/许可 | `@modelcontextprotocol/server` 2.4.0、`zod` 4.6.7 已在仓库；许可证 Apache-2.0/MIT，无新增第三方来源 |
| `doctor --repair` 误删数据 | 数据丢失 | 只修派生数据；先恢复后重建；不删 committed DB；删除动作需 `--yes` 并逐项列出 |
| 相似/重复结果被误读为等价 | API 误改 | 固定输出 `isHeuristic: true`、`relationClass: heuristic`、免责声明与人工确认提示 |
| 性能时间放宽被误读为达标 | 承诺失真 | 报告逐项标注 `target-miss`/`not-available`/`no-target`，不写「全部达标」 |

## 6. 对后续交付的影响

- 本阶段完成后，11 个命令从「未提供」变为真实命令；其余未提供项必须在 README 与 `--help` 中保持明确。
- `resources.maxMemoryMB` 语义变化与 `configHash` 变化需要写入 README 与发布说明。
- MCP 8 工具、`print` 三类物料与 3.4 发布验证构成对外交付面；后续修改工具名、字段、物料格式均属破坏性变更，须走 6.x Surface 流程。
