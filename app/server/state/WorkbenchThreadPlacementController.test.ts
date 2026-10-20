/*
 * Exports: none. Tests protect app-owned placement across daemons: dependent waits on another daemon's thread,
 * unreachable targets, questionnaire interruption order, refusals, and pins that follow their thread until archived.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import WorkbenchTemporaryDirectory from "../../../shared/WorkbenchTemporaryDirectory";
import { DaemonIdSchema, ProjectIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSidebarThreadRow } from "workbench-shared/workbench/thread/thread-sidebar-row";
import WorkbenchPresentationController from "./WorkbenchPresentationController";
import WorkbenchPresentationRepository from "./WorkbenchPresentationRepository";
import WorkbenchThreadPlacementController from "./WorkbenchThreadPlacementController";

type Row = WorkbenchThreadSidebarThreadRow;

function row(threadId: string, lifecycle: object, extra: object = {}): Row {
  return {
    activityAt: 0, title: threadId, entryKind: "thread", identity: { harness: "codex", threadId },
    metadata: { archived: false, pinned: false, snoozed: false }, lifecycle, waitingOnThreads: [], ...extra,
  } as unknown as Row;
}
const completed = (turnId: string) => ({ kind: "completed", reason: "agentCompleted", settled: false, agent: { agentStatus: "completed", turnId } });
const working = (turnId: string) => ({ kind: "working", reason: "acceptedIntent", settled: false, agent: { agentStatus: "working", turnId } });

/** One connected daemon holding some threads; summary batches answer every requested id, null for ones it lacks. */
function daemon(name: string) {
  const id = DaemonIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse(name);
  const rows = new Map<string, Row>();
  const listeners = new Set<() => void>();
  const interrupts: Array<{ threadId: string; requestKey: string }> = [];
  const source = {
    id,
    daemon: { threads: { interrupt: async (input: { threadId: string; requestKey: string }) => { interrupts.push(input); } } },
    observe(query: { threadIds: string[] }, listener: () => void) {
      let ids = query.threadIds;
      listeners.add(listener);
      return {
        getSnapshot: () => ({ phase: "current", failure: null, value: { kind: "threadSummaries", summaries: Object.fromEntries(
          ids.map(threadId => [threadId, rows.has(threadId) ? { projectId, summary: { facts: {}, row: rows.get(threadId)! } } : null]),
        ) } }),
        retarget: (next: { threadIds: string[] }) => { ids = next.threadIds; },
        release: () => { listeners.delete(listener); },
      };
    },
  };
  return {
    id, projectId, source, interrupts,
    put(next: Row) {
      rows.set(next.identity.threadId, next);
      for (const listener of [...listeners]) listener();
    },
    holds: (threadId: string) => rows.has(threadId),
  };
}

async function fixture(context: TestContext, daemons: Array<ReturnType<typeof daemon>>) {
  const temporary = await WorkbenchTemporaryDirectory.create("thread-snooze-");
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(temporary.path, "presentation.sqlite3") });
  await repository.start();
  const presentation = new WorkbenchPresentationController(repository);
  let connected = [...daemons];
  const notifySources = new Set<() => void>();
  const controller = new WorkbenchThreadPlacementController({
    sources: { all: () => connected.map(entry => entry.source) as never, subscribe: listener => {
      notifySources.add(listener); return () => { notifySources.delete(listener); };
    } },
    presentation,
    threads: { withThread: async (threadId, action) => {
      const owner = connected.find(entry => entry.holds(threadId));
      if (!owner) throw new Error("Thread UUID is unavailable on connected daemons.");
      return await action(owner.source as never, {
        phase: "current", identity: { threadId, harness: "codex" } as never,
        location: { daemonId: owner.id as DaemonId, projectId: owner.projectId }, logicalProjectId: null,
      });
    } },
    warn: message => assert.fail(message),
  });
  controller.start();
  context.after(async () => { controller.dispose(); presentation.close(); await repository.close(); await temporary.dispose(); });
  return {
    controller,
    disconnect(entry: ReturnType<typeof daemon>) {
      connected = connected.filter(candidate => candidate !== entry);
      for (const listener of [...notifySources]) listener();
    },
  };
}

test("a thread waits on a thread from another daemon and wakes once that target completes without claims", async context => {
  const desktop = daemon("desktop");
  const remote = daemon("remote");
  const sourceId = randomUUID();
  const targetId = randomUUID();
  desktop.put(row(sourceId, completed("s1")));
  remote.put(row(targetId, working("t1")));
  const f = await fixture(context, [desktop, remote]);

  assert.equal(await f.controller.toggleTarget(sourceId, targetId), true);
  assert.deepEqual(f.controller.read().snoozes.get(sourceId)?.targets.map(target => [target.identity.threadId, target.projectId]),
    [[targetId, remote.projectId]]);

  remote.put(row(targetId, completed("t1"), { gitArc: {
    phase: "active", checkpointCommit: "a".repeat(40), proposals: [], claimedPaths: ["file.ts"],
  } }));
  assert.ok(f.controller.read().snoozes.has(sourceId), "a target still holding claims is not ready");
  remote.put(row(targetId, completed("t1")));
  assert.equal(f.controller.read().snoozes.has(sourceId), false);
});

