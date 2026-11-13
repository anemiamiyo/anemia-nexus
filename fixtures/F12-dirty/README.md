# F12 dirty

Purpose: make a source edit after `nex build`, then assert that query/audit
outputs carry `staleness != fresh`, and that a workspace-root cwd without a
scope reports E16 rather than silently searching every root.
