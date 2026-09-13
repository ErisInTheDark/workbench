/*
 * No production exports. Tests protect transcript readiness, direct shadow recording, per-thread gap isolation, recovery, subscriptions, and disposal.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import WorkbenchTranscriptCaptureGapController from "./WorkbenchTranscriptCaptureGapController.ts";
import WorkbenchTranscriptController from "./WorkbenchTranscriptController.ts";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptObservation,
} from "./workbench-transcript-types.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import type { TranscriptPatchUpdate, TranscriptStreamUpdate } from "workbench-shared/workbench/transcript/thread-transcript-stream";

const fixtureIdentityValues = {
  NativeThreadId: {
    "native": fixtureIdentitySchemas.NativeThreadIdSchema.parse("native"),
    "thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread"),
  },
  NativeTurnId: {
    "turn": fixtureIdentitySchemas.NativeTurnIdSchema.parse("turn"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "provider-thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("provider-thread"),
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
  WorkbenchTurnId: {
    "historical": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("historical"),
    "turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
    "turn-provider-thread": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn-provider-thread"),
  },
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function observationsFor(threadId: string): WorkbenchTranscriptAtomicObservation[] {
  return [{
    activityAt: 1,
    createdAt: 1,
    kind: "thread",
    projectId: fixtureIdentityValues.ProjectId["project"],
    projectRoot: "C:/project",
    threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId),
    title: `Thread ${threadId}`,
    updatedAt: 1,
  }, {
    createdAt: 2,
    durationMs: null,
    endedAt: null,
    harnessId: "codex",
    kind: "turn",
    nativeLocation: "C:/project",
    nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(threadId),
    nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(`turn-${threadId}`),
    startedAt: 2,
    state: "inProgress",
    threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId),
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(`turn-${threadId}`),
    turnIndex: 0,
  }];
}

test("recording activity retires previews before persistence, but history and delayed settlement preserve newer accumulation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-preview-activity-"));
  const database = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  const controller = new WorkbenchTranscriptController(database, new WorkbenchTranscriptCaptureGapController({
    markerPath: join(directory, "capture-gap.json"),
  }));
  const events: TranscriptStreamUpdate[] = [];
  const threadId = fixtureIdentityValues.WorkbenchThreadId.thread;
  const turnId = fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn-thread");
  const patch: TranscriptPatchUpdate = {
    kind: "patch", threadId, turnId, itemId: "orphan",
    changes: [{ path: "file.ts", kind: { type: "add" }, diff: "+draft" }],
  };
  const item: WorkbenchTranscriptAtomicObservation = {
    kind: "item", threadId, turnId, lifecycle: "completed", observedAt: 3,
    item: { type: "reasoning", id: "later", summary: ["moved on"], content: [] },
  };
  const activities: WorkbenchTranscriptAtomicObservation[] = [
    observationsFor("thread")[1]!,
    { ...item, lifecycle: "streaming", item: { ...item.item, id: "started" } },
    {
      kind: "questionnaire", observedAt: 4,
      entry: {
        threadId, turnId, itemId: "questionnaire", requestKey: "request",
        insertAfterItemId: null, insertAfterItemIndex: null, resolvedAt: 4,
        request: { id: "request", title: "", summary: "", submitLabel: "", questions: [] },
        response: { answers: {} },
      },
    },
    {
      kind: "steer", observedAt: 5,
      entry: {
        threadId, turnId, attemptedAt: 3, canonicalItemId: null, clientUserMessageId: "client",
        entryKey: "steer", error: null, input: [{ type: "text", text: "later input", text_elements: [] }],
        requestId: "steer", resolvedAt: 5, status: "interrupted",
      },
    },
    {
      kind: "browse",
      entry: {
        threadId, turnId, action: "snapshot", actionIndex: 0, assetUrl: null, commandItemId: null,
        detailKind: "text", detailLabel: "snapshot", detailText: "captured", durationMs: 1,
        entryKey: "browse", recordedAt: 6, session: "session", state: "completed",
      },
    },
  ];
  const patches = () => events.filter(event => event.kind === "patch");
  const subscribe = () => controller.subscribe({
    id: "view", request: { threadId, turnLimit: 1 }, publish: () => {},
    publishStream: event => events.push(event),
  });
  const settle = database.settleTranscript.bind(database);
  const release = deferred<void>();
  const entered = deferred<void>();
  try {
    await controller.start();
    await controller.record(observationsFor("thread"), { source: "provider" });
    controller.acceptLiveUpdate(patch);
    await controller.record([{
      kind: "providerTurnScope", threadId, completeTurnIds: [turnId],
      observations: observationsFor("thread"),
    }], { source: "provider" });
    await subscribe();
    assert.deepEqual(patches().at(-1), patch, "History loading must retain the current megapatch");
    controller.unsubscribe("view");
    await controller.record([item], { source: "provider" });
    events.length = 0;
    await subscribe();
    assert.deepEqual(patches(), [], "Activity while unviewed must not be replayed as pending");

    controller.acceptLiveUpdate(patch);
    await controller.record([item], { source: "provider" });
    assert.deepEqual(patches().at(-1), { ...patch, changes: [] }, "Unchanged durable rows still represent observed activity");

    for (const activity of activities) {
      controller.acceptLiveUpdate(patch);
      await controller.record([activity], { source: "workbench" });
      assert.deepEqual(patches().at(-1), { ...patch, changes: [] }, `${activity.kind} must retire the preview`);
    }

    controller.acceptLiveUpdate(patch);
    database.settleTranscript = async observations => {
      entered.resolve();
      await release.promise;
      return settle(observations);
    };
    const recording = controller.record([item], { source: "provider" });
    const newer = { ...patch, itemId: "newer" };
    try {
      await entered.promise;
      assert.deepEqual(patches().at(-1), { ...patch, changes: [] }, "Retirement must precede asynchronous persistence");
      controller.acceptLiveUpdate(newer);
    } finally {
      release.resolve();
      await recording;
    }
    controller.unsubscribe("view");
    events.length = 0;
    await subscribe();
    assert.deepEqual(patches(), [newer], "The old settlement must not retire newer accumulation");

    database.settleTranscript = async () => { throw new Error("recording unavailable"); };
    await assert.rejects(controller.record([item], { source: "workbench" }));
    assert.deepEqual(patches().at(-1), { ...newer, changes: [] }, "Recording failure must not strand the previous preview");
  } finally {
    release.resolve();
    database.settleTranscript = settle;
    controller.dispose();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the transcript controller records, reads, refreshes, and stops admitting work after disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-transcript-controller-"));
  const database = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  const controller = new WorkbenchTranscriptController(
    database,
    new WorkbenchTranscriptCaptureGapController({
      markerPath: join(directory, "capture-gap.json"),
    }),
  );
  const projectionStarted = deferred<void>();
  const releaseProjection = deferred<void>();
  const projectionCompleted = deferred<void>();
  let blockProjection = false;
  try {
    await controller.start();
    await controller.record([{
      kind: "canonicalWindow",
      contentVersion: 3,
      materializedTurnIds: [fixtureIdentityValues.WorkbenchTurnId["turn"]],
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
      observations: [
        {
          kind: "thread",
          threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
          projectId: fixtureIdentityValues.ProjectId["project"],
          projectRoot: "C:/project",
          title: "Thread",
          createdAt: 1,
          updatedAt: 1,
          activityAt: 1,
        },
        {
          kind: "turn",
          threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
          turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
          turnIndex: 0,
          harnessId: "codex",
          nativeLocation: "C:/project",
          nativeThreadId: fixtureIdentityValues.NativeThreadId["native"],
          nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"],
          state: "inProgress",
          createdAt: 2,
          startedAt: 2,
          endedAt: null,
          durationMs: null,
        },
      ],
    }], { source: "compatibility" });

    const published: number[] = [];
    await controller.subscribe({
      id: "latest",
      request: { threadId: "thread", turnLimit: 10 },
      publish: async (snapshot) => {
        if (blockProjection) {
          projectionStarted.resolve();
          await releaseProjection.promise;
        }
        published.push(snapshot?.rows.threadItems.length ?? -1);
        if (blockProjection) projectionCompleted.resolve();
      },
    });
    blockProjection = true;
    const recording = controller.record([{
      kind: "providerTurnScope",
      completeTurnIds: [fixtureIdentityValues.WorkbenchTurnId["turn"]],
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
      observations: [{
        kind: "thread",
        threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
        projectId: fixtureIdentityValues.ProjectId["project"],
        projectRoot: "C:/project",
        title: "Thread",
        createdAt: 1,
        updatedAt: 3,
        activityAt: 3,
      }, {
        kind: "turn",
        threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentityValues.NativeThreadId["native"],
        nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"],
        state: "inProgress",
        createdAt: 2,
        startedAt: 2,
        endedAt: null,
        durationMs: null,
      }, {
        kind: "item",
        threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
        lifecycle: "completed",
        observedAt: 3,
        item: {
          type: "agentMessage",
          id: "message",
          text: "hello",
          phase: "final_answer",
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
      }],
    }], { source: "provider" });
    await projectionStarted.promise;
    let recordingSettled = false;
    void recording.then(() => {
      recordingSettled = true;
    });
    await Promise.resolve();
    assert.equal(recordingSettled, true);
    await recording;
    assert.deepEqual(published, [0]);
    releaseProjection.resolve();
    await projectionCompleted.promise;
    assert.deepEqual(published, [0, 1]);
    const snapshot = await controller.read({ threadId: "thread", turnLimit: 10 });
    const messageItemId = snapshot?.rows.threadItems.find(({ source_id }) => source_id === "message")?.id;
    assert.ok(messageItemId);
    assert.deepEqual(
      snapshot?.rows.threadItemAssistantMessages,
      [{
        item_id: messageItemId,
        item_type: "assistantMessage",
        state: "completed",
        phase: "finalAnswer",
        text: "hello",
      }],
    );

    controller.dispose();
    await assert.rejects(controller.read({ threadId: "thread", turnLimit: 10 }), /disposed/u);
  } finally {
    releaseProjection.resolve();
    controller.dispose();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable item facts refresh subscriptions only at complete projection boundaries", async () => {
  let reads = 0;
  let published = deferred<void>();
  const controller = new WorkbenchTranscriptController({
    failure: null,
    async readTranscript() {
      reads += 1;
      return null;
    },
    async settleTranscript(observations) {
      const threadIds = new Set(observations.flatMap((observation) => (
        observation.kind === "questionnaire" || observation.kind === "steer"
          ? [observation.entry.threadId]
          : observation.kind === "browse"
            ? [observation.entry.threadId]
            : observation.kind === "canonicalWindow"
              || observation.kind === "providerTurnScope"
              || observation.kind === "captureGap"
              ? [observation.threadId]
              : observation.threadId
                ? [observation.threadId]
                : []
      )));
      return { changedThreadIds: [...threadIds] };
    },
    async start() {
      return { schemaVersion: 1, tableNames: [] };
    },
  }, new WorkbenchTranscriptCaptureGapController({
    markerPath: join(tmpdir(), "unused-transcript-boundary-gap.json"),
  }));
  await controller.start();
  const awaitNextPublication = async (
    observation: WorkbenchTranscriptObservation,
    source: "compatibility" | "provider" | "workbench" = "provider",
  ) => {
    published = deferred<void>();
    await controller.record([observation], { source });
    await published.promise;
  };
  try {
    await controller.subscribe({
      id: "latest",
      request: { threadId: "thread", turnLimit: 1 },
      publish() {
        published.resolve();
      },
    });
    assert.equal(reads, 1);

    await controller.record([{
      item: {
        id: "message",
        memoryCitation: null,
        delivery: null,
        questions: null,
        phase: "commentary",
        text: "hello",
        type: "agentMessage",
      },
      kind: "item",
      lifecycle: "completed",
      observedAt: 2,
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
      turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
    }], { source: "provider" });
    await controller.record([{
      createdAt: 1,
      durationMs: null,
      endedAt: null,
      harnessId: "codex",
      kind: "turn",
      nativeLocation: "C:/project",
      nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"],
      nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"],
      startedAt: 1,
      state: "inProgress",
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
      turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
    }], { source: "provider" });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reads, 1);

    await awaitNextPublication({
      createdAt: 1,
      durationMs: 1,
      endedAt: 2,
      harnessId: "codex",
      kind: "turn",
      nativeLocation: "C:/project",
      nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"],
      nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"],
      startedAt: 1,
      state: "completed",
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
      turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
    });
    assert.equal(reads, 2);

    await awaitNextPublication({
      completeTurnIds: [fixtureIdentityValues.WorkbenchTurnId["turn"]],
      kind: "providerTurnScope",
      observations: [{
        createdAt: 1,
        durationMs: 1,
        endedAt: 2,
        harnessId: "codex",
        kind: "turn",
        nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"],
        nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"],
        startedAt: 1,
        state: "completed",
        threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
      }],
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
    });
    assert.equal(reads, 3);

    await awaitNextPublication({
      activityAt: 3,
      createdAt: 1,
      kind: "thread",
      projectId: fixtureIdentityValues.ProjectId["project"],
      projectRoot: "C:/project",
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
      title: "Thread",
      updatedAt: 3,
    });
    assert.equal(reads, 4);

    await awaitNextPublication({
      entry: {
        action: "browse",
        actionIndex: 0,
        assetUrl: null,
        commandItemId: null,
        durationMs: 1,
        entryKey: "browse",
        recordedAt: 4,
        session: "session",
        state: "completed",
        threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
      },
      kind: "browse",
    }, "workbench");
    assert.equal(reads, 5);
    published = deferred<void>();
    await controller.record([{
      item: { id: "screenshot", type: "functionCallOutput", namespace: "workbench", name: "screenshot", output: "queued capture" },
      kind: "item", lifecycle: "completed", observedAt: 5, threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
    }], { source: "workbench" });
    assert.equal(reads, 6, "Workbench item admission must request a snapshot without waiting for a provider terminal boundary");
    await published.promise;
  } finally {
    controller.dispose();
  }
});

test("capture gaps retain cutover evidence without blocking historical imports, subscriptions or live recording", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-transcript-controller-gap-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const markerPath = join(directory, "capture-gap.json");
  let database = new WorkbenchDatabaseController({ databasePath });
  let rejectSettlements = true;
  const failed = new WorkbenchTranscriptController({
    get failure() { return database.failure; },
    readTranscript: (request) => database.readTranscript(request),
    settleTranscript: (observations) => (
      rejectSettlements
        ? Promise.reject(new Error("settlement failed"))
        : database.settleTranscript(observations)
    ),
    start: () => database.start(),
  }, new WorkbenchTranscriptCaptureGapController({
    markerPath,
    now: () => 10,
    randomId: (() => {
      const ids = ["gap-provider", "gap-workbench"][Symbol.iterator]();
      return () => ids.next().value!;
    })(),
  }));
  let recovered: WorkbenchTranscriptController | null = null;
  try {
    await failed.start();
    await assert.rejects(
      failed.record(observationsFor("provider-thread"), { source: "provider" }),
      /shadow settlement failed/u,
    );
    await assert.rejects(
      failed.record(observationsFor("workbench-thread"), { source: "workbench" }),
      /shadow settlement failed/u,
    );
    failed.assertReady();
    assert.throws(() => failed.assertCutoverReady(), /capture gaps for 2 thread/u);
    assert.deepEqual(failed.pendingRecoveryThreadIds, ["provider-thread"]);

    rejectSettlements = false;
    await failed.record([{
      kind: "usageWindow", threadId: fixtureIdentityValues.WorkbenchThreadId["provider-thread"],
      catalog: observationsFor("provider-thread").filter(
        (observation): observation is Extract<WorkbenchTranscriptAtomicObservation, { kind: "thread" | "turn" }> => (
          observation.kind === "thread" || observation.kind === "turn"
        ),
      ),
      observations: [{
        kind: "turnUsageContext", threadId: fixtureIdentityValues.WorkbenchThreadId["provider-thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn-provider-thread"],
        model: "observed-model", serviceTier: null, observedAt: 5,
      }],
    }], { source: "compatibility" });
    assert.equal(await failed.read({ threadId: "provider-thread", turnLimit: 1 }), null);
    assert.deepEqual(failed.pendingRecoveryThreadIds, ["provider-thread"]);
    assert.throws(() => failed.assertCutoverReady(), /capture gaps for 2 thread/u);
    await failed.record(observationsFor("provider-thread"), { source: "provider" });
    await failed.record(observationsFor("workbench-thread"), { source: "workbench" });
    assert.equal(
      (await failed.read({ threadId: "workbench-thread", turnLimit: 1 }))?.thread.id,
      "workbench-thread",
    );
    const liveItem: WorkbenchTranscriptAtomicObservation = {
      kind: "item", threadId: fixtureIdentityValues.WorkbenchThreadId["provider-thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn-provider-thread"], lifecycle: "completed", observedAt: 6,
      item: {
        id: "live", type: "agentMessage", text: "fresh live content", phase: "commentary",
        memoryCitation: null, delivery: null, questions: null,
      },
    };
    await failed.record([liveItem], { source: "provider" });
    const originalTurn = observationsFor("provider-thread")[1]!;
    assert.ok(originalTurn.kind === "turn");
    const historicalTurn = {
      ...originalTurn,
      turnId: fixtureIdentityValues.WorkbenchTurnId.historical, turnIndex: 1, nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse("historical"),
    };
    await failed.record([{
      kind: "canonicalWindow", threadId: fixtureIdentityValues.WorkbenchThreadId["provider-thread"], contentVersion: 3,
      materializedTurnIds: [fixtureIdentityValues.WorkbenchTurnId["turn-provider-thread"], fixtureIdentityValues.WorkbenchTurnId["historical"]],
      observations: [
        ...observationsFor("provider-thread"), historicalTurn,
        { ...liveItem, item: {
          id: "live", type: "agentMessage", text: "stale compatibility content", phase: "commentary",
          memoryCitation: null, delivery: null, questions: null,
        } },
        { ...liveItem, turnId: fixtureIdentityValues.WorkbenchTurnId.historical, item: {
          id: "history", type: "agentMessage", text: "retained history", phase: "commentary",
          memoryCitation: null, delivery: null, questions: null,
        } },
      ],
    }], { source: "compatibility" });
    let published = false;
    await failed.subscribe({
      id: "gapped", request: { threadId: "provider-thread", turnLimit: 2 },
      publish: (snapshot) => {
        assert.ok(snapshot);
        assert.deepEqual(snapshot.rows.threadItemAssistantMessages.map(({ text }) => text).sort(), ["fresh live content", "retained history"]);
        published = true;
      },
    });
    assert.ok(published);
    failed.unsubscribe("gapped");
    assert.deepEqual(failed.pendingRecoveryThreadIds, ["provider-thread"]);
    assert.throws(() => failed.assertCutoverReady(), /capture gaps for 2 thread/u);
    await failed.record(observationsFor("clean-thread"), { source: "compatibility" });

    failed.dispose();
    await database.close();
    database = new WorkbenchDatabaseController({ databasePath });
    recovered = new WorkbenchTranscriptController(
      database,
      new WorkbenchTranscriptCaptureGapController({ markerPath, now: () => 20 }),
    );
    await recovered.start();
    recovered.assertReady();
    assert.deepEqual(recovered.pendingRecoveryThreadIds, ["provider-thread"]);
    await recovered.record(
      [{
        completeTurnIds: [fixtureIdentityValues.WorkbenchTurnId["turn-provider-thread"]],
        kind: "providerTurnScope",
        observations: observationsFor("provider-thread"),
        threadId: fixtureIdentityValues.WorkbenchThreadId["provider-thread"],
      }],
      { recoveryBoundary: true, source: "provider" },
    );
    assert.deepEqual(recovered.pendingRecoveryThreadIds, []);
    assert.throws(() => recovered!.assertCutoverReady(), /capture gaps for 1 thread/u);

    await recovered.record(observationsFor("workbench-thread"), { source: "workbench" });
    assert.equal(
      (await recovered.read({ threadId: "workbench-thread", turnLimit: 1 }))?.thread.id,
      "workbench-thread",
    );
  } finally {
    failed.dispose();
    recovered?.dispose();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
