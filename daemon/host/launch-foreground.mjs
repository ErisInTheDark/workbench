/*
 * No exports. Keep foreground development startup behind the dependency repair gate.
 */
import { createRequire } from "node:module";
import { readJournal, isRepairPending } from "../../installation/update-journal.mjs";

try {
  if (isRepairPending(await readJournal())) {
    throw new Error("Dependency update repair is pending. Launch Workbench or run `wb repair` before starting the host.");
  }
  const require = createRequire(import.meta.url);
  require("tsx/cjs");
  require("./foreground.ts");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message.replace(/[\r\n]/gu, " ") : "Workbench foreground bootstrap failed."}\n`);
  process.exitCode = 78;
}
