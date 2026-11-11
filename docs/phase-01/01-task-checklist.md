# Phase 01 完整任务清单：骨架与 TS 索引

> 生成日期：2026-11-12（Asia/Shanghai）
> 依据：`docs/19-delivery-phases.md` 阶段 01、`docs/02-technical-baseline.md`、`docs/05-data-model.md`、`docs/11-cli.md`、`docs/12-indexing.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md`、`docs/18-security.md`
> 状态：**仅计划基线；2026-11-12 已授权并完成实现，实际状态见 `03-implementation-report.md`（本清单未逐项回填）。**
> 本清单不是开工指令；开始任何一项前，必须满足 `docs/phase-01/00-freeze-and-entry.md` 的入场条件。

## 0. 使用规则

- `[ ]` 未开始；`[x]` 仅在完成实现、测试、自审并留下证据后勾选；`[BLOCKED]` 表示等待负责人裁定或上游依赖。
- 每项任务的“证据”必须可复核：命令、退出码、测试名、结果文件或代码位置。
- 不得跳过 gate 直接实现后续阶段能力；不得用固定数据、模拟结果、空实现或硬编码关系冒充完成。
- Phase 01 只做 TS/TSX 与 CLI 骨架。Vue、API Surface、关系图、影响分析、增量、MCP、发布验证均不在本阶段。
- 任务顺序是建议顺序，不是允许跳过依赖的理由；标注“阻断”的任务未关闭时，后续任务不得开工。

## 1. 阶段目标与边界

### 1.1 目标（依据 19.1）

把“规范”变成可运行的第一个产品切片：

1. CLI 骨架与命令注册框架；
2. 项目扫描与 root 识别；
3. 配置加载（JSON 默认 + 显式授权的 TS）；
4. TS/TSX 符号、声明与引用索引；
5. `status` / `doctor` 基础检查；
6. 退出码、错误码、输出格式与非 TTY 框架；
7. 用 F01 / F10 / F17 等夹具证明引用与安全边界。

### 1.2 明确不做

| 能力 | 处理 |
|---|---|
| Vue SFC 语义、模板边、`__VLS_` | Phase 02；本阶段不得声称支持 |
| API Surface / baseline / api-diff | Phase 03 |
| 依赖图、调用图、架构规则、样式链 | Phase 04 |
| impact / preflight / postflight / verify | Phase 05 |
| 真实增量、失效传播、完整提交协议、崩溃七注入点 | Phase 06；本阶段只做全量 build 与最小安全提交基础 |
| MCP 8 工具、`nex mcp`、`print` 物料 | Phase 07 |
| 发布验证、npm pack 独立安装 | Phase 07 的 3.4 全量验证 |
| 百万行档、真实 RSS 调度 | 按 D4/D7 延后；本阶段不得宣称已验证 |

### 1.3 命令面（Q-01，阻断）

`docs/19-delivery-phases.md` 写“17 命令 + 别名”，`docs/11-cli.md` 写“21 个主命令 + 4 个兼容别名”。**在负责人书面裁定前，不实现命令清单的最终取舍。**

无论最终数字如何，Phase 01 必须坚持：

- 已实现命令与未实现命令必须可区分；
- 未实现命令不得返回假数据或空结果冒充成功，必须返回 E24 并说明“未提供”；
- 兼容别名不得出现在主帮助列表；
- 不得为了凑数字注册无行为的空命令。

### 1.4 Phase 01 gate（编码前冻结）

以下 gate 在实现前由负责人确认；确认后不得降低：

| Gate | 判定 |
|---|---|
| G1 构建 | `npm run build`、`npm run typecheck`、`npm run lint`、`npm run format:check` 全部退出 0 |
| G2 单仓库索引 | 在 F01 上 `nex init` + `nex build` 退出 0；生成独立 root 索引与 manifest |
| G3 引用正确性 | F01 / F10 的 `certain` 引用与独立 tsserver Oracle 抽样一致；差异逐条解释，不得用工具自身输出自证 |
| G4 输出一致 | F01 上 `--format pretty` 与 `--format lines` 的条目集合与完整性字段一致；pretty 可读、无 ANSI 泄漏 |
| G5 非 TTY | 无输入管道下默认 lines；所有交互命令 5s 内退出（成功或 64），无 hang |
| G6 配置安全 | F17 的恶意 TS 配置、项目脚本、恶意命令、未授权配置全部符合 18.3/18.4；无越界读写、无网络、无脚本执行 |
| G7 双 Node | Node 22.16.0 与 Node 24.x 均完成 install/build/test/CLI 基础流程 |
| G8 自审 | 阶段报告、测试证据、已知问题、自审回执齐全；`git status --porcelain` 无验证残留 |

