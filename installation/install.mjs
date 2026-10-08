/*
 * No exports. Run checkout-owned installation without requiring installed dependencies.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import WorkbenchInstaller from "./WorkbenchInstaller.mjs";

try {
  if (process.env.WORKBENCH_THREAD_ID || process.env.CODEX_THREAD_ID) {
    throw new Error("Managed threads cannot run Workbench installation.");
  }
  const setup = new WorkbenchInstaller({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") });
  const mode = process.argv[2];
  if (mode === "--prepare") await setup.prepare();
  else if (mode === "--prepare-pinned") await setup.preparePinned();
  else if (mode === "--welcome") await setup.welcome();
  else if (mode === "--connect") await setup.connect();
  else throw new Error("Expected --prepare, --prepare-pinned, --welcome or --connect.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
