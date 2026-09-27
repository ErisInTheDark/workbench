/*
 * No production exports. Protect app presentation freshness and visible mutation failure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PresentationDraftInput, PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import { DaemonIdSchema, DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchPresentationClient from "./WorkbenchPresentationClient";

const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");

function snapshot(revision: number): PresentationSnapshot {
  return {
    daemons: [], defaults: [], divergences: [], drafts: [], folders: [],
    locations: [], members: [], projects: [], revision, sourceMappings: [],
  };
}

test("burst presentation notices share one read and retain the newest revision", async () => {
  const release = Promise.withResolvers<Response>();
  let reads = 0;
  const client = new WorkbenchPresentationClient({ fetcher: async () => {
    reads++;
    return reads === 1 ? Response.json(snapshot(1)) : await release.promise;
  } });
  try {
    await client.refresh();
    const updated = Promise.withResolvers<void>();
    const unsubscribe = client.subscribe(() => {
      if (client.snapshot().data?.revision === 3) updated.resolve();
    });
    client.noticeRevision(2);
    client.noticeRevision(3);
    assert.equal(reads, 2);
    release.resolve(Response.json(snapshot(3)));
    await updated.promise;
    unsubscribe();
    assert.equal(reads, 2);
  } finally {
    release.resolve(Response.json(snapshot(3)));
    client.dispose();
  }
});

test("a late presentation read cannot replace a newer mutation result", async () => {
  let releaseRead!: (response: Response) => void;
  const readResponse = new Promise<Response>(resolve => { releaseRead = resolve; });
  const fetcher: typeof fetch = async (_input, options) => options?.method === "POST"
    ? Response.json(snapshot(2)) : await readResponse;
  const client = new WorkbenchPresentationClient({ fetcher });
  try {
    const read = client.refresh();
    await client.mutate({ kind: "registerLocations",
      daemonId, hostname: "desktop", catalog: { data: [] } });
    releaseRead(Response.json(snapshot(1)));
    await read;
    assert.equal(client.snapshot().data?.revision, 2);
  } finally { client.dispose(); }
});

test("a rejected presentation mutation refreshes current state and still fails visibly", async () => {
  let revision = 0;
  const fetcher: typeof fetch = async (_input, options) => {
    if (options?.method === "POST") {
      revision = 3;
      return Response.json({ error: "Draft revision changed." }, { status: 400 });
    }
    return Response.json(snapshot(revision));
  };
  const client = new WorkbenchPresentationClient({ fetcher });
  try {
    await client.refresh();
    await assert.rejects(client.mutate({ kind: "registerLocations",
      daemonId, hostname: "desktop", catalog: { data: [] } }),
    /Draft revision changed/u);
    assert.equal(client.snapshot().data?.revision, 3);
  } finally { client.dispose(); }
});

test("own delete retains its exact revision even when a newer snapshot arrives first", async () => {
  const draft: PresentationDraftInput = {
    id: DraftIdSchema.parse(crypto.randomUUID()),
    logicalProjectId: LogicalProjectIdSchema.parse(crypto.randomUUID()),
    target: { daemonId, projectId: ProjectIdSchema.parse("project") },
    prompt: "first words", updatedAt: 1,
    selection: { kind: "custom", settings: {
      agentPath: null, agentSource: null, harness: "codex", model: "model",
      reasoningEffort: null, serviceTier: null, contextWindowTokens: null,
    } },
  };
  const initial: PresentationSnapshot = { ...snapshot(40), drafts: [{
    ...draft, revision: 5, phase: "unsent", pinned: false, snoozed: false,
    launchId: null, acceptedThreadId: null, attachments: [],
  }] };
  const deleteResponse = Promise.withResolvers<Response>();
  let reads = 0;
  let reopenedWith: number | null = null;
  const client = new WorkbenchPresentationClient({ fetcher: async (_input, options) => {
    if (options?.method !== "POST") return Response.json(reads++ === 0 ? initial : snapshot(43));
    const mutation = JSON.parse(String(options.body)) as { kind: string; expectedRevision: number | null };
    if (mutation.kind === "deleteDraft") return await deleteResponse.promise;
    reopenedWith = mutation.expectedRevision;
    return Response.json(snapshot(44));
  } });
  try {
    await client.refresh();
    const removal = client.removeDraft(draft.id);
    await client.refresh();
    deleteResponse.resolve(Response.json(snapshot(42)));
    await removal;
    await client.putDraft({ ...draft, prompt: "new words" });
    assert.equal(reopenedWith, 42);
  } finally {
    deleteResponse.resolve(Response.json(snapshot(42)));
    client.dispose();
  }
});

test("another client's deletion does not give this client a reopen token", async () => {
  const draft: PresentationDraftInput = {
    id: DraftIdSchema.parse(crypto.randomUUID()),
    logicalProjectId: LogicalProjectIdSchema.parse(crypto.randomUUID()),
    target: { daemonId, projectId: ProjectIdSchema.parse("project") },
    prompt: "words", updatedAt: 1,
    selection: { kind: "custom", settings: {
      agentPath: null, agentSource: null, harness: "codex", model: "model",
      reasoningEffort: null, serviceTier: null, contextWindowTokens: null,
    } },
  };
  let expectedRevision: number | null | undefined;
  let reads = 0;
  const client = new WorkbenchPresentationClient({ fetcher: async (_input, options) => {
    if (options?.method !== "POST") return Response.json(reads++ === 0
      ? { ...snapshot(10), drafts: [{
        ...draft, revision: 5, phase: "unsent", pinned: false, snoozed: false,
        launchId: null, acceptedThreadId: null, attachments: [],
      }] }
      : snapshot(12));
    expectedRevision = (JSON.parse(String(options.body)) as { expectedRevision: number | null }).expectedRevision;
    return Response.json({ error: "Draft changed in another browser." }, { status: 400 });
  } });
  try {
    await client.refresh();
    await client.refresh();
    await assert.rejects(client.putDraft(draft), /another browser/u);
    assert.equal(expectedRevision, null);
  } finally { client.dispose(); }
});
