/*
 * Exports:
 * - updateConflictPrompt: agent-facing request to integrate an update that conflicts with local work.
 * - updateFailurePrompt: agent-facing request to diagnose an update whose install broke.
 */
import type { InstallationUpdate } from "workbench-shared/workbench/installation-update";

// Update-issue references are agent-facing, so they carry the detail the buttons deliberately leave out.
export function updateConflictPrompt(update: InstallationUpdate) {
  const source = update.upstream ?? "upstream";
  const steps = "Integrate it with `wb git integrate start --from upstream` (`wb git --help` lists the integrate steps), preserving my local work.";
  return update.conflicts.length
    ? `Pulling Workbench updates from \`${source}\` would conflict with local changes in:\n\n${update.conflicts.map(file => `- \`${file}\``).join("\n")}\n\n${steps}`
    : `Pulling Workbench updates from \`${source}\` is blocked: ${update.reason ?? "rebasing my local Workbench commits would conflict."}\n\n${steps}`;
}

export function updateFailurePrompt(update: InstallationUpdate, failure: NonNullable<InstallationUpdate["failure"]>) {
  return `The last Workbench update from \`${update.upstream ?? "upstream"}\` broke while installing: ${failure.message}\n\nThe update log is at \`${failure.logPath}\`. Help me find the cause and get this update installed.`;
}
