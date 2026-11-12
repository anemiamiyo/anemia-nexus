# Phase 02 完整任务清单：Vue 语义与引用查询

> 生成日期：2026-11-12（Asia/Shanghai）
> 依据：`docs/19-delivery-phases.md` 阶段 02、`docs/04-architecture.md` 4.1/4.3、`docs/05-data-model.md`、`docs/07-code-search.md`、`docs/08-relations.md`、`docs/11-cli.md`、`docs/12-indexing.md`、`docs/15-output-contract.md`、`docs/16-nfr-and-errors.md`、`docs/17-testing.md`、`docs/20-prohibitions.md`
> 入场与裁定：`docs/phase-02/00-entry-and-decisions.md`
> 状态：**计划基线。实现按本清单逐项推进并回填证据；未完成项不得标记为完成。**

## 0. 使用规则

- `[ ]` 未开始；`[x]` 仅在实现、测试、自审并留下证据后勾选；`[BLOCKED]` 表示等待负责人裁定或上游依赖。
- 每项“证据”必须可复核：命令、退出码、测试名、代码位置或结果文件。
- 任务顺序是依赖顺序，不是可以跳过的理由；标注“阻断”的任务未关闭时，后续任务不得开工。
- 不得用固定数据、空实现、模拟映射或硬编码边冒充 Vue 语义；不得把 `unmapped` 当“没有数据”。
- 不得降低 `docs/phase-02/02-plan-and-gates.md` 的验收阈值；不达标按 20.6 报告，不得调口径。

## 1. 阶段目标与边界

### 1.1 目标（依据 19.1 阶段 02、4.1.7）

1. `.vue` 文件进入扫描与索引，按 root 独立建索引；
2. `@vue/language-core` 虚拟 TS 投影与影子物化；
3. 内存映射与入库前坐标转译；
4. `__VLS_` 内部符号过滤与计数；
5. Props / Emits / Slots 与 `propsCoverage`；
6. 四类模板引用边；
7. 4.3 的 Semantic Merger 与 `symbol_map`；
8. F05 / semantic-map Vue 的 V1–V4、V6 自动化断言；
9. `references` / `symbol` / `status` / `doctor` 的 Vue 可见性与诚实声明。

### 1.2 明确不做

| 能力 | 处理 |
|---|---|
| API Surface / baseline / api-diff | Phase 03；`surface` 仍为 `unknown` |
| 依赖图 / 调用图 / 架构规则 / 样式链 | Phase 04 |
| impact / preflight / postflight / verify | Phase 05 |
| 增量、失效传播、五态运行期转换、崩溃七注入点 | Phase 06；`update` 仍 E24 |
| MCP 8 工具、`print`、发布验证 | Phase 07 |
| 多 root 查询合并 | Phase 05（5.9） |
| `status --json-schema` | Phase 03/07；本阶段仍 E24 |
| SCIP 子进程峰值 RSS | Phase 06 |
| 完整 `npm ci` 重装 | 干净环境/发布验证 |
| `vue.typeResolver` 执行 | 仅告警，不执行 |
| 选择器级样式能力 | 永久不做（4.2） |

### 1.3 Phase 02 gate（编码前冻结，详见 `02-plan-and-gates.md`）

G1 构建、G2 投影、G3 坐标、G4 过滤、G5 模板边、G6 组件模型、G7 合并映射、G8 输出、G9 回归、G10 自审。

## 2. 入场与裁定（A）

- [ ] **A01 记录 Phase 01 关闭**：在 Phase 01 报告追加 §12，写明 pass-with-limits 被接受、四项补齐判断、Phase 02 授权。证据：报告 §12 与负责人原话摘录。
- [ ] **A02 冻结 Phase 02 口径**：确认 `docs/phase-02/00-entry-and-decisions.md`、本清单、`02-plan-and-gates.md` 为编码前基线。证据：三份文档存在且无 TODO 占位。
- [ ] **A03 记录基线 commit 与工作区**：`git status --porcelain` 为空；记录 commit。证据：命令输出。
- [ ] **A04 环境与 lockfile 基线**：`node -v`、`npm -v`、`npm ci --dry-run`、`npm ls --depth=0` 退出码。证据：命令与输出摘要。
- [ ] **A05 依赖准入**：`@vue/language-core`、`@vue/compiler-sfc`（及必要的 `@vue/compiler-dom`）按 3.2 三重门槛记录：用途、版本锁定、MIT 许可证、近 12 个月发布、audit 无 high/critical、运行时兼容性、性能影响。证据：`docs/phase-02/03-implementation-report.md` 依赖表 + `npm audit` 摘要。
- [ ] **A06 确认不引入禁用项**：无第三方 SQLite 驱动、无持久化 shadow/map.json、无 sass/less 编译器、无网络、无项目脚本执行。证据：依赖与代码审查。
- [ ] **A07 记录已知限制**：`00-entry-and-decisions.md` §8 的九项限制在实现中不得被悄悄消除或扩大。证据：报告 §已知问题。
- [ ] **A08 建立实施看板**：创建 Phase 02 报告骨架（未完成项不得预填通过）。证据：报告文件。

