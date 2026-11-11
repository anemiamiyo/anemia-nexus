# Anemia Nexus

> 以确定性索引为底座的**变更审计与 API 治理设施**，不是"更好的搜索工具"。
> 当前状态：**Phase 00 已完成（11/11，其中 6 项为 pass-with-limit）；规范 v1.24 已冻结；Phase 01 已实现 TS/TSX 索引与 CLI 骨架并通过 G1–G8，等待负责人评审；Vue / API Surface / 增量 / MCP 仍未实现。**

---

## 1. 项目定位与核心目标

在超大型前端项目中，AI CLI Agent 往往只能依赖文本搜索、目录浏览和有限上下文。它读到一个符号的 3 处引用，就可能认为只有 3 处，然后修改公共签名——这是**静默漏报**，不是报错。在契约密集、强调公共 API 稳定性的仓库里，静默漏报的代价远高于报错。

Anemia Nexus 的目标是把"变更影响、公共 API 差分、复用检测"变成**可复核的事实**：人在终端能核对，CI 能拦截，Agent 能通过 MCP 取得带证据的结论。搜索只是它的下沉能力。

三条不可替代的能力（规划目标，尚未实现）：

1. **可验证的完整性**：能回答"该符号在当前覆盖范围内共 N 处引用，已全部列出"，同时给出覆盖范围与未覆盖原因。
2. **确定性可复现**：同一 commit、命令、参数与构建指纹，输出逐字节一致。
3. **增量下的身份可判定**：文件重命名、移动、barrel 重导出不必然改变符号身份；工具给出身份是否延续及置信度。

**完整性承诺的严格边界**：所谓"零漏报"仅适用于**确定性静态关系**（`relationClass = certain`），且仅在该文件位于索引范围内、分析成功完成时成立。启发式关系带置信度标注；动态关系明确不保证识别。**禁止把"未发现引用"表述为"确认不存在引用"。**

Phase 01 交付了上述能力中的第一个可运行切片：TS/TSX 的符号与引用索引、CLI 骨架、`status` / `doctor` 与最小查询面。Vue、API Surface、关系图、影响分析、增量与 MCP 仍是规划内容；未实现命令返回 E24「未提供」，不会伪造结果。

### 1.1 适用范围与前置条件

**适用**：可被 TypeScript Compiler 解析的项目（含 TSX）；建议 10 万行以上、模块数 > 30、存在被其他代码或团队消费的公共 API；有 git 仓库。判据比行数更重要：是否存在"改动会波及外部消费方"的公共契约。

| 前置条件   | 要求                                 | 不满足的后果                                               |
| ---------- | ------------------------------------ | ---------------------------------------------------------- |
| 类型检查   | 能通过 tsc，建议 strict              | 降级为 `syntax-only`，引用/影响结论不得作确定性依据        |
| 类型完整度 | 避免 any 泛滥与隐式类型              | 只建议使用检索，不建议依赖影响分析                         |
| 路径别名   | 写入 tsconfig 或 `nexus.config.json` | 别名解析失败，跨包引用降为 heuristic                       |
| 多根工作区 | 每个 package 可独立 typecheck        | 未识别 root 不进入索引；跨 root 只允许已声明依赖 + exports |
| 版本控制   | 有 git 与可用 diff 基线              | 审计链路不可用，索引与查询仍可用                           |
| 运行环境   | Node ≥ 22.16.0                       | 启动即 E14 退出，不提供降级驱动                            |

**框架支持**：TS/TSX 开箱可用；Vue 3 限于可解析类型与四类模板边，复杂 Props/Slot 显式降级；CSS/SCSS/Less 只做文件级依赖；HTML 文件级引用为 opt-in（默认关）；Svelte、Angular 等 v1 不提供适配。

**不推荐**：中小型项目、个人/娱乐项目、实验性原型、无公共 API 契约的单人仓库、无法保证类型检查通过的项目。共同点是固定成本高于收益。

**成本口径**：固定成本上升（建索引、维护、每次增量、磁盘与内存），探索成本下降；**不以"节省 Token"作为价值主张**。

---

## 2. 主要功能与明确的非目标

### 2.1 规划中的主要功能（均未实现）

