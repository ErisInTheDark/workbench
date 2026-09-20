/*
 * Exports:
 * - default OpenCodeTranscriptReader: project canonical SQLite transcript pages for OpenCode threads.
 */
import type { WorkbenchTranscriptReadRequest, WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadPage, WorkbenchThreadPageResult } from "workbench-shared/workbench/thread/thread-actions";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import { readWorkbenchThreadPageNextCursor } from "workbench-shared/workbench/thread/workbench-thread-page";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";

export default class OpenCodeTranscriptReader {
  constructor(private readonly readSnapshot: (request: WorkbenchTranscriptReadRequest) => Promise<WorkbenchTranscriptSnapshot | null>) {}

  async readPage(input: WorkbenchThreadPage, entry: WorkbenchThreadSidebarEntry | null): Promise<WorkbenchThreadPageResult | null> {
    const catalog = await this.readSnapshot({ threadId: input.threadId, turnIds: [], turnLimit: 1 });
    if (!catalog) return null;
    const boundary = input.cursor === null ? undefined : catalog.turns.find(turn => turn.id === input.cursor);
    if (input.cursor !== null && !boundary) throw new Error("The requested OpenCode page boundary does not belong to this thread.");
    const snapshot = await this.readSnapshot({
      threadId: catalog.thread.id,
      beforeTurnIndex: boundary?.turn_index,
      turnLimit: 20,
    });
    if (!snapshot) return null;
    const projected = projectWorkbenchTranscript(snapshot);
    if (!projected.success) throw new Error("Stored OpenCode transcript could not be projected.");
    const saved = entry?.entryKind === "draft" ? null : entry;
    const settings = saved?.profile?.settings;
    const questionnaireEntries: WorkbenchThreadPageResult["questionnaireEntries"] = [];
    const steerEntries: WorkbenchThreadPageResult["steerEntries"] = [];
    const roots = new Map(snapshot.rows.threadItems.map(root => [root.public_id, root]));
    const inputs = new Map(snapshot.rows.threadItemUserMessages.map(row => [row.item_id, row]));
    const turns = projected.data.turns.map(turn => {
      const items: ThreadItem[] = [];
      for (const item of turn.items) {
        if ("requestKey" in item) {
          questionnaireEntries.push({
            threadId: snapshot.thread.id,
            turnId: turn.id,
            itemId: item.id,
            requestKey: item.requestKey,
            request: item.request,
            response: item.response,
            resolvedAt: item.resolvedAt,
            insertAfterItemId: items.at(-1)?.id ?? null,
            insertAfterItemIndex: items.length - 1,
          });
          continue;
        }
        if (item.type === "generic") {
          const value = item.safeValue;
          items.push({
            type: "dynamicToolCall",
            id: item.id,
            namespace: "opencode",
            tool: item.nativeType,
            arguments: value && typeof value === "object" && !Array.isArray(value) ? value : { value },
            status: "completed",
            contentItems: null,
            success: null,
            durationMs: null,
          });
          continue;
        }
        items.push(item);
        const state = getWorkbenchInputState(item);
        const root = roots.get(item.id);
        const input = root ? inputs.get(root.id) : undefined;
        if (item.type === "userMessage" && state?.kind === "steer") {
          steerEntries.push({
            threadId: snapshot.thread.id,
            turnId: turn.id,
            itemId: item.id,
            entryKey: item.id,
            input: item.content,
            status: state.status,
            attemptedAt: root?.created_at ?? snapshot.thread.created_at,
            resolvedAt: root?.updated_at ?? null,
            requestId: null,
            canonicalItemId: state.status === "sent" ? item.id : null,
            clientUserMessageId: item.clientId,
            error: input?.error_text ?? null,
          });
        }
      }
      return { ...turn, items };
    });
    const pageThread = { turns, workbenchTurnHistory: projected.data.turnHistory };
    const nextCursor = readWorkbenchThreadPageNextCursor(pageThread);
    return {
      browseResultEntries: projected.data.browseResultEntries,
      questionnaireEntries,
      steerEntries,
      entryScope: { mode: "turns", turnIds: snapshot.loadedTurnIds },
      nextCursor,
      thread: {
        id: WorkbenchThreadIdSchema.parse(snapshot.thread.id),
        isDraft: false,
        harness: "opencode",
        name: saved?.title ?? snapshot.thread.title,
        preview: "",
        cwd: snapshot.turns.at(-1)?.native_location ?? snapshot.thread.project_root,
        createdAt: snapshot.thread.created_at / 1000,
        updatedAt: snapshot.thread.updated_at / 1000,
        recencyAt: snapshot.thread.activity_at / 1000,
        status: saved?.lifecycle.kind === "working" ? "active"
          : saved?.lifecycle.kind === "needsAttention" && saved.lifecycle.reason === "pendingInput"
            ? "active:waitingOnUserInput" : saved ? "idle" : "notLoaded",
        source: saved?.entryKind === "subagent" ? "subAgent" : "unknown",
        agentNickname: saved?.entryKind === "subagent" ? saved.name : null,
        agentRole: null,
        path: null,
        model: settings?.model ?? null,
        reasoningEffort: settings?.reasoningEffort ?? null,
        serviceTier: settings?.serviceTier ?? null,
        agentPath: settings?.agentPath ?? null,
        tokenUsage: null,
        turns,
        turnHistory: projected.data.turnHistory,
        nextPageCursor: nextCursor,
        browseResultEntries: projected.data.browseResultEntries,
      },
    };
  }
}