## 2. 入场与基线

- [ ] **A01 确认授权**：项目负责人明确写出“启动 Phase 01”；记录日期与范围。证据：冻结记录或负责人指令摘录。
- [ ] **A02 关闭 Q-01**：负责人裁定命令总数、主命令/别名清单、Phase 01 实现/占位边界。证据：书面裁定；未关闭前本清单命令相关任务 `[BLOCKED]`。
- [ ] **A03 关闭 Q-02**：确认 Phase 01 的 `status.capabilities` 对未实现能力（尤其 `styleDependency`）的输出口径。证据：负责人确认或阶段设计说明。
- [ ] **A04 固定基线**：确认 Phase 00 变更的提交/归档方式；记录基线 commit。不得擅自 commit/push。
- [ ] **A05 冻结验证门槛**：在编码前写定 G3 的 Oracle 抽样范围、G4 的 pretty/lines 对照字段、G5 的超时、G6 的 F17 用例清单、G7 的 Node 版本。证据：`docs/phase-01/02-plan-and-gates.md`（新文件）。
- [ ] **A06 基线检查**：执行 `npm ci`、`npm run build`、`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`，记录退出码与当前 `--passWithNoTests` 状态。
- [ ] **A07 依赖审计**：对现有依赖执行 `npm audit`（官方 registry）；记录 high/critical；新增依赖逐个过 3.2 三重门槛。证据：审计摘要与依赖理由。
- [ ] **A08 建立执行看板**：创建 Phase 01 实施报告骨架，登记任务状态、风险、待裁定项；不得预填“已完成”。

## 3. 包边界与构建

- [ ] **B01 明确包边界**：`core` 负责扫描、配置、索引、存储、查询；`cli` 只负责参数、渲染、退出码与编排；`mcp` / `adapter-vue` 本阶段保持占位，不填充业务逻辑。证据：模块依赖图或源码结构说明。
- [ ] **B02 建立 tsup 构建**：ESM、`target: node20`、`node:` external、dts、shebang 仅 CLI 入口；不得把 `node:sqlite` 打包。
- [ ] **B03 建立 bin 映射**：`nex` / `anex` / `anemia` 指向同一产物；验证三者在干净安装路径下行为一致（本阶段可只验证 workspace 链接）。
- [ ] **B04 建立 exports/types**：各包 `exports`、`types`、`import` 条件可解析；禁止深层私有路径成为公开 API。
- [ ] **B05 TypeScript 基线**：strict 开启；禁止 `any`；统一路径别名；`tsc --noEmit` 覆盖全部实现包。
- [ ] **B06 npm scripts**：`build` / `typecheck` / `test` / `lint` / `format:check` 可独立执行；产品测试建立后移除 `--passWithNoTests`。
- [ ] **B07 构建可复现**：同一源码、依赖、Node 版本连续两次构建，产物哈希一致；记录差异原因（若 tsup 产生非确定性，必须定位）。
- [ ] **B08 双 Node 构建**：Node 22.16.0 与 Node 24.x 均执行构建与类型检查；不得用 24 的结果替代 22.16 下限结论。
- [ ] **B09 包内容检查**：`npm pack --dry-run` 不含 `.nexus/`、`fixtures/local`、测试临时目录、源码 map 或密钥；记录清单。
- [ ] **B10 依赖准入**：新增 Commander / Zod / proper-lockfile / SCIP 解析等依赖必须记录用途、版本锁定、许可证、近 12 个月发布、audit 结果；不得引入第三方 SQLite 驱动。
- [ ] **B11 原型隔离**：不得从 `phase00/` 直接 import 到产品代码；可复用的算法必须重写、补测试、去掉原型假设。证据：`rg`/import 检查与代码审查。
- [ ] **B12 版本单一来源**：`--version` 的包名、版本、Node 版本来自同一处；项目内额外输出构建指纹前 12 位（若已有索引）。

## 4. CLI 骨架

