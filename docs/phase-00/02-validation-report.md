# Phase 00 验证报告

> 执行日期：2026-11-11 至 2026-11-12
> 依据：`docs/21-phase-00.md`、`docs/phase-00/01-plan-and-thresholds.md`
> 范围裁定：百万行档性能验证按项目负责人批准跳过（见 `00-scope-decisions.md`）
> 结论性质：Phase 00 技术可行性结论；**不进入 Phase 01**
> 后续裁定（2026-11-12）：负责人已确认 **v1.24 进入规范冻结**；SCIP 固定 0.4.0；真实 RSS 调度与 G10 失效传播完备性延后；**Phase 01 未授权**。见 `docs/phase-01/00-freeze-and-entry.md`。

## 1. 结论摘要

Phase 00 共 11 项验证（G1–G10 + MCP 协议探针）全部执行完成，**11/11 退出码为 0**。未发现足以否决 SCIP + TypeScript Compiler API + @vue/language-core + `node:sqlite` 技术路线的证据。

但其中 6 项只能在明确的限制条件下判定通过，不能表述为“产品能力已验证”：

| 项 | 结论 | 说明 |
|---|---|---|
| G1 SCIP ↔ TS 映射 | **pass** | 43/43 声明 exact，falseMatch 0；SCIP 固定为 0.4.0 |
| G2 Vue 语义与模板边 | **pass-with-limit** | 6 个用户符号 100% 一致；golden 为人工期望集，未做 tsserver `findAllReferences` 全量交叉 |
| G3 重导出/别名/合并/跨包 | **pass** | 6/6 场景通过；含未声明依赖的负样本 |
| G4 身份迁移 | **pass** | 5.2.8 八场景 8/8；真实 TS 快照 + git 重命名证据 |
| G5 崩溃恢复 | **pass-with-limit** | 7/7 注入点 + 2 个非法态；注入用 `process.exit(137)`，非真实 kill -9 |
| G6 Node 双版本 | **pass** | 22.16.0 与 24.22.2 的 install/build/test/API 探针全部通过 |
| G7 RSS（5 万/30 万） | **pass-with-limit** | 50k 中位 301.8 MB；300k 中位 652.0 MB；**未含 SCIP 阶段** |
| G8 多根调度 | **pass-with-limit** | 五级降级顺序、取消、失败隔离、旧索引保留通过；内存压力为确定性模拟 |
| G9 配置安全 | **pass-with-limit** | 7/7 恶意用例 + E18；非 OS 级网络沙箱 |
| G10 全量/增量等价 | **pass-with-limit** | 10/10 字段相等；引用/依赖/调用边为全局重算，非真正按失效传播 |
| MCP 协议探针 | **pass** | 双 Node 版本均完成 initialize → tools/list → echo 调用 |

**建议**：Phase 00 可判定为“技术路线可行、带已知限制”；是否进入冻结评审与 Phase 01 由项目负责人决定。**本报告不构成进入 Phase 01 的授权。**

## 2. 执行环境与依赖

| 项 | 值 |
|---|---|
| 操作系统 | win32 / x64，16 vCPU，约 34.3 GB RAM |
| 开发运行时 | Node **v24.22.2**，npm **11.19.1**（fnm） |
| 下限运行时 | Node **v22.16.0**，npm **10.9.3**（见 6.1 的 npm 说明） |
| TypeScript | 5.9.3 |
| SCIP | `@sourcegraph/scip-typescript@0.4.0`（依赖 TS ^5.6.2） |
| Vue | `@vue/language-core@3.3.14`、`vue-tsc@3.3.14`、`@vue/compiler-sfc@3.5.45`、`vue@3.5.45` |
| MCP | `@modelcontextprotocol/server@2.4.0`、`@modelcontextprotocol/client@2.4.0` |
| SQLite | 内置 `node:sqlite`（无第三方驱动） |
| Zod | 4.6.7 |

## 3. 门槛执行纪律

- 门槛在验证开始前写入 `01-plan-and-thresholds.md`，验证后**未调整任何门槛**。
- 验证过程中修正的是实现缺陷与断言解析错误（SCIP namespace 描述符、git brace rename、Vue closing tag、TS symbol flags、npm 路径），不是放宽门槛。
- 所有正确性断言均使用独立来源：TypeScript Compiler API / `vue-tsc` / git / 文件系统副作用，而不是被测原型自证。

