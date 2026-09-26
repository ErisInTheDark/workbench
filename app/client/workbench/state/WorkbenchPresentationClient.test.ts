/*
 * No production exports. Protect app presentation freshness and visible mutation failure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
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
