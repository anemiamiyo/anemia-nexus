<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 3 章 技术选型与依赖策略；原文照录，未修改技术内容。 -->

## 3. 技术选型与依赖策略

| 技术 | 用途 | 决策 |
|---|---|---|
| TypeScript Compiler API | TS 类型及符号分析 | 核心底层 |
| ts-morph | 局部 AST 操作与语法补全 | 按需使用，禁止全项目常驻 |
| @vue/language-core / vue-tsc | SFC 虚拟 TS 生成与类型化语义 | Vue 语义的唯一实现路径 |
| @vue/compiler-sfc | SFC 语法层解析 | 仅语法层使用 |
| scip-typescript + @sourcegraph/scip | 跨文件代码导航索引与符号身份 | 优先集成，语义事实源 |
| dependency-cruiser | 文件与模块依赖、架构规则 | 直接复用 |
| Knip | 未使用代码、导出及依赖 | 直接复用 |
| API Extractor | 库项目公共 API 基线 | 仅库项目适用，不作为通用 diff 实现 |
| Zod | 数据 Schema 校验 + JSON Schema 派生 | 直接复用（配置与 MCP 入参同源） |
| Commander.js | CLI | 直接复用 |
| Vitest | 测试 | 直接复用 |
| proper-lockfile | 索引并发保护 | 直接复用，禁止自研锁 |
| postcss 系（postcss-scss / postcss-less / postcss-value-parser） | 样式文件级静态提取 | 只提取字符串字面量，不编译 |

## 3.1 选型结论前置（Phase 00 必须验证并给出结论）

1. **唯一事实源**：语义查询以 SCIP 索引为主；ts-morph 只做语法层补全与局部 AST 操作。两套引擎对同一文件的符号结论必须在 Phase 00 抽样比对，冲突率与冲突类型写入报告。
2. **ts-morph 不得全项目常驻**：它是全 AST 常驻内存，10 万行级项目将占用 GB 级内存。大项目必须走"预建索引 + 按需 addSourceFileAtPath"。
3. **Vue 语义依赖语言核心**：@vue/compiler-sfc 只能提供 AST，无法回答"模板中使用了哪个组件的哪个 prop"。必须用 @vue/language-core 生成虚拟 TS 再交给 TS Compiler。
4. **SCIP 链路需实测**：scip-typescript 要求项目可 typecheck 且 tsconfig 有效，产物为 index.scip（protobuf），解析依赖 @sourcegraph/scip；索引体积、生成耗时、monorepo 可用性须在 Phase 00 记录实测数据。
5. 不要同时引入多个实现相同功能的大型分析引擎；不得把 dependency-cruiser 与 Knip 的结果混入同一张图，必须按 `analysisEngine` 字段区分。
6. **MCP 用官方 SDK v2 拆分包**：服务端用 `@modelcontextprotocol/server`（stdio 传输），不用 v1 单体包、不手写 JSON-RPC；工具 schema 用 Standard Schema（Zod v4），输入输出同时声明；依赖锁定精确版本（见 14.1.3）。
7. **样式链只做语法层**：样式依赖用 postcss 系只提取静态字符串（HTML 若开启再加 parse5），不引入 sass / less 编译器，不执行编译，不解析变量拼接。
8. **装饰零依赖、格式双层闸**：终端装饰用 Node 22 内置 `util.styleText`；MCP 的格式约束由工具 schema + 服务端兜底两层实现，不因此引入新依赖。
9. **不假设多分析器共享语义对象（v1.24 新增）**：SCIP、TS Compiler API、Vue Language Core 各有自己的 Program、TS 版本、模块解析与虚拟文件投影。三者之间的符号映射必须显式设计、显式测试、显式记录失败，禁止在文档或代码注释中声称"它们共享同一套语义对象"。落地设计见 4.3。
10. **必须存在独立语义 Oracle（v1.24 新增）**：正确性判定不得使用工具自身输出自证。Oracle 由 tsserver（`findAllReferences` / `getDefinition`）与 `vue-tsc` 构成，与被测链路不共享实现代码。
11. **配置默认不执行（v1.24 新增）**：默认配置格式为 JSON 数据；TS 配置属于"可执行代码"，必须显式授权（18.3）。这条优先于任何"用户体验更顺手"的便利性考虑。
12. **发布验证必须独立于开发工作区（v1.24 新增）**：以 `npm pack` 产物 + 干净临时目录安装验证，不得用 monorepo 内 `npm run dev` 的结果作为包可用的证据（3.4）。

## 3.2 依赖准入原则

