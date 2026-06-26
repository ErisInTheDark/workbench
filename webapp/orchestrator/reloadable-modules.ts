/*
 * Exports:
 * - OrchestratorReloadableModules: live bundle of helper modules that can be reloaded without replacing the long-lived bridge instances. Keywords: reload, hot reload, orchestrator, bridge.
 * - loadOrchestratorReloadableModules: read the current helper exports from Node's module cache. Keywords: require, module cache, load.
 * - reloadOrchestratorReloadableModules: clear the targeted helper modules from require.cache and load fresh exports. Keywords: require.cache, invalidate, refresh.
 */

export type OrchestratorReloadableModules = {
  copilotThreadState: Pick<typeof import("./copilot-thread-state"),
    "applyCopilotEvent"
    | "cloneThread"
    | "createThreadState"
    | "formatPromptFromInput"
    | "INITIALIZE_RESULT"
    | "metadataToThread">;
  opencodeThreadState: Pick<typeof import("./opencode-thread-state"),
    "cloneThread"
    | "createOpenCodePermissionRequest"
    | "createOpenCodeQuestionRequest"
    | "EMPTY_OPENCODE_RATE_LIMITS"
    | "formatPromptFromInput"
    | "mapOpenCodeModelsToWorkbenchOptions"
    | "OPENCODE_INITIALIZE_RESULT"
    | "opencodeSessionToThread">;
  opencodeLiveThreadState: Pick<typeof import("./opencode-live-thread-state"),
    "applyOpenCodeLiveEvent"
    | "createOpenCodeLiveThreadState">;
  project: Pick<typeof import("../lib/project"), "isPathWithinRoot" | "readUserInvocableAgentDefinition" | "resolveProjectRoot">;
  threadBootstrap: Pick<typeof import("../lib/thread-bootstrap"),
    "buildThreadTitleBootstrapInstructions"
    | "buildThreadTitleRouteUrl"
    | "normalizeThreadTitle">;
  opencodeWorkbenchInstructions: Pick<typeof import("./opencode-workbench-instructions"),
    "buildOpenCodeWorkbenchSystemPrompt"
    | "ensureOpenCodeWorkbenchConfigDirectory">;
  workbenchPromptFiles: Pick<typeof import("../lib/workbench/instructions/WorkbenchPromptFiles"),
    "buildWorkbenchPromptInstructions"
    | "ensureWorkbenchPromptFiles">;
  workbenchLibrary: Pick<typeof import("../lib/workbench-library"), "buildWorkbenchLibraryBootstrapInstructions">;
};

const RELOADABLE_MODULE_SPECIFIERS = [
  "./copilot-thread-state",
  "./opencode-live-thread-state",
  "./opencode-thread-state",
  "./opencode-workbench-instructions",
  "../lib/project",
  "../lib/thread-bootstrap",
  "../lib/workbench/instructions/WorkbenchPromptFiles",
  "../lib/workbench-library",
] as const;

function requireTyped<TModule>(specifier: string) {
  return require(specifier) as TModule;
}

function collectCacheSubtree(moduleId: string, visited = new Set<string>()) {
  if (visited.has(moduleId)) {
    return visited;
  }

  const cachedModule = require.cache[moduleId];
  if (!cachedModule) {
    return visited;
  }

  visited.add(moduleId);
  for (const child of cachedModule.children) {
    if (!child?.id || /[\\/]node_modules[\\/]/u.test(child.id)) {
      continue;
    }

    collectCacheSubtree(child.id, visited);
  }

  return visited;
}

export function loadOrchestratorReloadableModules(): OrchestratorReloadableModules {
  return {
    copilotThreadState: requireTyped<OrchestratorReloadableModules["copilotThreadState"]>("./copilot-thread-state"),
    opencodeLiveThreadState: requireTyped<OrchestratorReloadableModules["opencodeLiveThreadState"]>("./opencode-live-thread-state"),
    opencodeThreadState: requireTyped<OrchestratorReloadableModules["opencodeThreadState"]>("./opencode-thread-state"),
    opencodeWorkbenchInstructions: requireTyped<OrchestratorReloadableModules["opencodeWorkbenchInstructions"]>("./opencode-workbench-instructions"),
    project: requireTyped<OrchestratorReloadableModules["project"]>("../lib/project"),
    threadBootstrap: requireTyped<OrchestratorReloadableModules["threadBootstrap"]>("../lib/thread-bootstrap"),
    workbenchPromptFiles: requireTyped<OrchestratorReloadableModules["workbenchPromptFiles"]>("../lib/workbench/instructions/WorkbenchPromptFiles"),
    workbenchLibrary: requireTyped<OrchestratorReloadableModules["workbenchLibrary"]>("../lib/workbench-library"),
  };
}

export function reloadOrchestratorReloadableModules() {
  const moduleIdsToClear = new Set<string>();
  for (const specifier of RELOADABLE_MODULE_SPECIFIERS) {
    const resolvedPath = require.resolve(specifier);
    for (const moduleId of collectCacheSubtree(resolvedPath)) {
      moduleIdsToClear.add(moduleId);
    }
  }

  for (const moduleId of moduleIdsToClear) {
    delete require.cache[moduleId];
  }

  return loadOrchestratorReloadableModules();
}
