/*
 * Exports:
 * - resolveWorkbenchLibraryRoot: resolve the process-wide Workbench library root from explicit input or environment. Keywords: Workbench, storage, root.
 */
import os from "node:os";
import path from "node:path";

export default function resolveWorkbenchLibraryRoot(value = process.env.WORKBENCH_LIBRARY_ROOT) {
  return path.resolve(value?.trim() || path.join(os.homedir(), ".workbench"));
}