1. 优先采用成熟、维护活跃、具有明确许可证的 npm 包。
2. 优先使用项目已经安装的依赖。
3. 新增依赖必须说明：解决的问题、现有依赖为何不足、维护状态、许可证、运行时兼容性、安全风险、性能影响、是否增加维护成本。
4. 不允许仅为了少量功能引入庞大的依赖。
5. 不允许自行实现已经由成熟工具完整支持的功能。
6. 对无法复用的能力，先编写技术调研报告，再决定是否定制开发。
7. 版本必须锁定，不能依赖未经验证的浮动版本。
8. **新增依赖必须过"三重门槛"（v1.24 新增）**：license 允许商用、最近 12 个月有发布、无高危漏洞（`npm audit` 无 high/critical）。任一不满足必须写入风险说明并经评审。

## 3.3 构建与发布链路（npm workspaces + tsup）

包管理与构建明确不用 pnpm 与 Vite：仓库用 npm 内置 workspaces，构建用 tsup（esbuild），版本与发布用 changesets。理由是本项目产物是 Node 库与 CLI，不是前端应用——tsup 原生支持 shebang、多入口、dts 与 external；Vite 需要额外插件与逐入口构建，还会注入面向浏览器的环境替换。

| 环节 | 选型 | 说明 |
|---|---|---|
| 包管理 | npm workspaces | npm 自带，无需额外安装；根 package.json 声明 workspaces |
| 构建 | tsup（esbuild） | ESM 输出、target node20、dts 内置 |
| 版本与发布 | changesets | 与 npm 兼容，多包统一版本与 changelog |
| 测试 | Vitest | 只做测试运行器，不参与产物构建 |
| CI | GitHub Actions | npm ci → build → test → 发布冒烟（3.4） |

三条打包硬约束：

1. `node:` 内置模块必须 external：包括 `node:sqlite`，禁止被 tsup 解析或打包；不得引入任何第三方 SQLite 驱动（原生模块会破坏零编译安装）。`package.json` 的 `engines.node` 写 `>=22.16.0`。
2. 输出必须为 ESM 且 `target: node20`（语法目标，见 2.2），禁止使用浏览器 target。
3. MCP 包单独构建，不依赖 CLI 的 chunk 共享，保证被平台以子进程方式启动时自包含。

bin 映射：`nex`、`anex`、`anemia` 指向同一份构建产物，命令撞名时换名即可，不产生第二份代码。

备选方案：若团队已有 Vite 工具链偏好，可用 `vite build --lib` 搭配 vite-plugin-dts，但需额外处理 shebang（rollup banner）、逐入口构建与动态 import 内联，验收成本更高，不作为默认。

## 3.4 发布验证（v1.24 新增，P2-05）

**核心原则：开发工作区能跑，不等于 npm 包能用。** 发布判定只看独立安装验证结果。

发布前必须全部通过，任一项失败即阻断发布：

| 序号 | 检查项 | 判定方式 |
|---|---|---|
| 1 | 工作区构建成功 | `npm run build` 全包退出码 0，无 TS 报错 |
| 2 | 单元测试通过 | `npm test` 全绿，无 skip 掩盖 |
| 3 | 集成测试通过 | 夹具端到端（16 章）全绿 |
| 4 | 类型检查通过 | `tsc --noEmit` 全包退出码 0 |
| 5 | 公开 API 检查通过 | `nex api-diff --fail-on breaking` 对上一发布版无未批准 breaking |
| 6 | 包导出路径正确 | 每个子包的 `exports` 字段逐条 `import` 实测可解析 |
| 7 | package.json exports 正确 | ESM/CJS 条件、types 条件、通配子路径逐项验证 |
| 8 | npm 包文件清单正确 | `npm pack --dry-run` 清单不含 `.nexus/`、`fixtures/local`、测试临时目录、源码 map |
| 9 | README 与实际功能一致 | 抽检 README 中每条命令，实际可执行 |
| 10 | 最低支持 Node 版本验证 | Node 22.16.0 下完成安装、CLI 启动、索引、MCP 启动 |
| 11 | 安装后 CLI 可启动 | 干净临时目录 `npm i <tarball>` 后 `npx nex --version` 与 `npx anex --version` 均指向本包 |
| 12 | MCP 服务可启动 | 干净目录 `nex mcp` 握手成功，`tools/list` 返回 8 工具 |

发布冒烟的执行约束：

- 在系统临时目录创建空工程，安装 `npm pack` 产物，不复用仓库的 `node_modules`。
- 冒烟过程不得写入用户全局配置（不改 dsh / claude / cursor 的 MCP 配置）。
- 冒烟结束删除临时目录，仓库 `git status --porcelain` 必须为空。
- 输出一份《发布验证记录》，逐项记录命令、退出码、耗时与环境版本，归档到 `docs/release/<version>.md`。

**禁止**：以"本地 dev 模式可用""CI 单测通过""同事机器上试过"作为发布依据；在冒烟失败时通过调整检查清单来放行。---

