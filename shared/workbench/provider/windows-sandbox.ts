/*
 * Exports:
 * - WINDOWS_SANDBOX_ERROR_LIMIT: longest setup failure message carried to clients.
 * - WindowsSandboxStatusSchema/WindowsSandboxStatus: whether one daemon's agent shells get Codex's elevated Windows sandbox.
 */
import { z } from "zod";

export const WINDOWS_SANDBOX_ERROR_LIMIT = 2000;

export const WindowsSandboxStatusSchema = z.discriminatedUnion("state", [
  /** The daemon is not on Windows. */
  z.object({ state: z.literal("unsupported") }).strict(),
  /** Elevated setup never ran; shells use the restricted-token sandbox. */
  z.object({ state: z.literal("not-set-up") }).strict(),
  /** Elevated setup is stale after a Codex update; shells use the restricted-token sandbox until it reruns. */
  z.object({ state: z.literal("update-required") }).strict(),
  z.object({ state: z.literal("setting-up") }).strict(),
  z.object({ state: z.literal("ready") }).strict(),
  /** The last setup attempt failed and the elevated sandbox is still not ready. */
  z.object({ state: z.literal("failed"), error: z.string().max(WINDOWS_SANDBOX_ERROR_LIMIT) }).strict(),
]);
export type WindowsSandboxStatus = z.infer<typeof WindowsSandboxStatusSchema>;
