/*
 * Exports:
 * - default CodexStoredTranscriptAdapter: adapt canonical history to retained native Codex response contracts.
 */
import type { CodexThreadContextReadResponse } from "workbench-shared/codex/thread-context";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type { WorkbenchThreadHydrationRequest } from "./lib/codex/thread-hydration";
import type WorkbenchTranscriptReader from "./WorkbenchTranscriptReader";

export default class CodexStoredTranscriptAdapter {
  constructor(private readonly canonical: WorkbenchTranscriptReader) {}

  catalog(threadId: string) { return this.canonical.catalog(threadId); }
  storedTurnSettlement(threadId: string, turnReference: string, completedAt: number) {
    return this.canonical.storedTurnSettlement(threadId, turnReference, completedAt);
  }
  readFileChange(threadId: string, turnId: string, itemId: string) {
    return this.canonical.readFileChange(threadId, turnId, itemId);
  }
  history(threadId: string) { return this.canonical.history(threadId); }

  async read(metadata: Thread, hydration: WorkbenchThreadHydrationRequest | null) {
    const catalog = await this.catalog(metadata.id);
    if (!catalog) return null;
    const beforeId = hydration?.mode === "previous" ? hydration.beforeTurnId : null;
    const before = beforeId === null ? null : catalog.turns.find(turn => turn.id === beforeId || turn.native_turn_id === beforeId);
    if (beforeId !== null && !before) return null;
    const candidates = before ? catalog.turns.filter(turn => turn.turn_index < before.turn_index) : catalog.turns;
    const selected = hydration?.mode === "legacyFull" || hydration === null ? candidates : candidates.slice(-1);
    const snapshot = selected.length
      ? await this.canonical.readSnapshot({ threadId: catalog.thread.id, turnIds: selected.map(turn => turn.id), turnLimit: 1 })
      : catalog;
    return snapshot ? this.project(metadata, snapshot) : null;
  }

  project(metadata: Thread, snapshot: WorkbenchTranscriptSnapshot): CodexThreadContextReadResponse {
    const { turns, turnHistory, ...entries } = this.canonical.content(snapshot);
    return {
      ...entries,
      thread: Object.assign({
        ...metadata, id: snapshot.thread.id,
        turns: turns.map(turn => ({
          ...turn,
          items: turn.items.map((item): ThreadItem => {
            if (item.type !== "generic") return item;
            const value = item.safeValue;
            const payload = value && typeof value === "object" && !Array.isArray(value) ? value : { value };
            // Only this retained native-response boundary reconstructs provider-native evidence.
            return { ...payload, id: item.id, type: item.nativeType } as ThreadItem;
          }),
        })),
        createdAt: snapshot.thread.created_at / 1000,
        updatedAt: snapshot.thread.updated_at / 1000,
      }, { workbenchTurnHistory: turnHistory }),
    };
  }
}
