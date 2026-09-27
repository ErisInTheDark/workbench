/* No production exports. Protect old browser-state reads while adding daemon-qualified registrations. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";
import WorkbenchBrowserStateRegistry from "./WorkbenchBrowserStateRegistry.ts";
import WorkbenchAppStateRoutes from "./workbench-app-state-routes.ts";

test("registration metadata is negotiated without changing legacy app-state responses", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-app-state-capability-"));
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
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const legacy = await (await fetch(`${origin}/api/workbench-client-state`)).json();
  const modern = await (await fetch(`${origin}/api/workbench-client-state?capabilities=2`)).json();
  assert.ok(legacy && typeof legacy === "object");
  assert.ok(modern && typeof modern === "object");
  assert.equal("registrations" in legacy, false);
  assert.ok("registrations" in modern);
  const invalid = await fetch(`${origin}/api/workbench-client-state/global-preference?capabilities=3`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "globalPreference", preference: {
      key: "harness", value: "not a provider",
    } }),
  });
  assert.equal(invalid.status, 400, "an invalid provider identity must not be admitted by a kind-only cast");
  const compatible = await fetch(`${origin}/api/workbench-client-state/global-preference?capabilities=3`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "globalPreference",
      preference: { key: "theme", value: "winter", oldBrowserHint: true } }),
  });
  assert.equal(compatible.status, 200, "unknown old-browser fields must not reject a valid preference");
});

test("draft images upload separately from the bounded mutation body and remain readable", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-app-state-images-"));
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
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browserStateId = "b67fc086-6f5d-46eb-aede-081027e43b72";
  const read = await fetch(`${origin}/api/workbench-client-state?capabilities=3`, {
    headers: { "x-workbench-browser-state-id": browserStateId },
  });
  const state = await read.json() as { daemonRegistrationId: string };
  const draft = {
    kind: "composerDraft", daemonRegistrationId: state.daemonRegistrationId,
    projectId: "project", threadId: "thread",
    value: { attachments: [], text: "saved", updatedAt: 1 },
  };
  const saved = await fetch(`${origin}/api/workbench-client-state/composer-draft?capabilities=3`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-workbench-browser-state-id": browserStateId },
    body: JSON.stringify(draft),
  });
  assert.equal(saved.status, 200);
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
  const updated = await fetch(`${origin}/api/workbench-client-state?capabilities=3`, {
    headers: { "x-workbench-browser-state-id": browserStateId },
  });
  const payload = await updated.json() as { rows: { composerDraftAttachments: Array<{ url: string }> } };
  assert.equal(payload.rows.composerDraftAttachments.length, 3);
  assert.ok(payload.rows.composerDraftAttachments.every(item => item.url.startsWith("/api/workbench-client-state/attachment?")));
  const retained = await fetch(`${origin}/api/workbench-client-state/composer-draft?capabilities=3`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-workbench-browser-state-id": browserStateId },
    body: JSON.stringify({
      ...draft,
      value: {
        attachments: payload.rows.composerDraftAttachments.map(item => ({
          id: new URL(item.url, origin).searchParams.get("attachmentId"), url: item.url,
        })),
        text: "edited after upload", updatedAt: 2,
      },
    }),
  });
  assert.equal(retained.status, 200);
  assert.equal((await retained.json() as { rows: { composerDraftAttachments: unknown[] } })
    .rows.composerDraftAttachments.length, 3);
  const legacy = await fetch(`${origin}/api/workbench-client-state?capabilities=2`, {
    headers: { "x-workbench-browser-state-id": browserStateId },
  });
  const legacyPayload = await legacy.json() as { rows: { composerDraftAttachments: Array<{ url: string }> } };
  assert.ok(legacyPayload.rows.composerDraftAttachments.every(item => item.url.startsWith("data:image/png;base64,")));
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
  const removed = await fetch(`${origin}/api/workbench-client-state/composer-draft?capabilities=3`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-workbench-browser-state-id": browserStateId },
    body: JSON.stringify({
      ...draft, value: {
        attachments: [{ id: "one", url: original.pathname + original.search }],
        text: "keep one", updatedAt: 3,
      },
    }),
  });
  assert.equal(removed.status, 200);
  original.searchParams.set("attachmentId", "two");
  assert.equal((await fetch(original)).status, 404);
  original.searchParams.set("attachmentId", "one");
  assert.equal((await fetch(original)).status, 200);
});