| 能力                             | 说明                                                                                                        | 规划阶段 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| 确定性索引                       | TypeScript / TSX / Vue 3 SFC；SCIP 为主、TS Compiler API 校验、Vue Language Core 投影                       | 01–02    |
| 代码检索                         | 符号、类型、文件、目录、导出、签名、组件 Props/Emits/Slots、引用、JSON/配置、示例与测试、废弃 API、身份历史 | 01–02    |
| API Surface 治理                 | 公共/内部/opaque 分类、公开证据来源、基线快照、语义化差分、弃用链路                                         | 03       |
| 关系分析                         | 文件/模块依赖、符号引用、导出重导出、静态调用、组件关系、测试关联；三分类 + 四档置信度                      | 04       |
| 变更影响分析                     | 直接/间接依赖者、受影响 Surface/组件/类型/测试、盲区清单、风险等级                                          | 05       |
| Preflight / Postflight / CI 门禁 | 变更前审计、变更后审计、退出码门禁                                                                          | 05       |
| 增量与一致性                     | 失效传播、提交协议、崩溃恢复、五态状态机、增量=全量门禁                                                     | 06       |
| 复用性检测                       | 可解释的相似 API 检索、重复实现巡检                                                                         | 07       |
| MCP 接入                         | 8 个工具，仅 `refresh` 可写索引                                                                             | 07       |
| CLI                              | 21 个主命令 + 4 个兼容别名，`nex` / `anex` / `anemia`                                                       | 01–07    |
| 多根工作区                       | 每个 root 独立索引，跨 root 只允许已声明依赖 + exports 可解析的边                                           | 02–05    |
| 样式依赖                         | 仅文件级 `@import` / `@use` / `@forward` / `<style src>` / TS import，不做选择器                            | 04       |

### 2.2 明确的非目标（v1 不做）

- 不做 IDE、不做语言服务器、不替代 tsserver / LSP。
- 不追求全语言覆盖；v1 只承诺 TypeScript、TSX、Vue SFC、JSON 与常见配置文件；样式只做文件级依赖。
- 不宣称"完整调用图"，只提供带置信度标注的静态调用关系。
- **不做运行时追踪**：不注入探针、不采集运行时调用计数、不做覆盖率插桩。
- 不做代码生成、不做自动修复、不修改被分析项目的业务代码。
- 不以"节省 Token"作为价值主张。对外口径是：**固定成本上升，探索成本下降**。
- 不提供样式类名 / 选择器的消费方全集。
- 不做 Sass / Less 编译，不解析变量拼接后的路径，不读取项目外文件，不访问网络。
- 不提供自动迁移旧索引的承诺；Schema 不兼容时默认重建。
- 不自动写入 AGENTS.md、MCP 配置或 Skill 目录；接入物料只打印到终端。

---

## 3. 核心技术栈

| 层          | 选型                                                                                | 状态                                         |
| ----------- | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| 运行环境    | Node.js **≥ 22.16.0**（强制；低于即 E14 退出）                                      | 已配置 `engines` + `engine-strict`           |
| 开发语言    | TypeScript **5.9.3**（锁定 5.x；`@vue/language-core` 不接受 TS 7.x）                | 已安装                                       |
| 包管理      | npm workspaces                                                                      | 已配置                                       |
| 构建        | tsup 8.5.1（ESM，`target: node20` 仅语法目标）                                      | 已配置并验证                                 |
| 测试        | Vitest 5.1.0                                                                        | 已配置；产品无测试，Phase 00 有独立验证脚本  |
| 版本发布    | changesets 3.0.3                                                                    | 已安装，未启用发布流程                       |
| 代码规范    | ESLint 10 + typescript-eslint + eslint-plugin-n；Prettier 3                         | 已配置并验证                                 |
| 索引存储    | 内置 `node:sqlite`（唯一驱动，禁止第三方）                                          | Phase 01 产品链路已接入并验证                |
| 语义分析    | `@sourcegraph/scip-typescript@0.4.0`；TS Compiler API；@vue/language-core / vue-tsc | 已安装；Phase 00 原型验证通过                |
| 依赖 / 质量 | dependency-cruiser、Knip                                                            | 规划；尚未接入                               |
| 配置校验    | Zod（JSON Schema 派生）                                                             | 已安装；Phase 00 安全原型验证                |
| CLI / MCP   | Commander.js；`@modelcontextprotocol/server` v2                                     | CLI 骨架已实现；MCP 协议探针通过、服务未实现 |
| 并发保护    | proper-lockfile                                                                     | 已安装；调度为 Phase 00 模拟原型             |
| 样式解析    | postcss 系（只提取字符串，不编译）                                                  | 规划；尚未接入                               |

