/*
 * Exports:
 * - copyComposerSettings: copy only profile-owned settings.
 * - resolveLinkedProfileSelection: resolve a stored profile link against current definitions, falling back to saved Custom settings.
 * - WorkbenchThreadCreationProfileSchema: validate creation sources before provider forwarding.
 * - contextCompactionThreshold: reserve fixed or proportional context headroom.
 * - WorkbenchModelContextCapabilitySchema: validated configurable model bounds.
 */
import { z } from "zod";
import type {
  WorkbenchComposerProfile,
  WorkbenchComposerProfileTargetSelection,
  WorkbenchComposerSettings,
  WorkbenchHarness,
  WorkbenchModelContextCapability,
  WorkbenchThreadCreationProfile,
} from "../../types.ts";
import { WorkbenchComposerProfileSelectionSchema, WorkbenchComposerProfileSlotSchema } from "./thread-state.ts";

export function copyComposerSettings(settings: WorkbenchComposerSettings): WorkbenchComposerSettings {
  return {
    agentPath: settings.agentPath, agentSource: settings.agentSource,
    harness: settings.harness, model: settings.model,
    reasoningEffort: settings.reasoningEffort, serviceTier: settings.serviceTier,
    ...(settings.harness !== "opencode" && settings.contextWindowTokens !== undefined ? { contextWindowTokens: settings.contextWindowTokens } : {}),
  };
}

// A linked selection resolves its stored profile's current definition; saved settings
// only survive as Custom when the definition is gone or its provider no longer fits.
export function resolveLinkedProfileSelection(
  profiles: readonly WorkbenchComposerProfile[],
  link: { profileId: string; settings: WorkbenchComposerSettings | null },
  constraint?: { harness?: WorkbenchHarness },
): WorkbenchComposerProfileTargetSelection | null {
  const definition = profiles.find((profile) => profile.id === link.profileId);
  if (definition && (!constraint?.harness || definition.harness === constraint.harness)) {
    return { kind: "profile", profileId: link.profileId, settings: copyComposerSettings(definition) };
  }
  return link.settings ? { kind: "custom", settings: link.settings } : null;
}

export const WorkbenchThreadCreationProfileSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("target"), slot: WorkbenchComposerProfileSlotSchema }).strict(),
  z.object({ kind: z.literal("snapshot"), selection: WorkbenchComposerProfileSelectionSchema }).strict(),
]) as z.ZodType<WorkbenchThreadCreationProfile>;

export function contextCompactionThreshold(cap: number) {
  return Math.floor(cap - Math.max(50_000, cap * 0.1));
}

export const WorkbenchModelContextCapabilitySchema = z.object({
  model: z.string().min(1),
  defaultTokens: z.number().int().min(51_000),
  maximumTokens: z.number().int().positive(),
}).refine(value => value.maximumTokens >= value.defaultTokens) satisfies z.ZodType<WorkbenchModelContextCapability>;
