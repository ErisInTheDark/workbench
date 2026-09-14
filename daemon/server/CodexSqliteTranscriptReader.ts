/*
 * Exports:
 * - default CodexSqliteTranscriptReader: project SQL windows and resolve typed stored file changes.
 */
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { WorkbenchThreadContextReadResponse } from "workbench-shared/types";
import type { WorkbenchTranscriptReadRequest, WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { WorkbenchThreadHydrationRequest } from "./lib/codex/thread-hydration";
import type { WorkbenchTranscriptContextSnapshot } from "./database/transcript/workbench-transcript-types";

export default class CodexSqliteTranscriptReader {
  constructor(
    private readonly readSnapshot: (request: WorkbenchTranscriptReadRequest) => Promise<WorkbenchTranscriptSnapshot | null>,
    private readonly readContext: (threadId: string) => Promise<WorkbenchTranscriptContextSnapshot | null>,
  ) {}

  catalog(threadId: string) {
    return this.readSnapshot({ threadId, turnIds: [], turnLimit: 1 });
  }

  async read(metadata: Thread, hydration: WorkbenchThreadHydrationRequest | null) {
    const catalog = await this.catalog(metadata.id);
    if (!catalog) return null;
    const beforeId = hydration?.mode === "previous" ? hydration.beforeTurnId : null;
    const before = beforeId === null ? null : catalog.turns.find(turn => turn.id === beforeId || turn.native_turn_id === beforeId);
    if (beforeId !== null && !before) return null;
    const candidates = before ? catalog.turns.filter(turn => turn.turn_index < before.turn_index) : catalog.turns;
    const selected = hydration?.mode === "legacyFull" || hydration === null ? candidates : candidates.slice(-1);
    const snapshot = selected.length
      ? await this.readSnapshot({ threadId: catalog.thread.id, turnIds: selected.map(turn => turn.id), turnLimit: 1 })
      : catalog;
    return snapshot ? this.project(metadata, snapshot) : null;
  }

  project(metadata: Thread, snapshot: WorkbenchTranscriptSnapshot): WorkbenchThreadContextReadResponse {
    const { turns, turnHistory, ...entries } = this.content(snapshot);
    return {
      ...entries,
      thread: Object.assign({
        ...metadata, id: snapshot.thread.id, turns,
        createdAt: snapshot.thread.created_at / 1000,
        updatedAt: snapshot.thread.updated_at / 1000,
      }, { workbenchTurnHistory: turnHistory }),
    };
  }

  async history(threadId: string) {
    const snapshot = await this.readContext(threadId);
    return snapshot ? this.content(snapshot) : { questionnaireEntries: [], steerEntries: [], browseResultEntries: [] };
  }

  async readFileChange(threadId: string, turnId: string, itemId: string): Promise<WorkbenchFileChangeItem | null> {
    const catalog = await this.catalog(threadId);
    const turn = catalog?.turns.find(candidate => candidate.id === turnId || candidate.native_turn_id === turnId);
    if (!catalog || !turn) return null;
    const snapshot = await this.readSnapshot({ threadId: catalog.thread.id, turnIds: [turn.id], turnLimit: 1 });
    if (!snapshot) return null;
    const root = snapshot.rows.threadItems.find(candidate => (
      candidate.turn_id === turn.id && (candidate.public_id === itemId || candidate.source_id === itemId)
    ));
    if (!root) return null;
    const projection = projectWorkbenchTranscript(snapshot);
    if (!projection.success) throw new Error("Stored SQL transcript could not be projected.");
    const projectedId = root.public_id ?? root.source_id;
    const item = projection.data.turns.flatMap(candidate => candidate.items).find(candidate => candidate.id === projectedId);
    return item?.type === "fileChange" ? item : null;
  }

  private content(snapshot: WorkbenchTranscriptContextSnapshot) {
    const projected = projectWorkbenchTranscript(snapshot);
    if (!projected.success) throw new Error("Stored SQL transcript could not be projected.");
    const projection = projected.data;
    const questionnaireEntries: WorkbenchThreadContextReadResponse["questionnaireEntries"] = [];
    const steerEntries: WorkbenchThreadContextReadResponse["steerEntries"] = [];
    const roots = new Map(snapshot.rows.threadItems.map(root => [root.public_id ?? root.source_id, root]));
    const inputs = new Map(snapshot.rows.threadItemUserMessages.map(row => [row.item_id, row]));
    const turns = projection.turns.map(turn => {
      const items: ThreadItem[] = [];
      const excluded = new Set(turn.items.filter(item => "requestKey" in item
        || (item.type === "generic" && item.nativeType === "workbenchSteer")).map(item => item.id));
      const order = snapshot.contextItemOrder?.find(entry => entry.turnId === turn.id)?.itemIds;
      for (const item of turn.items) {
        if ("requestKey" in item) {
          const predecessors = order?.slice(0, order.indexOf(item.id)).filter(id => !excluded.has(id))
            ?? items.map(item => item.id);
          questionnaireEntries.push({
            threadId: snapshot.thread.id, turnId: turn.id, itemId: item.id, requestKey: item.requestKey,
            request: item.request, response: item.response, resolvedAt: item.resolvedAt,
            insertAfterItemId: predecessors.at(-1) ?? null, insertAfterItemIndex: predecessors.length - 1,
          });
          continue;
        }
        if (item.type === "generic") {
          // The retained native response preserves unknown provider payloads at its existing boundary.
          const value = item.safeValue;
          const payload = value && typeof value === "object" && !Array.isArray(value) ? value : { value };
          if (item.nativeType === "workbenchSteer" && Array.isArray(payload.input)) {
            // Audio steers retain the typed entry as opaque JSON until the input schema supports them.
            const entry = payload as unknown as WorkbenchThreadContextReadResponse["steerEntries"][number];
            steerEntries.push({ ...entry, itemId: item.id, threadId: snapshot.thread.id, turnId: turn.id });
            continue;
          }
          items.push({ ...payload, id: item.id, type: item.nativeType } as ThreadItem);
          continue;
        }
        items.push(item);
        const root = roots.get(item.id);
        const input = root ? inputs.get(root.id) : undefined;
        if (item.type === "userMessage" && root && input?.input_kind === "steer") {
          steerEntries.push({
            threadId: snapshot.thread.id, turnId: turn.id, itemId: item.id, entryKey: item.id,
            input: item.content, status: input.delivery_state === "delivered" ? "sent" : input.delivery_state,
            attemptedAt: root.created_at, resolvedAt: root.updated_at, requestId: null,
            canonicalItemId: input.delivery_state === "delivered" ? item.id : null,
            clientUserMessageId: input.client_id, error: input.error_text,
          });
        }
      }
      return { ...turn, items };
    });
    return {
      browseResultEntries: projection.browseResultEntries, questionnaireEntries, steerEntries,
      entryScope: { mode: "turns" as const, turnIds: snapshot.loadedTurnIds },
      turns, turnHistory: projection.turnHistory,
    };
  }
}
