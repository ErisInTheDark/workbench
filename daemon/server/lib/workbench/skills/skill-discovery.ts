/*
 * Exports:
 * - listSkillDefinitionsFromDirectory: discover root-bounded SKILL.md packages from one skills directory.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkbenchSkillDefinition } from "workbench-shared/types";

export async function listSkillDefinitionsFromDirectory(
  rootPath: string,
  relativeDirectory: string,
  parseFrontmatter: (content: string) => Map<string, string> | null,
  optional = false,
): Promise<WorkbenchSkillDefinition[]> {
  const directoryPath = path.resolve(rootPath, relativeDirectory);
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || optional && (code === "EACCES" || code === "EPERM")) return [];
    throw error;
  }

  let root: string;
  try {
    root = await fs.realpath(rootPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (optional && (code === "EACCES" || code === "EPERM")) return [];
    throw error;
  }
  const skills: WorkbenchSkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relativePath = path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name, "SKILL.md");
    const absolutePath = path.resolve(rootPath, relativePath);
    let content: string;
    try {
      const realPath = await fs.realpath(absolutePath);
      const relativeRealPath = path.relative(root, realPath);
      if (relativeRealPath === ".." || relativeRealPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRealPath)) {
        throw new Error(`Skill path escapes its source root: ${relativePath}`);
      }
      content = await fs.readFile(realPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!content.trim()) continue;
    const frontmatter = parseFrontmatter(content);
    skills.push({
      content: content.trim(),
      description: frontmatter?.get("description") ?? "",
      name: frontmatter?.get("name") ?? entry.name,
      path: absolutePath.replaceAll("\\", "/"),
      relativePath,
    });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}
