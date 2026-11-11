# F01 reexport-chain

**测什么**：多层 barrel、别名重导出、`export *`、默认/具名混合，以及 SCIP 引用边与 symbolId 的稳定性。

**断言**：

- `nex init --roots all` 识别单 root；`nex build` 退出 0。
- 公共符号 `add` 的 `certain` 引用为 7 条，与 tsserver Oracle 逐条一致（0 漏报 / 0 误报）。
- `references add --format pretty|lines|json|markdown` 的条目集合一致，均为 7 条。
- `Counter` 的构造函数调用计入类引用。

**Golden 来源**：`tools/oracle/tsserver-references.mjs`（TypeScript LanguageService），不调用被测映射代码。