## 4. G1–G10 结果

### G1 SCIP ↔ TypeScript Compiler API 符号映射（pass）

- 夹具：`fixtures/semantic-map`（T01–T08）。
- 结果：eligible declarations **43**，exact **43**，`mappingSuccessRate = 1.0`，`falseMatchCount = 0`，`unmapped = 0`，`conflict = 0`。
- T01–T08 每个场景至少 1 条 exact 映射；T08 含同 root 与跨 package 两个子场景。
- 已知行为：T06 三个重载在 SCIP 中共享同一 symbol；原型在 TS 层按 `@ordinal` 区分（0/1/2），调用点分别解析到第 2/3 行。
- 证据：`phase00/results/g1-mapping.json`。

### G2 Vue SFC 语义与模板引用（pass-with-limit）

- 夹具：`fixtures/semantic-map/vue`（App.vue / Child.vue / main.ts）。
- 用户符号集合：App `{Child, msg, count, onClick}`、Child `{emit, fire}`，与人工 golden **6/6 一致**，无 unmapped。
- 模板边：component-use 1、event-binding 3、directive-binding 1、prop-binding 1、interpolation 3；slot 内容边 1。
- `__VLS_` 幽灵引用 **0**；非法坐标 **0**；未映射模板引用 **0**。
- `vue-tsc --noEmit` 退出码 **0**。
- 限制：用户符号集合的 Oracle 是人工 golden + `vue-tsc` 类型检查，不是 tsserver `findAllReferences` 全量比对；`__VLS_` 过滤规则仍需在 Phase 02 用 vue-tsc 既有规则做更大样本对照。
- 证据：`phase00/results/g2-vue.json`。

### G3 声明合并、重导出、别名、跨包（pass）

6/6 场景通过：

| 场景 | 结果 |
|---|---|
| T02 barrel 多层 | level1/level2 均解析到 `internal.ts`；`shared` 仅 1 个声明 |
| T03 别名重导出 | `renamed` 解析到 `original`；无第二符号 |
| T04 type/value import | 两者 `isTypeOnly` 正确区分，目标符号不同 |
| T05 声明合并 | `Box` 3 个声明（2 interface + namespace），成员 `a/b/tag` 完整 |
| T06 函数重载 | 3 个声明 ordinal 0/1/2；调用分别解析到 string/number 重载 |
| T08 同 root / 跨包 | 同 root 解析正确；已声明依赖 + exports 的跨包允许；仅 tsconfig paths、未声明依赖的跨包被拒绝 `undeclared-dependency` |

证据：`phase00/results/g3-scenarios.json`。

### G4 身份迁移（pass）

5.2.8 八场景全部通过：

1. 文件重命名：ID 不变，high，E1/E3/E5。
2. 跨目录移动：ID 不变，high，路径更新。
3. 双文件内容互换：low + `identityAmbiguous` + 候选，不继承。
4. 同名符号新增：新 ID，旧 ID 保留，不合并。
5. 删除后重建：新 ID，旧 ID retired；E3+E6 medium 分支未触发。
6. 声明内容大幅修改：ID 不变，结构指纹变化。
7. 多候选：low + 2 候选 + 不选择。
8. 跨 package 移动：旧 ID retired，新 root 新 ID。

证据：`phase00/results/g4-identity.json`。

### G5 SQLite / manifest 崩溃恢复（pass-with-limit）

- 7 个注入点全部符合 12.3.3 的现场 → 动作 → 状态映射：
  - begin / pending：旧索引 fresh；
  - committed-pending / verified：丢弃 pending，旧索引 stale；
  - committed / manifest-temp：manifest 修复为 committed，fresh；
  - manifest：manifest 已指向新 build，fresh。
- 额外非法态：损坏 DB → E07；无 build_record 但有数据 → E19。
- 限制：注入使用子进程 `process.exit(137)` 模拟未展开终止，不是真实 `kill -9`；未覆盖 Windows 文件系统缓存与 WAL 持久化的所有边界。Phase 01/06 需用真实进程终止补测。
- 证据：`phase00/results/g5-crash-recovery.json`。

### G6 Node 运行环境（pass）

| 运行时 | npm | npm ci | build | test | API 探针 |
|---|---|---|---|---|---|
| Node 22.16.0 | 10.9.3 | 0 | 0 | 0 | sqlite / styleText / watch / AbortSignal.timeout 全部 true |
| Node 24.22.2 | 11.19.1 | 0 | 0 | 0 | 同上 |

