# Node.js 内置 API 最低版本登记

> 本文件由 2.2「运行环境：五个概念必须分开」第 3 条与 3.1 选型结论要求建立。
> 职责仅限：登记项目使用的 Node 内置 API 及其最低版本。**不承载架构决策**。

## 1. 硬性口径

- 项目最低支持运行环境为 **Node.js 22.16.0**（`engines.node >= 22.16.0`，启动时校验，不满足即 E14 退出）。
- 构建产物 `target: node20` 只表示语法可被 Node 20 解析，**不是运行期 API 兼容性证明**。
- 新增任何 Node 内置 API，必须在本文件登记最低版本，并在同一次提交中确认与最低运行环境相容。
- CI 使用 `eslint-plugin-n` 的 `n/no-unsupported-features/node-builtins` 规则，以 `22.16.0` 为基准拦截越界 API（配置见根目录 `eslint.config.js`）。`node:sqlite` 在 22.16.0 仍被标记 experimental，规则中显式 `ignores: ['sqlite']`；这是规范强制的唯一驱动，不构成回退路径。

## 2. 登记表

| API | 项目用途 | 最低版本 | 状态 | 依据 |
|---|---|---|---|---|
| `node:sqlite`（`DatabaseSync` / `StatementSync` / `timeout`） | 唯一权威存储驱动；禁止第三方 SQLite 驱动 | **22.16.0** | **已验证：Phase 00 G6 + Phase 01 产品链路（22.16.0 / 24.22.2）** | 2.2、5.6；22.13 起免 `--experimental-sqlite`，22.16 起提供 `busy-timeout` |
| `util.styleText` | pretty 输出层的终端装饰，零依赖 | 22.16.0（由最低运行环境保证） | **已验证：Phase 00 G6；Phase 01 CLI 使用** | 3.1 第 8 条、15.7 |
| `fs.watch`（递归监听） | MCP watch 模式的文件变化信号 | 22.16.0（由最低运行环境保证） | **已验证：Phase 00 G6（Windows 递归监听）** | 14.1.2、12.4.3 |
| `AbortSignal.timeout` | 命令/任务超时与取消传播 | 22.16.0（由最低运行环境保证） | **已验证：Phase 00 G6** | 18.4、5.10.3 |
| `process.versions.node` | 启动时版本校验（E14）与构建指纹 | 随 Node 提供 | **已验证：Phase 00 G6；Phase 01 E14 检查** | 2.2 第 2 条、5.11 |
| `node:module` `registerHooks()` | TS 配置加载子进程的同步模块钩子，阻断网络/子进程模块 | **22.15.0** | **已验证：Phase 01（22.16.0 / 24.22.2）** | 18.3.2 |
| Node Permission Model：`--permission`、`--allow-fs-read` | TS 配置子进程的文件系统与子进程边界 | **22.16.0** | **已验证：Phase 01 F17 用例** | 18.3.2；非 OS 级网络沙箱，残余风险见 Phase 01 报告 |
| `--experimental-strip-types` | 在独立子进程中加载 `nexus.config.ts` | **22.16.0** | **已验证：Phase 01（22.16.0 / 24.22.2）** | 18.3.2 |
| `node:readline` `createInterface()` | TTY 下的 init / verify 交互确认（稳定 API，无实验标记） | 随 Node 提供 | **已验证：Phase 01 init；Phase 05 verify** | 11.6、18.4 |
| `node:fs` `cpSync` | **仅测试夹具**复制；不进入产品运行路径 | 16.7.0（测试环境） | 已验证：Phase 01 测试 | 17.1 |
| `node:child_process` `execFile`（`shell: false`） | `verify` 白名单命令执行；超时与 1 MB 输出上限 | 随 Node 提供 | **已验证：Phase 05 单测与 CLI** | 18.4 |
| `node:child_process` `execFileSync` | 读取 git ref 形式的 API 基线（`git show <ref>:<path>`）与 Phase 05 postflight Git 读取 | 随 Node 提供 | **已验证：Phase 03/05 单测与 act** | 6.3、11.3、13.2 |

## 3. 维护规则

1. 表中「已验证」条目由 Phase 00 G6 双 Node 探针与 Phase 01 双 Node 测试共同确认；后续新增 API 仍必须先登记再使用。
2. 未登记的内置 API 不得进入实现；确需使用时先补登记再提交。
3. 本文件不复制架构说明；涉及「为什么这样选」的内容引用 `02-technical-baseline.md` 与 `03-tech-stack-and-build.md`。
4. `--experimental-strip-types` 只支持可擦除语法；含 enum / namespace 值的 `.ts` 配置可能加载失败，这是已知限制（见 Phase 01 报告）。