- [ ] **C01 根命令与全局参数**：建立 Commander 根命令；实现 `--format`、`--color`、`--no-color`、`--width`、`--pager`、`--compact`、`--verbose`、`--quiet`、`--explain`、`--no-truncate`、`--budget-hint`、`--cursor`、`--output-file`、`--root`、`--roots`、`--yes`、`--non-interactive`、`--version`、`--help`。
- [ ] **C02 参数互斥与校验**：`--root` 与 `--roots` 同现退出 64；非法枚举退出 64 并列出合法值；布尔开关不接受 `--flag=true`。
- [ ] **C03 命令分组**：按生命周期/查询/治理/审计/接入/测试六组组织帮助；命令数量与清单按 Q-01 裁定。
- [ ] **C04 兼容别名**：`query`、`mcp-config`、`agents`、`skill` 的别名行为与主命令一致；帮助主列表隐藏别名，仅在“兼容”附注列出。
- [ ] **C05 实现/占位矩阵**：逐命令标注 `implemented` / `stub-E24`；未实现命令不得进入正常结果路径。证据：矩阵表与集成测试。
- [ ] **C06 帮助文本**：`nex --help` 分组；`nex <cmd> --help` 显示参数与至少 2 个示例；不得出现未实现能力作为可用示例。
- [ ] **C07 版本输出**：`nex --version` 输出包名、版本、Node 版本；项目内可附加 `buildFingerprint` 前 12 位；不得输出绝对路径。
- [ ] **C08 格式优先级**：`--format` > `NEXUS_FORMAT` > `output.format` > TTY ? pretty : lines；非法值不回落。
- [ ] **C09 颜色/宽度/分页**：pretty 使用 `util.styleText`；`NO_COLOR`；默认宽度 `min(COLUMNS, 120)`；非 TTY 强制 pager off；`--compact` 与 pretty 同现只提示不报错。
- [ ] **C10 通道隔离**：结果写 stdout；进度、诊断、警告写 stderr；`--quiet` 不输出进度；错误不写项目文件。
- [ ] **C11 非 TTY**：自动检测 + `--non-interactive`；需要输入且缺参数时立即 64，打印缺失参数与可复制命令；不得等待 stdin。
- [ ] **C12 信号与取消**：Ctrl-C / abort 传播到子进程与写入；取消后不留下部分提交；退出码语义明确。
- [ ] **C13 退出码框架**：0 成功/无阻断；1 阻断；2 仅告警；64 用法；70 内部错误；映射集中管理，禁止各命令自行 `process.exit`。
- [ ] **C14 错误码框架**：E00–E24 的 `code` / `category` / `severity` / `reason` / `file` / `suggestion` / `evidence` 统一构造；E23 附复现信息。
- [ ] **C15 错误人读层**：pretty 错误固定四行（结论、可复制命令、前提检查、常见坑）；不以错误码开头，不输出堆栈。
- [ ] **C16 内部错误兜底**：未捕获异常统一映射 E23 + 70；不得把内部异常伪装为 0 或 2；测试覆盖。

## 5. 配置与 init

- [ ] **D01 配置 Schema**：Zod `strict()`，`configVersion: 1`；覆盖 `defaults`、`workspaces`、`roots`、`style`、`vue`、`commands`、`output`、`budgets`、`ignore`。
- [ ] **D02 未知字段/类型错误**：E17，指出字段路径与期望类型；不做静默忽略或默认值回填。
- [ ] **D03 JSON Schema 派生**：由同一 Schema 派生 `schema/nexus.config.schema.json`；测试 Schema 与运行时校验一致。
- [ ] **D04 配置位置**：只接受 `.nexus/nexus.config.json` 或授权后的 `.nexus/nexus.config.ts`；双源 E17；仓库根旧路径 E17；版本过高 E17。
- [ ] **D05 合并优先级**：内置基线 → `defaults` → `roots.<rootId>`；任何层都不能删除内置忽略基线条目；计算 `configHash`。
- [ ] **D06 忽略基线**：内置 `.git`、`.dsh`、`.agent`、`node_modules`、`dist`、`build`、`out`、`.next`、`.nexus`、缓存等；`include` 只能显式反向纳入；`doctor` 能打印来源。
- [ ] **D07 根集合探测**：按 5.7 顺序读取 `package.json#workspaces`、`pnpm-workspace.yaml`、`lerna.json`、`nx.json`、`turbo.json`、`rush.json`、`*.code-workspace`、配置显式 roots；记录来源。
- [ ] **D08 候选 root 判定**：有 tsconfig 且可独立 typecheck 才算 root；非索引包标 `non-indexable` 并列出，不静默丢弃。
- [ ] **D09 init 交互**：TTY 打印候选表（名称/路径/tsconfig/exports/可索引性），允许全部/部分/跳过；不得静默选第一个。
- [ ] **D10 init 非 TTY**：缺 `--roots` 时 E15，列出候选与可直接复制的命令；不得阻塞。
- [ ] **D11 init 默认只打印**：TTY 一次确认；非 TTY 必须 `--write-config` + `--yes`；否则不落盘。
- [ ] **D12 init 写入**：原子写 `.nexus/nexus.config.json`、示例配置、`workspace.json`、`.nexus/roots/<rootId>/`；不得写 AGENTS.md、MCP 配置、`.gitignore`。
- [ ] **D13 init 幂等/覆盖**：已有配置时默认不覆盖；`--force` 必须二次确认；失败不留下半成品。
- [ ] **D14 TS 配置授权**：`--trust-config` 仅本次进程；持久授权写 `.nexus/trust.json`（路径 + 内容哈希 + 时间），哈希变化失效。
- [ ] **D15 TS 配置未授权**：E18，说明“可执行代码”风险与授权命令；若存在 JSON，使用 JSON 并提示忽略 TS，不静默执行。
- [ ] **D16 TS 配置加载**：独立子进程、5s 超时、工作目录项目根、禁用网络、IPC 序列化、Zod 同源校验；禁止主进程 `import()` 执行。
- [ ] **D17 配置加载记录**：`manifest.configLoads[]` 记录路径、哈希、授权来源、耗时、结果摘要；不得记录密钥。
- [ ] **D18 配置错误恢复**：配置非法时不启动索引；`status` 仍可返回可诊断状态（按 Q-02 口径），不得崩溃。