## 3. 依赖、构建与版本（B）

- [ ] **B01 core 依赖**：`packages/core/package.json` 增加 `@vue/language-core@3.3.14`、`@vue/compiler-sfc@3.5.45`（精确版本）。证据：package.json diff。
- [ ] **B02 根依赖归属**：确认这些包在根 `devDependencies` 与 core `dependencies` 的归属不产生双版本；`npm ls @vue/language-core @vue/compiler-sfc` 单实例。证据：命令输出。
- [ ] **B03 分析器版本元组**：`ANALYZER_VERSION` 写入 `vueLanguageCore`、`vueTsc`、`vueCompilerSfc`（版本从已安装 package.json 读取或常量锁定，二者一致）。证据：代码 + 单测。
- [ ] **B04 构建产物**：`npm run build` 全包退出 0；`node:sqlite` 仍 external；Vue 依赖不被错误打包进 CLI 入口导致 ESM 破损。证据：构建日志 + `dist` 检查。
- [ ] **B05 类型检查与 Lint**：`npm run typecheck`、`npm run lint`、`npm run format:check` 退出 0。证据：命令输出。
- [ ] **B06 双 Node**：Node 22.16.0 与 Node 24.x 各完成 build/typecheck/测试。证据：两套输出。
- [ ] **B07 构建可复现**：同一源码连续两次构建 dist 哈希一致。证据：哈希记录。

## 4. 扫描与投影（C）

- [ ] **C01 `.vue` 文件发现**：目录扫描与 tsconfig 文件列表两条路径都能发现 `.vue`；不受 `include` 限制漏掉 SFC；忽略规则、敏感文件、大小上限、symlink 规则与 TS 一致。证据：单测 + F05。
- [ ] **C02 文件语言标记**：`ScannedFile` 带 language（`ts`/`tsx`/`vue`），`files` 表写入正确；`.vue` 计入 `filesCovered`。证据：DB 查询。
- [ ] **C03 阶段进度**：`build` 进度事件含 Vue 投影阶段与计数（不写 stdout 结果）。证据：CLI stderr 输出。
- [ ] **C04 投影 API**：`@vue/language-core` 的 `createVueLanguagePlugin` 按 v1.24 4.1.6 锁定组合使用；不使用 `phase00/` 导入。证据：`rg` 检查 + 代码。
- [ ] **C05 单次投影**：同一 SFC 在一次构建中只投影一次；投影结果与映射段只驻留内存。证据：代码审查 + 单测计数。
- [ ] **C06 投影失败处理**：单个 SFC 投影失败（语法错误/语言核心异常）不崩溃整 root；计入 `filesFailed`/`degraded: vue-projection-failed`，并保留可诊断原因。证据：负向单测。
- [ ] **C07 空/仅模板 SFC**：无 `<script>`、`<script setup>`、`<script>`+`<script setup>` 两种脚本形态均可投影；无脚本时组件符号仍生成。证据：F05 夹具。
- [ ] **C08 外部语言块**：`<style>`、`<i18n>`、自定义块不进入影子 TS；`<style src>` 不产生样式边（Phase 04）。证据：夹具 + 断言。
- [ ] **C09 SFC 解析安全**：`@vue/compiler-sfc` 解析错误不执行任何代码、不读越界文件；仅读已扫描文件。证据：代码 + 安全用例。
- [ ] **C10 投影版本锁定**：`projectorVersion` 常量写入 meta 与 `vue_file_meta`；language-core 版本变化触发全局重建。证据：指纹与 manifest。
- [ ] **C11 大文件/跳过**：超过大小上限的 `.vue` 与 TS 同样跳过并计入 `filesSkippedBySize`，不静默丢弃。证据：单测。
- [ ] **C12 CRLF/LF**：CRLF 与 LF 同一内容视为同一 sourceHash；坐标按 LF 归一化口径处理。证据：单测。

