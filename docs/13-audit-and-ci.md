<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 13 章 Preflight、Postflight 与 CI 门禁；原文照录，未修改技术内容。 -->

# 13. Preflight、Postflight 与 CI 门禁

本章能力**只存在于 CLI 与 CI**，不作为 MCP 工具暴露：它们包含 git diff、静态检查、报告生成等有副作用且非幂等的动作。

"只读"的定义是"不修改被分析项目"；索引自维护（refresh / watch）是唯一例外，且仅写 `.nexus/`。

## 13.1 Preflight 必须做到

1. 识别任务涉及的现有 API。
2. 检查是否已经有类似功能（调用第 9 章，含 9.2 的符号名抽取与失败提示）。
3. 提供相关源代码位置。
4. 分析依赖关系。
5. 检查架构边界。
6. 评估潜在修改影响。
7. 推荐需要阅读的文档和测试。
8. 生成任务上下文（走 `nex context` 同一实现，不另写一套）。

## 13.2 Postflight 必须做到

1. 获取 Git Diff。
2. 分析修改文件。
3. 尽可能识别修改的符号（识别不出时必须标 `unidentified`，不得跳过）。
4. 检查新增和删除的 API，并输出 Surface 差分（含 `evidenceSource` 与 `exportKind`）。
5. 检查依赖变化。
6. 检查架构规则。
7. 检查相关测试是否覆盖受影响符号。
8. 运行可配置的类型与静态检查（**命令白名单，需用户事先授权**，见 18.4；未授权时跳过并标注 `skipped-unauthorized`，不报 E12 阻断）。
9. 生成变更报告。
10. 样式文件被删除、移动或重命名时，若仍存在静态消费方，输出 warning 并默认退出 2（不默认阻断，可用 `--fail-on` 提升为阻断）；无静态消费方时不报警。
11. **（v1.24 新增）** 输出 `confidence` 字段；当存在 `relationClass = heuristic` 的受影响项时，`confidence` 上限为 `medium`，且**禁止**自动触发 `--fail-on` 阻断（避免误杀正常变更）。

## 13.3 报告与门禁（默认输出到终端，不落盘）

报告默认只写 stdout，**不得自动创建任何文件或目录**。工具不负责留档：需要留档时由用户显式指定 `--output-file`，或由 CI 重定向。禁止在项目内生成 report、logs、debug 等目录。

```bash
nex postflight --base origin/main --format json --fail-on breaking   # CI 直接管道消费
nex postflight --base origin/main --format markdown                  # 人读，输出到终端
nex postflight --base HEAD~1 --output-file /tmp/nex-postflight.json  # 只有显式指定才落盘
```

硬性断言：执行 `nex postflight` 后，工作区不得新增任何未跟踪文件（CI 用 `git status --porcelain` 校验）。唯一允许写入的目录是 `.nexus/`，且只由 build 与 update 产生。

报告结构（json 与 markdown 同源，字段一致）：

```text
{
  "base": "<ref>",
  "buildFingerprint": "bf_xxx",
  "staleness": "fresh",
  "mode": "normal",
  "confidence": "high|medium|low",
  "findings": [ { "id", "severity", "code", "file", "line", "symbolId", "evidence", "suggestion" } ],
  "surfaceDiff": { "breaking": [], "additive": [], "internal": [], "ambiguous": [] },
  "coverage": { ... },
  "blindSpots": [ ... ],
  "verification": { "commands": [], "skipped": [] }
}
```

## 13.4 特别规定

- 不允许自动覆盖用户已有修改。
- 不允许自动执行 `git reset`、`clean`、强制 `checkout` 等破坏性命令。
- 不允许自动修改业务代码来消除审计错误。
- 不允许未经授权自动安装或升级依赖。
- 不允许把索引推断出的关系当作确定事实。
- 工作区原本存在的错误必须与本次修改引入的问题区分，报告中分列（`pre-existing` / `introduced`）。
- 审计失败必须提供明确证据（文件、行号、规则、判定依据）。
- **（v1.24 新增）** `verify` 执行的每条命令必须逐条回显（命令、工作目录、超时、预期用途），并在报告里记录退出码与输出摘要；超时或输出超限按 18.4 处理。

---

