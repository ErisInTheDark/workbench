/*
 * Exports:
 * - providerLabels: each installed provider's display name.
 */
import type { WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";

export const providerLabels: Readonly<Record<WorkbenchProviderKey, string>> = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };
