/*
 * Exports:
 * - normalizeComposerProfile/normalizeComposerProfileMutation: daemon profile boundary normalization.
 * - applyComposerProfileMutation: deterministic daemon profile mutation semantics.
 */
import type {
  WorkbenchComposerProfile,
  WorkbenchComposerProfileMutation,
  WorkbenchComposerSettings,
  WorkbenchHarness,
} from "../../types.ts";
import { z } from "zod";
import { normalizeWorkbenchAgentPath } from "../agent-paths.ts";
import { ProviderKeySchema } from "../provider/provider-key.ts";

const ProfileChangesSchema = z.object({
  contextWindowTokens: z.number().int().positive().nullable(),
  agentPath: z.string().nullable(),
  agentSource: z.enum(["library", "project"]).nullable(),
  description: z.string(),
  model: z.string().trim().min(1),
  name: z.string(),
  reasoningEffort: z.string().nullable(),
  scope: z.union([
    z.object({ kind: z.literal("global") }).strict(),
    z.object({ kind: z.literal("project"), projectId: z.string().trim().min(1) }).strict(),
  ]),
  serviceTier: z.literal("fast").nullable(),
}).partial().strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeHarness(value: unknown): WorkbenchHarness | null {
  const parsed = ProviderKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
  const context = ProfileChangesSchema.shape.contextWindowTokens.safeParse(value.contextWindowTokens);
  if (!context.success) return null;
  return {
    ...(context.data !== undefined ? { contextWindowTokens: context.data } : {}),
    agentPath,
    agentSource: agentPath && (value.agentSource === "library" || value.agentSource === "project") ? value.agentSource : null,
    harness,
    model,
    reasoningEffort: typeof value.reasoningEffort === "string" && value.reasoningEffort.trim() ? value.reasoningEffort.trim() : null,
    serviceTier: value.serviceTier === "fast" ? "fast" : null,
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
    if (!profile) return null;
    if (value.changes === undefined) return { kind: "upsert", profile };
    const changes = ProfileChangesSchema.safeParse(value.changes);
    return changes.success ? { kind: "upsert", profile, changes: changes.data } : null;
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
  if (mutation.changes) {
    const existing = profiles[existingIndex];
    if (!existing) throw new Error("The composer profile does not exist.");
    const profile = normalizeComposerProfile({
      ...existing, ...mutation.changes, id: existing.id, harness: existing.harness,
      createdAt: existing.createdAt, updatedAt: Date.now(),
    });
    if (!profile || (profile.scope.kind === "global" && profile.agentSource === "project")) {
      throw new Error("The composer profile settings or scope are invalid.");
    }
    return profiles.map((entry, index) => index === existingIndex ? profile : entry);
  }
  if (mutation.profile.scope.kind === "global" && mutation.profile.agentSource === "project") {
    throw new Error("Profiles using a project agent cannot be global.");
  }
  return existingIndex < 0
    ? [...profiles, mutation.profile]
    : profiles.map((profile, index) => index === existingIndex ? mutation.profile : profile);
}