限制：nvm 安装的 Node 22.16.0 自带 npm 10.9.2 缺少 `@npmcli/config`，本次用同机 Node 22.18.0 的 npm 10.9.3 CLI 执行安装；Node 运行时仍为 22.16.0。该问题是本机 nvm 安装不完整，不是产品缺陷。

> 环境补充（2026-11-12）：该 npm 10.9.2 安装问题已消失，npm 10.9.2 现可在 CMD 正常使用（`npm -v`、`npm ls`、`npm ci --dry-run` 退出 0）。当前分工为 PowerShell / fnm（Node 24.22.2）与 CMD / nvm-windows（Node 22.16.0）。本节保留为 Phase 00 执行时的历史记录。

证据：`phase00/results/g6-runtime.json`。

### G7 真实 RSS（pass-with-limit）

每档 3 次独立进程，50ms 采样 + 阶段检查点：

| 规模 | 实际 LOC | 文件 | 峰值 RSS 中位/最大 | 查询常驻 | 构建耗时中位 | DB 大小 |
|---|---|---|---|---|---|---|
| 约 5 万 | 62,250 | 50 | **301.8 / 301.8 MB** | 36.1 MB | 0.75 s | 2.7 MB |
| 约 30 万 | 298,800 | 240 | **652.0 / 652.0 MB** | 37.0 MB | 2.18 s | 13.5 MB |

目标：50k ≤400（硬 550）MB；300k ≤700（硬 900）MB；查询 ≤60/100 MB。**均通过。**

限制：

- 峰值覆盖 TypeScript Program 构建、声明/引用遍历、SQLite 写入；**未包含 SCIP 子进程**。SCIP 已在 G1 单独验证正确性，但其内存需在 Phase 01/06 的集成管线补测。
- 百万行档按 D4 不验证。
- 生成器构造的是规整单包 TS 项目，不代表真实 Vue/React 工程的类型复杂度。

证据：`phase00/results/g7-rss.json`。

### G8 多根资源调度（pass-with-limit）

- 五级降级顺序严格为：`disable-calls → chunked → reduce-vue-projection → serialize → abort-root`，最终报 E20。
- 取消传播：3 个任务在 30 ms 取消，全部 rejected，耗时远低于 2 s，无最终文件写入。
- 失败隔离：root-b 失败，root-a/root-c 成功；root-b 旧索引保留，临时文件清理，无部分提交。
- 限制：内存压力为确定性输入而非实时 RSS；Phase 01/06 必须接入真实 `Global Resource Coordinator` 与进程 RSS 采样。
- 证据：`phase00/results/g8-scheduler.json`。

### G9 配置安全（pass-with-limit）

7/7 + E18：

| 用例 | 结果 |
|---|---|
| 恶意 TS 配置读项目外文件 | `READ_DENIED`，无 `READ_OK` |
| 恶意 TS 配置发起网络请求 | `FETCH_DENIED` |
| 恶意 TS 配置写项目外文件 | `WRITE_DENIED`，文件不存在 |
| `postinstall` / `prepare` | 仅读取 package.json，未执行，marker 不存在 |
| 恶意自定义命令 `rm -rf /` | E17 拒绝；合法 `npm run typecheck` 通过 |
| 未授权 verify | `skipped-unauthorized`；显式要求时 E12 |
| 不可信插件 | 默认禁用；显式允许后 `untrusted: true` |
| 未授权 `.ts` 配置 | E18；授权后 benign 配置可加载 |

限制：隔离依赖 Node `--permission` + ESM `registerHooks` + CJS require hook；不是 OS 级网络沙箱，不能证明所有逃逸路径都被阻断。Phase 01 需补平台级网络与文件系统隔离测试。

证据：`phase00/results/g9-security.json`。

### G10 全量 vs 增量等价（pass-with-limit）

- 变更集：修改文件、删除文件、重命名文件、新增文件、跨包签名变更。
- 10/10 比较字段相等：symbols、identity、references、exports、files、surfaceHash、edges、buildFingerprint、coverage、manifest。
- 增量复用了 12/20 个未变化文件。
- 限制：引用、依赖、调用边为全局重算；未实现按 `12.1` 的失效传播与按 root 局部增量。该结果是“表示层等价”，不是“真实增量实现已验证”。
- 证据：`phase00/results/g10-equivalence.json`。

