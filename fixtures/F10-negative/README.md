# F10 negative

**测什么**：漏报负样本。未被引用的声明、字符串/动态访问、动态 `import()` 不应被伪造成静态引用。

**断言**：

- `neverReferenced`、`onlyDeclared`、`stringNamed` 的 `certain` 引用为 0。
- `referencedOnce`、`typeOnlyUsed` 的引用数与 tsserver Oracle 一致。
- 全部公共符号与 Oracle 对照 0 差异。

**Golden 来源**：`tools/oracle/tsserver-references.mjs`。
