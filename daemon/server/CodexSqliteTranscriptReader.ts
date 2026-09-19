/*
 * Exports:
 * - default CodexSqliteTranscriptReader: read canonical pages, derive stale-turn settlement, and resolve stored file changes.
 */
import type { CodexThreadContextReadResponse } from "workbench-shared/codex/thread-context";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";

import type { WorkbenchTranscriptReadRequest, WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { WorkbenchThreadHydrationRequest } from "./lib/codex/thread-hydration";
import type { WorkbenchTranscriptContextSnapshot, WorkbenchTranscriptObservation } from "./database/transcript/workbench-transcript-types";
import { NativeThreadIdSchema, NativeTurnIdSchema, WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadPage, WorkbenchThreadPageResult } from "workbench-shared/workbench/thread/thread-actions";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import { readWorkbenchThreadPageNextCursor } from "workbench-shared/workbench/thread/workbench-thread-page";
import { toThreadTurn } from "workbench-shared/codex/thread-adapter";

export default class CodexSqliteTranscriptReader {
  constructor(
    private readonly readSnapshot: (request: WorkbenchTranscriptReadRequest) => Promise<WorkbenchTranscriptSnapshot | null>,
    private readonly readContext: (threadId: string) => Promise<WorkbenchTranscriptContextSnapshot | null>,
    private readonly readMaterializedTurns: (threadId: string, turnIds: readonly string[]) => Promise<string[]>,
  ) {}

  catalog(threadId: string) {
    return this.readSnapshot({ threadId, turnIds: [], turnLimit: 1 });
  }

  async readPage(input: WorkbenchThreadPage, entry: WorkbenchThreadSidebarEntry | null): Promise<WorkbenchThreadPageResult | null> {
    const catalog = await this.catalog(input.threadId);
    if (!catalog) return null;
    const boundary = input.cursor === null ? null : catalog.turns.find(turn => turn.id === input.cursor);
    if (input.cursor !== null && !boundary) throw new Error("The requested page boundary does not belong to this thread.");
    const candidates = boundary ? catalog.turns.filter(turn => turn.turn_index < boundary.turn_index) : catalog.turns;
    const materialized = new Set(await this.readMaterializedTurns(catalog.thread.id, candidates.map(turn => turn.id)));
    const selected = boundary ? candidates.at(-1) : candidates.findLast(turn => materialized.has(turn.id));
    if ((selected && !materialized.has(selected.id)) || (!selected && candidates.length)) return null;
    const snapshot = selected
      ? await this.readSnapshot({ threadId: catalog.thread.id, turnIds: [selected.id], turnLimit: 1 })
      : catalog;
    if (!snapshot) return null;
    const { turns, turnHistory, ...entries } = this.content(snapshot);
    const pageThread = { turns, workbenchTurnHistory: turnHistory };
    const nextCursor = readWorkbenchThreadPageNextCursor(pageThread);
    const saved = entry?.entryKind === "draft" ? null : entry;
    const settings = saved?.profile?.settings;
    return {
      ...entries, nextCursor,
      thread: {
        id: WorkbenchThreadIdSchema.parse(snapshot.thread.id), isDraft: false, harness: "codex",
        name: saved?.title ?? snapshot.thread.title, preview: "",
        cwd: selected?.native_location ?? catalog.turns.at(-1)?.native_location ?? snapshot.thread.project_root,
        createdAt: snapshot.thread.created_at / 1000, updatedAt: snapshot.thread.updated_at / 1000,
        recencyAt: snapshot.thread.activity_at / 1000,
        status: saved?.lifecycle.kind === "working" ? "active"
          : saved?.lifecycle.kind === "needsAttention" && saved.lifecycle.reason === "pendingInput" ? "active:waitingOnUserInput"
            : saved ? "idle" : "notLoaded",
        source: saved?.entryKind === "subagent" ? "subAgent" : "unknown",
        agentNickname: saved?.entryKind === "subagent" ? saved.name : null,
        agentRole: null, path: null, model: settings?.model ?? null, reasoningEffort: settings?.reasoningEffort ?? null,
        serviceTier: settings?.serviceTier ?? null, agentPath: settings?.agentPath ?? null, tokenUsage: null,
        turns: turns.map(turn => toThreadTurn(turn)), turnHistory, nextPageCursor: nextCursor,
        browseResultEntries: entries.browseResultEntries,
      },
    };
  }

  async storedTurnSettlement(threadId: string, turnReference: string, completedAt: number): Promise<WorkbenchTranscriptObservation[]> {
    const catalog = await this.catalog(threadId);
    const turn = catalog?.turns.find(turn => turn.id === turnReference || turn.native_turn_id === turnReference);
    if (!catalog || !turn || turn.state !== "inProgress" || catalog.turns.at(-1)?.id !== turn.id) return [];
    const snapshot = await this.readSnapshot({ threadId: catalog.thread.id, turnIds: [turn.id], turnLimit: 1 });
    if (!snapshot) throw new Error("Stored recovery turn is not materialised.");
    const projection = projectWorkbenchTranscript(snapshot);
    if (!projection.success) throw new Error("Stored recovery turn could not be projected.");
    const current = snapshot.turns.find(candidate => candidate.id === turn.id)!;
    if (current.state !== "inProgress" || snapshot.turns.at(-1)?.id !== current.id) return [];
    const ownerThreadId = WorkbenchThreadIdSchema.parse(snapshot.thread.id);
    const turnId = WorkbenchTurnIdSchema.parse(current.id);
    const endedAt = Math.max(current.started_at ?? 0, Math.round(completedAt * 1000));
    const observations: WorkbenchTranscriptObservation[] = [{
      kind: "turn", threadId: ownerThreadId, turnId,
      ...(current.native_turn_id === null ? { nativeTurnId: null } : { nativeTurnId: NativeTurnIdSchema.parse(current.native_turn_id) }),
      nativeThreadId: NativeThreadIdSchema.parse(current.native_thread_id), nativeLocation: current.native_location,
      harnessId: current.harness_id, state: "interrupted", createdAt: current.created_at,
      startedAt: current.started_at, endedAt, durationMs: current.started_at === null ? null : endedAt - current.started_at,
    }];
    for (const item of projection.data.turns.find(candidate => candidate.id === current.id)?.items ?? []) {
      if (!("status" in item) || item.status !== "inProgress") continue;
      switch (item.type) {
        case "commandExecution":
        case "dynamicToolCall":
        case "fileChange":
        case "mcpToolCall":
        case "collabAgentToolCall":
          observations.push({
            kind: "item", threadId: ownerThreadId, turnId, publicItemId: WorkbenchItemIdSchema.parse(item.id),
            item: item.type === "collabAgentToolCall" ? { ...item, status: "interrupted" } : { ...item, status: "completed" },
            lifecycle: "completed", observedAt: endedAt,
          });
      }
    }
    return observations;
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

  project(metadata: Thread, snapshot: WorkbenchTranscriptSnapshot): CodexThreadContextReadResponse {
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
    const directRoot = snapshot.rows.threadItems.find(candidate => (
      candidate.turn_id === turn.id && candidate.public_id === itemId
    ));
    const source = directRoot ? null : snapshot.rows.itemSourceAliases.find(candidate => (
      candidate.turn_id === turn.id
      && candidate.reference === itemId
      && candidate.component_kind === "item"
      && candidate.component_index === 0
    ));
    const root = directRoot ?? snapshot.rows.threadItems.find(candidate => (
      candidate.turn_id === turn.id && candidate.public_id === source?.item_identity_id
    ));
    if (!root) return null;
    const projection = projectWorkbenchTranscript(snapshot);
    if (!projection.success) throw new Error("Stored SQL transcript could not be projected.");
    const projectedId = root.public_id;
    const item = projection.data.turns.flatMap(candidate => candidate.items).find(candidate => candidate.id === projectedId);
    return item?.type === "fileChange" ? item : null;
  }

  private content(snapshot: WorkbenchTranscriptContextSnapshot) {
    const projected = projectWorkbenchTranscript(snapshot);
    if (!projected.success) throw new Error("Stored SQL transcript could not be projected.");
    const projection = projected.data;
    const questionnaireEntries: CodexThreadContextReadResponse["questionnaireEntries"] = [];
    const steerEntries: CodexThreadContextReadResponse["steerEntries"] = [];
    const roots = new Map(snapshot.rows.threadItems.map(root => [root.public_id, root]));
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
            const entry = payload as unknown as CodexThreadContextReadResponse["steerEntries"][number];
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