## 5. 影子物化与 SCIP（D）

- [ ] **D01 影子目录**：`.nexus/tmp/vue/<token>/` 镜像 root 相对目录；写入 `<rel>.vue.ts` 与 `<rel>.d.vue.ts`。证据：代码 + 临时目录断言。
- [ ] **D02 shim 语义**：`export *` + `export { default }` 转发；`import X from './X.vue'` 在 `allowArbitraryExtensions` 下解析到 shim。证据：F05 构建中 SCIP 无解析错误。
- [ ] **D03 临时 tsconfig**：`files` 与 `rootDirs` 按 00 文档 §5.2 生成；不写项目根、不改真实 tsconfig。证据：文件内容断言。
- [ ] **D04 单次 SCIP**：有 `.vue` 时一次 SCIP 同时索引真实 TS 与影子；无 `.vue` 时保持 Phase 01 路径。证据：构建耗时事件 + 索引文档分类。
- [ ] **D05 document 分类**：以影子前缀区分 shadow document 与真实 TS；真实 document 路径与普通构建一致。证据：单测/构建日志。
- [ ] **D06 无影子残留**：构建成功、失败、异常退出后 `.nexus/tmp/` 为空；启动先清理残留。证据：F05 与负向测试。
- [ ] **D07 无持久化**：DB/manifest/输出不含影子文本、映射段、绝对路径或 token。证据：`rg` 扫描 + 单测。
- [ ] **D08 SCIP 失败**：影子工程 SCIP 失败返回 E11 或降级，不产出半套 Vue 符号；旧索引保留。证据：负向测试。
- [ ] **D09 超时/输出上限**：沿用 30min 超时与 1MB 输出上限；不新增无上限日志。证据：代码审查。
- [ ] **D10 路径大小写与分隔符**：document 路径统一 `/`；Windows 反斜杠归一化。证据：单测（`src\App.vue.ts`）。
- [ ] **D11 真实 tsconfig 语义继承**：target/module/moduleResolution/jsx/baseUrl/paths/types/typeRoots/lib 等被继承；不因影子 tsconfig 改变真实 TS 语义。证据：F01/F10 回归与 F05 typecheck。
- [ ] **D12 清理顺序**：SCIP 输出先写入影子目录，映射完成后再删除；异常路径 finally 清理。证据：代码审查。

## 6. 坐标、过滤与身份（E）

- [ ] **E01 UTF-8 → UTF-16**：SCIP 列（byte）转换为 UTF-16 偏移后再映射；含非 ASCII 的 SFC 断言坐标正确。证据：单测（中文/emoji）。
- [ ] **E02 映射段构建**：使用 `generatedOffsets`/`sourceOffsets`/`lengths`/`generatedLengths`；段按 generated 排序；重叠段有确定优先级。证据：单测。
- [ ] **E03 坐标回指**：声明位置必须映射回 `.vue`；不能回指的一律丢弃并计数。证据：单测 + `filteredInternal`。
- [ ] **E04 名称前缀过滤**：`__VLS_` 前缀 + generated-only 区间双判；不得只按名称过滤。证据：单测。
- [ ] **E05 幽灵引用零容忍**：DB 与四格式输出不得出现 `__VLS_`；出现即 E11。证据：F05 断言。
- [ ] **E06 引用边过滤**：target 为内部符号的边丢弃；用户→用户边保留。证据：F05。
- [ ] **E07 重复边去重**：同一源码位置 + 目标 + kind 只保留一条（Volar tracking 数组产生的重复）。证据：F05 边计数。
- [ ] **E08 坐标排序稳定**：references 按 path/line/col/target 排序；symbols 按 symbolId。证据：两次构建逐字节一致。
- [ ] **E09 符号身份**：Vue 符号沿用 5.2.2 的 `symbolId`（rootId+kind+nameChain+structuralFingerprint，不含路径）；组件成员用 `组件名.成员名`。证据：单测 + 报告。
- [ ] **E10 匿名/组件符号**：组件合成符号 `volatile` / `identityConfidence` 语义明确；碰撞按 5.2.2 处理后缀并计入 `hashCollisions`。证据：F05 组件名冲突用例（如需要）。
- [ ] **E11 历史身份**：Vue 符号参与 `symbol_id_history`；同构建重复构建 ID 稳定。证据：两次构建对比。
- [ ] **E12 坐标口径**：入库行 1 起、列 0 起，UTF-16；四格式输出一致。证据：单测 + F05 输出。

