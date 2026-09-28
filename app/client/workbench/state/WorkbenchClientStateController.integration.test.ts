/* No production exports. Exercise browser state against real SQLite and binary attachment admission. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "../../../../shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { createServer } from "node:http";
import { ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchClientStateMutation, WorkbenchClientStateResponse } from "workbench-shared/state/workbench-client-state";
import WorkbenchAppStateRepository from "../../../server/state/WorkbenchAppStateRepository";
import WorkbenchBrowserStateRegistry from "../../../server/state/WorkbenchBrowserStateRegistry";
import WorkbenchAppStateRoutes from "../../../server/state/workbench-app-state-routes";
import { createWorkspaceClientFixture } from "../app/workspace-client-fixture";
import WorkbenchClientStateController from "./WorkbenchClientStateController";
import { saveComposerDraft, saveQuestionnaireDraft } from "./draft-persistence";

const browserStateId = "b67fc086-6f5d-46eb-aede-081027e43b72";
const daemonId = "10000000-0000-4000-8000-000000000001";

async function fixture(context: TestContext, failAttachment = false) {
  const temporary = await WorkbenchTemporaryDirectory.create("workspace-app-state-");
  const directory = temporary.path;
  const repository = new WorkbenchAppStateRepository({ databasePath: path.join(directory, "state.sqlite3") });
  await repository.start();
  const registry = new WorkbenchBrowserStateRegistry(repository);
  registry.start();
  const routes = new WorkbenchAppStateRoutes(registry);
  const server = createServer((request, response) => {
    void routes.handle(request, response, new URL(request.url!, "http://localhost")).catch(error => {
      response.writeHead(500); response.end(error instanceof Error ? error.message : "Attachment failed.");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const mutations: WorkbenchClientStateMutation[] = [];
  const connection = createWorkspaceClientFixture();
  const socket = await connection.open();
  let intercept = async (mutation: WorkbenchClientStateMutation) => registry.mutateBrowser(browserStateId, mutation, true);
  const rawRequest = connection.rpc.requestRaw.bind(connection.rpc);
  context.mock.method(connection.rpc, "requestRaw", async (
    request: Parameters<typeof rawRequest>[0], options?: Parameters<typeof rawRequest>[1],
  ) => {
    if (request.method !== "app/state/mutate") return rawRequest(request, options);
    assert.equal(request.params.browserStateId, browserStateId);
    mutations.push(request.params.mutation);
    return intercept(request.params.mutation);
  });
  let failedAttachment = false;
  const state = new WorkbenchClientStateController({
    browserStateId, workspace: connection.workspace,
    fetcher: async (input, init) => {
      const url = new URL(String(input), origin);
      assert.ok(url.protocol === "data:" || url.pathname === "/api/workbench-client-state/attachment");
      if (failAttachment && !failedAttachment && init?.method === "PUT"
        && url.searchParams.get("attachmentId") === "second") {
        failedAttachment = true;
        return new Response("injected upload failure", { status: 500 });
      }
      return fetch(url, init);
    },
  });
  context.after(async () => {
    state.dispose(); connection.dispose(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await registry.close(); await repository.close();
    await temporary.dispose();
  });
  await state.bootstrap();
  const query = await socket.request("workspace/observe", 0, request => request.params.query.kind === "appState");
  let revision = 0;
  const push = (data: WorkbenchClientStateResponse) => socket.observation(query, {
    kind: "appState", phase: "current", failure: null, data,
  }, ++revision);
  push(await registry.readWorkspaceBrowser(browserStateId, [{ daemonId, attachedLocal: true }]));
  return { state, registry, mutations, push,
    intercept: (next: typeof intercept) => { intercept = next; } };
}

test("large composer and questionnaire image drafts recover after an upload failure without embedding image bytes in state intents", async context => {
  const f = await fixture(context, true);
  const image = `data:image/png;base64,${Buffer.alloc(600_000, 42).toString("base64")}`;
  const identity = {
    daemonRegistrationId: f.state.daemonRegistrationId,
    projectId: ProjectIdSchema.parse("project"), threadId: ThreadReferenceSchema.parse("thread"),
  };
  const target = { ...identity, kind: "thread" as const };
  const update = () => ({ text: "send both", attachments: [
    { id: "first", url: image }, { id: "second", url: image },
  ], updatedAt: 1 });
  await assert.rejects(saveComposerDraft(f.state, target, update, {
    reason: "autosave", detached: false,
  }), /injected upload failure/);
  assert.equal(f.state.records("composerDraft")[0]?.value.attachments.length, 1);
  const saved = await saveComposerDraft(f.state, target, update, { reason: "autosave", detached: false });
  assert.equal(saved?.attachments.length, 2);
  assert.ok(f.mutations.every(mutation => JSON.stringify(mutation).length < 1_000_000));
  const savedUrl = saved?.attachments[1]?.url;
  assert.ok(savedUrl);
  assert.equal(await f.state.resolveDraftAttachmentUrl(savedUrl), image);
  const answer = await saveQuestionnaireDraft(f.state, () => ({ ...identity, requestKey: "question" }), current => ({
    ...current, attachments: [{ id: "answer", url: image }],
  }));
  assert.equal(await f.state.resolveDraftAttachmentUrl(answer.attachments[0]!.url), image);
  f.push(await f.registry.readBrowser(browserStateId, undefined, true));
  assert.equal(f.state.records("composerDraft")[0]?.value.attachments.length, 2);
  assert.equal(f.state.records("questionnaireDraft")[0]?.value.attachments.length, 1);
});

test("app-owned alias registration preserves native draft addresses and later edits in SQLite", async context => {
  const f = await fixture(context);
  const identity = { kind: "composerDraft" as const, daemonRegistrationId: f.state.daemonRegistrationId,
    projectId: "old", threadId: "native" };
  const value = { text: "retained", attachments: [], updatedAt: 1 };
  await f.state.put({ ...identity, value });
  f.state.rememberThreadIdentityAlias("old", "native", "canonical-thread");
  const projectId = ProjectIdSchema.parse("00000000-0000-4000-8000-000000000002");
  f.push(await f.registry.readWorkspaceBrowser(browserStateId, [{
    daemonId, attachedLocal: true, aliases: [{ alias: "old", projectId }],
  }]));
  assert.equal(f.state.records("composerDraft")[0]?.threadId, "canonical-thread");
  await f.state.put({ ...identity, projectId, threadId: "canonical-thread", value: { ...value, text: "newer", updatedAt: 2 } });
  f.push(await f.registry.readBrowser(browserStateId, undefined, true));
  assert.equal(f.state.records("composerDraft").length, 1);
  assert.equal(f.state.records("composerDraft")[0]?.value.text, "newer");
  const stored = await f.registry.readBrowser(browserStateId);
  const live = stored.rows.composerDrafts.filter(row => !row.deleted);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.thread_id, "native");
  assert.equal(live[0]?.project_id, projectId);
  await f.state.delete({ ...identity, projectId, threadId: "canonical-thread" });
  f.push(await f.registry.readBrowser(browserStateId, undefined, true));
  assert.deepEqual(f.state.records("composerDraft"), []);
});

test("provider-specific model preferences commit independently and a failed write rolls back only its optimistic edit", async context => {
  const f = await fixture(context);
  const left = { kind: "modelPreference" as const, harness: "codex" as const, modelId: "shared-name", favourite: true };
  const right = { ...left, harness: "copilot" as const };
  await Promise.all([f.state.put(left), f.state.put(right)]);
  f.intercept(async mutation => {
    if (mutation.action === "put" && mutation.record.kind === "modelPreference" && mutation.record.harness === "codex") {
      throw new Error("storage rejected write");
    }
    return f.registry.mutateBrowser(browserStateId, mutation, true);
  });
  await assert.rejects(f.state.put({ ...left, favourite: false }), /storage rejected/);
  f.push(await f.registry.readBrowser(browserStateId));
  assert.deepEqual(f.state.records("modelPreference").map(record => [record.harness, record.favourite]).sort(), [
    ["codex", true], ["copilot", true],
  ]);
});
