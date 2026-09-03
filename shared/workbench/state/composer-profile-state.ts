/*
 * Exports:
 * - normalizeComposerProfile/normalizeComposerProfileMutation: daemon profile boundary normalization. Keywords: composer, profile, normalize, validation.
 * - applyComposerProfileMutation: deterministic daemon profile mutation semantics. Keywords: composer, profile, mutation.
 */
import type {
  WorkbenchComposerProfile,
  WorkbenchComposerProfileMutation,
  WorkbenchComposerSettings,
  WorkbenchHarness,
} from "../../types.ts";
import { normalizeWorkbenchAgentPath } from "../agent-paths.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeHarness(value: unknown): WorkbenchHarness | null {
  return value === "codex" || value === "copilot" || value === "opencode" ? value : null;
}

function normalizeDescription(value: unknown) {
  if (typeof value !== "string") return null;
  const description = value.replace(/\r\n?/gu, "\n").trim();
  return description || null;
}

function normalizeSettings(value: unknown): WorkbenchComposerSettings | null {
  if (!isRecord(value)) return null;
  const harness = normalizeHarness(value.harness);
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!harness || !model) return null;
  const agentPath = normalizeWorkbenchAgentPath(typeof value.agentPath === "string" ? value.agentPath : null);
  return {
    agentPath,
    agentSource: agentPath && (value.agentSource === "library" || value.agentSource === "project") ? value.agentSource : null,
    harness,
    model,
    reasoningEffort: typeof value.reasoningEffort === "string" && value.reasoningEffort.trim() ? value.reasoningEffort.trim() : null,
    serviceTier: harness === "codex" && value.serviceTier === "fast" ? "fast" : null,
  };
}

export function normalizeComposerProfile(value: unknown): WorkbenchComposerProfile | null {
  const settings = normalizeSettings(value);
  if (!settings || !isRecord(value)) return null;
  const description = normalizeDescription(value.description);
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const scope = isRecord(value.scope) && value.scope.kind === "global"
    ? { kind: "global" as const }
    : isRecord(value.scope) && value.scope.kind === "project" && typeof value.scope.projectId === "string" && value.scope.projectId.trim()
      ? { kind: "project" as const, projectId: value.scope.projectId.trim() }
      : null;
  if (!id || !scope) return null;
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
    ? Math.max(0, Math.trunc(value.createdAt))
    : Date.now();
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
    ? Math.max(createdAt, Math.trunc(value.updatedAt))
    : createdAt;
  return { ...settings, createdAt, ...(description ? { description } : {}), id, name, scope, updatedAt };
}

export function normalizeComposerProfileMutation(value: unknown): WorkbenchComposerProfileMutation | null {
  if (!isRecord(value)) return null;
  if (value.kind === "delete" && typeof value.profileId === "string" && value.profileId.trim()) {
    return { kind: "delete", profileId: value.profileId.trim() };
  }
  if (value.kind === "upsert") {
    const profile = normalizeComposerProfile(value.profile);
    return profile ? { kind: "upsert", profile } : null;
  }
  return null;
}

export function applyComposerProfileMutation(
  profiles: readonly WorkbenchComposerProfile[],
  mutation: WorkbenchComposerProfileMutation,
) {
  if (mutation.kind === "delete") {
    return profiles.filter((profile) => profile.id !== mutation.profileId);
  }
  const existingIndex = profiles.findIndex((profile) => profile.id === mutation.profile.id);
  return existingIndex < 0
    ? [...profiles, mutation.profile]
    : profiles.map((profile, index) => index === existingIndex ? mutation.profile : profile);
}
