# F04 multi-root

**测什么**：npm workspaces 多 root 的独立索引与 cwd 归属。

**断言**：

- `init --roots all` 选择两个 root，`build` 各自生成独立 `.nexus/roots/<rootId>/`。
- 仓库根 cwd 没有唯一 activeRoot；查询返回 E16 并列出候选。
- cwd 在 `packages/ui` 时 `activeRoot = f04-ui`，只返回该 root 的符号。

**Golden 来源**：人工期望的 root 列表与 E16 候选清单；不合并多 root 索引。
