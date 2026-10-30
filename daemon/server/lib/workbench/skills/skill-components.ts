/*
 * Exports:
 * - readSkillComponentPaths: read the component file list from skill frontmatter.
 * - resolveSkillComponents: resolve declared TSX files within their skill folder.
 * - formatSkillComponentHints: tell the agent which components the skill exposes and how to test them.
 * - SkillComponent: a named component and its resolved file.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { readSkillFrontmatterList, resolveSkillExtensionFile } from "./skill-extension-files";

export interface SkillComponent {
  name: string;
  path: string;
  root: string;
}

export function readSkillComponentPaths(content: string): string[] {
  return readSkillFrontmatterList(content, "workbench_components");
}

export function formatSkillComponentHints(content: string): string {
  const tags = readSkillComponentPaths(content).map(declared => {
    const fileName = path.posix.basename(declared.replaceAll("\\", "/"));
    return `<${fileName.slice(0, fileName.length - path.posix.extname(fileName).length)}>`;
  });
  if (!tags.length) return "";
  return `\n\nChat components: ${tags.join(", ")}. Test markup with the wb \`vis_test\` tool (CLI: \`wb vis test --markup '<Component ... />'\`).`
    + " Pass MCP data without retyping it: `mcp_call` with `keep: \"<name>\"` (and `keepOnly: true` to skip the inline copy), then a prop value `\"@result:<name>\"`.";
}

export async function resolveSkillComponents(skillPath: string, content: string, onlyName?: string): Promise<SkillComponent[]> {
  const root = await realpath(path.dirname(skillPath));
  const components: SkillComponent[] = [];
  const names = new Set<string>();
  for (const declared of readSkillComponentPaths(content)) {
    const fileName = path.posix.basename(declared.replaceAll("\\", "/"));
    const declaredName = fileName.slice(0, fileName.length - path.posix.extname(fileName).length);
    if (onlyName !== undefined && declaredName !== onlyName) continue;
    const file = await resolveSkillExtensionFile(root, declared, { extensions: [".tsx"], kind: "Component" });
    const name = path.basename(file, path.extname(file));
    if (!/^[A-Z][A-Za-z0-9_]*$/u.test(name)) throw new Error(`Component must be a named TSX file: ${declared}`);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate component name: ${name}`);
    names.add(key);
    components.push({ name, path: file, root });
  }
  return components;
}
