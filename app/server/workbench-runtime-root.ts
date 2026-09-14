/*
 * Keywords: app, installation, runtime, storage.
 * Exports:
 * - default resolveWorkbenchRuntimeRoot: resolve app runtime within this installation, independently of cwd and instruction-library configuration.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const installationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default function resolveWorkbenchRuntimeRoot(repositoryRootPath = installationRoot) {
  return path.join(path.resolve(repositoryRootPath), ".workbench", "app");
}
