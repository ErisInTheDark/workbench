/*
 * Exports:
 * - No production exports; Node tests protect thread admission, proposal observation, source and history lifecycles, and child hydration.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadPayload } from "workbench-shared/types";
import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import type { WorkbenchThreadObservationSnapshot, WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadTranscriptProjectionState } from "./transcript/ThreadTranscriptProjectionController";
import WorkbenchThreadController, { type ThreadControllerPorts } from "./WorkbenchThreadController";
import ThreadObservationController from "./thread/ThreadObservationController";
import ThreadTranscriptProjectionController from "./transcript/ThreadTranscriptProjectionController";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  DraftId: {
    "draft": fixtureIdentitySchemas.DraftIdSchema.parse("draft"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "child": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child"),
    "missing": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("missing"),
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
};

function fixture() {
  const requests: Array<{ subscriptionId: string; resolve: (value: object) => void }> = [];
  const releases: string[] = [];
  const observations = new ThreadObservationController({
    request: (method, params) => {
      if (method.endsWith("/release")) {
        releases.push((params as { subscriptionId: string }).subscriptionId);
        return Promise.resolve({ accepted: true });
      }
      return new Promise<object>(resolve => requests.push({ ...params as { subscriptionId: string }, resolve }));
    },
  });
  const target = { kind: "provider" as const, harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") };
  const document: ThreadPayload = {
    id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"), harness: "codex", isDraft: false, turns: [], browseResultEntries: [], turnHistory: [],
    agentNickname: null, agentPath: null, agentRole: null, createdAt: 1, cwd: "C:/project",
    model: null, name: null, path: null, preview: "", reasoningEffort: null, serviceTier: null,
    source: "codex", status: "idle", tokenUsage: null, updatedAt: 1,
  };
  let native: ThreadPayload | null = null;
  const listeners = new Set<() => void>();
  const reads: Array<{ admit: () => Promise<void>; resolve: (value: ThreadPayload | null) => void }> = [];
  const errors: string[] = [];
  const proposalReads: Array<{
    proposalId: string;
    reject: (error: Error) => void;
    resolve: (proposal: GitCheckpointProposal) => void;
  }> = [];
  const proposalRefreshListeners = new Set<() => void>();
  const releasedHistoricalTurnIds: string[][] = [];
  const transcriptSelectedTurnIds: string[][] = [];
  let publishTranscript!: (state: ThreadTranscriptProjectionState) => void;
  const ports: ThreadControllerPorts = {
    controls: {
      compactThread: async value => value, stopThread: async value => value,
      setCurrentThreadAgent: () => {}, setCurrentThreadModel: () => {},
      setCurrentThreadReasoningEffort: () => {}, setCurrentThreadServiceTier: () => {},
      setCurrentThreadComposerSettings: () => {}, submitPendingUserInputRequest: async () => {},
      updateThreadStateWithAcceptance: async () => true,
    },
    observations,
    getChild: () => { throw new Error("Unexpected child."); },
    releaseHistoricalTurns: (turnIds) => {
      releasedHistoricalTurnIds.push([...turnIds]);
      if (native) {
        const removed = new Set(turnIds);
        native = { ...native, turns: native.turns.filter((turn) => !removed.has(turn.id)) };
        for (const listener of listeners) listener();
      }
      return native;
    },
    readNative: () => ({ document: native, pendingQuestionnaire: null, rateLimits: null }),
    subscribeNative: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readGitArcProposal: ({ proposalId }) => new Promise<GitCheckpointProposal>((resolve, reject) => {
      proposalReads.push({ proposalId, reject, resolve });
    }),
    subscribeGitArcProposalRefresh: listener => {
      proposalRefreshListeners.add(listener);
      return () => { proposalRefreshListeners.delete(listener); };
    },
    read: (_options, admit) => new Promise(resolve => reads.push({ admit, resolve })),
    createTranscript: publish => {
      publishTranscript = publish;
      const controller = new ThreadTranscriptProjectionController({
        onStateChange: publish, turnLimit: 4,
        transcripts: {
          subscribe: async () => {}, unsubscribe: async () => {},
        },
      });
      const select = controller.select.bind(controller);
      controller.select = (selection, options) => {
        transcriptSelectedTurnIds.push(selection?.thread.turns.map(({ id }) => id) ?? []);
        select(selection, options);
      };
      return {
        controller,
        stopAvailability: () => {},
      };
    },
    reportError: message => { errors.push(message); },
  };
  const owner = new WorkbenchThreadController("project", target, ports);
  function admit(
    index = 0,
    children: WorkbenchThreadSidebarEntry[] = [],
    gitArc?: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>["gitArc"],
  ) {
    const snapshot: WorkbenchThreadObservationSnapshot = {
      projectId: fixtureIdentityValues.ProjectId["project"], subscriptionId: requests[index]!.subscriptionId, target,
      entries: [{
        activityAt: 1, title: "thread", entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"] },
        ...(gitArc ? { gitArc } : {}),
        metadata: { archived: false, pinned: true, snoozed: false },
        lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      }, ...children],
      revision: 1, version: 1, updateKind: "threadObservation", freshness: "fresh", error: null,
    };
    observations.accept(snapshot);
    requests[index]!.resolve({ observation: snapshot });
  }
  function publish(value: ThreadPayload | null) {
    native = value;
    for (const listener of listeners) listener();
  }
  return { owner, observations, document, requests, releases, reads, errors, proposalReads, proposalRefreshListeners, releasedHistoricalTurnIds, transcriptSelectedTurnIds, admit, publish, ports,
    publishTranscript: (state: ThreadTranscriptProjectionState) => publishTranscript(state) };
}

function proposal(proposalId: string, status: GitCheckpointProposal["status"]): GitCheckpointProposal {
  return {
    amendTargetMessage: null,
    amendTargetSha: null,
    baseCommit: "a".repeat(40),
    changes: [],
    committedSha: status === "committed" ? "b".repeat(40) : null,
    description: "",
    freshChanges: null,
    includeNewerAvailable: false,
    mode: "commit",
    paths: ["src/one.ts"],
    proposalId,
    status,
    supersededByProposalId: null,
    supersededBySha: null,
    title: "Proposal",
    unavailableReason: status === "unavailable" ? "Proposal is no longer valid." : null,
  };
}

function gitArc(proposalId = "proposal") {
  return {
    checkpointCommit: "a".repeat(40),
    claimedPaths: [],
    intentDescription: "",
    intentName: "test",
    phase: "resolved" as const,
    proposals: [{ proposalId, status: "proposed" as const }],
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

test("opening reconciles saved history without discarding it when the provider is unavailable", async () => {
  const f = fixture();
  let reconciliations = 0;
  Object.assign(f.ports, {
    reconcile: async () => { reconciliations++; throw new Error("provider unavailable"); },
  });
  f.ports.read = async () => { f.publish(f.document); return f.document; };
  const read = f.owner.read();
  f.admit();
  assert.equal(await read, f.document);
  assert.equal(reconciliations, 1);
  assert.equal(f.ports.readNative().document, f.document);
  f.owner.dispose();
});

for (const retire of [false, true]) {
  test(`saved history is readable during recovery and ${retire ? "retirement fences" : "completion triggers"} its reread`, async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const recovery = Promise.withResolvers<void>();
    let reads = 0;
    f.ports.reconcile = async () => { entered.resolve(); await recovery.promise; };
    f.ports.read = async () => {
      reads++;
      f.publish(f.document);
      return f.document;
    };
    const release = f.owner.acquire("route");
    const opening = f.owner.read();
    f.admit();
    try {
      await entered.promise;
      assert.equal(f.owner.getSnapshot().status, "ready");
      assert.equal(f.owner.getSnapshot().document, f.document);
      assert.equal(reads, 1);
      if (retire) f.owner.dispose();
      recovery.resolve();
      assert.equal(await opening, retire ? null : f.document);
      assert.equal(reads, retire ? 1 : 2);
    } finally {
      recovery.resolve();
      await opening;
      release();
      f.owner.dispose();
    }
  });
}

test("summary consumers share admission without loading a transcript", () => {
  const f = fixture();
  const first = f.owner.acquire("summary");
  const second = f.owner.acquire("summary");
  assert.equal(f.requests.length, 1);
  assert.equal(f.reads.length, 0);
  f.admit();
  assert.equal(f.owner.getSnapshot().status, "ready");
  first();
  assert.equal(f.releases.length, 0);
  second();
  assert.equal(f.releases.length, 1);
  f.owner.dispose();
});

test("proposal observation hydrates only on demand and fences stale refreshes", async () => {
  const f = fixture();
  f.publish(f.document);
  const release = f.owner.acquire("view");
  f.admit(0, [], gitArc());

  assert.equal(f.owner.getSnapshot().status, "ready");
  assert.deepEqual(f.owner.getSnapshot().gitArcProposals, {});
  assert.equal(f.proposalReads.length, 0);
  assert.equal(f.proposalRefreshListeners.size, 1);

  const releaseProposal = f.owner.observeGitArcProposal("proposal");
  const releaseDuplicateProposal = f.owner.observeGitArcProposal("proposal");
  assert.deepEqual(f.owner.getSnapshot().gitArcProposals, { proposal: { status: "loading" } });
  assert.equal(f.proposalReads.length, 1);

  releaseProposal();
  [...f.proposalRefreshListeners][0]!();
  assert.equal(f.proposalReads.length, 2);
  f.proposalReads[0]!.resolve(proposal("proposal", "proposed"));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.owner.getSnapshot().gitArcProposals, { proposal: { status: "loading" } });

  const refreshed = proposal("proposal", "proposed");
  f.proposalReads[1]!.resolve(refreshed);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.owner.getSnapshot().gitArcProposals, {
    proposal: { proposal: refreshed, status: "loaded" },
  });
  assert.equal(f.owner.getSnapshot().status, "ready");

  [...f.proposalRefreshListeners][0]!();
  assert.equal(f.proposalReads.length, 3);
  assert.deepEqual(f.owner.getSnapshot().gitArcProposals, {
    proposal: { proposal: refreshed, refreshing: true, status: "loaded" },
  });
  const unavailable = proposal("proposal", "unavailable");
  f.proposalReads[2]!.resolve(unavailable);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.owner.getSnapshot().gitArcProposals, {
    proposal: { proposal: unavailable, status: "loaded" },
  });

  [...f.proposalRefreshListeners][0]!();
  assert.equal(f.proposalReads.length, 4);
  releaseDuplicateProposal();
  [...f.proposalRefreshListeners][0]!();
  assert.equal(f.proposalReads.length, 4);
  release();
  assert.deepEqual(f.owner.getSnapshot().gitArcProposals, {});
  assert.equal(f.proposalRefreshListeners.size, 0);
  f.proposalReads[3]!.resolve(proposal("proposal", "proposed"));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.owner.getSnapshot().gitArcProposals, {});
  f.owner.dispose();
});

test("proposal observation failures stay source-local", async () => {
  const f = fixture();
  f.publish(f.document);
  const release = f.owner.acquire("view");
  f.admit(0, [], gitArc());
  const releaseProposal = f.owner.observeGitArcProposal("proposal");
  f.proposalReads[0]!.reject(new Error("proposal read failed"));
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(f.owner.getSnapshot().status, "ready");
  assert.deepEqual(f.owner.getSnapshot().gitArcProposals, {
    proposal: { error: "proposal read failed", status: "failed" },
  });
  releaseProposal();
  release();
  f.owner.dispose();
});

test("an empty initial read settles as failed and a deliberate retry can admit content", async () => {
  const f = fixture();
  const release = f.owner.acquire("summary");
  f.admit();
  try {
    const first = f.owner.read({}, { retain: false });
    f.reads[0]!.resolve(null);
    assert.equal(await first, null);
    assert.equal(f.owner.getSnapshot().status, "failed");
    assert.equal(f.errors.length, 1);
    const retry = f.owner.read({}, { retain: false });
    f.publish(f.document);
    f.reads[1]!.resolve(f.document);
    await retry;
    assert.equal(f.owner.getSnapshot().status, "ready");
    assert.equal(f.owner.getSnapshot().error, null);
    const refresh = f.owner.read({}, { retain: false });
    f.reads[2]!.resolve(null);
    await refresh;
    assert.equal(f.owner.getSnapshot().status, "ready");
    assert.equal(f.owner.getSnapshot().document, f.document);
  } finally {
    release();
    f.owner.dispose();
  }
});

for (const outcome of ["empty", "rejected"] as const) {
  test(`family hydration stops after an ${outcome} child read without blocking its parent`, async () => {
    const f = fixture();
    let reads = 0;
    let available = false;
    let childDocument: ThreadPayload | null = null;
    const child = new WorkbenchThreadController("project", {
      kind: "subagent", parentThreadId: fixtureIdentityValues.WorkbenchThreadId.thread,
      threadId: fixtureIdentityValues.WorkbenchThreadId.child, harness: "codex",
    }, {
      ...f.ports,
      getChild: () => child,
      readNative: () => ({ document: childDocument, pendingQuestionnaire: null, rateLimits: null }),
      read: async () => {
        reads++;
        if (available) return childDocument = { ...f.document, id: fixtureIdentityValues.WorkbenchThreadId.child };
        if (outcome === "rejected") throw new Error("Child unavailable");
        return null;
      },
    });
    f.ports.getChild = () => child;
    const release = f.owner.acquire("summary");
    f.admit(0, [{
      entryKind: "subagent", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId.child },
      activityAt: 1, cwd: "C:/project", createdAt: 1, directSubagentIndex: 0,
      name: "child", parentThreadId: fixtureIdentityValues.WorkbenchThreadId.thread, pinned: false,
      profileId: "", profileName: "", projectId: fixtureIdentityValues.ProjectId.project,
      title: "child", updatedAt: 1, lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    }]);
    f.publish(f.document);
    const family = f.owner.acquireChildren(["child"]);
    try {
      const initial = child.read();
      if (outcome === "rejected") await assert.rejects(initial, /Child unavailable/);
      else await initial;
      assert.equal(reads, 1);
      assert.equal(child.getSnapshot().status, "failed");
      assert.equal(f.owner.getSnapshot().status, "ready");
      f.publish({ ...f.document, updatedAt: 2 });
      assert.equal(reads, 1);
      available = true;
      await child.read();
      assert.equal(reads, 2);
      assert.equal(child.getSnapshot().status, "ready");
      assert.ok(f.owner.getSnapshot().relatedDocuments.child);
    } finally {
      family();
      release();
      child.dispose();
      f.owner.dispose();
    }
  });
}

test("a document alone cannot admit a view", () => {
  const f = fixture();
  f.publish(f.document);
  const release = f.owner.acquire("view");
  assert.equal(f.owner.getSnapshot().status, "loading");
  f.admit();
  assert.equal(f.owner.getSnapshot().status, "ready");
  release();
  f.owner.dispose();
});

test("a routed surface waits for the route owner's explicit opening before admission", async () => {
  const f = fixture();
  const release = f.owner.acquire("route");
  assert.equal(f.requests.length, 0);
  assert.equal(f.reads.length, 0);
  const opening = f.owner.read();
  assert.equal(f.requests.length, 1);
  f.admit();
  await f.reads[0]!.admit();
  f.publish(f.document);
  f.reads[0]!.resolve(f.document);
  await opening;
  assert.equal(f.owner.getSnapshot().status, "ready");
  release();
  f.owner.dispose();
});

test("the final view release cancels its pending admission without a self-retaining read", async () => {
  const f = fixture();
  const release = f.owner.acquire("view");
  const pending = f.reads[0]!.admit();
  const cancelled = assert.rejects(pending, /cancelled/);
  release();
  assert.equal(f.releases.length, 1);
  await cancelled;
  f.reads[0]!.resolve(null);
  f.owner.dispose();
});

test("history retention waits for every surface and inactive release keeps only the latest page", () => {
  const f = fixture();
  const turns = ["oldest", "older", "previous", "current"].map((id, index) => ({
    completedAt: index + 1, durationMs: 1, error: null, id, items: [], itemsView: "full" as const,
    startedAt: index, status: "completed" as const,
  }));
  f.publish({
    ...f.document,
    turnHistory: turns.map((turn) => ({
      completedAt: turn.completedAt, durationMs: turn.durationMs, itemCount: 0,
      loadState: "loaded" as const, startedAt: turn.startedAt, status: turn.status, turnId: turn.id,
    })),
    turns,
  });
  const summary = f.owner.acquire("summary");
  const view = f.owner.acquire("view");
  const first = f.owner.acquireHistorySurface();
  const second = f.owner.acquireHistorySurface();
  first.setAtEnd(true);
  assert.deepEqual(f.releasedHistoricalTurnIds, []);
  second.setAtEnd(true);
  assert.deepEqual(f.releasedHistoricalTurnIds, [["oldest", "older"]]);
  assert.deepEqual(f.transcriptSelectedTurnIds.at(-1), ["previous", "current"]);
  view();
  assert.deepEqual(f.releasedHistoricalTurnIds.at(-1), ["previous"]);
  assert.equal(f.owner.getSnapshot().document?.turns.at(-1)?.id, "current");
  first.release();
  second.release();
  summary();
  f.owner.dispose();
});

test("a remounted view starts fresh while its cancelled read is still settling", async () => {
  const f = fixture();
  const first = f.owner.acquire("view");
  first();
  const second = f.owner.acquire("view");
  assert.equal(f.reads.length, 2);
  f.admit(1);
  await f.reads[1]!.admit();
  f.publish(f.document);
  const opening = f.owner.read();
  f.reads[1]!.resolve(f.document);
  await opening;
  f.reads[0]!.resolve(null);
  assert.equal(f.owner.getSnapshot().status, "ready");
  second();
  f.owner.dispose();
});

test("route activation coalesces opening and leaves an admitted panel intact", async () => {
  const f = fixture();
  const release = f.owner.acquire("route");
  const first = f.owner.activate();
  const second = f.owner.activate();
  assert.equal(f.requests.length, 1);
  assert.equal(f.reads.length, 1);
  f.admit();
  await f.reads[0]!.admit();
  f.publish(f.document);
  f.reads[0]!.resolve(f.document);
  await Promise.all([first, second]);
  await f.owner.activate();
  assert.equal(f.reads.length, 1);
  assert.equal(f.owner.getSnapshot().status, "ready");
  release();
  f.owner.dispose();
});

test("route activation never loads a tooltip-only consumer", async () => {
  const f = fixture();
  const release = f.owner.acquire("summary");
  f.admit();
  const activated = f.owner.activate();
  assert.equal(f.reads.length, 0);
  await activated;
  release();
  f.owner.dispose();
});

test("draft recovery retains its local document without provider reads", async () => {
  const f = fixture();
  const draft = new WorkbenchThreadController("project", { kind: "draft", draftId: fixtureIdentityValues.DraftId["draft"] }, f.ports);
  f.publish({ ...f.document, id: fixtureIdentitySchemas.DraftIdSchema.parse("draft"), isDraft: true });
  const release = draft.acquire("view");
  const recovered = draft.recover();
  assert.equal(f.reads.length, 0);
  await recovered;
  assert.equal(draft.getSnapshot().status, "ready");
  release();
  draft.dispose();
  f.owner.dispose();
});

test("a missing child fails at the common owner while its root remains available", async () => {
  const f = fixture();
  const root = f.owner.acquire("summary");
  f.admit();
  const child = new WorkbenchThreadController("project", {
    kind: "subagent", parentThreadId: fixtureIdentityValues.WorkbenchThreadId["thread"], threadId: fixtureIdentityValues.WorkbenchThreadId["missing"],
  }, f.ports);
  const release = child.acquire("summary");
  assert.equal(child.getSnapshot().status, "failed");
  await assert.rejects(child.waitForAdmission(), /no longer available/);
  release();
  root();
  child.dispose();
  f.owner.dispose();
});

test("reconnection preserves an accepted view while native caches rebuild", () => {
  const f = fixture();
  f.publish(f.document);
  const release = f.owner.acquire("view");
  f.admit();
  f.observations.disconnect();
  f.publish(null);
  assert.equal(f.owner.getSnapshot().status, "ready");
  assert.equal(f.owner.getSnapshot().document, f.document);
  release();
  f.owner.dispose();
});

test("recovery replaces an in-flight read and fences its obsolete admission", async () => {
  const f = fixture();
  const release = f.owner.acquire("view");
  const oldRead = f.owner.read();
  f.observations.disconnect();
  f.observations.reset();
  const recovered = f.owner.recover();
  assert.equal(f.reads.length, 2);
  await assert.rejects(f.reads[0]!.admit(), /cancelled/);
  f.admit(1);
  await f.reads[1]!.admit();
  f.publish(f.document);
  f.reads[1]!.resolve(f.document);
  await recovered;
  f.reads[0]!.resolve(null);
  await oldRead;
  assert.equal(f.owner.getSnapshot().status, "ready");
  release();
  f.owner.dispose();
});

test("two views share one initial read and the remaining view keeps admission alive", async () => {
  const f = fixture();
  const first = f.owner.acquire("view");
  const second = f.owner.acquire("view");
  assert.equal(f.reads.length, 1);
  first();
  assert.equal(f.releases.length, 0);
  f.admit();
  await f.reads[0]!.admit();
  const read = f.owner.read();
  f.publish(f.document);
  f.reads[0]!.resolve(f.document);
  await read;
  assert.equal(f.owner.getSnapshot().status, "ready");
  second();
  assert.equal(f.releases.length, 1);
  f.owner.dispose();
});

test("SQLite failures remain source-local while common failures own the whole view", () => {
  const f = fixture();
  f.publish(f.document);
  const release = f.owner.acquire("view");
  f.admit();
  f.publishTranscript({ status: "failed", threadId: "thread", message: "projection failed", projection: null });
  assert.equal(f.owner.getSnapshot().status, "ready");
  assert.equal(f.owner.getSnapshot().transcript.status, "failed");
  f.owner.fail(new Error("admission withdrawn"));
  f.publish(f.document);
  assert.equal(f.owner.getSnapshot().status, "failed");
  assert.equal(f.owner.getSnapshot().error, "admission withdrawn");
  release();
  f.owner.dispose();
});

test("invalid live domain state reaches the common failure instead of leaving controls independently usable", async t => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const f = fixture();
  f.publish(f.document);
  const release = f.owner.acquire("view");
  f.admit();
  f.observations.accept({ subscriptionId: f.requests[0]!.subscriptionId, entries: "invalid" });
  assert.equal(f.owner.getSnapshot().status, "failed");
  assert.ok(f.owner.getSnapshot().error);
  await assert.rejects(f.owner.waitForAdmission(), /invalid live thread state/);
  release();
  f.owner.dispose();
});

test("family views coalesce child hydration and release only their own demand", async () => {
  const f = fixture();
  const entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> = {
    activityAt: 1, createdAt: 1, updatedAt: 1, cwd: "C:/project", directSubagentIndex: 0,
    entryKind: "subagent", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["child"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    name: "child", parentThreadId: fixtureIdentityValues.WorkbenchThreadId["thread"], pinned: false, profileId: "", profileName: "",
    projectId: fixtureIdentityValues.ProjectId["project"], title: "child",
  };
  let document: ThreadPayload | null = null;
  let accept!: () => void;
  const page = new Promise<void>(resolve => { accept = resolve; });
  const listeners = new Set<() => void>();
  let reads = 0;
  let refreshFailure = false;
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  let nextTimer = 0;
  const child = new WorkbenchThreadController("project", {
    kind: "subagent", harness: "codex", parentThreadId: fixtureIdentityValues.WorkbenchThreadId["thread"], threadId: fixtureIdentityValues.WorkbenchThreadId["child"],
  }, {
    ...f.ports,
    getChild: () => child,
    scheduleRefresh: callback => {
      const timer = ++nextTimer as unknown as ReturnType<typeof setTimeout>;
      timers.set(timer, callback);
      return timer;
    },
    cancelRefresh: timer => { timers.delete(timer); },
    readNative: () => ({ document, pendingQuestionnaire: null, rateLimits: null }),
    subscribeNative: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    read: async (_options, admit) => {
      reads++;
      if (refreshFailure) throw new Error("refresh failed");
      await admit();
      await page;
      document = { ...f.document, id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child"), turns: [{
        id: "turn", status: "inProgress", items: [], itemsView: "full", error: null, startedAt: 1, completedAt: null, durationMs: null,
      }] };
      for (const listener of listeners) listener();
      return document;
    },
  });
  f.ports.getChild = () => child;
  f.publish(f.document);
  const root = f.owner.acquire("view");
  f.admit(0, [entry]);
  const first = f.owner.acquireChildren(["child"]);
  const second = f.owner.acquireChildren(["child"]);
  assert.equal(reads, 1);
  first();
  assert.equal(child.hasConsumers, true);
  const loading = child.read();
  accept();
  await loading;
  assert.equal(f.owner.getSnapshot().relatedDocuments.child?.id, "child");
  assert.equal(timers.size, 0, "background hydration does not own active-view polling");
  const firstView = child.acquire("view");
  const secondView = child.acquire("view");
  assert.equal(timers.size, 1);
  const [timer, callback] = [...timers][0]!;
  timers.delete(timer);
  callback();
  await child.read();
  assert.equal(reads, 2);
  assert.equal(timers.size, 1);
  refreshFailure = true;
  const [next, refresh] = [...timers][0]!;
  timers.delete(next);
  refresh();
  await assert.rejects(child.read(), /refresh failed/);
  assert.equal(child.getSnapshot().status, "ready");
  assert.equal(f.errors.length, 1);
  firstView();
  assert.equal(timers.size, 1);
  secondView();
  assert.equal(timers.size, 0);
  second();
  assert.equal(child.hasConsumers, false);
  root();
  f.owner.dispose();
  child.dispose();
});