## 6. 项目扫描与 root

- [ ] **E01 文件发现**：从 rootPath 扫描 TS/TSX（及允许的 JSON 配置）；使用统一 ignore 规则；符号链接/junction 不跟随，或按明确策略拒绝。
- [ ] **E02 敏感文件排除**：`.env*`、密钥、证书、依赖、构建产物、缓存不读；测试断言不会打开这些文件。
- [ ] **E03 tsconfig 解析**：读取 tsconfig / extends / references；无效时 E03 并降级 `syntax-only`；本阶段至少能报告，不伪造语义结论。
- [ ] **E04 rootId**：由 package name 归一化；冲突时确定性消歧（路径后缀哈希）；不得用绝对路径。
- [ ] **E05 rootPath 与 exclude**：统一 `/` 分隔；`rootPath` 相对仓库根；`exclude` / `followTsReferences` 影响扫描；配置变化触发重建而非局部猜测。
- [ ] **E06 多 root 隔离**：每个 root 独立 `.nexus/roots/<rootId>/`；不得合并符号表、引用或 manifest。
- [ ] **E07 根集合歧义**：构建期无法确定 root 时 E15，列出候选与来源；不得静默取第一个。
- [ ] **E08 workspace.json**：定性为派生 + 缓存；由配置与各 root manifest 重建；删除后可恢复；不得作为唯一权威。
- [ ] **E09 扫描可复现**：同一文件集、ignore、配置下，文件列表排序稳定；路径分隔符统一；不输出绝对路径。
- [ ] **E10 扫描边界测试**：覆盖嵌套 root、root 外引用、ignore 反向 include、无 tsconfig 包、大小写/路径分隔符。

## 7. 存储与提交基础

