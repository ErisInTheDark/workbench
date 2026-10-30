/*
 * Exports:
 * - readSkillFrontmatterList: read one list field (inline `[a, b]` or block `- a`) from skill frontmatter.
 * - resolveSkillExtensionFile: resolve one declared file inside its skill folder, rejecting absolute paths and escapes.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";

function readScalar(value: string): string {
  const text = value.trim();
  if (text.startsWith("\"")) {
    const quoted = /^("(?:\\.|[^"\\])*")\s*(?:#.*)?$/u.exec(text)?.[1];
    if (!quoted) throw new Error("Invalid quoted skill file path.");
    const parsed = conformToZodSchema(z.string(), JSON.parse(quoted));
    if (!parsed.success || parsed.repairedPaths.length || parsed.discardedPaths.length) throw new Error("Skill file paths must be strings.");
    return parsed.data;
  }
  if (text.startsWith("'")) {
    const quoted = /^'((?:''|[^'])*)'\s*(?:#.*)?$/u.exec(text)?.[1];
    if (quoted === undefined) throw new Error("Invalid quoted skill file path.");
    return quoted.replaceAll("''", "'");
  }
  return text.replace(/\s+#.*$/u, "").trim();
}

export function readSkillFrontmatterList(content: string, field: string): string[] {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
  if (!frontmatter) return [];
  const lines = frontmatter.split(/\r?\n/u);
  const fieldPattern = new RegExp(`^${field}\\s*:`, "u");
  const index = lines.findIndex(line => fieldPattern.test(line));
  if (index < 0) return [];
  const raw = lines[index]!.replace(fieldPattern, "").trim();
  const inline = raw.startsWith("#") ? "" : raw;
  if (inline) {
    const list = /^\[([\s\S]*)\]\s*(?:#.*)?$/u.exec(inline)?.[1];
    if (list === undefined) throw new Error(`${field} must be a list.`);
    const parts = list.match(/(?:"(?:\\.|[^"])*"|'(?:''|[^'])*'|[^,])+/gu) ?? [];
    return parts.map(readScalar).filter(Boolean);
  }
  const paths: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const item = /^\s+-\s+(.+)$/u.exec(line);
    if (!item) break;
    const value = readScalar(item[1]!);
    if (!value) throw new Error(`${field} paths cannot be empty.`);
    paths.push(value);
  }
  return paths;
}

/** The real file a skill declares, which must stay inside the skill's (real) folder and have one of `extensions`. */
export async function resolveSkillExtensionFile(root: string, declared: string, { extensions, kind }: {
  extensions: readonly string[]; kind: string;
}): Promise<string> {
  const normalized = declared.replaceAll("\\", "/");
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized)) throw new Error(`${kind} path must be relative: ${declared}`);
  const file = await realpath(path.resolve(root, normalized));
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${kind} path escapes its skill: ${declared}`);
  }
  if (!extensions.includes(path.extname(file).toLowerCase()) || !(await stat(file)).isFile()) {
    throw new Error(`${kind} must be a ${extensions.join(" or ")} file: ${declared}`);
  }
  return file;
}
