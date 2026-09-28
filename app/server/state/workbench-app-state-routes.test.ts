/* No exports. Protect browser-qualified attachment admission and retained binary content. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "../../../shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import test from "node:test";
import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";
import WorkbenchBrowserStateRegistry from "./WorkbenchBrowserStateRegistry.ts";
import WorkbenchAppStateRoutes from "./workbench-app-state-routes.ts";

test("draft images upload separately from the bounded mutation body and remain readable", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-app-state-images-");
  const root = temporary.path;
  const repository = new WorkbenchAppStateRepository({ databasePath: path.join(root, "state.sqlite3") });
  await repository.start();
  const registry = new WorkbenchBrowserStateRegistry(repository);
  registry.start();
  const routes = new WorkbenchAppStateRoutes(registry);
  const server = createServer((request, response) => {
    void routes.handle(request, response, new URL(request.url!, "http://localhost"));
  });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await registry.close();
    await repository.close();
    await temporary.dispose();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browserStateId = "b67fc086-6f5d-46eb-aede-081027e43b72";
  const state = await registry.readBrowser(browserStateId, undefined, true);
  const draft = {
    kind: "composerDraft" as const, daemonRegistrationId: state.daemonRegistrationId,
    projectId: "project", threadId: "thread",
    value: { attachments: [], text: "saved", updatedAt: 1 },
  };
  await registry.mutateBrowser(browserStateId, { action: "put", record: draft }, true);
  const image = new Uint8Array(600_000).fill(42);
  for (const attachmentId of ["one", "two", "three"]) {
    const address = new URL(`${origin}/api/workbench-client-state/attachment`);
    address.searchParams.set("browserStateId", browserStateId);
    address.searchParams.set("kind", "composerDraft");
    address.searchParams.set("daemonRegistrationId", state.daemonRegistrationId);
    address.searchParams.set("projectId", "project");
    address.searchParams.set("threadId", "thread");
    address.searchParams.set("attachmentId", attachmentId);
    const uploaded = await fetch(address, {
      method: "PUT",
      headers: { "content-type": "image/png", "x-workbench-browser-state-id": browserStateId },
      body: image,
    });
    assert.equal(uploaded.status, 200);
    const downloaded = await fetch(address);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), image);
  }
  const payload = await registry.readBrowser(browserStateId, undefined, true);
  assert.equal(payload.rows.composerDraftAttachments.length, 3);
  assert.ok(payload.rows.composerDraftAttachments.every(item => item.url.startsWith("/api/workbench-client-state/attachment?")));
  const retained = await registry.mutateBrowser(browserStateId, { action: "put", record: {
      ...draft,
      value: {
        attachments: payload.rows.composerDraftAttachments.map(item => ({
          id: new URL(item.url, origin).searchParams.get("attachmentId")!, url: item.url,
        })),
        text: "edited after upload", updatedAt: 2,
      },
    } }, true);
  assert.equal(retained.rows.composerDraftAttachments.length, 3);
  const wrongBrowser = new URL(`${origin}/api/workbench-client-state/attachment`);
  wrongBrowser.searchParams.set("browserStateId", "515f22e0-b967-4927-864f-876c487c0979");
  wrongBrowser.searchParams.set("kind", "composerDraft");
  wrongBrowser.searchParams.set("daemonRegistrationId", state.daemonRegistrationId);
  wrongBrowser.searchParams.set("projectId", "project");
  wrongBrowser.searchParams.set("threadId", "thread");
  wrongBrowser.searchParams.set("attachmentId", "one");
  assert.equal((await fetch(wrongBrowser)).status, 404);
  const original = new URL(wrongBrowser);
  original.searchParams.set("browserStateId", browserStateId);
  original.searchParams.set("attachmentId", "one");
  assert.equal((await fetch(original, {
    method: "PUT",
    headers: { "content-type": "image/png", "x-workbench-browser-state-id": "515f22e0-b967-4927-864f-876c487c0979" },
    body: image,
  })).status, 400);
  await registry.mutateBrowser(browserStateId, { action: "put", record: {
      ...draft, value: {
        attachments: [{ id: "one", url: original.pathname + original.search }],
        text: "keep one", updatedAt: 3,
      },
    } }, true);
  original.searchParams.set("attachmentId", "two");
  assert.equal((await fetch(original)).status, 404);
  original.searchParams.set("attachmentId", "one");
  assert.equal((await fetch(original)).status, 200);
});