- [ ] **F01 SQLite 驱动**：只用 `node:sqlite` 的 `DatabaseSync`；启动 API 探针；不得引入第三方驱动或回退。
- [ ] **F02 WAL/只读**：启用 WAL；查询用 `readOnly: true`；`busy_timeout` 只作读侧兜底，不作为并发正确性依赖。
- [ ] **F03 Schema v1**：建立 `files`、`symbols`、`references`、`build_record`、`symbol_id_history`、`symbol_map` 等 Phase 01 必需表与索引；未来表通过迁移增加。
- [ ] **F04 Schema 版本**：`schemaVersion` 与实际 DDL 同源；不匹配报 E06；迁移/重建路径明确。
- [ ] **F05 build_record**：`pending` / `committed` 两态；记录 buildId、fingerprint、状态；不得只写 manifest 不写 DB。
- [ ] **F06 事务**：`BEGIN IMMEDIATE` 写入符号/引用/文件 + pending 记录；事务内做外键闭合、必需索引、覆盖率分母、指纹字段检查。
- [ ] **F07 提交校验**：COMMIT 后重开只读连接校验 pending + fingerprint；再独立短事务置 committed。
- [ ] **F08 manifest 原子写**：临时文件 + fsync + rename；manifest 指向 committed build；不得先写 manifest 后写 DB。
- [ ] **F09 manifest 派生**：DB 为权威；manifest 与 DB 不一致时以 DB committed 为准，可重写；记录修复事件。
- [ ] **F10 并发锁**：`proper-lockfile` 按 root；超时 30s、stale 10min 可配；CLI 写入共用锁；不得自研锁。
- [ ] **F11 启动恢复（最小）**：清理 `.nexus/tmp/`；处理 pending、manifest 滞后、无 committed 的非法态；完整七注入点留 Phase 06。
- [ ] **F12 损坏处理**：`integrity_check` 失败 E07；无 committed 但有数据 E19；`doctor` 给重建建议，不抢救损坏数据。
- [ ] **F13 失败保留旧索引**：build 失败不删除上一个 committed；临时目录清理；状态置 `stale` 或 `failed`。
- [ ] **F14 指纹字段**：`filesHash`、`configHash`、`schemaVersion`、`analyzerVersion`、`rootSetHash`、`nodeVersion`、`sqliteVersion`、`platform`、`degraded`；`builtAt` 不入指纹。
- [ ] **F15 历史身份表**：`symbol_id_history` 记录 active/retired、build、证据；Phase 01 至少支持同 build 稳定 ID 与基本历史，完整 F15 迁移门禁后续验证。
- [ ] **F16 数据可解释**：manifest 记录构建耗时、峰值 RSS、写入行数、降级事件；不得只写“成功”。

## 8. TS/TSX 索引

- [ ] **G01 内容 Hash**：按文件内容计算 `sourceHash`，不得用 mtime 判断变化；新增/删除/修改/重命名可识别。
- [ ] **G02 单一 Program**：SCIP 与自有分析复用同一 Program，或直接使用 SCIP 结果 + 轻量语法遍历；禁止两套完整类型检查并行。
- [ ] **G03 SCIP 调用**：固定 `@sourcegraph/scip-typescript@0.4.0`；只对可 typecheck 的 root 调用；记录命令、退出码、耗时、stderr 摘要。
- [ ] **G04 SCIP 解析适配层**：封装 0.4.0 的 protobuf 解析路径；对包内部路径变更做契约测试；不得把内部路径散落在业务代码。
- [ ] **G05 映射**：SCIP symbol ↔ TS declaration；复用 Phase 00 的 T01–T08 场景；`falseMatchCount = 0`；未映射/冲突显式记录。
- [ ] **G06 symbolId**：按 5.2 生成，不含路径；同一声明在重命名/移动场景下的稳定性按 Phase 01 可实现范围处理，不宣称“永不变”。
- [ ] **G07 declarationLocator**：独立于 `symbolId`，记录路径/行/列/容器链；路径统一 `/`；不得用行号做身份。
- [ ] **G08 identityConfidence**：high/medium/low 字段；低置信不继承旧 ID；多候选保留候选，不强行选择。
- [ ] **G09 符号字段**：name、kind、signature、visibility、exportKind、analysisEngine、rootId、isTypeOnly 等按 Schema 落库；缺失字段用明确语义，不用空字符串冒充。
- [ ] **G10 引用**：从 SCIP occurrence 建立 source/target/kind/role；记录 `relationClass`、`confidence`、`analysisEngine`；不得把 heuristic 当 certain。
- [ ] **G11 关系分类**：Phase 01 至少区分 `certain` 与 `dynamic-unresolved`；尚无法判定的标 unresolved，不静默丢弃。
- [ ] **G12 导出/导入边**：为 F01 的 barrel / 别名重导出建立边；不得把未声明依赖的跨包引用造边；跨 root 只允许已声明依赖 + exports。
- [ ] **G13 覆盖率**：按 5.12 计算 `fileCoverage`、`semanticCoverage`、`referenceCoverage`、`unresolvedRate`、`mappingSuccessRate`；分子分母可核对。
- [ ] **G14 buildFingerprint**：按 5.11 生成 `bf_` + base32(sha256) 前 20 位；字段齐全；同源同配置可复现。
- [ ] **G15 写入方式**：流式/分批写入 SQLite，禁止先攒巨型数组再 stringify；字符串 interning 或整数 ID 按需使用。
- [ ] **G16 排序稳定**：符号、引用、文件输出显式排序；Map/Set 遍历先排序；浮点/数字格式统一；不得随机顺序。
- [ ] **G17 分析器失败**：SCIP 失败/超时/输出非法时 E11 或降级；记录 engine、文件、最小复现；不得产出半套语义结论冒充成功。
- [ ] **G18 大文件/跳过**：超过阈值跳过并计 `filesSkippedBySize`；解析失败计 `filesFailed`；不得静默丢弃。
- [ ] **G19 TSX**：至少覆盖一个 TSX 项目夹具；JSX 符号与引用可索引；不得声称支持 Vue。
- [ ] **G20 引用完整性抽检**：对 F01 的公共符号做 tsserver `findReferences` 对照；差异逐条分类（实现缺陷/Oracle 差异/范围差异）。

