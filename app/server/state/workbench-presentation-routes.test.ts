/*
 * No production exports. Protect bounded app-local state and image-content admission.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DaemonIdSchema, ProjectIdSchema, ProjectIdentityKeySchema } from "workbench-shared/workbench/identity";
import WorkbenchPresentationController from "./WorkbenchPresentationController";
import WorkbenchPresentationRepository from "./WorkbenchPresentationRepository";
import WorkbenchPresentationRoutes from "./workbench-presentation-routes";

test("presentation HTTP admits state and bounded image bytes without daemon execution routes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-presentation-http-"));
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(root, "presentation.sqlite3") });
  const owner = new WorkbenchPresentationController(repository);
  const routes = new WorkbenchPresentationRoutes(owner);
  const server = http.createServer((request, response) => {
    void routes.handle(request, response, new URL(request.url ?? "/", "http://localhost"))
      .then(handled => { if (!handled) { response.writeHead(404); response.end(); } })
      .catch(error => { response.writeHead(500); response.end(String(error)); });
  });
  try {
    await repository.start();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const daemonId = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
    const projectId = ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
    const identityKey = ProjectIdentityKeySchema.parse("remote://example.test/owner/repo");
    const registration = await fetch(`${origin}/api/workbench-presentation/mutate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "registerLocations", daemonId, hostname: "desktop",
        catalog: { data: [{
          identityKey, rootIdentityKeys: [identityKey],
          project: {
            id: projectId, kind: "git", name: "repo", relativePath: "repo",
            rootPath: "/repo", roots: [{ id: "repo", isPrimary: true,
              name: "repo", relativePath: "repo", rootPath: "/repo" }], lastCommitTimeMs: null,
          },
        }] },
      }),
    });
    assert.equal(registration.status, 200);
    const registered = await registration.json() as { projects: Array<{ id: string }> };
    const draftId = "2d64382a-c7e5-456a-9ee5-6e16de89453d";
    const saved = await fetch(`${origin}/api/workbench-presentation/mutate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "putDraft", expectedRevision: null,
        draft: {
          id: draftId, logicalProjectId: registered.projects[0]!.id,
          target: { daemonId, projectId }, prompt: "hello", updatedAt: 1,
          selection: { kind: "custom", settings: {
            agentPath: null, agentSource: null, harness: "codex", model: "test",
            reasoningEffort: null, serviceTier: null,
          } },
        },
      }),
    });
    assert.equal(saved.status, 200);
    const bytes = Buffer.from("image-bytes");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const upload = await fetch(`${origin}/api/workbench-presentation/drafts/${draftId}/attachments/image-1/chunks/0`, {
      method: "PUT", body: bytes,
    });
    assert.equal(upload.status, 200);
    const completed = await fetch(`${origin}/api/workbench-presentation/drafts/${draftId}/attachments/image-1/complete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 1, mediaType: "image/png", hash }),
    });
    assert.equal(completed.status, 200);
    const image = await fetch(`${origin}/api/workbench-presentation/drafts/${draftId}/attachments/image-1`);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    const rejected = await fetch(`${origin}/api/workbench-presentation/drafts/${draftId}/attachments/image-1/complete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 1, mediaType: "text/html", hash }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    owner.close();
    await repository.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
