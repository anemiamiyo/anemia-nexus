# F07 api-surface

**测什么**：API Surface 的公开证据来源（`package-exports` / `barrel-derived` / `manual-override` / `none`）、`exportKind`（type / value / both）、条件导出、子路径、`*` 通配、多层 barrel、重载、`@deprecated` 继任者、`no-successor`、`export =` opaque 边界与 internal 反向误报。

**断言**：

- `package.json` `exports` 的 `.` 条件 `types` / `import` / `require` 生成独立记录，`add` 的 primary 为 `package-exports` 且 `derived=true`；
- `Numeric` 为纯类型导出（`isTypeOnly=true`、`runtimePresent=false`）；`Both` 的 `exportKind=both` 且有两个签名；
- `format` 经 `src/index.ts -> src/utils.ts -> src/format.ts` 多层 barrel 可达，`. ` 与 `./utils` 都有记录；
- `feature` 由 `./advanced/*` 通配命中，`entryPath=./advanced/feature`；
- `oldAdd` 的 `@deprecated` 指向 `add`，`doomed` 无继任者且 `removalVersion=2.0.0`；
- `internalHelper` / `InternalShape` 在 internal，不得出现在 public entries；`export =` 进入 opaque；
- 两次 `nex api-snapshot --yes` 的 `nexus.baseline.json` 逐字节一致；证据来源变化后 `surfaceHash` 必变。

**Golden 来源**：人工核对 TypeScript AST / `tsc` 导出语义与 Node `exports` 语义，固化在 `expected/surface-golden.json`；不是由 Surface Builder 生成。人工核对日期：2026-11-13。