## 7. 组件模型（F）

- [ ] **F01 Props 抽取**：`defineProps<T>()`、`withDefaults(defineProps<T>(), ...)`、运行时 props 三种形态至少覆盖前两种；属性名、类型文本、required、默认值语义正确。证据：F05 + 单测。
- [ ] **F02 Props 类型解析**：在完整 Program 上下文中用 checker 解析；any / never / error 或 ambient 越界标 `heuristic` + reason；不把原始文本当已解析。证据：F05 复杂 props。
- [ ] **F03 propsCoverage**：`{ resolved, total, unresolved[] }` 分子分母可核对；写入 `components` 表与 manifest 汇总；`symbol` 输出可见。证据：F05 断言。
- [ ] **F04 Emits 抽取**：类型字面量 `{ select: [] }` 与调用签名 `(e:'x', p:...)` 两种形态；名称与 payload 类型文本。证据：F05。
- [ ] **F05 Slots 抽取**：`defineSlots` 的 slot 名与参数类型；v-if 分支/union slot 不猜测；never 标 `heuristic` + reason。证据：F05 + 单测。
- [ ] **F06 组件符号**：每 SFC 一个 `component` 符号；位置锚定 `<script`，无脚本时锚定文件起始；名称冲突按 5.2.2 处理。证据：F05。
- [ ] **F07 源文本类型**：Props/Emits/Slots 的类型文本从 `.vue` 源码切片，不输出 `__VLS_Props` 等内部名。证据：F05 输出。
- [ ] **F08 组件成员符号**：Props/Emits/Slots 成员作为组件成员符号参与引用目标解析；不进入 V2 用户符号集合。证据：F05 引用。
- [ ] **F09 组件查询**：`nex symbol <组件>` 输出 component 块（props/emits/slots/propsCoverage）；`--format lines/json` 字段一致。证据：CLI 集成测试。
- [ ] **F10 `vue.typeResolver`**：配置非空时构建告警 `vue-type-resolver-unsupported`，不执行命令、不阻断，除非另有授权（18.4）。证据：负向测试。
- [ ] **F11 组件与脚本关系**：组件符号的 sourceSymbolId 关系（模板边 source）指向组件符号；不伪造 script→component 边。证据：DB 查询。
- [ ] **F12 组件 sourceHash**：使用 `.vue` 文件 sourceHash；变化触发失效（Phase 06 增量使用）。证据：manifest/DB。
- [ ] **F13 组件名规范**：文件名去扩展名；不引入路径；大小写保留。证据：单测。
- [ ] **F14 组件重复构建**：同内容两次构建组件 ID/成员 ID/coverage 完全一致。证据：对比脚本。

## 8. 模板引用边（G）

- [ ] **G01 组件标签**：`<Child>` / `<child>` 解析到 script 符号时产出 `component-use`，位置为标签名起始；闭标签不重复产边。证据：F05。
- [ ] **G02 事件绑定**：`@click="save"`、`@select="onClick"` → `template-binding`，位置为表达式标识符。证据：F05。
- [ ] **G03 指令绑定**：`v-if="cond"`、`v-show`、`v-for` 表达式 → `template-binding`。证据：F05。
- [ ] **G04 属性绑定**：`:label="msg"`、`:value="x"` → `template-binding`；静态字符串不产边。证据：F05。
- [ ] **G05 插值**：`{{ count }}` → `interpolation`；slot 内容中的插值同样产出。证据：F05。
- [ ] **G06 动态参数**：`v-bind:[key]="value"` 静态键按 certain，动态键按 `dynamic-unresolved` + `dynamic-argument-key`；`v-slot:[name]` 同类处理。证据：F05。
- [ ] **G07 成员表达式**：`obj.save` 中 `save` 为 heuristic，`obj` 为 certain；不把成员误标 certain。证据：F05。
- [ ] **G08 四类齐备**：F05 对组件标签、事件/指令、插值、动态参数各至少 1 条；缺失即 gate 失败。证据：F05 断言。
- [ ] **G09 边 source**：模板边 source 为 `.vue` 精确位置；`sourceSymbolId` 为组件符号。证据：DB。
- [ ] **G10 边 target**：target 为 script 符号 symbolId；外部库符号不进入 target，计入外部计数。证据：DB。
- [ ] **G11 `--no-template`**：排除 `role=template:*` 的边，`notes` 声明“模板边未纳入”；不得静默省略。证据：CLI 测试。
- [ ] **G12 删除 handler 定位**：夹具断言：删掉 `@click` 的 handler 后，`references` 中该边定位到模板行（不要求实现 impact）。证据：F05 测试脚本模拟。
- [ ] **G13 引用三分类**：模板边 relationClass 只能是 certain / heuristic / dynamic-unresolved；不得出现空值或自造分类。证据：DB 约束检查。
- [ ] **G14 边去重与排序**：同位置同目标同 kind 去重；输出顺序稳定。证据：两次构建对比。

