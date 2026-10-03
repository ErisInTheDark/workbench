/*
 * Exports:
 * - WorkbenchUnfinishedTurnTarget: completed turn whose agent ended without finishing its task.
 * - WorkbenchProviderRecovery: replay managed turns through their provider's captured context.
 */
import type { WorkbenchThreadId, WorkbenchTurnId } from "../identity";

export interface WorkbenchUnfinishedTurnTarget {
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
}

export interface WorkbenchProviderRecovery {
  /** Manual resume of the current turn through its captured start context. */
  refresh?(threadId: WorkbenchThreadId): Promise<void>;
  /**
   * Start the hidden unfinished-turn continuation with the completed turn's own context. Workbench core owns
   * when this runs; resolve quietly when newer provider work superseded the turn, throw when admission failed.
   */
  continueUnfinished?(target: WorkbenchUnfinishedTurnTarget): Promise<void>;
}
