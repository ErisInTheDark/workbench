/*
 * Exports:
 * - WorkbenchProviderRecovery: refresh a managed turn through its provider's captured context.
 */
import type { WorkbenchThreadId } from "../identity";

export interface WorkbenchProviderRecovery {
  refresh(threadId: WorkbenchThreadId): Promise<void>;
}
