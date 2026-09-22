/*
 * Exports:
 * - WorkbenchContextAdmission: provider admission, not model receipt.
 * - WorkbenchContextTrigger: input boundary requesting fresh background context.
 * - WorkbenchProviderContext: passive developer context without turn admission.
 */
import type { WorkbenchThreadId } from "../identity.ts";

export type WorkbenchContextAdmission = "admitted" | "unsupported";
export type WorkbenchContextTrigger = "start" | "steer" | "answer";

export interface WorkbenchProviderContext {
  inject(input: { threadId: WorkbenchThreadId; text: string }, signal?: AbortSignal): Promise<WorkbenchContextAdmission>;
}