> **工程链兼容性**：tsup 9.0.0 的 `engines` 为 `^22.18.0 || ^24.11.0 || >=26.0.0`，会破坏 Node 22.16.0 下限矩阵，故固定 **tsup 8.5.1**；changesets 3.0.3 要求 npm ≥10.9.0（Node 22.16.0 自带 npm 10.9.2，满足）；ESLint 10 要求 Node ≥22.13，Vitest 5 / Vite 7 要求 ≥22.12。TypeScript 固定 5.9.3，满足 typescript-eslint 8 的 `>=4.8.4 <6.1.0` 约束。SCIP 固定 `@sourcegraph/scip-typescript@0.4.0`（TS 5.x）；最新的 0.6.x 依赖 TS 6 且要求 Node ≥22.23.4，升级须单独评审。
>
> **注意**：Phase 00 已安装分析/验证依赖（SCIP、Vue、Zod、MCP、ts-morph、proper-lockfile），并用于 `phase00/` 原型；这**不代表**产品功能已实现。`packages/*/src` 仍是占位入口。

---

## 4. 项目目录结构

```text
anemia-nexus/
├── .changeset/                 # changesets 配置
├── .dsh/                       # 项目级 AI 协作规范（git 忽略）
│   └── AGENTS.md
├── .github/workflows/ci.yml    # Node 22.16.0 / 24 双矩阵
├── docs/                       # 技术规范主体（权威来源）
│   ├── README.md               # 文档索引与职责
│   ├── 00-…23-*.md             # 按原章号拆分的规范
│   ├── appendix-a-d.md
│   ├── runtime-api.md          # Node API 最低版本登记
│   ├── phase-00/               # Phase 00 范围、门槛、验证报告
│   └── phase-01/               # 规范冻结、Phase 01 计划与任务清单
├── fixtures/                   # 合成夹具（semantic-map、F15 identity）
│   └── local/                  # 用户本地真实项目（git 忽略）
├── phase00/                    # Phase 00 验证原型（非产品实现）
├── packages/
│   ├── core/                   # anemia-core：扫描/配置/索引/存储/查询
│   ├── cli/                    # anemia-cli：CLI（bin: nex/anex/anemia）
│   ├── mcp/                    # anemia-mcp：MCP Server（占位）
│   └── adapter-vue/            # anemia-adapter-vue：Vue 适配（占位）
├── eslint.config.js
├── tsconfig.base.json
├── vitest.config.ts
├── package.json                # npm workspaces 根
├── LICENSE / NOTICE            # Apache-2.0
└── README.md
```

- `packages/core` 与 `packages/cli` 已含 Phase 01 产品实现；`packages/mcp` 与 `packages/adapter-vue` 仍是占位入口。
- `packages/cli` 已声明 `nex` / `anex` / `anemia` 三个 bin，指向同一份 `dist/main.js`。
- `.nexus/`、`dist/`、`coverage/`、`node_modules/`、`fixtures/local/` 均不纳入版本控制。
- `nexus.baseline.json` 规划纳入 git（尚未生成）。

---

## 5. 文档导航

完整索引与职责边界见 [`docs/README.md`](docs/README.md)。

