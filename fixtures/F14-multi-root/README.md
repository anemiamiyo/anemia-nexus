# F14 multi-root

Covers `docs/05-data-model.md` 5.7 cross-root rules:

- declared `@f14/ui` + matching `exports` -> one `cross-package` edge;
- undeclared `@f14/lib` -> `unresolved(package-boundary:undeclared-dependency)`;
- bad subpath `@f14/ui/nope` -> `unresolved(package-boundary:exports-mismatch)`;
- declared but absent `@f14/ghost` -> `unresolved(package-boundary:root-not-indexed)`;
- tsconfig path alias to a sibling root -> `unresolved(outside-root)`.

The target root is never expanded; app's index stores only the edges.