## 9. Semantic Merger 与 symbol_map（H）

- [ ] **H01 映射表结构**：`symbol_map` 每符号每引擎一行，engine 取值 `scip|ts|vue`；`match_quality` 取值 exact/structural/conflict/ambiguous/unmapped。证据：DDL + DB 查询。
- [ ] **H02 文件级对齐**：同一 rootId + 相对路径 + sourceHash；不一致不映射并登记原因。证据：单测。
- [ ] **H03 声明级对齐**：名称起始位置 + kind；多点命中进入结构级。证据：单测。
- [ ] **H04 结构级对齐**：名称链 + 参数个数 + 类型文本归一化哈希；仍多义保留 ambiguous。证据：单测。
- [ ] **H05 交叉校验**：SCIP descriptor 名称链与声明名称链不一致记 conflict；以 TS 为准并降一档置信度。证据：单测/F05。
- [ ] **H06 Vue 生成锚**：Vue 声明的生成位置锚仅内存；不写 DB；token 不出现。证据：DB 扫描。
- [ ] **H07 未映射登记**：无 SCIP 定义的 Vue 声明记 unmapped + reason（synthetic-component / no-definition / generated-only / ambiguous 等），逐条可查。证据：F05 + symbol_map 查询。
- [ ] **H08 falseMatchCount = 0**：两引擎指向不同声明却同一符号的数量为 0；测试断言。证据：统计 + 测试。
- [ ] **H09 mappingSuccessRate**：分子分母定义写入报告；合成组件与组件成员的处理明确。证据：manifest + 报告。
- [ ] **H10 冲突不补齐**：缺失一侧不构造另一侧符号；引用计数标 partial。证据：单测。
- [ ] **H11 重载序号**：Vue 宏/声明重载按 ordinal 区分；不合并。证据：单测（若夹具覆盖）。
- [ ] **H12 映射证据**：`evidence_json` 记录命中的 step 与比较字段；不记录绝对路径或 token。证据：DB 查询。
- [ ] **H13 analyzer_version**：每行记录对应引擎版本；五元组与指纹一致。证据：DB 查询。
- [ ] **H14 T09 场景**：semantic-map/vue 全部用户符号产出映射；模板四类边齐备；未映射登记完整。证据：集成测试。

## 10. 存储与 Schema（I）

- [ ] **I01 schemaVersion 2**：`schemaVersion` 与 DDL 同源；v1 库按重建处理；`doctor` 给重建命令。证据：DDL + doctor 测试。
- [ ] **I02 `vue_file_meta`**：列含 `file_id`（或 path+build）、`source_hash`、`projector_version`、`language_core_version`、`generated_at`、`generated_bytes`、`filtered_internal`、`template_edges`；不含影子文本/映射段。证据：DDL。
- [ ] **I03 `components`**：组件符号、props/emits/slots JSON、propsCoverage、analysis_engine、source；主键（build_id, symbol_id）。证据：DDL。
- [ ] **I04 索引**：`components` 与 `vue_file_meta` 的查询索引；5.6 必需索引仍全部存在。证据：`doctor`/DB。
- [ ] **I05 提交协议**：新表与新列在同一 `BEGIN IMMEDIATE` 内写入；闭合校验覆盖组件符号存在、引用目标存在或显式 null。证据：commit 代码 + 测试。
- [ ] **I06 清理与保留**：`recoverPending`/`pruneBuilds` 同时清理 `components`/`vue_file_meta`；保留 K=2。证据：单测。
- [ ] **I07 只读查询**：查询层只读打开；组件读取不写库。证据：代码审查。
- [ ] **I08 无影子数据**：DB 无 `.nexus/tmp` 路径、无 `__VLS_` 名称、无映射段。证据：SQL 断言。
- [ ] **I09 损坏库**：损坏 DB 查询返回 E01/E07（与 Phase 01 记录一致），不返回假数据。证据：负向测试。
- [ ] **I10 历史表**：Vue 符号写入 `symbol_id_history`；active 唯一；retired 不复用。证据：DB。

