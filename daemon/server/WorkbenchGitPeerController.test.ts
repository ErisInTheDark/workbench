/* No production exports. Tests protect peer HTTP input conformance, required identity rejection and repair diagnostics. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import WorkbenchGitPeerController from "./WorkbenchGitPeerController";

const daemonId = "11111111-1111-4111-8111-111111111111";
const projectId = "project";
const peerProjectId = "peer-project";
const tip = "a".repeat(40);

test("peer HTTP inputs repair additive drift and isolated haves without inventing required identity", async context => {
  const warnings: string[] = [];
  const controller = new WorkbenchGitPeerController({
    resolveRoot: async () => null,
    transitions: {
      run: async <TValue>(_root: string, operation: () => Promise<TValue>) => await operation(),
    },
    warn: message => warnings.push(message),
  });
  const server = createServer((request, response) => void controller.handleHttpRequest(request, response));
  context.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = async (path: string, body?: object) => await fetch(`${origin}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const additive = await post("/daemon/git-peer/haves", {
    projectId,
    peer: { daemonId, projectId: peerProjectId, futurePeerField: true },
    branch: "main",
    futureRequestField: true,
  });
  assert.equal(additive.status, 409);
  assert.deepEqual(await additive.json(), { error: "This folder is not a Git checkout." });

  const repairedArray = await post("/daemon/git-peer/bundle", {
    projectId,
    branch: "main",
    haves: [tip, "not-a-commit", "b".repeat(40)],
  });
  assert.equal(repairedArray.status, 409);
  assert.deepEqual(await repairedArray.json(), { error: "This folder is not a Git checkout." });

  const additiveQuery = await post(
    `/daemon/git-peer/receive?projectId=${projectId}&peerDaemonId=${daemonId}&peerProjectId=${peerProjectId}&branch=main&tip=${tip}&future=true`,
  );
  assert.equal(additiveQuery.status, 409);
  assert.deepEqual(await additiveQuery.json(), { error: "This folder is not a Git checkout." });

  const invalidIdentity = await post("/daemon/git-peer/haves", {
    projectId,
    peer: { daemonId: "invalid", projectId: peerProjectId },
    branch: "main",
  });
  assert.equal(invalidIdentity.status, 400);
  assert.deepEqual(await invalidIdentity.json(), { error: "Peer request is invalid." });

  assert.ok(warnings.some(message => message.includes("futurePeerField") && message.includes("futureRequestField")));
  assert.ok(warnings.some(message => message.includes("haves.1")));
  assert.ok(warnings.some(message => message.includes("future")));
});