| 文档                                                                                                            | 内容                                                           |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`docs/01-scope-and-positioning.md`](docs/01-scope-and-positioning.md)                                          | 适用范围、前置条件、定位、能力承诺、非目标、成功判据、设计原则 |
| [`docs/02-technical-baseline.md`](docs/02-technical-baseline.md)                                                | 产品基线、命名与命令、运行环境五层口径                         |
| [`docs/03-tech-stack-and-build.md`](docs/03-tech-stack-and-build.md)                                            | 选型、依赖准入、构建发布链路、发布验证                         |
| [`docs/04-architecture.md`](docs/04-architecture.md)                                                            | 总体架构、Vue 索引管线、样式依赖链、多分析器语义统一           |
| [`docs/05-data-model.md`](docs/05-data-model.md)                                                                | 实体、符号身份、存储、多根、资源协调、构建指纹                 |
| [`docs/06-api-surface.md`](docs/06-api-surface.md)                                                              | API 边界、证据来源、基线、差分、弃用                           |
| [`docs/07-code-search.md`](docs/07-code-search.md) – [`docs/10-impact-analysis.md`](docs/10-impact-analysis.md) | 检索、关系、复用、影响分析                                     |
| [`docs/11-cli.md`](docs/11-cli.md)                                                                              | 命令、参数、格式、退出码、非 TTY                               |
| [`docs/12-indexing.md`](docs/12-indexing.md)                                                                    | 失效、提交协议、状态机、忽略规则                               |
| [`docs/13-audit-and-ci.md`](docs/13-audit-and-ci.md)                                                            | Preflight / Postflight / CI                                    |
| [`docs/14-agent-integration.md`](docs/14-agent-integration.md)                                                  | MCP 8 工具与接入模板                                           |
| [`docs/15-output-contract.md`](docs/15-output-contract.md)                                                      | 三层输出、完整性字段、稳定格式                                 |
| [`docs/16-nfr-and-errors.md`](docs/16-nfr-and-errors.md)                                                        | 准确率、性能、错误码 E00–E24                                   |
| [`docs/17-testing.md`](docs/17-testing.md)                                                                      | 合成夹具 F01–F18、验证项、断言                                 |
| [`docs/18-security.md`](docs/18-security.md)                                                                    | 六类操作边界、降级、配置执行、自定义命令                       |
| [`docs/19-delivery-phases.md`](docs/19-delivery-phases.md)                                                      | 阶段 00–07 与交付管理                                          |
| [`docs/20-prohibitions.md`](docs/20-prohibitions.md)                                                            | 48 条 AI Agent 禁令                                            |
| [`docs/21-phase-00.md`](docs/21-phase-00.md)                                                                    | Phase 00 十组验证与内存校准                                    |
| [`docs/22-onboarding.md`](docs/22-onboarding.md)                                                                | 首次接入与失败体验                                             |
| [`docs/23-conflicts.md`](docs/23-conflicts.md)                                                                  | 跨章节冲突与消解                                               |
| [`docs/appendix-a-d.md`](docs/appendix-a-d.md)                                                                  | 兼容矩阵、文档职责、冻结清单、修订对照                         |
| [`docs/runtime-api.md`](docs/runtime-api.md)                                                                    | Node 内置 API 最低版本登记                                     |
| [`docs/phase-01/00-freeze-and-entry.md`](docs/phase-01/00-freeze-and-entry.md)                                  | 规范冻结、负责人裁定与 Phase 01 入场条件                       |
| [`docs/phase-01/01-task-checklist.md`](docs/phase-01/01-task-checklist.md)                                      | Phase 01 完整任务清单（计划基线）                              |
| [`docs/phase-01/02-plan-and-gates.md`](docs/phase-01/02-plan-and-gates.md)                                      | Phase 01 授权、Q-01/Q-02 裁定与冻结门槛                        |
| [`docs/phase-01/03-implementation-report.md`](docs/phase-01/03-implementation-report.md)                        | Phase 01 实施报告、状态矩阵、gate 结论与已知限制               |

文档职责：`docs/` 是技术规范唯一权威来源；本 README 只负责安装、运行、配置、上手与能力边界；`.dsh/AGENTS.md` 只负责 AI 协作纪律，不复制错误码表或工具用法全集。

---

## 6. 开发环境要求

| 项                  | 要求                   | 说明                                                      |
| ------------------- | ---------------------- | --------------------------------------------------------- |
| Node.js             | **≥ 22.16.0**          | `node:sqlite` 的 API 可用性下限；启动时校验，不满足报 E14 |
| Node.js（开发基线） | 24 LTS                 | 2.2 定义的开发主力环境；CI 同时验证 22.16.0 与 24         |
| npm                 | 随 Node 提供（≥ 10.9） | workspaces 与 changesets 需要                             |
| Git                 | 可用                   | 审计链路与发布验证依赖                                    |
| 包管理器            | 仅 npm                 | 不使用 pnpm                                               |
| 构建器              | 仅 tsup                | 不使用 Vite 做构建                                        |

