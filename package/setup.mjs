/*
 * No exports. Run checkout-owned setup without requiring installed dependencies.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import WorkbenchSetup from "./WorkbenchSetup.mjs";

try {
  if (process.env.WORKBENCH_THREAD_ID || process.env.CODEX_THREAD_ID) {
    throw new Error("Managed threads cannot run Workbench installation.");
  }
  const setup = new WorkbenchSetup({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") });
  const mode = process.argv[2];
  if (mode === "--prepare") await setup.prepare();
  else if (mode === "--welcome") await setup.welcome();
  else if (mode === "--connect") await setup.connect();
  else throw new Error("Expected --prepare, --welcome or --connect.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
