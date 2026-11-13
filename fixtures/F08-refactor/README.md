# F08 refactor

Four-layer chain used by Phase 05:

```text
app -> panel -> button -> overlay -> core
button.test.ts -> overlay/button
button -> styles/theme.scss
```

Assertions:

- `impact src/core.ts` reaches overlay/button/panel/app as direct or indirect.
- `impact --symbol useOverlay` reports button/panel/app and the test relation.
- `impact src/styles/theme.scss` returns only file-level style dependents.
