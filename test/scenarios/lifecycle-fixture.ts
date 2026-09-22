/*
 * Exports:
 * - seedLifecycleTranscript: admit an isolated durable transcript and image for post-migration app checks.
 */
import Database from "better-sqlite3";
import { NativeThreadIdSchema, NativeTurnIdSchema, type ProjectId } from "../../shared/workbench/identity";
import WorkbenchThreadIdentityRepository from "../../daemon/server/database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "../../daemon/server/database/transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchTranscriptRepository from "../../daemon/server/database/transcript/WorkbenchTranscriptRepository";
import externalizeCodexTranscriptInlineImages from "../../daemon/server/codex-transcript-image-assets";
import WorkbenchTranscriptAssetStore from "../../daemon/server/database/transcript/WorkbenchTranscriptAssetStore";

export async function seedLifecycleTranscript(project: string, databasePath: string, projectId: ProjectId) {
  const database = new Database(databasePath, { fileMustExist: true });
  database.pragma("foreign_keys = ON");
  try {
    const threads = new WorkbenchThreadIdentityRepository(database);
    const nativeThreadId = NativeThreadIdSchema.parse("lifecycle-transcript");
    const thread = threads.observe({
      native: { harness: "codex", nativeLocation: project, nativeThreadId },
      projectId, projectRoot: project,
      title: "isolated transcript", createdAt: 1, updatedAt: 2, activityAt: 2,
    });
    const turn = threads.observeTurn({
      kind: "turn", turnId: NativeTurnIdSchema.parse("lifecycle-turn"),
      threadId: thread.threadId, harnessId: "codex", nativeLocation: project,
      nativeThreadId, nativeTurnId: NativeTurnIdSchema.parse("lifecycle-turn"),
      state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
    });
    const item = new WorkbenchTranscriptIdentityRepository(database).admit({
      threadId: thread.threadId,
      sources: [{
        turnId: turn.turnId,
        reference: "image",
        kind: "stable",
        component: { kind: "item", index: 0 },
      }],
    });
    const bytes = Buffer.from("isolated transcript image");
    const image = await externalizeCodexTranscriptInlineImages({
      type: "image" as const, url: `data:image/png;base64,${bytes.toString("base64")}`,
    }, {
      assets: { writeTranscriptAsset: async input => new WorkbenchTranscriptAssetStore(database).write(input) },
      threadId: nativeThreadId,
    });
    new WorkbenchTranscriptRepository(database).settle([{
      kind: "providerTurnScope", threadId: thread.threadId, completeTurnIds: [turn.turnId],
      observations: [{
        kind: "turn", threadId: thread.threadId, turnId: turn.turnId, turnIndex: turn.turnIndex,
        harnessId: "codex", nativeLocation: project, nativeThreadId,
        nativeTurnId: NativeTurnIdSchema.parse("lifecycle-turn"),
        state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
      }, {
        kind: "item", threadId: thread.threadId, turnId: turn.turnId, publicItemId: item.itemId,
        lifecycle: "completed", observedAt: 2,
        item: { id: "image", type: "userMessage", clientId: null, content: [image.value] },
      }],
    }, {
      kind: "providerCursor", threadId: thread.threadId, turnId: turn.turnId, previousCursor: null,
    }]);
    return { threadId: thread.threadId, turnId: turn.turnId, itemId: item.itemId, bytes };
  } finally { database.close(); }
}
