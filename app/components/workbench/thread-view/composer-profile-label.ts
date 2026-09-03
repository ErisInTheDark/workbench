/*
 * Exports:
 * - getComposerProfileDisplayLabel: derive a profile's custom or settings-based display label without persisting fallback text. Keywords: composer, profile, label, fallback.
 */
import type { WorkbenchComposerProfile } from "workbench-shared/types";
import { formatHarnessLabel } from "./harness-label";

export function getComposerProfileDisplayLabel(profile: WorkbenchComposerProfile, agentLabel?: string | null, modelLabel?: string | null) {
  if (profile.name.trim()) return profile.name.trim();
  const prefix = profile.agentPath ? `${agentLabel || profile.agentPath} on ` : "";
  const details = [modelLabel || profile.model, profile.reasoningEffort].filter(Boolean).join(" ");
  return `${prefix}${formatHarnessLabel(profile.harness)}: ${details}${profile.serviceTier === "fast" ? " ⚡" : ""}`;
}
