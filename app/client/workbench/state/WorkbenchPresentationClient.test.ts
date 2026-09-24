/*
 * No production exports. Protect app presentation freshness and visible mutation failure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import WorkbenchPresentationClient from "./WorkbenchPresentationClient";

const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");

function snapshot(revision: number): PresentationSnapshot {
  return {
    daemons: [], defaults: [], divergences: [], drafts: [], folders: [],
    locations: [], members: [], projects: [], revision, sourceMappings: [],
  };
}

test("cancelled daemon import cannot fetch another page or mutate presentation state", async () => {
  const projectId = ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
  const logicalProjectId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const pageRequested = Promise.withResolvers<void>();
  const releasePage = Promise.withResolvers<{
    projectId: typeof projectId; sourceRevision: number; drafts: []; nextCursor: string;
  }>();
  let pages = 0;
  let mutations = 0;
  const daemon = {
    presentationExport: {
      project: () => {
        pages++;
        pageRequested.resolve();
        return releasePage.promise;
      },
    },
  } as unknown as WorkbenchDaemonClient;
  const client = new WorkbenchPresentationClient({ fetcher: async (_input, options) => {
    if (options?.method === "POST") mutations++;
    return Response.json(snapshot(1));
  } });
  const cancellation = new AbortController();
  try {
    await client.refresh();
    const importing = client.importProject(daemonId, projectId, logicalProjectId, daemon, cancellation.signal);
    await pageRequested.promise;
    cancellation.abort();
    releasePage.resolve({ projectId, sourceRevision: 1, drafts: [], nextCursor: "next" });
    await assert.rejects(importing, { name: "AbortError" });
    assert.equal(pages, 1);
    assert.equal(mutations, 0);
  } finally {
    releasePage.resolve({ projectId, sourceRevision: 1, drafts: [], nextCursor: "next" });
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
