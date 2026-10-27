/*
 * Exports:
 * - readWorkbenchSkillDirectoryName: the `<dir>` of a `skills/<dir>/SKILL.md` path from any skill source, or null.
 */

const SKILL_DIRECTORY_PATTERN = /^(?:\.agents(?:\.local)?\/)?skills\/(?:builtin\/)?([^/]+)\/SKILL\.md$/iu;

export function readWorkbenchSkillDirectoryName(relativePath: string) {
  return SKILL_DIRECTORY_PATTERN.exec(relativePath.replaceAll("\\", "/"))?.[1] ?? null;
}
