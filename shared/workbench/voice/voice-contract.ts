/*
 * Exports:
 * - VoiceRequestSchema/VoiceRequest: private native process commands.
 * - TranscriptDeltaSchema/TranscriptDelta: revisioned text and retained beam evidence.
 * - VoiceEventSchema/VoiceEvent: native readiness, transcript and session outcomes.
 */
import { z } from "zod";

const sessionId = z.string().min(1).max(128);
const position = z.number().int().nonnegative();
const hypothesis = z.object({
  text: z.string(),
  tokens: z.array(z.string()),
  timestamps: z.array(z.number().finite().nonnegative()),
  score: z.number().finite(),
});
const alternative = z.object({
  start: position,
  end: position,
  options: z.array(z.object({
    text: z.string(),
    // Support within the retained beam, not calibrated recognition probability.
    confidence: z.number().finite().min(0).max(1),
  })).min(2).max(3),
}).refine(span => span.start <= span.end);

export const TranscriptDeltaSchema = z.object({
  sessionId,
  revision: z.number().int().positive(),
  segment: position,
  // A final segment is immutable history, not necessarily the end of the session.
  isFinal: z.boolean(),
  stableText: z.string(),
  unstableText: z.string(),
  alternatives: z.array(alternative),
  // Endpoint reset can temporarily add a blank seed beyond max_active_paths.
  hypotheses: z.array(hypothesis).min(1).max(64),
  inlineText: z.string(),
}).refine(delta => {
  const length = delta.stableText.length + delta.unstableText.length;
  return delta.alternatives.every((span, index, spans) =>
    span.end <= length && (index === 0 || spans[index - 1]!.end <= span.start));
});
export type TranscriptDelta = z.infer<typeof TranscriptDeltaSchema>;

export const VoiceRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), sessionId }).strict(),
  z.object({
    type: z.literal("audio"),
    sessionId,
    // Base64 signed PCM16 little-endian, 16 kHz mono, at most one second.
    pcm: z.string().min(4).max(42668),
  }).strict(),
  z.object({ type: z.literal("finish"), sessionId }).strict(),
  z.object({ type: z.literal("cancel"), sessionId }).strict(),
]);
export type VoiceRequest = z.infer<typeof VoiceRequestSchema>;

export const VoiceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), version: z.literal(1) }),
  z.object({ type: z.literal("started"), sessionId }),
  z.object({ type: z.literal("transcript"), delta: TranscriptDeltaSchema }),
  z.object({ type: z.literal("finished"), sessionId }),
  z.object({ type: z.literal("cancelled"), sessionId }),
  z.object({ type: z.literal("error"), sessionId: sessionId.nullable(), message: z.string().max(512) }),
]);
export type VoiceEvent = z.infer<typeof VoiceEventSchema>;
