<!-- 来源：《Anemia Nexus》技术设计与开发任务书 v1.24 · 第 17 章 测试与验收；原文照录，未修改技术内容。 -->

# 17. 测试与验收

必须用合成夹具覆盖以下项目类型（每类一个小项目，见 17.1）：

- 纯 TypeScript 项目。
- Vue 3 + TypeScript 项目。
- React + TSX 项目。
- JavaScript 混合 TypeScript 项目。
- Monorepo。
- 路径别名项目。
- 规模场景：由生成器按需生成（F11），不提交大项目快照。
- 包含动态导入和运行时注册的项目。
- **符号重命名 / 移动 / 同名冲突的项目**（F15）。
- **可注入崩溃的存储场景**（F16）。
- **恶意配置与脚本场景**（F17）。

## 17.1 测试语料：小型合成夹具为主，真实项目仅本地可选

三条硬约束：

1. 单个夹具不超过 2000 行、20 个文件；`F01–F18` 合计不超过 12000 行（含新增三个夹具后的重算配额）。`fixtures/semantic-map`（4.3.4）单独计 ≤ 1500 行。
2. 禁止提交 `node_modules`、构建产物、第三方项目快照；CI 不得下载外部仓库。
3. 规模与性能测试用生成器现场造数据（默认 1k、5k、10k 行三档，需显式指定才跑更大），生成物不进仓库。

### 17.1.1 合成夹具清单

| 编号 | 主题 | 覆盖点 | 规模 |
|---|---|---|---|
| F01 | reexport-chain | 多层 barrel、别名重导出、`export *` 冲突、默认导出与具名导出混合 | 10 文件 / 300 行 |
| F02 | decl-merge | declaration merging、global augmentation、namespace、模块增强 | 6 / 200 |
| F03 | advanced-types | 函数重载、泛型、条件类型、映射类型、type-only import、循环类型引用 | 8 / 250 |
| F04 | monorepo-ref | project references、composite、路径别名、tsconfig extends | 2 包 / 12 文件 / 400 |
| F05 | vue-sfc | defineProps 复杂类型、defineEmits、slot 类型、自动导入、四类模板引用边（golden 基线） | 12 / 350 |
| F06 | dynamic | 动态 import、约定式路由、provide/inject、动态属性访问 | 8 / 300 |
| F07 | api-surface | 导出判定、deprecated 与继任者、重载签名、opaque 类型、子路径与条件导出 | 8 / 250 |
| F08 | refactor | 改名、删除、移动，以及增量结果与全量结果的对照 | 10 / 400 |
| F09 | duplicate | 重复实现识别、相似度阈值边界 | 8 / 250 |
| F10 | negative | 漏报负样本：引用全集与 tsserver 逐条对照 | 6 / 150 |
| F11 | generated | 性能与内存：由脚本生成 N 文件 × M 符号，运行时不提交 | 1k–10k 行 |
| F12 | dirty | 脏工作区、未提交改动、staleness 门禁与拒绝场景 | 5 / 120 |
| F13 | style-deps | CSS @import、SCSS @use/@forward、Less @import、Vue style src、TS import 样式、动态路径 unresolved、别名 heuristic、ignore 边界 | 10 / 200 |
| F14 | multi-root | 两个 root 各一套索引；已声明依赖的 cross-package 边成立；未声明依赖、exports 不匹配、别名越界三类均记 unresolved(package-boundary)；根集合歧义触发 E15 | 2 roots / 10 / 250 |
| **F15** | **identity** | 文件重命名、跨目录移动、同名文件互换、同名符号新增、删除后重建、内容大幅修改、多候选、跨 root 移动（5.2.8 八场景） | 10 / 400 |
| **F16** | **crash-recovery** | 在 12.3.3 七个注入点断电（子进程被 kill -9），验证恢复后状态与数据 | 6 / 200 |
| **F17** | **config-security** | 恶意 TS 配置（读文件 / 发请求 / 写文件 / 执行 shell）、package.json 自动脚本、恶意自定义命令、未授权 TS 配置 | 6 / 200 |
| **F18** | **scheduler** | 三 root 并行 + 人为压低内存预算，验证降级阶梯、取消传播、失败隔离、旧索引保留 | 3 roots / 12 / 350 |

每个夹具必须自带 `tsconfig.json`、`expected/` 目录下的 golden 输出，以及一段说明"这个夹具在测什么、看哪几个断言"。golden 由 tsserver / vue-tsc 或人工核对生成，**不得由本工具自证**。

### 17.1.2 真实项目的接入方式（不入库）

需要看真实项目表现时，由用户把项目复制到 `fixtures/local/`。该目录已写入 `.gitignore`，发布包与 CI 均不包含，也不会被自动扫描。

```text
fixtures/local/            # 已加入 .gitignore，用户自行拷入
  my-project/             # 任意真实项目，可随时删除
```

只有显式指定才会读取：`nex test --fixtures local --project my-project`。目录为空时跳过并提示，不计为失败。真实项目的定位只有两个：观察规模化行为与主观体验；所有正确性断言仍以合成夹具和 tsserver 对照为准。

### 17.1.3 测试成本预算

单次 CI 全量测试：不超过 8 分钟（新增 F15–F18 后上调）、测试产物不超过 60 MB、不产生任何网络下载。夹具总行数超过 12000 行时，必须先合并或删除旧夹具再新增。任何"为了测一个边角场景就新建大项目"的做法一律驳回。

