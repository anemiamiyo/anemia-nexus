# Phase 01 实施计划与验证门槛（A05）

> 记录日期：2026-11-12（Asia/Shanghai）
> 依据：`docs/19-delivery-phases.md` 阶段 01、`docs/phase-01/01-task-checklist.md`、`docs/phase-01/00-freeze-and-entry.md`
> 状态：**Phase 01 已获负责人授权并启动；本文件在编码前冻结验证门槛。**

## 1. 授权与入场裁定

### 1.1 A01 启动授权

项目负责人于 2026-11-12 明确宣布"开启 Phase 01 的开发流程，并全权负责"。授权范围严格限于 `docs/19-delivery-phases.md` 的阶段 01：CLI 骨架、项目扫描与 root 识别、配置加载（JSON + 授权 TS）、TS/TSX 符号与引用索引、`status` / `doctor`、退出码与错误码框架、F01 / F10 / F17 夹具验证。

不包含：Vue 语义、API Surface、关系图、影响分析、增量更新、MCP、发布验证。不得据本授权进入 Phase 02。

### 1.2 A02 Q-01 命令面裁定

**裁定：以 `docs/11-cli.md` 为准，命令面为 21 个主命令 + 4 个兼容别名。**

Phase 01 的实现边界：

| 状态 | 命令 | 说明 |
|---|---|---|
| implemented | `init` | 根探测、配置与目录骨架（确认后落盘） |
| implemented | `build` | 全量构建（按 root 分发） |
| implemented | `status` | 永不报错；uninitialized / ready + 五态 |
| implemented | `doctor` | 基础检查与 `--schema`；`--mcp` / `--dump-vue-map` / `--repair` 返回 E24 |
| implemented | `symbol` | 名称 / ID 查询、基础身份信息 |
| implemented | `references` | 引用全集、三分类计数、完整性字段 |
| implemented | `search` | 名称 / 类型 / 路径检索 |
| stub-E24 | 其余 14 个主命令 | 明确返回 E24「未提供」，退出码 1，不返回假数据 |
| alias | `query` → `search`、`mcp-config` / `agents` / `skill` → `print` | 别名不出现在主帮助列表 |

未实现命令必须可区分：帮助中标注 `[not implemented]`，执行时返回 E24，绝不返回空结果冒充成功。

### 1.3 A03 Q-02 能力声明口径

Phase 01 的 `status.capabilities` **只声明真实可用能力**：

```json
{
  "styleDependency": "none",
  "styleSelector": "none",
  "htmlFileRef": "experimental-off",
  "vue": "none",
  "incremental": false,
  "mcpFormats": [],
  "dynamicUnresolved": "marked"
}
```

与 `docs/14-agent-integration.md` 示例值 `styleDependency: "file-level"` 的差异以本节裁定为准；Phase 04 实现样式文件级依赖后再改回。`vue: "none"` 表示 Phase 01 不索引 Vue SFC，不得声称支持。

### 1.4 A04 基线

基线 commit：`dce0c43b8c796de8696cc848ace50ef6c7fe47ff`（`chore: 初始化仓库并添加 Phase 00 验证基准`），提交时 `git status --porcelain` 为空。Q-03 的提交/归档问题由该提交关闭：Phase 00 变更已入库，基线可追溯。

Phase 01 实施完成后形成一个本地提交（不 push），使 G8 的"工作区无验证残留"可判定。

## 2. 冻结门槛（编码前写定，不得事后降低）

### 2.1 G3 引用正确性 / Oracle 抽样范围

- 夹具：`fixtures/F01-reexport-chain` 与 `fixtures/F10-negative`。
- 抽样：F01 中所有 `export` 顶层符号的 `certain` 入边，全量对照，不做抽样省略；F10 全部声明全量对照。
- Oracle：独立脚本使用 TypeScript `LanguageService.findReferences` / `getDefinitionAtPosition`，只依赖 TypeScript 与夹具，不 import 任何 `packages/*` 代码。
- 允许差异：仅允许 Oracle 与 SCIP 在"声明合并 / 重载"位置口径上的差异；每条差异必须分类为 `implementation-defect` / `oracle-difference` / `scope-difference` 并给出证据。
- 门槛：`certain` 0 漏报、0 误报；无法达到即阻断 Phase 01，不得调低门槛。

### 2.2 G4 输出一致对照字段

`--format pretty|lines|json|markdown` 必须同源同字段。对照字段：

`counts.{total,returned,certain,heuristic,dynamicUnresolved,partial}`、`coverage.{filesCovered,filesSkipped,filesIgnored,filesFailed,resolved,unresolved,unmapped}`、`truncated`、`nextCursor`、`staleness`、`buildFingerprint`、`degraded`。

pretty 条目集合（按 `path:line:col` 与 `symbolId` 归一）必须等于 lines；`--format lines` / `json` / `markdown` 输出不得含 ANSI（`\x1b` 计数为 0）。pretty 在 `NO_COLOR=1`、固定 `COLUMNS` 下纳入 golden。

### 2.3 G5 非 TTY 判定

- 无输入管道（`stdin` 非 TTY）下所有命令 5 秒内退出；交互命令缺参数立即 64，不等待 stdin。
- 默认格式为 `lines`；显式 `--format pretty` 仍可用但不含 ANSI。
- `--yes` / `--write-config` 路径可成功；无 `--yes` 的破坏性操作返回 64。