> 本机双运行时：**PowerShell 由 fnm 管理 Node v24.22.2（npm 11.19.1）**，**CMD 由 nvm-windows 管理 Node v22.16.0（npm 10.9.2）**；`.nvmrc` 写 `24`。npm 10.9.2 现已可在 CMD 中正常使用（已验证 `npm -v`、`npm ls`、`npm ci --dry-run` 均退出 0）。Phase 00/01 记录中的“npm 10.9.2 缺 `@npmcli/config`、临时改用 npm 10.9.3”是当时环境状态，现已恢复。

安装依赖（仅安装工程链；运行时不联网）：

```bash
npm install
```

如 npm 默认缓存目录不可写，可临时指定缓存路径，**不要修改全局 npm 配置**：

```bash
npm install --cache ./.npm-cache
```

---

## 7. 安装、构建、测试命令

```bash
npm install            # 安装 workspace 依赖并生成/使用 package-lock.json
npm run build          # tsup 构建全部 packages（ESM + d.ts，target node20）
npm run typecheck      # tsc --noEmit，逐 package
npm test               # Vitest；当前无测试，--passWithNoTests
npm run test:watch     # Vitest watch
npm run lint           # ESLint，含 Node 22.16.0 内置 API 越界检查
npm run format         # Prettier 写入
npm run format:check   # Prettier 检查
npm run changeset      # 创建 changeset（发布流程尚未启用）
npm run phase00        # Phase 00 全部验证（需要 Node 子进程权限）
```

**Phase 01 已提供 `nex` / `anex` / `anemia` 命令（构建后）：**

```bash
npm run build
node packages/cli/dist/main.js init --roots all --write-config --yes
node packages/cli/dist/main.js build
node packages/cli/dist/main.js status
node packages/cli/dist/main.js references <symbol>
```

已实现：`init`、`build`、`status`、`doctor`、`symbol`、`references`、`search`；`query` 为 `search` 的兼容别名。其余命令（`update`、`deps`、`impact`、`context`、`api-snapshot`、`api-diff`、`similar`、`audit-duplicates`、`preflight`、`postflight`、`verify`、`print`、`mcp`、`test`）在 Phase 01 返回 E24「未提供」，退出码 1。

本项目是 Node 库与 CLI，不是前端应用，**没有常驻 dev server**。开发期使用 `npm run test:watch`、编辑器类型检查、`npm run build` 与 `node packages/cli/dist/main.js`；CLI 不启动任何后台常驻进程。

### 7.1 安装后的手动接入（规划；`nex` 尚未实现）

以下四步来自 21.1，**工具实现后才可执行**；工具只打印接入物料，不代写任何配置文件：

1. **MCP**：运行 `nex print mcp-config --client dsh`，把打印出的 JSON 合并到平台 MCP 配置，重启平台。
2. **AGENTS.md**：运行 `nex print agents`，把片段粘贴到项目根 `AGENTS.md`；已存在则追加，不覆盖原内容。
3. **Skill**：从仓库下载 `skills/nexus`，复制到平台 skills 目录（dsh 为 `~/.dsh/skills/nexus`，以平台文档为准）。
4. **验证**：`nex status` 应返回 `state: uninitialized` 或 `ready`；已完成 build 的项目应为 `ready` 且 `staleness: fresh`。

工具不提供 `--write-*` / `--install` 参数；MCP 配置、AGENTS 片段与 Skill 一律只打印到终端。

---

## 8. 当前初始化状态

### 8.1 已完成