## 9. 查询最小面

- [ ] **H01 `symbol`**：按名称/ID 查询符号详情；输出签名、位置、Surface 归属（本阶段可标 `unknown`/未实现，不得伪造 public）、身份置信度。
- [ ] **H02 `references`**：按符号输出引用全集；`counts` 三分类；`coverage` 完整；`staleness` / `buildFingerprint` 必带。
- [ ] **H03 `search`**：按名称/类型/路径检索；结果排序稳定；无结果区分“确认不存在”与“索引未覆盖”。
- [ ] **H04 activeRoot**：cwd 最长前缀匹配唯一 root；cwd 在仓库根/root 外时必须显式 `--root`/`--roots`，否则 E16。
- [ ] **H05 根路由**：`--root` 与 `--roots` 互斥；单 root 查询不读其他 root；`all` 分组不跨 root 排序/去重。
- [ ] **H06 不越界**：A 未声明依赖 B 时，不返回 B 的符号；只提示“存在于 B，但未声明依赖”。
- [ ] **H07 staleness**：`fresh` 才能承诺完整性；`dirty`/`indexing`/`stale` 标 `partial: true` 与原因；`failed` 返回 E19/E02。
- [ ] **H08 完整性字段**：`counts`、`coverage`、`truncated`、`nextCursor`、`staleness`、`buildFingerprint`、`degraded` 全格式一致。
- [ ] **H09 分页/裁剪**：不得静默截断；裁剪给 `truncated` + `nextCursor`；`--no-truncate` 走游标；`--budget-hint` 不删条目。
- [ ] **H10 错误语义**：E01 索引不存在、E02 过期不可靠、E05 符号不存在（区分未覆盖）、E16 根归属失败；`status` 不返回 E01。
- [ ] **H11 输出一致**：同一结果在 lines/json/pretty/markdown 的字段集合一致；pretty 不二次查询/排序；无 ANSI 泄漏。
- [ ] **H12 确定性**：同一 fingerprint + 参数输出逐字节一致；测试固定 locale/时区/路径分隔符。

## 10. status 与 doctor

- [ ] **I01 `status` 未初始化**：无 `.nexus/` 时返回 `state: uninitialized`；退出 0；给 init 引导；不报 E01。
- [ ] **I02 `status` ready**：返回 `state: ready`、`staleness`、`buildFingerprint` 前 12 位、`activeRoot`、`roots[]`。
- [ ] **I03 `status` 覆盖**：`coverage` 字段按 5.12；`semanticCoverage` 在降级时为 null；不给伪百分比。
- [ ] **I04 `status` 能力**：`capabilities` 只声明本阶段真实可用的能力；MCP 未提供时 `mcpFormats` 不得声称可用；`styleDependency` 按 Q-02 口径明确未提供。
- [ ] **I05 `status` self**：serverVersion、packageName、binaryPath（相对/安装路径，不泄漏用户绝对路径）、projectRoot、nodeVersion。
- [ ] **I06 `status` 永不报错**：配置/DB/索引异常转为可诊断状态或 warnings；退出 0；不得因缺索引失败。
- [ ] **I07 `doctor` 基础检查**：Node 版本、配置 Schema、双源、DB 可打开、schemaVersion、manifest/DB 一致性、必需索引、root 集合、锁、ignore 清单。
- [ ] **I08 `doctor --schema`**：打印配置 JSON Schema；与运行时 Schema 同源。
- [ ] **I09 `doctor` 退出码**：无问题 0；仅告警 2；阻断问题 1；用法 64；内部 70；报告含证据与建议。
- [ ] **I10 未实现诊断**：`--mcp`、`--dump-vue-map`、`--repair` 本阶段返回 E24 或明确“未提供”，不得假装修复。
- [ ] **I11 快照复用**：`status` / `doctor` / 查询共用同一索引快照与状态机读取，不各写一套推断逻辑。
- [ ] **I12 输出稳定**：roots 排序、字段顺序、路径格式稳定；同一状态输出可复现。