## 11. 查询、输出与 CLI（J）

- [ ] **J01 references 默认含模板边**：Vue 项目中默认返回模板边；`counts` 三分类正确。证据：F05。
- [ ] **J02 `--no-template`**：CLI 参数生效；JSON/lines/markdown/pretty 一致；notes 声明。证据：CLI 测试。
- [ ] **J03 symbol 组件块**：`symbol` 输出 component 详情；四格式字段集合一致。证据：F05 CLI。
- [ ] **J04 coverage.filteredInternal**：查询 envelope 与 manifest 中出现；四格式一致。证据：测试。
- [ ] **J05 无结果区分**：`not-found` / `not-covered` / `stale` 等不出现在被伪造的状态；Vue 未覆盖文件仍有说明。证据：测试。
- [ ] **J06 稳定输出**：同 buildFingerprint 两次查询逐字节一致（lines/json）。证据：哈希对比。
- [ ] **J07 无 ANSI**：lines/json/markdown 无 `\x1b`；pretty 才可着色。证据：测试。
- [ ] **J08 notes 可读**：模板边关闭、typeResolver 不支持、Vue 未索引等声明可读且不误导。证据：CLI 输出。
- [ ] **J09 错误码**：Vue 分析失败 E11；映射失败不新增错误码；错误仍四行 pretty。证据：测试。
- [ ] **J10 输出不泄内部**：不输出 `__VLS_`、影子路径、绝对路径、token、时间戳。证据：四格式扫描。
- [ ] **J11 search**：组件符号可检索；不因内部符号污染结果。证据：F05。
- [ ] **J12 多 root 诚实**：多 root 下 symbol/references 仍 E24；不因 Vue 实现悄悄改变。证据：回归测试。

## 12. status / doctor / 能力声明（K）

- [ ] **K01 capabilities.vue**：按实际能力声明（Phase 02 完成 SFC 语义后为 `sfc-semantic`；未完成或无 `.vue` 时不得冒充）。证据：status JSON。
- [ ] **K02 capabilities.templateReferences**：声明四类边能力与 `--no-template` 语义。证据：status JSON。
- [ ] **K03 propsCoverage 汇总**：status/manifest 有 Vue 文件数、组件数、mapped/unmapped、filteredInternal、propsCoverage。证据：status。
- [ ] **K04 status 永不 E01**：Vue 相关失败降级为 warnings，不改变 status 契约。证据：负向测试。
- [ ] **K05 doctor --schema**：仍可用；schemaVersion 2 报告正确。证据：CLI。
- [ ] **K06 doctor --dump-vue-map**：对指定 `.vue` 现场重新投影并打印映射段（stdout，不落盘）；文件不存在 E05/E00。证据：CLI 测试。
- [ ] **K07 tmp 残留检查**：doctor 报告 `.nexus/tmp/` 非空为 warning；构建结束清理。证据：doctor 输出。
- [ ] **K08 版本与指纹**：`--version` 展示 buildFingerprint 前 12 位；Vue 分析器版本变化改变指纹。证据：CLI + 两次构建。
- [ ] **K09 E24 保持**：`status --json-schema`、`update` 等仍 E24，不因 Phase 02 误开放。证据：测试。
- [ ] **K10 help 文案**：`references --no-template`、`doctor --dump-vue-map` 的 help 与实际一致，不再写“Vue is not indexed”。证据：help 输出。

## 13. 夹具与 Oracle（L）

