/*
 * Exports:
 * - normalizeThreadLocation: compare absolute locations with existing Windows drive casing rules.
 * - isThreadWithinRoot/isThreadAtRoot: test descendant or exact thread locations.
 * - isProjectThread/isProjectThreadAtExpectedCwd: validate project and relationship-owned locations.
 */
export function normalizeThreadLocation(filePath: string) {
  const normalized = String(filePath ?? "")
    .trim()
    .replace(/^\\\\\?\\UNC\\/iu, "//")
    .replace(/^\\\\\?\\/iu, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return /^[a-z]:/iu.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function isThreadWithinRoot(candidatePath: string, rootPath: string) {
  if (!candidatePath.trim() || !rootPath.trim()) return false;
  const candidate = normalizeThreadLocation(candidatePath);
  const root = normalizeThreadLocation(rootPath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function isThreadAtRoot(candidatePath: string, rootPath: string) {
  return Boolean(candidatePath.trim() && rootPath.trim())
    && normalizeThreadLocation(candidatePath) === normalizeThreadLocation(rootPath);
}

export function isProjectThread(thread: { cwd: string }, rootPath: string | string[]) {
  const roots = Array.isArray(rootPath) ? rootPath : [rootPath];
  return roots.some(root => isThreadAtRoot(thread.cwd, root));
}

export function isProjectThreadAtExpectedCwd(thread: { cwd: string }, rootPath: string | string[], expectedCwd: string | null | undefined) {
  if (!expectedCwd?.trim()) return isProjectThread(thread, rootPath);
  const roots = Array.isArray(rootPath) ? rootPath : [rootPath];
  return roots.some(root => isThreadWithinRoot(expectedCwd, root)) && isThreadAtRoot(thread.cwd, expectedCwd);
}