## 17.2 重点验证项

1. 符号是否准确。
2. 类型签名是否准确。
3. 导出链是否准确。
4. 引用关系是否正确。
5. 依赖方向是否正确。
6. 变更影响是否存在漏报（以 tsserver 为基准，按 `certain` 统计）。
7. 动态关系是否正确标记为不确定（三分类齐备）。
8. 增量索引是否与全量索引结果一致（12.2 全字段比对）。
9. **删除和重命名是否正确处理，身份是否按 5.2 判定（含置信度与歧义保留）**。
10. 索引版本升级是否安全。
11. 同一构建指纹下输出是否逐字节可复现。
12. Surface 判定与 api-diff 分级是否准确，`evidenceSource` 是否正确。
13. 多 root 查询路由是否准确：cwd 在 root 内只取本 root；cwd 在仓库根且未给 scope 时必须报 E16；`--roots all` 结果按 root 分组、无跨 root 排序与去重、同名符号 `globalAmbiguous` 标记正确。
14. 多 root 构建隔离是否成立：故意让一个 root 构建失败，其余 root 仍成功且各自索引可用；失败 root 被标 `stale`，工作区不声称整体完整；不存在跨 root 合并索引。
15. 根集合变更是否只影响该影响的 root：新增一个 package 只新增其索引，移除一个只删其目录，其余 root 的 `index.db` 修改时间与内容不变。
16. 配置优先级：`roots.<rootId>` > `defaults` > 内置基线；任何一层都不能删除内置基线条目（删了应被忽略并给出 warning）。
17. 配置位置与格式：只接受 `.nexus/nexus.config.json` 或（已授权的）`.nexus/nexus.config.ts`；两者并存报 E17 并拒绝启动；仓库根存在配置文件同样报 E17。
18. **配置安全**：未授权时 `.ts` 配置不被加载（E18）；恶意配置不产生文件写入、不发网络请求、不执行 shell（F17）。
19. **崩溃恢复**：12.3.3 七个注入点后重启，状态与数据符合表定义，旧索引可用（F16）。
20. **资源调度**：预算压到下限时按 5.10.4 顺序降级，不破坏已有索引，取消后无部分提交（F18）。
21. **映射正确性**：4.3.4 的 T01–T10 全部通过，`falseMatchCount = 0`。
22. **状态机**：12.4.2 的转换集之外无转换；watch 漏事件能被周期核对补回（F12）。

测试不能只验证工具自身能运行，还要验证索引结果是否正确；准确率测试必须与 tsserver 对照，不能自证。所有断言都必须在对应夹具中有落点；新增一个坑，先写夹具、再改实现。

### 17.2.1 格式通道断言（可自动执行）

| # | 断言 |
|---|---|
| 1 | MCP：format 缺省 / `"pretty"` / `"markdown"` / `"xml"` / 空串 → 均返回 lines；非法值令 `formatFallback=true`，无 `\x1b`，不 isError |
| 2 | MCP：`tools/list` 中 format 的 enum 与 description 均不含 pretty / markdown |
| 3 | CLI：伪 TTY（node-pty）默认 pretty；管道默认 lines；两者剥 ANSI 后条目集合相等 |
| 4 | CLI：非 TTY 下显式 `--format pretty` 结构保留、无 ANSI、可读 |
| 5 | CLI：非法 `--format` 退出码 64 并列出合法值 |
| 6 | `NO_COLOR=1` 下 `COLUMNS=80` 与 `COLUMNS=120` 各一份 golden，覆盖 F01 / F05 / F13 |
| 7 | `nex postflight --format pretty` 执行后 `git status --porcelain` 仍为空 |
| 8 | `--pager off` 与 `--pager auto` 在非 TTY 下逐字节一致 |
| 9 | **（新增）** 四格式（pretty / lines / json / markdown）的 `counts`、`coverage`、`truncated`、`nextCursor`、`staleness` 字段值完全一致 |
| 10 | **（新增）** `counts.partial > 0` 时，任何格式下都不出现"全部列出"字样（文案断言） |

断言 1、2、8、9 属必过项，失败即阻断合并。

### 17.2.2 数据与安全断言（v1.24 新增）

| # | 断言 |
|---|---|
| 11 | 全量 vs 增量：12.2 的十项比较全部相等，`buildFingerprint` 相同 |
| 12 | 身份迁移：F15 八场景均输出 `confidence` + `evidence`；`low` 场景不继承旧 ID |
| 13 | 身份不复用：`retired` 的 `symbolId` 不出现在任何新符号上 |
| 14 | 崩溃恢复：F16 七个注入点后 `status` 与数据符合 12.3.3 表 |
| 15 | 配置安全：F17 中四种恶意配置均不产生副作用；未授权 `.ts` 配置触发 E18 |
| 16 | 项目脚本不执行：含 `postinstall` / `prepare` 的夹具在 build 后 `node_modules` 未变化、无新文件 |
| 17 | 网络零请求：全流程在离线环境中通过（CI 用 `--offline` 或防火墙断言） |
| 18 | 降级可见：任何 `degraded` 非空的构建，其后所有查询输出都带 `degraded` 字段 |
| 19 | 错误码稳定：同一失败场景在 CLI 与 MCP 下 `code` 一致 |
| 20 | 非 TTY 不阻塞：所有交互命令在无输入管道下 5s 内退出（64 或成功），无 hang |---