- [x] 将任务书 v1.24 按章节拆分为 25 个规范文件，正文与原文逐字节一致（已校验），并建立 [`docs/README.md`](docs/README.md) 索引。
- [x] 建立 [`.dsh/AGENTS.md`](.dsh/AGENTS.md) 项目级 AI 协作规范，并加入 `.gitignore`。
- [x] 建立 npm workspaces 骨架：`anemia-core`、`anemia-cli`、`anemia-mcp`、`anemia-adapter-vue`（均为占位入口）。
- [x] 配置 TypeScript 5.x、tsup（ESM / node20 / dts）、Vitest、ESLint（含 `n/no-unsupported-features/node-builtins` @ 22.16.0）、Prettier、changesets、GitHub Actions 双 Node 矩阵。
- [x] 生成 `package-lock.json`，全部版本精确锁定。
- [x] 落地 **Apache-2.0** 许可证与 NOTICE；根与 4 个子包写入 `license` 字段。
- [x] 完成 **Phase 00**：11 项验证全部退出码 0，证据写入 `phase00/results/`，报告见 [`docs/phase-00/02-validation-report.md`](docs/phase-00/02-validation-report.md)。
- [x] 建立 Phase 00 夹具：`fixtures/semantic-map`（T01–T09）、`fixtures/F15-identity`（八场景）。
- [x] 完成 **Phase 01**：CLI 骨架与 `init` / `build` / `status` / `doctor` / `symbol` / `references` / `search`；Zod JSON 配置与授权 TS 配置子进程；root 探测与隔离扫描；SCIP 0.4.0 + `node:sqlite` 的 TS/TSX 索引；四格式输出、退出码与错误码框架。
- [x] 建立 Phase 01 夹具：`fixtures/F01-reexport-chain`、`fixtures/F10-negative`、`fixtures/F17-config-security`、`fixtures/F04-multi-root`，以及独立 tsserver Oracle（`tools/oracle/`）。
- [x] 双 Node 验证：Node 22.16.0 与 24.22.2 下 build / typecheck / 52 项测试 / CLI 基础链路全部通过。

### 8.2 Phase 00 验证结果

| 组                  | 结果            | 关键指标                                                                                         |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| G1 SCIP↔TS          | pass            | 43/43 声明 exact；falseMatch 0                                                                   |
| G2 Vue              | pass-with-limit | 6/6 用户符号；component-use / event / directive / prop / interpolation 边齐全；`vue-tsc` 0 error |
| G3 重导出/合并/跨包 | pass            | 6/6 场景                                                                                         |
| G4 身份迁移         | pass            | 8/8 场景                                                                                         |
| G5 崩溃恢复         | pass-with-limit | 7/7 注入点 + 2 非法态                                                                            |
| G6 双 Node          | pass            | 22.16.0 / 24.22.2 的 install、build、test、API 探针全部通过                                      |
| G7 RSS              | pass-with-limit | 50k：中位 301.8 MB；300k：中位 652.0 MB；查询常驻约 36–37 MB                                     |
| G8 调度             | pass-with-limit | 五级降级顺序、取消、失败隔离、旧索引保留                                                         |
| G9 配置安全         | pass-with-limit | 7/7 恶意用例 + E18                                                                               |
| G10 全量/增量       | pass-with-limit | 10/10 字段相等；复用 12/20 文件                                                                  |
| MCP 协议探针        | pass            | 双 Node 版本 initialize → tools/list → echo；协议 2025-11-25                                     |

工程检查仍通过：`npm run typecheck`、`npm run lint`、`npm run build`、`npm run format:check`、`npm test`（52 项）。**Phase 00 的 pass-with-limit 限制必须与结果一起引用，不能只写“通过”。**

### 8.2.1 Phase 01 验证结果

| Gate          | 结果 | 关键证据                                                                                                 |
| ------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| G1 构建       | pass | Node 22.16.0 / 24.22.2 下 build、typecheck、lint、format:check 退出 0；连续两次构建产物哈希一致          |
| G2 单仓库索引 | pass | F01 上 `init` + `build` 退出 0，生成独立 root 索引与 manifest                                            |
| G3 引用正确性 | pass | F01 20 个公共符号、F10 11 个公共符号与 tsserver Oracle 全量对照，0 漏报 / 0 误报                         |
| G4 输出一致   | pass | F01 `references add` 的 pretty / lines / json / markdown 条目数一致，均为 7；lines/json/markdown 无 ANSI |
| G5 非 TTY     | pass | 无输入管道下所有命令 5s 内退出；缺参数 64；`--yes` 路径成功                                              |
| G6 配置安全   | pass | F17 未授权 E18、越界读写/网络/子进程被拒；项目 scripts 未执行；恶意命令 E17                              |
| G7 双 Node    | pass | 22.16.0 / 24.22.2 的 build、typecheck、52 项测试、CLI 基础链路                                           |
| G8 自审       | pass | 实施报告、测试证据、已知问题、自审回执齐全；工作区无验证残留                                             |

完整报告见 [`docs/phase-01/03-implementation-report.md`](docs/phase-01/03-implementation-report.md)。

### 8.3 明确未完成

