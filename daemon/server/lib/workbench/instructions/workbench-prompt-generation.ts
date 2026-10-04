/*
 * Exports:
 * - loadWorkbenchPromptAssembly: return the current instruction-assembly generation, loading a fresh one only after its source files change.
 */
import { createSourceTrackedModule } from "workbench-shared/reload/require-cache-generations";

const assembly = createSourceTrackedModule<typeof import("./workbench-prompt-assembly")>(
  require, require.resolve("./workbench-prompt-assembly"),
);

export function loadWorkbenchPromptAssembly() {
  return assembly.load();
}