- [ ] **L01 F05 夹具**：`fixtures/F05-vue-sfc/`，12 文件、≤350 行；覆盖 defineProps 复杂类型、defineEmits、slots、自动导入（可选）、四类模板边、动态参数、成员表达式、script+script setup、slot 内容。证据：文件清单与行数。
- [ ] **L02 expected golden**：`expected/symbols.json`（用户符号集合）、`expected/template-edges.json`（四类边与位置）、`expected/components.json`（props/emits/slots/propsCoverage）。golden 由 vue-tsc/人工核对，不由本工具自证。证据：文件。
- [ ] **L03 夹具说明**：README 写明测什么、看哪几个断言、如何更新 golden。证据：README。
- [ ] **L04 semantic-map Vue 扩展**：T09 场景补齐；若需新文件，总量仍 ≤1500 行。证据：夹具。
- [ ] **L05 vue-tsc Oracle**：F05 与 semantic-map 的 `vue-tsc --noEmit` 退出 0；错误差异逐条解释。证据：命令输出。
- [ ] **L06 用户符号对照**：用 Phase 00 同源的 language-core 投影 + golden 对照；不得用本工具输出自证。证据：测试脚本。
- [ ] **L07 模板边对照**：golden 边的 path/line/col/kind/target 与 DB 逐条比对；允许的差异必须显式标注（如闭标签）。证据：测试。
- [ ] **L08 tsserver 回归**：F01/F10 的既有 Oracle 断言仍通过。证据：测试。
- [ ] **L09 负向夹具**：投影失败/非法 SFC/无脚本 SFC/动态参数/中文标识符/CRLF 至少各 1 个用例。证据：测试文件。
- [ ] **L10 夹具不入包**：`npm pack --dry-run` 不含 fixtures/.nexus/tmp。证据：pack 清单。
- [ ] **L11 行数配额**：F05 ≤350 行；F01–F18 合计仍 ≤12000 行（本阶段只新增 F05）。证据：`wc -l`。
- [ ] **L12 无外部下载**：测试不联网、不下载夹具。证据：离线运行。

## 14. 测试与门禁（M）

- [ ] **M01 单测：映射**：UTF-8→UTF-16、段边界、重叠段、CRLF、不可回指。证据：测试名。
- [ ] **M02 单测：过滤**：`__VLS_` 双判、宏、幽灵引用。证据：测试名。
- [ ] **M03 单测：组件抽取**：props/emits/slots/never/any/required/default。证据：测试名。
- [ ] **M04 单测：模板分类**：组件/事件/指令/属性/插值/动态键/成员表达式。证据：测试名。
- [ ] **M05 集成：F05 构建**：`init` + `build` 退出 0；无 `__VLS_`；四类边齐备；组件数据正确。证据：测试名 + 日志。
- [ ] **M06 集成：semantic-map T09**：映射、未映射登记、符号集合。证据：测试名。
- [ ] **M07 V1 200 点**：抽样 200（不足则全量）坐标回指与 Volar 往返一致；记录实际数量。证据：测试输出。
- [ ] **M08 V2 对照**：golden 用户符号集合 0 missing / 0 extra / 0 ghost。证据：测试断言。
- [ ] **M09 V3 四类边**：四类各 ≥1；动态键 unresolved；删除 handler 定位。证据：测试断言。
- [ ] **M10 V4 propsCoverage**：resolved/total 与 unresolved 逐条；slot never 标注。证据：测试断言。
- [ ] **M11 V6 映射**：T09 全部产出映射结果；unmapped 全登记；falseMatch 0。证据：测试断言。
- [ ] **M12 重复构建一致**：同指纹两次构建，符号/引用/组件/坐标逐字节一致；tmp 为空。证据：测试。
- [ ] **M13 格式一致**：pretty/lines/json/markdown 的 counts/coverage/truncated/nextCursor/staleness 一致；无 ANSI；notes 一致。证据：测试。
- [ ] **M14 非 TTY**：所有新增/修改命令无输入管道下 5s 内退出；无 hang。证据：测试脚本。
- [ ] **M15 回归**：F01/F10/F15/F17 既有测试全绿；`update`/`status --json-schema` 仍 E24。证据：测试。
- [ ] **M16 测试成本**：`npm test` 总时长记录；新增测试不超 17.1.3 预算；无网络。证据：计时。

## 15. 性能与可观测（N）

- [ ] **N01 耗时分解**：scan / project / shadow write / scip / map / write 分别记录；Vue 投影时间单列。证据：manifest/timings。
- [ ] **N02 内存**：父进程峰值 RSS 记录；SCIP 子进程仍 null + 原因；不宣称 16.2 达标。证据：manifest。
- [ ] **N03 规模说明**：F05/semantic-map 是小夹具，不可外推；报告写明。证据：报告。
- [ ] **N04 外部符号计数**：Vue 外部库引用与未映射计数可核对。证据：coverage。
- [ ] **N05 映射原因分布**：`unmappedReasons` 分类计数。证据：manifest/status。
- [ ] **N06 无随机性**：构建/输出无时间戳、绝对路径、token、随机顺序。证据：两次构建 diff。
- [ ] **N07 大文件保护**：投影前按大小上限跳过；避免 OOM。证据：代码 + 单测。
- [ ] **N08 采样器清理**：所有异常路径停止内存采样器与定时器。证据：代码审查。

