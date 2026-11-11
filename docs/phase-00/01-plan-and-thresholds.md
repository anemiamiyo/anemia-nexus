# Phase 00 执行计划与验收门槛（验证前声明）

> 声明时间：2026-11-11（**在任何 G1–G10 验证运行之前**）
> 依据：`docs/21-phase-00.md`、`docs/04-architecture.md` 4.3.4、`docs/05-data-model.md` 5.2.8、`docs/12-indexing.md` 12.3.3、`docs/17-testing.md`
> 范围裁定：见 `00-scope-decisions.md`（百万行档不验证）

## 1. 目标与非目标

**目标**：用真实分析器、真实 SQLite、真实 Node 运行环境和独立 Oracle，验证 P0 技术路线是否成立；产出可复核的报告、最小原型、自动化用例与残余风险清单。

**非目标**：不实现 Phase 01 的 CLI 骨架、不建立生产索引器、不实现 8 个 MCP 工具、不做发布验证、不修改任务书技术结论。原型代码放在 `phase00/`，不得被后续阶段当作生产实现直接复用。

## 2. 验证环境与依赖（已锁定）

| 项 | 版本/说明 |
|---|---|
| Node（开发验证） | 24.22.2（fnm） |
| Node（下限验证） | 22.16.0（G6 安装并由 fnm 切换） |
| TypeScript | 5.9.3 |
| SCIP | `@sourcegraph/scip-typescript@0.4.0`（依赖 TS ^5.6.2；npm 上的 `scip-typescript` 为安全占位包，不使用） |
| Vue | `@vue/language-core@3.3.14`、`vue-tsc@3.3.14`、`@vue/compiler-sfc@3.5.45` |
| 存储 | Node 内置 `node:sqlite`（不引入第三方驱动） |
| 配置校验 | `zod@4.6.7` |
| MCP | `@modelcontextprotocol/server@2.4.0`、`@modelcontextprotocol/client@2.4.0`（仅协议探针） |
| 并发锁 | `proper-lockfile@4.1.2` |
| 运行脚本 | `tsx@4.23.15`（仅验证脚本） |

## 3. 判定规则

1. 每个验证组只允许三种结论：`pass` / `pass-with-limit`（附明确限制）/ `fail`（附架构调整建议）。**不存在“基本通过”。**
2. 本文件中的门槛在验证开始前写定；验证后**不得调整门槛**。确需变更，必须记录原门槛、变更理由与批准人。
3. 正确性判定必须使用独立 Oracle（tsserver / `ts.LanguageService`、`vue-tsc`），**不得用被测工具自身输出自证**。
4. 所有夹具为合成仓库，不使用真实业务项目；性能生成物不提交。
5. 每个断言必须在报告中给出可复现命令、输入、输出摘要与退出码。

## 4. G1–G10 门槛

