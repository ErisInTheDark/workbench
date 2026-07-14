/*
 * Exports:
 * - formatHarnessLabel: format Workbench harness identifiers for composer UI. Keywords: harness, label, composer.
 */

import type { WorkbenchHarness } from "../../../lib/types";

export function formatHarnessLabel(harness: WorkbenchHarness) {
  return harness === "codex" ? "Codex" : harness === "copilot" ? "Copilot" : "OpenCode";
}