test("a target no connected daemon answers for keeps its source waiting", async context => {
  const desktop = daemon("desktop");
  const remote = daemon("remote");
  const sourceId = randomUUID();
  const targetId = randomUUID();
  desktop.put(row(sourceId, completed("s1")));
  remote.put(row(targetId, working("t1")));
  const f = await fixture(context, [desktop, remote]);
  await f.controller.toggleTarget(sourceId, targetId);

  f.disconnect(remote);
  desktop.put(row(sourceId, completed("s1")));
  assert.ok(f.controller.read().snoozes.has(sourceId));
});

test("a target that is already done adds nothing, and an idle thread holding claims cannot snooze", async context => {
  const desktop = daemon("desktop");
  const sourceId = randomUUID();
  const doneId = randomUUID();
  desktop.put(row(sourceId, completed("s1"), { gitArc: {
    phase: "active", checkpointCommit: "a".repeat(40), proposals: [], claimedPaths: ["file.ts"],
  } }));
  desktop.put(row(doneId, completed("d1")));
  const f = await fixture(context, [desktop]);

  assert.equal(await f.controller.toggleTarget(sourceId, doneId), true);
  assert.equal(f.controller.read().snoozes.has(sourceId), false);
  assert.equal(await f.controller.snooze(sourceId, true), false);
  assert.equal(f.controller.read().snoozes.has(sourceId), false);
});

test("questionnaire snooze interrupts its turn before recording, then wakes only when the question leaves", async context => {
  const desktop = daemon("desktop");
  const threadId = randomUUID();
  const question = { itemId: null, requestKey: "q", turnId: null, request: {
    id: "q", title: "Choose", summary: "", submitLabel: "Send",
    questions: [{ id: "c", header: "c", question: "Go?", options: [], allowOther: true, isSecret: false }],
  } };
  const waiting = row(threadId, { kind: "needsAttention", reason: "pendingInput", requestKey: "q", settled: false }, { pendingQuestionnaire: question });
  desktop.put(waiting);
  const f = await fixture(context, [desktop]);

  assert.equal(await f.controller.snooze(threadId, true, "other"), false);
  assert.deepEqual(desktop.interrupts, []);
  assert.equal(await f.controller.snooze(threadId, true, "q"), true);
  assert.deepEqual(desktop.interrupts, [{ threadId, requestKey: "q" }]);
  assert.equal(f.controller.read().snoozes.get(threadId)?.basis.questionnaireKey, "q");

  desktop.put(row(threadId, working("t9"), { pendingQuestionnaire: question }));
  assert.ok(f.controller.read().snoozes.has(threadId), "turn movement keeps a held question snoozed");
  desktop.put(row(threadId, working("t9")));
  assert.equal(f.controller.read().snoozes.has(threadId), false);
});

test("a pin on another daemon's thread feeds its watched row, survives settling and drops on archive", async context => {
  const desktop = daemon("desktop");
  const remote = daemon("remote");
  const threadId = randomUUID();
  remote.put(row(threadId, working("t1")));
  const f = await fixture(context, [desktop, remote]);

  assert.equal(await f.controller.pin(threadId, true), true);
  assert.equal(f.controller.read().isPinned(threadId), true);
  const watched = f.controller.readPinnedRows().get(threadId);
  assert.deepEqual(watched?.location, { daemonId: remote.id, projectId: remote.projectId });
  assert.equal(watched?.row.entryKind === "thread" && watched.row.metadata.pinned, true);

  remote.put(row(threadId, { ...completed("t1"), settled: true }));
  assert.equal(f.controller.read().isPinned(threadId), true, "a restore inside the archive window returns pinned");
  remote.put(row(threadId, { ...completed("t1"), settled: true }, { metadata: { archived: true, pinned: false, snoozed: false } }));
  assert.equal(f.controller.read().isPinned(threadId), false);
  assert.equal(f.controller.readPinnedRows().has(threadId), false);
});

test("settled threads cannot gain a pin, and unpinning always succeeds", async context => {
  const desktop = daemon("desktop");
  const threadId = randomUUID();
  desktop.put(row(threadId, { ...completed("t1"), settled: true }));
  const f = await fixture(context, [desktop]);

  assert.equal(await f.controller.pin(threadId, true), false);
  assert.equal(f.controller.read().isPinned(threadId), false);
  assert.equal(await f.controller.pin(randomUUID(), false), true);
});
