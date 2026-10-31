/*
 * Exports:
 * - listSkillDefinitionsFromDirectory: discover root-bounded SKILL.md packages from one skills directory.
 * - readSkillLayer: discover one skills directory as a labelled precedence layer.
 * - WorkbenchSkillSource/WorkbenchSkillLayer: one precedence layer of skills and the directory it was read from.
 * - WorkbenchProjectSkills/EMPTY_PROJECT_SKILLS: a project's skill layers in precedence order plus lowercase skill names it hides at every layer.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkbenchSkillDefinition } from "workbench-shared/types";

export type WorkbenchSkillSource = "local overlay" | "project" | "user library" | "user agents" | "builtin";

export interface WorkbenchSkillLayer {
  readonly source: WorkbenchSkillSource;
  readonly directory: string;
  readonly skills: readonly WorkbenchSkillDefinition[];
}

export interface WorkbenchProjectSkills {
  readonly layers: readonly WorkbenchSkillLayer[];
  readonly hiddenNames: readonly string[];
}

export const EMPTY_PROJECT_SKILLS: WorkbenchProjectSkills = { layers: [], hiddenNames: [] };

export async function readSkillLayer(
  source: WorkbenchSkillSource,
  rootPath: string,
  relativeDirectory: string,
  parseFrontmatter: (content: string) => Map<string, string> | null,
  optional = false,
): Promise<WorkbenchSkillLayer> {
  return {
    source,
    directory: path.resolve(rootPath, relativeDirectory).replaceAll("\\", "/"),
    skills: await listSkillDefinitionsFromDirectory(rootPath, relativeDirectory, parseFrontmatter, optional),
  };
}

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