## 11. 安全边界

- [ ] **J01 路径边界**：所有读路径经 `realpath`/规范化后验证在项目根内；拒绝 `..`、绝对路径、符号链接/junction 逃逸。
- [ ] **J02 敏感排除**：`.env*`、密钥、证书、`node_modules`、构建产物、`.git` 等永不读取；F17 断言无越界读取。
- [ ] **J03 不执行项目脚本**：扫描/build/init 不运行 `postinstall`、`prepare`、build scripts；不得自动安装依赖；测试前后 `node_modules` 不变。
- [ ] **J04 不动态执行用户字符串**：禁止 `eval`、`new Function`、`require(用户字符串)`；TS 配置只在受控子进程。
- [ ] **J05 命令白名单框架**：即使 `verify` 未实现，也先建立“完整命令 + 参数 + cwd + timeout”的校验模型；禁止 shell 拼接/通配符/管道。
- [ ] **J06 SQL 参数化**：所有值绑定参数；标识符白名单；F17/单元测试覆盖注入字符串。
- [ ] **J07 默认离线**：工具自身不发起网络；TS 配置子进程禁用网络；测试在断网/阻断钩子下运行。
- [ ] **J08 子进程护栏**：超时、输出上限 1 MB、kill tree、cwd 限制、环境变量最小化；崩溃不拖垮主进程。
- [ ] **J09 F17 夹具**：恶意 TS 配置读文件/发请求/写文件/执行 shell、`postinstall`/`prepare`、恶意命令、未授权 verify、不可信插件。
- [ ] **J10 平台级验证**：在 Node 22.16 与 24 上验证权限/钩子可用性；记录“非 OS 级网络沙箱”的残余风险，不夸大隔离强度。
- [ ] **J11 日志脱敏**：错误、verbose、测试输出不含密钥、token、用户绝对路径；`--output-file` 默认不写项目内。
- [ ] **J12 安全回归**：F17 每次 CI 运行；`git status --porcelain` 为空；无新文件、无外网、无子进程残留。

## 12. 测试、夹具与 Oracle

- [ ] **K01 F01 reexport-chain**：按 17.1 建 10 文件 / ≤300 行；覆盖多层 barrel、别名重导出、`export *` 冲突、默认/具名混合；含 `tsconfig` 与 expected。
- [ ] **K02 F10 negative**：6 文件 / ≤150 行；覆盖漏报负样本；用于 tsserver 逐条对照。
- [ ] **K03 F17 config-security**：6 文件 / ≤200 行；覆盖 18.4.3 全部用例；不得包含真实密钥。
- [ ] **K04 多 root 夹具**：至少 2 root（可用 F04/F14 的缩小版）；覆盖已声明依赖、未声明依赖、无 tsconfig、嵌套 root。
- [ ] **K05 夹具说明**：每个夹具写“测什么、断言哪几条、如何生成 golden”；golden 不得由被测工具自证。
- [ ] **K06 tsserver Oracle**：独立脚本用 TypeScript LanguageService `findReferences` / `getDefinition`；不复用 SCIP 映射代码。
- [ ] **K07 抽样门槛**：编码前写定 F01/F10 的符号/引用抽样范围与允许差异；默认要求 `certain` 0 漏报、0 误报，无法达到则记录并阻断。
- [ ] **K08 单元测试**：配置 Schema、路径边界、ID 生成、指纹、排序、错误映射、分页游标。
- [ ] **K09 集成测试**：`init` → `build` → `status` → `references` 全链路；断言退出码、DB、manifest、输出字段。
- [ ] **K10 CLI golden**：lines/json/pretty 的固定输出；固定 `NO_COLOR=1`、`COLUMNS`、locale、时区。
- [ ] **K11 非 TTY**：无输入管道执行全部交互命令，5s 内退出；缺参数 64；`--yes` 路径成功。
- [ ] **K12 格式契约**：四格式字段一致；无 `\x1b`；`counts/coverage/truncated/nextCursor/staleness` 相同；pretty 条目数等于 lines。
- [ ] **K13 安全测试**：F17 全用例；断网；无越界读写；无项目脚本执行；无子进程残留。
- [ ] **K14 Node 矩阵**：Node 22.16.0 与 24.x 跑 build/typecheck/test/CLI 基础链路；记录差异。
- [ ] **K15 CI**：在现有双矩阵中加入产品测试与夹具；不得只跑 Phase 00 脚本；测试总时长目标 ≤8 分钟。
- [ ] **K16 禁止假绿**：移除 `--passWithNoTests`；不得 skip 安全/引用用例；失败必须修复或显式阻断。
- [ ] **K17 测试预算**：夹具总量 ≤12000 行；单夹具 ≤2000 行/20 文件；不提交 `node_modules`/构建产物/真实项目。
- [ ] **K18 无网络**：CI 与本地安全测试不得下载外部仓库；依赖只来自 lockfile。