- **未进入 Phase 02**；Vue 语义与模板边、API Surface、依赖/调用图、impact、增量、MCP 8 工具、`print` 物料、`doctor --repair` 均未实现。
- `packages/mcp` / `packages/adapter-vue` 仍是占位入口；未生成 `nexus.baseline.json`。
- 多 root 的 `symbol` / `references` 查询返回 E24；`status --json-schema` 返回 E24；`--pager` 不启动外部分页器。
- 未执行发布验证（`npm pack` 12 项）与 changesets 发布流程；包仍为 `private: true`。
- SCIP 子进程峰值 RSS 未采集（`scipPeakRssMB: null` 并带原因）；G5 未使用真实 kill -9；G8 内存压力为模拟；G9 非 OS 级网络沙箱；G10 边为全局重算；百万行档按负责人批准未验证。
- Phase 01 的 `update` 明确未提供，不实现、不宣称增量能力。

---

## 9. 后续开发阶段

阶段划分与门禁以 [`docs/19-delivery-phases.md`](docs/19-delivery-phases.md) 为准：

| 阶段 | 名称                 | 进入条件                                     |
| ---- | -------------------- | -------------------------------------------- |
| 00   | 可行性验证与定位校验 | **已完成**（11/11，含 6 项 pass-with-limit） |
| 01   | 骨架与 TS 索引       | **已完成实现，G1–G8 pass，等待负责人评审**   |
| 02   | Vue 语义与引用查询   | Phase 01 通过；Vue 投影、语义合并、模板边    |
| 03   | API Surface 与基线   | Phase 02 通过                                |
| 04   | 关系图与架构分析     | Phase 03 通过                                |
| 05   | 影响分析与审计       | Phase 04 通过                                |
| 06   | 增量、性能与一致性   | Phase 05 通过                                |
| 07   | 复用性、MCP 与交付   | Phase 06 通过                                |

**Phase 00 的结论具有否决权**：任一 P0 项无法验证通过，必须停止并提交架构调整申请，不得"先做着看"。Phase 00 与 Phase 01 均已完成实现；**Phase 01 尚未通过负责人评审，本仓库不会自动进入 Phase 02**。

未来接入顺序（工具实现后，按 21.1）：安装 → 手动接入（MCP / AGENTS.md / Skill）→ `nex init` → `nex build` → `nex status`。工具只打印接入物料，不代写任何配置文件。

---

## 10. 能力边界与承诺口径

| 概念                 | 含义                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `certain`            | 在支持的语言、语法、配置与依赖范围内，可由 TS / Vue 语义判定的关系；覆盖完整且分析成功时承诺 0 漏报 |
| `heuristic`          | 由名称、结构、路径、相似度推断；必须标注，不承诺完整                                                |
| `dynamic-unresolved` | 动态 import、运行时拼接路径、反射、运行时注册等；明确不保证识别，输出 `!` + reason                  |
| `partial`            | 映射不完整或覆盖不完整；此时禁止使用"全集""已全部列出"                                              |
| 索引五态             | `fresh` / `dirty` / `indexing` / `stale` / `failed`；非 fresh 必须声明影响                          |

对外文案禁止出现："完整调用图"、"零漏检 / 100% 准确"（无限定）、"始终实时"、"符号 ID 永不变"、"节省 Token"、"自动修复索引"。

---

## 11. 安全与隐私边界

以下为**产品设计约束**（尚未实现，但实现时必须遵守）：

- 默认只读、默认离线；打开项目、扫描目录、建立索引、响应查询、启动 MCP 均不得执行被分析项目的代码。
- 配置文件默认是 `.nexus/nexus.config.json`（纯数据，Zod `strict()`）；`.ts` 配置是可执行代码，必须显式授权，且在独立子进程中加载、禁网、限时。
- 不隐式运行 `package.json` 的 `prepare` / `postinstall` / 构建脚本，不自动安装依赖，不执行任意 shell 命令。
- 不读取项目根之外的文件；默认排除 `.env*`、密钥、证书、依赖与构建产物。
- `verify` 的自定义命令只能来自显式授权白名单，逐条回显、超时、输出大小上限。
- `doctor --repair` 只修 Nexus 自身数据，不改源码与项目配置。

Phase 00 验证只在合成夹具中执行了受限配置与恶意用例；未执行任何真实业务项目代码，未修改用户全局配置。

---

## 12. 已知限制与待确认事项

