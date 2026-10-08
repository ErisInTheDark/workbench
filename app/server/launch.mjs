/*
 * No exports. Resume dependency repair before loading the app's TypeScript runtime.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJournal, isRepairPending } from "../../package/update-journal.mjs";
import { runRepair } from "../../package/update.mjs";

try {
  if (process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim()) {
    throw new Error("Managed threads cannot launch or repair Workbench.");
  }
  if (isRepairPending(await readJournal())) {
    const journal = await runRepair({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") });
    if (journal && journal.phase !== "done") {
      throw new Error(`Workbench update repair failed: ${journal.lastError ?? "repair incomplete"}. Run \`wb repair\` (log: ${journal.logPath}).`);
    }
  }
  const require = createRequire(import.meta.url);
  require("tsx/cjs");
  require("./index.ts");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message.replace(/[\r\n]/gu, " ") : "Workbench app bootstrap failed."}\n`);
  process.exitCode = 1;
}
