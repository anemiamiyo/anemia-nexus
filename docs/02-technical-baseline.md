<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 2 章 产品技术基线；原文照录，未修改技术内容。 -->

# 2. 产品技术基线

| 项目属性 | 决策 |
|---|---|
| 产品类型 | 通用项目智能工具（以变更审计与 API 治理为核心） |
| 运行环境 | Node.js ≥ 22.16.0（强制，见 2.2） |
| 开发语言 | TypeScript 5.x（与 @vue/language-core 兼容族锁定） |
| 主要目标 | TypeScript 前端项目（含 Vue 3 SFC） |
| 核心接口 | CLI（人用与 CI 用） |
| 扩展接口 | MCP（查询只读 + 索引自维护） |
| 索引存储 | SQLite 为权威存储（内置 node:sqlite），仅保留可读可 diff 的 JSON 产物 |
| 语义事实源 | SCIP 索引为主，TS Compiler API 校验，ts-morph 仅做局部语法；三者映射关系见 4.3 |
| 配置格式 | `.nexus/nexus.config.json`（默认，数据）；`.nexus/nexus.config.ts`（需显式授权，可执行代码） |
| 运行模式 | 全量 + 增量（状态机见 12.4） |
| 输出契约 | 分层输出 + 完整性字段 + 禁止静默截断 |
| 基线管理 | `nexus.baseline.json` 纳入 git，供 api-diff 与 CI 门禁使用 |
| AI 兼容 | 不绑定特定 Agent |
| 核心原则 | 优先复用成熟 npm 工具；不确定即降级并标注 |

## 2.1 命名与命令

产品系列统一使用 `anemia-` 前缀。对外名称定为 **Anemia Nexus**，取义"把代码库汇成一张可查询的关系枢纽"：符号是节点，引用是连线，公共 API 是边界，变更影响是传播路径。命令取 `nex`（nexus 的缩写），索引目录、配置文件与基线文件统一使用全称 nexus，形成"命令用短名、产物用全名"的分层。

| 对象 | 命名 | 说明 |
|---|---|---|
| 主包（聚合） | `anemia-nexus` | 对外发布入口包，暴露 CLI 与库 API |
| 子包 | `anemia-core` / `anemia-cli` / `anemia-mcp` / `anemia-adapter-vue` | 按职责拆分发布 |
| 主命令 | `nex` | nexus 缩写；与包名解耦 |
| 备用命令 | `anex` | 全局环境已存在 nex 时使用，行为与 nex 完全一致 |
| 全名别名 | `anemia` | 供脚本或习惯性输入使用 |
| 索引目录 | `.nexus/` | 与 `.git` 同级惯例一致；默认加入 `.gitignore`，可随时删除重建 |
| 配置文件（默认） | `.nexus/nexus.config.json` | 数据配置，Zod 严格校验，未知字段拒绝 |
| 配置文件（可选） | `.nexus/nexus.config.ts` | **可执行代码**，仅在显式授权后加载（18.3） |
| 基线文件 | `nexus.baseline.json` | 纳入 git，供 code review 与 CI 比对 |
| MCP 服务名 | `anemia-nexus` | 由 `nex mcp-config` 打印片段；工具集 8 个，仅 refresh 可写索引 |

命令名冲突已实测：npm 上存在名为 `nex` 的包（v2.0.22，其 bin 亦为 nex），同一全局环境同时安装两者时可能发生 bin 冲突。处理方式：(1) 以 devDependency 使用，走 npx 或 `node_modules/.bin`，不冲突；(2) 需要全局安装时优先使用备用命令 `anex`，或安装后用 `nex --version` 确认指向本工具；(3) 发布说明必须写明该风险与替代命令，不得假设用户环境干净。

命名纪律：文档、错误信息、日志与对外文案中不得再出现旧命令名，示例统一写作 `nex <command>`。索引目录与配置文件改名属于破坏性变更，升级时必须提供一次性迁移或明确的重建提示。

## 2.2 运行环境：五个概念必须分开（v1.24 修订，P1-02）

v1.23 同时出现"engines ≥ 22.16"与"tsup target node20"，读者容易误读为"支持 Node 20"。v1.24 明确拆成五个独立概念，任何文档与报错不得混用：

| 概念 | 取值 | 由什么决定 | 谁来验证 |
|---|---|---|---|
| 开发运行环境 | Node 24 LTS（当前主力） | 团队开发机 | 开发者本机 `node -v` |
| 最低支持运行环境 | **Node 22.16.0** | `node:sqlite` 的 API 可用性（22.13 起免 `--experimental-sqlite`，22.16 起提供 `busy-timeout`） | `engines.node` + 启动时校验，不满足即 E14 |
| CI 验证环境 | Node 22.16.0（下限矩阵）与 Node 24（当前矩阵）双跑 | 发布门禁 | CI 矩阵任务 |
| 构建语法转换目标 | `target: node20`（tsup） | 仅决定语法降级与打包产物形态 | `tsup.config.ts` |
| 实际运行时 API 依赖 | `node:sqlite`、`util.styleText`、`fs.watch` 递归、`AbortSignal.timeout` 等 | 逐项标注最低 Node 版本 | 启动时 API 探针 + 类型定义 |

三条硬规则：

1. **构建 target 不是兼容性证明。** `target: node20` 只表示产出语法可被 Node 20 解析，不代表运行期 API 在 Node 20 存在。对外只承诺"最低支持 Node 22.16.0"，不承诺 Node 20 可运行。
2. **启动即校验，不允许中途失败。** CLI、MCP 启动的第一件事是读取 `process.versions.node` 并比对 `engines.node`，不满足直接 E14 退出，退出码 1，附当前版本、所需版本与升级方式（nvm / 官方安装包）。
3. **API 清单随代码维护。** 新增任何 Node 内置 API 必须同步在 `docs/runtime-api.md` 登记最低版本；CI 用 `eslint-plugin-n` 的 `n/no-unsupported-features/node-builtins` 规则，以 22.16 为基准拦截越界 API。

