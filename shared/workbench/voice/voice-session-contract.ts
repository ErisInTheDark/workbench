/*
 * Exports:
 * - VoiceConfigurationSchema/VoiceConfiguration: reload-compatible configuration wire shape.
 * - VoiceModelSelection: the complete user-configurable transformer settings.
 * - readVoiceModelSelection/createVoiceConfiguration: isolate legacy composer-shaped transport.
 * - VoiceSessionEventSchema/VoiceSessionEvent: connection-local voice outcomes.
 * - VoiceStartSchema/VoiceStart: controlled-document admission.
 * - VoiceAudioSchema/VoiceAudio: bounded ordered PCM frames.
 */
import { z } from "zod";
import { WorkbenchComposerProfileSelectionSchema } from "../thread/thread-state";
import { TranscriptDeltaSchema } from "./voice-contract";
import type { WorkbenchComposerSettings } from "../../types";

export const VoiceConfigurationSchema = z.object({
  selection: WorkbenchComposerProfileSelectionSchema.nullable(),
}).strict();
export type VoiceConfiguration = z.infer<typeof VoiceConfigurationSchema>;
export type VoiceModelSelection = Pick<WorkbenchComposerSettings, "harness" | "model">;

export function readVoiceModelSelection(value: VoiceConfiguration): VoiceModelSelection | null {
  const settings = value.selection?.settings;
  return settings ? { harness: settings.harness, model: settings.model } : null;
}

export function createVoiceConfiguration(settings: VoiceModelSelection | null): VoiceConfiguration {
  return { selection: settings ? { kind: "custom", settings: {
    ...settings, agentPath: null, agentSource: null, reasoningEffort: "none",
    serviceTier: null, contextWindowTokens: null,
  } } : null };
}
const sessionId = z.string().uuid();
export const VoiceStartSchema = z.object({
  sessionId, text: z.string().max(1_000_000), recordAudio: z.boolean().default(false),
}).strict();
export type VoiceStart = z.input<typeof VoiceStartSchema>;
export const VoiceAudioSchema = z.object({
  sessionId, sequence: z.number().int().nonnegative(),
  pcm: z.string().min(4).max(42668).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();
export type VoiceAudio = z.infer<typeof VoiceAudioSchema>;
export const VoiceSessionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), sessionId, state: z.enum(["preparing", "listening", "finishing"]) }).strict(),
  z.object({ type: z.literal("transcript"), sessionId, delta: TranscriptDeltaSchema }).strict(),
  z.object({ type: z.literal("document"), sessionId, revision: z.number().int().positive(), text: z.string().max(1_000_000) }).strict(),
  z.object({ type: z.literal("finished"), sessionId }).strict(),
  z.object({ type: z.literal("cancelled"), sessionId }).strict(),
  z.object({ type: z.literal("error"), sessionId, message: z.string().max(512) }).strict(),
]);
export type VoiceSessionEvent = z.infer<typeof VoiceSessionEventSchema>;
