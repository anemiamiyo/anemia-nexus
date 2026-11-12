# F13 style-deps

Covers the S1 file-level style chain from `docs/04-architecture.md` 4.2:

- CSS `@import`
- SCSS `@use` / `@forward`
- Vue `<style src>`
- TS/JS `import "./x.css"`
- alias (`@styles`), dynamic path (`#{...}`), `sass:*`, external package, missing target

Expected: style files produce no symbols; all edges are file-level `dependencies` rows.
