/*
 * Exports:
 * - WorkbenchTranscriptReaderOptions: canonical storage and metadata ports, without provider access.
 * - default WorkbenchTranscriptReader: own canonical pages, history projection and stored recovery facts.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkbenchTranscriptReadRequest, WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { WorkbenchThreadPage, WorkbenchThreadPageResult } from "workbench-shared/workbench/thread/thread-actions";
import { workbenchThreadActions, WorkbenchTranscriptRecoveryRequiredError } from "workbench-shared/workbench/thread/thread-actions";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadContextUsageSnapshot } from "workbench-shared/workbench/thread/thread-context-usage";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import { readWorkbenchThreadPageNextCursor } from "workbench-shared/workbench/thread/workbench-thread-page";
import { NativeThreadIdSchema, NativeTurnIdSchema, WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptContextSnapshot, WorkbenchTranscriptObservation } from "./database/transcript/workbench-transcript-types";

export interface WorkbenchTranscriptReaderOptions {
  readProviderCursor?(threadId: string, turnId: string): Promise<string | null | undefined>;
  readSnapshot(request: WorkbenchTranscriptReadRequest): Promise<WorkbenchTranscriptSnapshot | null>;
  readContext(threadId: string): Promise<WorkbenchTranscriptContextSnapshot | null>;
  readMaterializedTurns(threadId: string, turnIds: readonly string[]): Promise<string[]>;
  readContextUsage(threadId: string): Promise<ThreadContextUsageSnapshot | null>;
  readMetadata(thread: WorkbenchTranscriptSnapshot["thread"], provenance: string | null): Promise<{
    entry: WorkbenchThreadSidebarEntry | null;
    harness: WorkbenchHarness;
  }>;
}

export default class WorkbenchTranscriptReader {
  constructor(private readonly options: WorkbenchTranscriptReaderOptions) {}

  catalog(threadId: string) {
    return this.options.readSnapshot({ threadId, turnIds: [], turnLimit: 1 });
  }

  readSnapshot(request: WorkbenchTranscriptReadRequest) {
    return this.options.readSnapshot(request);
  }

  async readPage(input: WorkbenchThreadPage): Promise<WorkbenchThreadPageResult> {
    const catalog = await this.catalog(input.threadId);
    if (!catalog) throw new WorkbenchTranscriptRecoveryRequiredError("Canonical SQLite transcript requires explicit recovery.");
    const boundary = input.cursor === null ? null : catalog.turns.find(turn => turn.id === input.cursor);
    if (input.cursor !== null && !boundary) throw new Error("The requested page boundary does not belong to this canonical thread.");
    const candidates = boundary ? catalog.turns.filter(turn => turn.turn_index < boundary.turn_index) : catalog.turns;
    const materialized = new Set(await this.options.readMaterializedTurns(catalog.thread.id, candidates.map(turn => turn.id)));
    const selected = boundary ? candidates.at(-1) : candidates.findLast(turn => materialized.has(turn.id));
    const missing = Boolean((selected && !materialized.has(selected.id)) || (!selected && candidates.length));
    const unknownPrevious = input.recoveryAware && boundary?.native_turn_id && !candidates.length
      && this.options.readProviderCursor && await this.options.readProviderCursor(catalog.thread.id, boundary.id) !== null;
    const recovery: WorkbenchThreadPageResult["recovery"] = missing || unknownPrevious
      ? boundary ? { mode: "previous", beforeTurnId: boundary.id } : { mode: "latest" } : null;
    if (missing && !input.recoveryAware) throw new WorkbenchTranscriptRecoveryRequiredError("The requested canonical SQLite turn is not materialised; explicit transcript recovery is required.");
    const snapshot = selected && !missing
      ? await this.readSnapshot({ threadId: catalog.thread.id, turnIds: [selected.id], turnLimit: 1 })
      : catalog;
    if (!snapshot) throw new Error("The requested canonical SQLite turn is not materialised.");
    const { turns, turnHistory, ...entries } = this.content(snapshot);
    const { entry, harness } = await this.options.readMetadata(snapshot.thread, catalog.turns.at(-1)?.harness_id ?? null);
    const saved = entry?.entryKind === "draft" ? null : entry;
    const settings = saved?.profile?.settings;
    const pageThread = { turns, workbenchTurnHistory: turnHistory };
    let nextCursor = readWorkbenchThreadPageNextCursor(pageThread);
    if (input.recoveryAware && nextCursor === null && selected?.native_turn_id && this.options.readProviderCursor
      && await this.options.readProviderCursor(catalog.thread.id, selected.id) !== null) nextCursor = selected.id;
    let usage: ThreadContextUsageSnapshot | null = null;
    try {
      usage = await this.options.readContextUsage(snapshot.thread.id);
    } catch {
      console.warn("[canonical-transcript] Unable to restore context usage; thread content remains available.");
    }
    return {
      ...entries, nextCursor, ...(input.recoveryAware ? { recovery } : {}),
      thread: {
        id: WorkbenchThreadIdSchema.parse(snapshot.thread.id), isDraft: false, harness,
        name: saved?.title ?? snapshot.thread.title, preview: "",
        cwd: catalog.turns.at(-1)?.native_location ?? snapshot.thread.project_root,
        createdAt: snapshot.thread.created_at / 1000, updatedAt: snapshot.thread.updated_at / 1000,
        recencyAt: snapshot.thread.activity_at / 1000,
        status: saved?.lifecycle.kind === "working" ? "active"
          : saved?.lifecycle.kind === "needsAttention" && saved.lifecycle.reason === "pendingInput"
            ? "active:waitingOnUserInput" : saved ? "idle" : "notLoaded",
        source: saved?.entryKind === "subagent" ? "subAgent" : "unknown",
        agentNickname: saved?.entryKind === "subagent" ? saved.name : null,
        agentRole: null, path: null, model: settings?.model ?? null,
        reasoningEffort: settings?.reasoningEffort ?? null, serviceTier: settings?.serviceTier ?? null,
        agentPath: settings?.agentPath ?? null, tokenUsage: usage?.tokenUsage ?? null,
        turns, turnHistory, nextPageCursor: nextCursor, browseResultEntries: entries.browseResultEntries,
      },
    };
  }

  async history(threadId: string) {
    const snapshot = await this.options.readContext(threadId);
    if (!snapshot) throw new Error("Canonical SQLite transcript history is unavailable.");
    return this.content(snapshot);
  }

  content(snapshot: WorkbenchTranscriptContextSnapshot) {
    const projected = projectWorkbenchTranscript(snapshot);
    if ("issues" in projected) {
      const detail = projected.issues.slice(0, 5).map(issue => `${issue.code} in ${issue.table}`).join(", ");
      throw new Error(`Canonical SQLite transcript projection failed: ${detail.slice(0, 500)}`);
    }
    const questionnaireEntries: WorkbenchThreadPageResult["questionnaireEntries"] = [];
    const steerEntries: WorkbenchThreadPageResult["steerEntries"] = [];
    const roots = new Map(snapshot.rows.threadItems.map(root => [root.public_id, root]));
    const inputs = new Map(snapshot.rows.threadItemUserMessages.map(row => [row.item_id, row]));
    const turns = projected.data.turns.map(turn => {
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
        if (item.type === "generic" && item.nativeType === "workbenchSteer") {
          const retained = workbenchThreadActions["thread/steers/read"].result.safeParse({ data: [item.safeValue] });
          if (!retained.success) throw new Error("Stored Workbench steer history is invalid.");
          const entry = retained.data.data[0]!;
          steerEntries.push({ ...entry, itemId: item.id, threadId: snapshot.thread.id, turnId: turn.id });
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
      turns, turnHistory: projected.data.turnHistory, questionnaireEntries, steerEntries,
      browseResultEntries: projected.data.browseResultEntries,
      entryScope: { mode: "turns" as const, turnIds: snapshot.loadedTurnIds },
    };
  }

  async readFileChange(threadId: string, turnId: string, itemId: string): Promise<WorkbenchFileChangeItem | null> {
    const catalog = await this.catalog(threadId);
    const turn = catalog?.turns.find(candidate => candidate.id === turnId || candidate.native_turn_id === turnId);
    if (!catalog || !turn) return null;
    const snapshot = await this.readSnapshot({ threadId: catalog.thread.id, turnIds: [turn.id], turnLimit: 1 });
    if (!snapshot) return null;
    const direct = snapshot.rows.threadItems.find(root => root.turn_id === turn.id && root.public_id === itemId);
    const alias = direct ? null : snapshot.rows.itemSourceAliases.find(source => source.turn_id === turn.id
      && source.reference === itemId && source.component_kind === "item" && source.component_index === 0);
    const root = direct ?? snapshot.rows.threadItems.find(root => root.turn_id === turn.id && root.public_id === alias?.item_identity_id);
    if (!root) return null;
    const item = this.content(snapshot).turns.flatMap(turn => turn.items).find(item => item.id === root.public_id);
    return item?.type === "fileChange" ? item : null;
  }

  async storedTurnSettlement(threadId: string, turnReference: string, completedAt: number): Promise<WorkbenchTranscriptObservation[]> {
    const catalog = await this.catalog(threadId);
    const turn = catalog?.turns.find(turn => turn.id === turnReference || turn.native_turn_id === turnReference);
    if (!catalog || !turn || turn.state !== "inProgress" || catalog.turns.at(-1)?.id !== turn.id) return [];
    const snapshot = await this.readSnapshot({ threadId: catalog.thread.id, turnIds: [turn.id], turnLimit: 1 });
    if (!snapshot) throw new Error("Stored recovery turn is not materialised.");
    const current = snapshot.turns.find(candidate => candidate.id === turn.id)!;
    if (current.state !== "inProgress" || snapshot.turns.at(-1)?.id !== current.id) return [];
    const ownerThreadId = WorkbenchThreadIdSchema.parse(snapshot.thread.id);
    const turnId = WorkbenchTurnIdSchema.parse(current.id);
    const endedAt = Math.max(current.started_at ?? 0, Math.round(completedAt * 1000));
    const observations: WorkbenchTranscriptObservation[] = [{
      kind: "turn", threadId: ownerThreadId, turnId,
      nativeTurnId: current.native_turn_id === null ? null : NativeTurnIdSchema.parse(current.native_turn_id),
      nativeThreadId: NativeThreadIdSchema.parse(current.native_thread_id), nativeLocation: current.native_location,
      harnessId: current.harness_id, state: "interrupted", createdAt: current.created_at,
      startedAt: current.started_at, endedAt, durationMs: current.started_at === null ? null : endedAt - current.started_at,
    }];
    for (const item of this.content(snapshot).turns.find(candidate => candidate.id === current.id)?.items ?? []) {
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
}
