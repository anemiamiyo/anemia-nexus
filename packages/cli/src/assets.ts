/**
 * Integration assets printed by `nex print` (docs/14-agent-integration.md 14.2/14.3).
 * These functions only build strings; the CLI writes them to stdout and never
 * to the filesystem.
 */
export type PrintAsset = 'mcp-config' | 'agents' | 'skill';
export type PrintClient = 'dsh' | 'claude' | 'cursor';

export const PRINT_ASSETS: readonly PrintAsset[] = ['mcp-config', 'agents', 'skill'];
export const PRINT_CLIENTS: readonly PrintClient[] = ['dsh', 'claude', 'cursor'];

const CLIENT_TARGETS: Record<PrintClient, string> = {
  dsh: 'the dsh MCP configuration file',
  claude: 'the Claude desktop MCP configuration file',
  cursor: 'the Cursor MCP configuration file',
};

export function isPrintAsset(value: string): value is PrintAsset {
  return (PRINT_ASSETS as readonly string[]).includes(value);
}

export function isPrintClient(value: string): value is PrintClient {
  return (PRINT_CLIENTS as readonly string[]).includes(value);
}

export function clientTarget(client: PrintClient): string {
  return CLIENT_TARGETS[client];
}

export function mcpConfigAsset(client: PrintClient): string {
  const config = {
    mcpServers: {
      'anemia-nexus': {
        command: 'npx',
        args: ['-y', 'anemia-nexus', 'mcp'],
      },
    },
  };
  void client;
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function agentsAsset(): string {
  return `# AGENTS.md（项目级接入约定）

<!-- 由 \`nex print agents\` 打印到终端；本工具不会创建或修改任何文件。 -->

## 每次任务开始
- 先运行 \`nex status\`
- 状态为 fresh：直接查询
- 状态为 dirty / stale：先看 staleness 原因，再决定是否 \`nex update\`
- 状态为 uninitialized / failed / indexing：停止，原样输出引导块，不产出结论

## 定位与判定
- 查符号、引用、依赖：\`nex symbol\` / \`nex references\` / \`nex deps\`
- 不自行用文件搜索推断引用全集
- heuristic 与 dynamic-unresolved 必须提示人工确认
- 静态引用数不代表调用频率

## 变更
- 动公共 API 前：\`nex impact\` 与 \`nex api-diff\`
- \`postflight\` 未通过不提交

## 配置
- 不改配置格式，不授权执行未确认的配置代码
- 不把 \`.nexus/nexus.config.json\` 改成 \`.ts\`

## 格式
- 走 MCP 时无需指定 format（恒为紧凑格式）
- 走 CLI 时显式 \`--format lines\` 或 \`--format json\`，不依赖 TTY 推断

## 声明
- 未使用 Nexus 时，回答开头声明「本次未使用 Nexus，结论未经索引校验」
`;
}

export function skillAsset(): string {
  return `---
name: nexus
description: Use Anemia Nexus to answer symbol, reference, dependency and change-impact questions from the committed index.
---

# Nexus 使用流程

1. 起步检查：先调用 \`status\`。状态为 \`fresh\` 才直接下结论；\`dirty\` / \`stale\` 先提示更新；\`uninitialized\` / \`failed\` / \`indexing\` 时原样输出工具给出的引导块，不继续推断。
2. 查询选择：符号用 \`symbol\`，引用用 \`references\`，依赖与调用用 \`deps\`，变更影响用 \`impact\`。不要用文件搜索替代引用全集。
3. 变更前审计：动公共 API 前先看 \`impact\` 与 \`api-diff\`，并区分 \`certain\` / \`heuristic\` / \`dynamic-unresolved\`。
4. 失败时：原样返回工具给出的错误码、原因与下一步命令；不要自行猜测或把 heuristic 当成事实。
`;
}