| 组 | 验证 | 通过门槛 | 主要产物 |
|---|---|---|---|
| G1 | SCIP ↔ TS Compiler API 符号映射（T01–T08） | 合格声明映射成功率 `mappingSuccessRate ≥ 95%`；`falseMatchCount = 0`；未映射 / 歧义逐条登记；T01–T08 每组至少 1 条 exact 映射 | `results/g1-mapping.json` + 对照报告 |
| G2 | Vue SFC 语义与模板引用（T09） | 过滤 `__VLS_*` 后用户符号集合与 Oracle 一致率 **100%**；四类模板边（component-use / template-binding / interpolation / slot 内容）各 ≥1；坐标不一致 **0**；`vue-tsc` 对该夹具 0 error | `results/g2-vue.json` |
| G3 | 声明合并、重导出、别名、跨包（T02–T05、T08） | **5/5** 场景符合 4.3.4 断言；T03 别名不产生第二符号；T04 类型/值 import 不合并；T05 合并成员完整；T08 跨包只按 5.7 规则 | `results/g3-scenarios.json` |
| G4 | 文件移动/重命名后的身份策略（5.2.8 八场景） | **8/8** 产出预期 `identityConfidence` + 证据；`low` 不继承旧 ID；多候选保留 `candidates[]`；`retired` ID 不复用 | `results/g4-identity.json` |
| G5 | SQLite WAL 与 manifest 一致性（12.3.3 七注入点） | **7/7** 恢复现场与 12.3.3 表一致；kill 后无部分提交；旧索引在允许场景可读；`invalid` 场景报 E19 而非返回旧数据 | `results/g5-crash-recovery.json` |
| G6 | Node 运行环境与所需 API | Node **22.16.0 与 24.22.2 双版本**均通过：安装、构建、`node:sqlite` 读写、最小索引、MCP 协议探针、版本校验；API 清单逐项确认 | `results/g6-runtime.json` |
| G7 | 真实 RSS（5 万 / 30 万 LOC；**百万行档不验证**） | 每档 3 次、间隔重启；中位数 ≤ 目标（400 / 700 MB）且最大值 ≤ 硬上限（550 / 900 MB）；查询常驻 ≤ 60 / 100 MB；按 16.2.3 字段记录；缺一项即无效 | `results/g7-rss.json` |
| G8 | 多根资源调度（3 root + 压预算） | 5.10.4 五级降级**按顺序**触发且可观察；取消传播 ≤ 2s；无部分提交；失败 root 标 `failed` 且旧索引保留；其余 root 不受影响 | `results/g8-scheduler.json` |
| G9 | 配置安全边界（F17 七用例） | **7/7** 无文件写入、无网络请求、无未授权 shell/子进程；未授权 `.ts` 配置报 E18；`postinstall`/`prepare` 不执行；恶意命令被白名单拒绝 | `results/g9-security.json` |
| G10 | 全量与增量结果一致性（12.2 十项比较） | **10/10** 比较项相等，`buildFingerprint` 相同；差异必须能由指纹差异解释 | `results/g10-equivalence.json` |

### 4.1 T01–T10 场景门槛

| 编号 | 场景 | 门槛 |
|---|---|---|
| T01 | 普通函数/类/变量/接口 | 三引擎均 mapping，`match_quality = exact` |
| T02 | Barrel 多层重导出 | 链末端身份唯一；链上每跳有边 |
| T03 | `export { A as B }` | 别名不产生第二符号；引用指向 A 的 `symbolId` |
| T04 | `import type` vs 值 import | 边 kind 不同，不合并 |
| T05 | 声明合并 | 合并为一个符号，成员完整，`ambiguous = false` |
| T06 | 函数重载 | 每个重载独立 `@ordinal`，调用点指向选中重载 |
| T07 | 泛型与泛型实例 | 类型参数不误当符号；实例化引用指向泛型声明 |
| T08 | 跨目录 / 跨 package | 同 root exact；跨 root 只按 5.7 |
| T09 | Vue SFC | 全部可回指；四类模板边齐备 |
| T10 | 文件删除/重命名/路径变化 | 不产生重复符号；身份迁移按 5.2 判定并给置信度 |

### 4.2 MCP 协议探针门槛

- 最小 stdio server，官方 SDK v2，仅一个 echo 工具。
- 完成 `initialize → tools/list → 一次调用`，全程 ≤ 30s。
- 记录协商的 `protocolVersion`、拉起耗时、退出码。
- 不修改任何平台 MCP 配置，不注册全局服务，结束后无残留进程/文件。

## 5. 执行顺序

1. G1 → G2 → G3（语义映射主线，P0）
2. G4（身份）
3. G5（提交/恢复）
4. G6（双 Node 环境）
5. G7（RSS；5 万/30 万）
6. G8（调度）
7. G9（安全）
8. G10（增量等价）
9. MCP 协议探针
10. 汇总报告、项目描述文档、风险与未解决清单

## 6. 失败处理

任一组 `fail`：停止该组后续依赖验证，按 `docs/20-prohibitions.md` 20.6 提交《架构问题报告》，不得通过降低门槛、换更小夹具或使用被测工具自证来“通过”。`pass-with-limit` 必须写明限制条件、影响范围与后续验证计划。