## 16. 文档、报告与自审（O）

- [ ] **O01 README**：Vue 能力、命令参数、限制更新；不宣称 Surface/impact/MCP。证据：README diff。
- [ ] **O02 docs/runtime-api.md**：登记新增 Node API（若使用）；Vue 依赖不改变 Node 下限。证据：diff。
- [ ] **O03 `.dsh/AGENTS.md`**：当前状态与可用命令更新（不纳入 git）。证据：文件。
- [ ] **O04 Phase 02 报告**：按 19.3 的九项结构与 implemented/partial/heuristic/unresolved/unsupported/failed 标注。证据：报告文件。
- [ ] **O05 自审回执**：边界与安全审查、递归检查、测试结果、已知缺陷、兼容性影响。证据：报告 §自审。
- [ ] **O06 文档同步**：19 章阶段表、README、配置 Schema、AGENTS 四处口径一致；不修改 v1.24 正文。证据：审查记录。
- [ ] **O07 工作区干净**：`git status --porcelain` 仅含本阶段预期文件；`.nexus/tmp/` 为空。证据：命令输出。
- [ ] **O08 下一阶段交接**：明确 Phase 03 可复用项（组件模型、symbol_map、模板边）与需补项（Surface evidenceSource、api-snapshot）。证据：报告 §7。

---

## 17. 执行顺序

1. A（入场）→ B（依赖/版本）→ C（扫描/投影）；
2. D（影子/SCIP）→ E（坐标/过滤）→ F（组件模型）；
3. G（模板边）→ H（Semantic Merger）；
4. I（存储）→ J/K（查询/CLI/status/doctor）；
5. L（夹具/Oracle）→ M（测试/门禁）→ N（性能记录）→ O（文档/报告）。

若 D 或 E 不通过，G–H 不得开工；若 G 四类边不齐，Phase 02 不得以“bloque 少数边”关闭。

## 18. 执行结果（2026-11-12）

| 分组 | 状态 | 证据 |
|---|---|---|
| A 入场与裁定 | 完成 | `docs/phase-02/00-entry-and-decisions.md`；Phase 01 报告 §12 |
| B 依赖/构建/版本 | 完成 | `@vue/language-core@3.3.14` 等三依赖；Node 22/24 build/typecheck；dist 哈希一致 |
| C 扫描与投影 | 完成 | `.vue` 扫描、5/5 F05 投影、`packages/core/src/vue/project.ts` |
| D 影子与 SCIP | 完成 | `.nexus/tmp/vue/`、单次 SCIP、构建后 tmp 为空 |
| E 坐标/过滤/身份 | 完成 | V1 61 点、V2 0 missing/0 extra/0 ghost |
| F 组件模型 | 完成 | V4：4/4、1/1、2/4；any/never/slot-never reason |
| G 模板边 | 完成 | V3：组件 3 / 绑定 12 / 插值 6 / 动态 1；删除 handler 后边消失 |
| H Semantic Merger | 完成 | V6：T09 全映射；`falseMatchCount=0`；unmapped 全登记 |
| I 存储/Schema | 完成 | `SCHEMA_VERSION=2`；`components`、`vue_file_meta`；事务与清理 |
| J 查询/输出/CLI | 完成 | `references --no-template`、`symbol` 组件块、`coverage.filteredInternal` |
| K status/doctor | 完成 | `capabilities.vue=sfc-semantic`、`doctor --dump-vue-map` |
| L 夹具/Oracle | 完成 | `fixtures/F05-vue-sfc` golden；`vue-tsc` 0 error；semantic-map T09 |
| M 测试/门禁 | 完成 | 58 passed（Node 22.16.0 / 24.22.2）；四格式/非 TTY/ANSI |
| N 性能/可观测 | 完成（小夹具） | F05 2021ms / 139.3MB；semantic-map 2523ms；不宣称 16.2 |
| O 文档/报告/自审 | 完成 | README、AGENTS、`docs/phase-02/03-implementation-report.md` |

任务清单已按分组回填执行状态；逐项证据见 Phase 02 报告 §2–§9。未实现项按 unsupported 登记，未勾选为完成。
