/*
 * Exports:
 * - readSkillComponentPaths: read the component file list from skill frontmatter.
 * - resolveSkillComponents: resolve declared TSX files within their skill folder.
 * - formatSkillComponentHints: tell the agent which components the skill exposes and how to test them.
 * - SkillComponent: a named component and its resolved file.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";

export interface SkillComponent {
  name: string;
  path: string;
  root: string;
}

function readScalar(value: string): string {
  const text = value.trim();
  if (text.startsWith("\"")) {
    const quoted = /^("(?:\\.|[^"\\])*")\s*(?:#.*)?$/u.exec(text)?.[1];
    if (!quoted) throw new Error("Invalid quoted component path.");
    const parsed = conformToZodSchema(z.string(), JSON.parse(quoted));
    if (!parsed.success || parsed.repairedPaths.length || parsed.discardedPaths.length) throw new Error("Component paths must be strings.");
    return parsed.data;
  }
  if (text.startsWith("'")) {
    const quoted = /^'((?:''|[^'])*)'\s*(?:#.*)?$/u.exec(text)?.[1];
    if (quoted === undefined) throw new Error("Invalid quoted component path.");
    return quoted.replaceAll("''", "'");
  }
  return text.replace(/\s+#.*$/u, "").trim();
}

export function readSkillComponentPaths(content: string): string[] {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
  if (!frontmatter) return [];
  const lines = frontmatter.split(/\r?\n/u);
  const field = lines.findIndex(line => /^workbench_components\s*:/u.test(line));
  if (field < 0) return [];
  const raw = lines[field]!.replace(/^workbench_components\s*:/u, "").trim();
  const inline = raw.startsWith("#") ? "" : raw;
  if (inline) {
    const list = /^\[([\s\S]*)\]\s*(?:#.*)?$/u.exec(inline)?.[1];
    if (list === undefined) throw new Error("workbench_components must be a list.");
    const parts = list.match(/(?:"(?:\\.|[^"])*"|'(?:''|[^'])*'|[^,])+/gu) ?? [];
    return parts.map(readScalar).filter(Boolean);
  }
  const paths: string[] = [];
  for (const line of lines.slice(field + 1)) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const item = /^\s+-\s+(.+)$/u.exec(line);
    if (!item) break;
    const value = readScalar(item[1]!);
    if (!value) throw new Error("Component paths cannot be empty.");
    paths.push(value);
  }
  return paths;
}

export function formatSkillComponentHints(content: string): string {
  const tags = readSkillComponentPaths(content).map(declared => {
    const fileName = path.posix.basename(declared.replaceAll("\\", "/"));
    return `<${fileName.slice(0, fileName.length - path.posix.extname(fileName).length)}>`;
  });
  if (!tags.length) return "";
  return `\n\nChat components: ${tags.join(", ")}. Test markup with the wb \`vis_test\` tool (CLI: \`wb vis test --markup '<Component ... />'\`).`;
}

export async function resolveSkillComponents(skillPath: string, content: string, onlyName?: string): Promise<SkillComponent[]> {
  const root = await realpath(path.dirname(skillPath));
  const components: SkillComponent[] = [];
  const names = new Set<string>();
  for (const declared of readSkillComponentPaths(content)) {
    const normalized = declared.replaceAll("\\", "/");
    const fileName = path.posix.basename(normalized);
    const declaredName = fileName.slice(0, fileName.length - path.posix.extname(fileName).length);
    if (onlyName !== undefined && declaredName !== onlyName) continue;
    if (path.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized)) throw new Error(`Component path must be relative: ${declared}`);
    const file = await realpath(path.resolve(root, normalized));
    const relative = path.relative(root, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Component path escapes its skill: ${declared}`);
    }
    const name = path.basename(file, path.extname(file));
    if (path.extname(file).toLowerCase() !== ".tsx" || !/^[A-Z][A-Za-z0-9_]*$/u.test(name) || !(await stat(file)).isFile()) {
      throw new Error(`Component must be a named TSX file: ${declared}`);
    }
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate component name: ${name}`);
    names.add(key);
    components.push({ name, path: file, root });
  }
  return components;
}
