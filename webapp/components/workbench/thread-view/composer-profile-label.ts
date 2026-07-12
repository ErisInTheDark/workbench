/*
 * Exports:
 * - getComposerProfileDisplayLabel: derive a profile's custom or settings-based display label without persisting fallback text. Keywords: composer, profile, label, fallback.
 */
import type { WorkbenchComposerProfile } from "../../../lib/types";
import { formatHarnessLabel } from "./ThreadHarnessControl";

export function getComposerProfileDisplayLabel(profile: WorkbenchComposerProfile, agentLabel?: string | null, modelLabel?: string | null) {
  if (profile.name.trim()) return profile.name.trim();
  const prefix = profile.agentPath ? `${agentLabel || profile.agentPath} on ` : "";
  const details = [modelLabel || profile.model, profile.reasoningEffort].filter(Boolean).join(" ");
  return `${prefix}${formatHarnessLabel(profile.harness)}: ${details}${profile.serviceTier === "fast" ? " ⚡" : ""}`;
}
