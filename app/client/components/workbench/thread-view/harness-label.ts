/*
 * Exports:
 * - formatHarnessLabel: display known brands without renaming other providers.
 */

import type { WorkbenchHarness } from "workbench-shared/types";

export function formatHarnessLabel(harness: WorkbenchHarness) {
  return harness === "codex" ? "Codex" : harness === "copilot" ? "Copilot" : harness === "opencode" ? "OpenCode" : harness;
}
