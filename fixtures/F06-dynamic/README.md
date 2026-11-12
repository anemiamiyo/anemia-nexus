# F06 dynamic

Covers the Phase 04 call/dependency classifications that must not be reported as
certain:

- `import('./lazy')` -> dependency `dynamic-import` / `dynamic-unresolved`;
- `obj[key]()` -> call `unresolved` / `dynamic-callee`;
- `eval(...)` -> call `unresolved` / `eval`;
- `obj.known()` on `any` with one same-file `known` declaration -> call
  `heuristic` (marked `?`);
- a direct same-file call -> `direct` / `certain`.
