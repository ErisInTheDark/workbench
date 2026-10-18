/*
 * Exports:
 * - mcpToolLabel: readable label for an MCP server tool; the server's title, else its name sentence-cased.
 * - mcpToolSharedPrefix: a name prefix every listed tool shares (such as `COMPOSIO_`), dropped from labels.
 */

export function mcpToolLabel(tool: { name: string; title?: string | null }, sharedPrefix = "") {
  if (tool.title?.trim()) return tool.title.trim();
  const words = tool.name.slice(sharedPrefix.length).replace(/[_-]+/gu, " ").trim();
  const sentence = /[a-z]/u.test(words) ? words : words.toLowerCase();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function mcpToolSharedPrefix(tools: readonly { name: string }[]) {
  const prefix = tools[0]?.name.match(/^[A-Za-z0-9]+[_-]/u)?.[0] ?? "";
  return tools.length > 1 && prefix && tools.every(tool => tool.name.startsWith(prefix)) ? prefix : "";
}
