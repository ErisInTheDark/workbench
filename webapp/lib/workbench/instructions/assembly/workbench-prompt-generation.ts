/*
 * Exports:
 * - loadFreshWorkbenchPromptAssembly: discard the cached assembly subtree and load one fresh instruction-source generation. Keywords: prompts, instructions, reload.
 */

function collectCacheSubtree(moduleId: string, visited = new Set<string>()) {
  if (visited.has(moduleId)) return visited;
  const cachedModule = require.cache[moduleId];
  if (!cachedModule) return visited;
  visited.add(moduleId);
  for (const child of cachedModule.children) {
    if (child?.id && !/[\\/]node_modules[\\/]/u.test(child.id)) collectCacheSubtree(child.id, visited);
  }
  return visited;
}

export function loadFreshWorkbenchPromptAssembly() {
  const resolvedPath = require.resolve("./WorkbenchPromptFiles");
  for (const moduleId of collectCacheSubtree(resolvedPath)) delete require.cache[moduleId];
  return require("./WorkbenchPromptFiles") as typeof import("./WorkbenchPromptFiles");
}