## 13. 性能与可观测性

- [ ] **L01 阶段耗时**：build 输出配置、扫描、SCIP、映射、写入、校验各阶段耗时；写 stderr（verbose）与 manifest 摘要。
- [ ] **L02 峰值 RSS**：50ms 采样构建子进程 RSS；记录父进程单独开销；不得把平均值当峰值。
- [ ] **L03 DB 体积**：记录 index.db + WAL 大小；写 manifest。
- [ ] **L04 写入行数**：记录 symbols/references/files 写入行数与批次数。
- [ ] **L05 降级事件**：记录 degraded 列表与原因；所有查询可见，不得静默。
- [ ] **L06 不宣称性能达标**：Phase 01 只记录小夹具数据；16.2 的 5 万/30 万/百万目标不在本阶段宣称。
- [ ] **L07 SCIP 峰值**：在集成构建中单独记录 SCIP 子进程峰值；Phase 00 G7 未含 SCIP，本阶段不得沿用旧结论。
- [ ] **L08 可复现环境**：记录 Node、OS、CPU、内存、SCIP/TS 版本；性能记录缺字段视为无效。

## 14. 文档与阶段交付

- [ ] **M01 README 同步**：只写已实现命令与真实能力；未实现能力明确“未提供”；不得把规划写成已实现。
- [ ] **M02 runtime-api 同步**：新增 Node API（permission、strip-types、sqlite 等）登记最低版本与验证结果。
- [ ] **M03 AGENTS 同步**：更新当前状态、可用命令、Phase 01 限制；代码自审第 6 节继续生效。
- [ ] **M04 实施报告**：按 19.3 写 `docs/phase-01/02-implementation-report.md`：实施内容、测试证据、性能数据、已知问题、未完成事项、依赖/架构变化、对后续阶段影响、文档同步、gate 结论。
- [ ] **M05 状态矩阵**：逐项标 `implemented` / `partial` / `heuristic` / `unresolved` / `unsupported` / `failed`；不得只写“完成”。
- [ ] **M06 已知限制**：至少记录 SCIP 0.4.0 固定、无真实增量、无 Vue、无真实 RSS 调度、非 OS 网络沙箱、G10 延后。
- [ ] **M07 gate 结论**：逐条对照 19.1 与 1.4 的 gate，给出通过/不通过；不通过不得进入 Phase 02。
- [ ] **M08 不越阶段**：不得在 Phase 01 报告中宣称 Phase 02–07 能力；不得启动下一阶段。
- [ ] **M09 工作区清洁**：`git status --porcelain` 为空；`.nexus/tmp/` 为空；无临时夹具/日志/数据库残留。
- [ ] **M10 自审回执**：按 `.dsh/AGENTS.md` 第 6.5 节提交完整回执；测试未执行项必须写明原因。
- [ ] **M11 负责人评审**：提交报告与证据，等待负责人决定是否进入 Phase 02；未获授权不得继续。

## 15. Phase 01 完成定义（Definition of Done）

Phase 01 只有在以下全部成立时才算完成：

- [ ] G1–G8 全部通过，或未通过项已作为阻断问题上报并得到负责人书面处理决定。
- [ ] F01 上 `init` / `build` / `status` / `references` 可重复执行，退出码与输出稳定。
- [ ] `certain` 引用与 tsserver Oracle 抽样一致；差异有分类、有证据、无未解释漏报。
- [ ] lines / json / pretty / markdown 的完整性字段一致；pretty 可读且不污染机器通道。
- [ ] 非 TTY 全部命令不阻塞；缺参数 64；非法参数 64。
- [ ] F17 安全用例通过；无越界读写、无网络、无脚本执行、无残留。
- [ ] Node 22.16.0 与 24.x 双矩阵通过。
- [ ] 所有未实现命令返回 E24 并明确“未提供”，不存在假成功。
- [ ] 实施报告、已知限制、自审回执、负责人评审记录齐全。
- [ ] 负责人明确授权进入 Phase 02；否则停在 Phase 01。
