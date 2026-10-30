/*
 * Exports:
 * - readSkillMcpMatcherPaths: read the MCP matcher file list from skill frontmatter.
 * - resolveSkillMcpMatchers: resolve declared matcher files within their skill folder, in declared order.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { readSkillFrontmatterList, resolveSkillExtensionFile } from "./skill-extension-files";

export function readSkillMcpMatcherPaths(content: string): string[] {
  return readSkillFrontmatterList(content, "workbench_mcp_matchers");
}

export async function resolveSkillMcpMatchers(skillPath: string, content: string): Promise<{ files: string[]; root: string } | null> {
  const declared = readSkillMcpMatcherPaths(content);
  if (!declared.length) return null;
  const root = await realpath(path.dirname(skillPath));
  const files = await Promise.all(declared.map(file => resolveSkillExtensionFile(root, file, { extensions: [".ts", ".js"], kind: "MCP matcher" })));
  return { files: [...new Set(files)], root };
}
