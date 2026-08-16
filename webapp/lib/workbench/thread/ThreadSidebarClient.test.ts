/* No production exports. Tests protect optimistic draft queues, revisions, and leave-safe flushing. */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadSidebarClient from "./ThreadSidebarClient.ts";
import type { WorkbenchThreadDraft, WorkbenchThreadStateSnapshot } from "./thread-state.ts";

const draft = (prompt: string, clientUpdatedAt: number): WorkbenchThreadDraft => ({
  agent: null, attachments: [], clientUpdatedAt, composerSettings: {}, createdAt: 1,
  draftId: "00000000-0000-4000-8000-000000000001", harness: "codex", model: null,
  profileId: null, projectId: "project", prompt, reasoningEffort: null, serviceTier: null, updatedAt: clientUpdatedAt,
});
const snapshot = (revision: number): WorkbenchThreadStateSnapshot => ({ entries: [], error: null, freshness: "fresh", projectId: "project", revision });

test("optimistic edits keep the newest value through one single-flight flush", async () => {
  const writes: WorkbenchThreadDraft[] = [];
  let releaseFirst: (() => void) | null = null;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const states: string[] = [];
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    onDraftSaveStateChange: (_id, state) => states.push(state),
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async (_projectId, value) => { writes.push(value); if (writes.length === 1) await first; },
    },
  });
  await client.open("project");
  client.edit(draft("first value here", 2));
  const flushing = client.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.edit(draft("newest value here", 3));
  releaseFirst?.();
  await flushing;
  await client.flush();
  assert.deepEqual(writes.map((value) => value.prompt), ["first value here", "newest value here"]);
  assert.equal(client.getDraftSaveState(draft("", 0).draftId), "saved");
  assert.deepEqual(states, ["saving", "saved"]);
});

test("newer pushed revisions win and foreign project revisions are ignored", async () => {
  const installed: Array<WorkbenchThreadStateSnapshot | null> = [];
  const client = new ThreadSidebarClient({
    onChange: (value) => installed.push(value),
    transport: { close: async () => undefined, deleteDraft: async () => undefined, open: async () => snapshot(2), upsertDraft: async () => undefined },
  });
  await client.open("project");
  client.accept(snapshot(1));
  client.accept({ ...snapshot(3), projectId: "other" });
  client.accept(snapshot(3));
  assert.deepEqual(installed.map((value) => value?.revision), [2, 3]);
});

test("failed navigation flush preserves the route and re-enters the same debounced edit path", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let navigated = false;
  let attempts = 0;
  const states: string[] = [];
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    onDraftSaveStateChange: (_id, state) => states.push(state),
    transport: {
      close: async () => undefined,
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk busy");
      },
    },
  });
  await client.open("project");
  client.edit(draft("keep this route here", 2));
  await assert.rejects(client.guardNavigation(() => { navigated = true; }), /disk busy/u);
  assert.equal(navigated, false);
  assert.equal(client.getDraftSaveState(draft("", 0).draftId), "saving");
  assert.deepEqual(states, ["saving", "failed", "saving"]);

  context.mock.timers.tick(500);
  assert.equal(attempts, 2);
  await client.flush();
  assert.equal(client.getDraftSaveState(draft("", 0).draftId), "saved");
  assert.deepEqual(states, ["saving", "failed", "saving", "saved"]);
});

test("close flushes the newest draft before releasing project observation", async () => {
  const events: string[] = [];
  const client = new ThreadSidebarClient({
    onChange: () => undefined,
    transport: {
      close: async () => { events.push("close"); },
      deleteDraft: async () => undefined,
      open: async () => snapshot(1),
      upsertDraft: async (_projectId, value) => { events.push(`save:${value.prompt}`); },
    },
  });
  await client.open("project");
  client.edit(draft("persist before close", 2));
  await client.close();
  assert.deepEqual(events, ["save:persist before close", "close"]);
});