规范 v1.24 已冻结。Phase 00 与 Phase 01 的完整限制分别见 [`docs/phase-00/02-validation-report.md`](docs/phase-00/02-validation-report.md) 与 [`docs/phase-01/03-implementation-report.md`](docs/phase-01/03-implementation-report.md)。

Phase 01 新增加的限制：

- 多 root 查询面不完整：`symbol` / `references` 仅支持单 root，多 root 返回 E24；`search --roots all` 可用。
- `status --json-schema`、`doctor --repair` / `--mcp` / `--dump-vue-map`、`print`、`mcp`、`update` 均返回 E24。
- SCIP 子进程峰值 RSS 不可观测，manifest 记录 `scipPeakRssMB: null` 与原因；不得把父进程 RSS 当作 SCIP 峰值。
- 真实增量、失效传播、五态状态机的 `dirty` / `indexing` 运行期转换未实现；Phase 01 只有全量 build 与提交/恢复基础。
- TS 配置只支持可擦除语法；enum / namespace 值可能加载失败。持久授权 `.nexus/trust.json` 只读取，Phase 01 未提供写入口（`--trust-config` 仅本次进程）。
- `--pager` 不启动外部分页器；`--budget-hint` 只记录，不做裁剪；默认不做分页（无静默截断）。
- 双 Node 验证按本机运行时归属执行：PowerShell / fnm 提供 Node 24.22.2，CMD / nvm-windows 提供 Node 22.16.0；不修改项目依赖或用户全局配置。

规范第 0.3 节事项的当前状态：

| 事项                            | Phase 00 后的状态                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| SCIP 与 TS/Vue 语义映射正确性   | 43/43 声明 exact；T01–T09 场景通过；仍限声明级与合成夹具，Vue golden 为人工期望集     |
| 三档内存预算（400/700/1500 MB） | 50k 中位 301.8 MB、300k 中位 652.0 MB 通过；**百万行档按 D4 未测**；G7 未含 SCIP 峰值 |
| 符号身份迁移算法                | 5.2.8 八场景原型 8/8；未接入生产索引                                                  |
| TS 配置授权流程 UX              | E18 / 授权执行原型通过；非 TTY 与交互体验未验证                                       |
| 百万行档性能                    | 按负责人批准不验证，由后续真实项目实测替代                                            |

Phase 00 新增的限制（必须在 Phase 01 前评审）：

- SCIP 固定 0.4.0；升级到 0.6.x 会引入 TS 6 / Node ≥22.23.4 冲突，需单独决策。
- G5 使用 `process.exit(137)` 模拟崩溃，未用真实 kill -9。
- G8 内存压力为确定性模拟，未接真实 RSS。
- G9 不是 OS 级网络沙箱。
- G10 的引用/依赖/调用边为全局重算，未实现 12.1 的失效传播。

待确认：

- Phase 01 是否通过负责人评审并进入 Phase 02（**当前不进入**）。
- 4 个 workspace 包仍为 `private: true`；Phase 07 发布前需按 changesets 流程调整。
- Phase 01 的 `npm ci` 基线检查当时未执行；npm 10.9.2 现已在 CMD 恢复可用（`npm ci --dry-run` 退出 0），完整 `npm ci` 重装尚未重跑，历史记录见 Phase 01 报告 §11。

如发现文档冲突、关键配置缺失或规范无法落实，应按 [`docs/20-prohibitions.md`](docs/20-prohibitions.md) 的 20.6 提交《架构问题报告》，**不得自行作出架构级决策**。

---

## 13. 文档与变更纪律

- `docs/` 是技术规范的唯一权威来源；本 README 与 `.dsh/AGENTS.md` 均不得与其冲突。
- 原始任务书不存放在本仓库；`docs/` 由 v1.24 拆分而来，正文未改写。
- 修改架构、数据模型、公开接口或验收口径，必须经项目负责人确认并形成版本记录；实现者不得就地改写规范。
- 跨章节概念变更必须同步 [`docs/23-conflicts.md`](docs/23-conflicts.md) 或对应章节。
- 阶段报告必须注明所依据的规范版本（v1.24），并按 `docs/19-delivery-phases.md` 19.3 的清单交付。
- 本项目使用 [Apache License 2.0](LICENSE)，版权人为 `anemiamiyo <anemia114514@gmail.com>`（见 [NOTICE](NOTICE)）。