## 5. MCP 协议探针（pass）

- 最小 stdio server（官方 SDK v2，仅 echo 工具）+ client 直连。
- 双 Node 版本均完成 `initialize → tools/list → tools/call`：
  - 协商 `protocolVersion = 2025-11-25`；
  - `tools/list` 返回 1 个工具 `echo`；
  - structuredContent 与 text content 均为 `hello-phase00`；
  - 墙钟时间 < 1 s，低于 30 s 门槛；
  - 未修改任何平台 MCP 配置，未注册全局服务。
- 证据：`phase00/results/mcp-probe.json`。

## 6. 通过项、限制与残余风险

### 6.1 已解决/已确认

- Node 24.22.2 开发环境与 Node 22.16.0 下限均可用。
- Apache-2.0 许可证已落地。
- SCIP / Vue / MCP 依赖的真实 API 可用；MCP v2 拆分包可工作。
- 符号身份八场景、SQLite 七注入点、Vue 四类模板边、双 Node 环境均有可复现证据。

### 6.2 必须带限制表述的项

1. **SCIP 版本风险**：0.4.0 依赖 TS 5.x；最新 0.6.x 依赖 TS 6 且要求 Node ≥22.23.4，与本项目 TS 5.x 锁定和 22.16 下限冲突。升级必须单独评审。
2. **SCIP 记忆未纳入 G7**：300k 的 652 MB 不含 SCIP 峰值；集成管线可能更高。
3. **G5 未真实 kill -9**：`process.exit(137)` 与 OS 强制终止在 WAL/文件缓存上可能有差异。
4. **G8 内存压力为模拟值**：未证明真实 RSS 下的调度行为。
5. **G9 非 OS 级网络沙箱**：ESM/CJS hook + permission model 可被更底层机制绕过。
6. **G10 边全局重算**：未验证 12.1 的失效传播完备性。
7. **G2 golden 为人工期望集**：未做 tsserver 全量引用对照。
8. **百万行档**：按 D4 未验证；16.2/21.2 的百万行目标仍未证实。

### 6.3 规范 0.3 未关闭事项的当前状态

| 事项 | 当前状态 |
|---|---|
| SCIP 与 TS/Vue 语义映射正确性 | 43/43 声明 exact、T01–T09 场景通过；仍限声明级与合成夹具 |
| 三档内存预算 | 50k/300k 实测通过；百万行档按 D4 未测 |
| 符号身份迁移算法 | 八场景原型通过；未接入生产索引 |
| TS 配置授权 UX | 原型 E18/授权路径通过；非 TTY 与交互体验未验证 |
| 百万行档性能 | 按 D4 不验证；由后续真实项目实测替代 |

依赖审计（2026-11-12，官方 registry）：**0 high / 0 critical**，1 low + 12 moderate，均为 devDependencies（ESLint / typescript-eslint / esbuild 链）；满足 3.2 的“无高危漏洞”门槛，但不能据此推断未来运行时依赖同样干净。

## 7. 复现方式

```bash
# 全部 Phase 00（需要 Node 子进程权限：npm / scip / vue-tsc / git / MCP）
npm run phase00

# 单项
node phase00/g1-g3/run-g1.mjs
node phase00/g1-g3/run-g2.mjs
node phase00/g1-g3/run-g3.mjs
node phase00/g4/run-identity.mjs
node phase00/g5/run-crash-recovery.mjs
node phase00/g6/run-runtime.mjs
node phase00/g7/run-rss.mjs
node phase00/g8/run-scheduler.mjs
node phase00/g9/run-security.mjs
node phase00/g10/run-equivalence.mjs
node phase00/mcp/run-probe.mjs
```

结果写入 `phase00/results/*.json`；性能生成物与临时目录在 `phase00/tmp/`，均不入库。

## 8. 建议的下一步

1. 由项目负责人评审本报告与 `01-plan-and-thresholds.md`，决定是否进入规范冻结评审。
2. 若进入 Phase 01，先处理本报告 6.2 的限制，尤其是：SCIP 版本策略、G7 加入 SCIP 峰值、真实增量失效传播、G9 平台级网络隔离。
3. **在冻结评审与明确授权前，不启动 Phase 01。**