### 2.4 G6 F17 安全用例清单

| # | 用例 | 期望 |
|---|---|---|
| 1 | 未授权 `.ts` 配置 | E18，不加载，打印授权命令 |
| 2 | 恶意 `.ts` 配置读项目外文件 | 未授权 E18；授权后越界读取被拒 |
| 3 | 恶意 `.ts` 配置发起网络请求 | 网络被禁用，主流程按配置错误或安全降级处理 |
| 4 | 恶意 `.ts` 配置写项目外文件 | 写入被拒 |
| 5 | 恶意 `.ts` 配置执行 shell | 子进程被拒 |
| 6 | `package.json` 含 `postinstall` / `prepare` | 全流程不执行，`node_modules` 不变 |
| 7 | 恶意自定义命令（`rm -rf`） | 白名单校验拒绝（E17） |
| 8 | 未授权 verify 命令 | 不执行；跳过并标注 `skipped-unauthorized` |

验收：`git status --porcelain` 无新增、无网络、无子进程残留。

### 2.5 G7 双 Node

- 下限：Node `22.16.0`；当前矩阵：Node `24.x`。
- 每版本执行 `npm run build`、`npm run typecheck`、`npm test`、`nex --version`、`nex init` / `nex build` / `nex status` / `nex references` 基础链路。
- 24.x 结果不得替代 22.16.0 下限结论；缺失版本必须如实记录为"未执行"。

### 2.6 其他冻结项

- K07：`certain` 0 漏报 / 0 误报；`mappingSuccessRate` 门槛 0.95（Phase 00 同口径）；`falseMatchCount = 0`。
- L 系列：Phase 01 只记录小夹具数据，不宣称 16.2 的 5 万 / 30 万 / 百万行目标。
- SCIP 固定 `@sourcegraph/scip-typescript@0.4.0`；分析器版本写入指纹。
- 阶段结束只提交报告与 gate 结论，等待负责人决定是否进入 Phase 02。

## 3. 执行结果（2026-11-12）

### 3.1 基线与授权

- 基线 commit：`dce0c43b8c796de8696cc848ace50ef6c7fe47ff`；开工时 `git status --porcelain` 为空。
- 授权：项目负责人 2026-11-12 宣布启动 Phase 01 并全权负责；Q-01 / Q-02 / Q-03 的裁定见第 1 节。
- 实施报告：`docs/phase-01/03-implementation-report.md`。

### 3.2 A06 基线检查

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm install`（npm 10.9.3 + Node 22.16.0） | 0 | Node 22.16.0 自带 npm 10.9.2 缺 `@npmcli/config`，按 Phase 00 记录使用同机 npm 10.9.3 CLI |
| `npm run build` | 0 | Node 22.16.0 与 24.22.2 均通过 |
| `npm run typecheck` | 0 | `tsconfig.typecheck.json` 覆盖 core + cli |
| `npm run lint` | 0 | 含 `n/no-unsupported-features/node-builtins` @ 22.16.0；`node:sqlite` 显式豁免 |
| `npm run format:check` | 0 | Prettier 3 |
| `npm test` | 0 | 52 项；Node 22.16.0 与 24.22.2 各跑一遍 |

**未执行**：`npm ci`。原因：本机 Node 22.16.0 的 npm 10.9.2 不可用；`npm ci` 需要清理并重新安装全部依赖，且会运行依赖生命周期脚本。已用 `npm install` 与 lockfile 校验替代；此偏差不影响 G1–G8，但必须如实记录。

**环境补充（2026-11-12）**：运行时归属已明确——PowerShell 用 fnm（Node 24.22.2 / npm 11.19.1），CMD 用 nvm-windows（Node 22.16.0 / npm 10.9.2）。npm 10.9.2 在 CMD 下已恢复正常：`npm -v`、`npm ls --depth=0`、`npm ci --dry-run` 均退出 0；完整 `npm ci` 重装仍未执行，避免破坏已验收的 `node_modules`。上表与上方"未执行"条目保留为 Phase 01 执行时的历史记录。

### 3.3 A07 依赖审计

- `npm audit` 对 npmmirror 返回 `NOT_IMPLEMENTED`，改用官方 registry 后完成。
- 结果：13 项漏洞（1 low / 12 moderate，无 high / critical），全部位于 ESLint / typescript-eslint 开发依赖链；运行依赖未发现 high / critical。
- 新增直接依赖：`commander@15.1.0`（CLI，锁精确版本）、`@sourcegraph/scip-typescript@0.4.0`（固定，Phase 00 D6）、`proper-lockfile@4.1.2`、`zod@4.6.7`、`typescript@5.9.3`（core 运行时）。均为 Phase 00 已安装或规范指定版本。

### 3.4 证据路径

- 测试：`packages/core/test/*.test.ts`、`packages/cli/test/cli.test.ts`。
- Oracle：`tools/oracle/tsserver-references.mjs`、`tools/oracle/compare-fixture.mjs`。
- 夹具：`fixtures/F01-reexport-chain`、`fixtures/F10-negative`、`fixtures/F17-config-security`、`fixtures/F04-multi-root`。
- 报告：`docs/phase-01/03-implementation-report.md`。
