/* Exports: none; tests protect transfer policy capture, duplicate actions and persistent partial completion. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { createWorkspaceClientFixture } from "../app/workspace-client-fixture";
import WorkbenchGitPeerState from "./WorkbenchGitPeerState";

const location = { daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001"), projectId: ProjectIdSchema.parse("own") };
const peer = {
  daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002"), projectId: ProjectIdSchema.parse("peer"),
  hostname: "nixos", rootPath: "/work", state: "current" as const, ahead: 1, behind: 1, failure: null,
};

test("an in-flight transfer captures its mode and ignores a repeated action", async t => {
  const fixture = createWorkspaceClientFixture();
  t.after(() => fixture.dispose());
  const handle = WorkbenchGitPeerState.acquire(fixture.workspace, location);
  t.after(handle.release);
  const calls: Parameters<typeof fixture.rpc.requestRaw>[0][] = [];
  const gate = Promise.withResolvers<object>();
  fixture.rpc.requestRaw = request => { calls.push(request); return gate.promise; };
  const first = handle.state.transfer("pull", peer, "rebase");
  await handle.state.transfer("send", peer, "merge");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: "workspace/git/peer", params: {
    action: "pull", location, peer: { daemonId: peer.daemonId, projectId: peer.projectId }, mode: "rebase",
  } });
  gate.resolve({ kind: "current" });
  await first;
  assert.equal(handle.state.getSnapshot().busy, null);
});

test("partial completion survives changed peer counts until the next explicit action", async t => {
  const fixture = createWorkspaceClientFixture();
  t.after(() => fixture.dispose());
  const socket = await fixture.open();
  const handle = WorkbenchGitPeerState.acquire(fixture.workspace, location);
  t.after(handle.release);
  const observation = await socket.request("workspace/observe");
  await socket.observation(observation, { kind: "gitPeers", phase: "current", failure: null,
    data: { branch: "main", peers: [peer] } });
  fixture.rpc.requestRaw = async () => ({
    kind: "blocked", location, progress: "senderUpdated", reason: "Receiver has overlapping edits.", conflicts: ["file.txt"],
  });
  await handle.state.transfer("pull", peer, "rebase");
  assert.equal(handle.state.getSnapshot().outcome?.progress, "senderUpdated");
  await socket.observation(observation, { kind: "gitPeers", phase: "current", failure: null,
    data: { branch: "main", peers: [{ ...peer, ahead: 0, behind: 2 }] } }, 2);
  assert.equal(handle.state.getSnapshot().outcome?.progress, "senderUpdated");
  fixture.rpc.requestRaw = async () => ({ kind: "current" });
  await handle.state.transfer("pull", peer, "merge");
  assert.equal(handle.state.getSnapshot().outcome, null);
});

test("closing and reopening a view retains its in-flight action and partial result", async t => {
  const fixture = createWorkspaceClientFixture();
  t.after(() => fixture.dispose());
  const first = WorkbenchGitPeerState.acquire(fixture.workspace, location);
  const gate = Promise.withResolvers<object>();
  fixture.rpc.requestRaw = () => gate.promise;
  const transfer = first.state.transfer("pull", peer, "rebase");
  first.release();
  const reopened = WorkbenchGitPeerState.acquire(fixture.workspace, location);
  t.after(reopened.release);
  assert.equal(reopened.state.getSnapshot().busy?.mode, "rebase");
  gate.resolve({ kind: "blocked", location, progress: "senderUpdated", reason: "Overlapping edits.", conflicts: ["file.txt"] });
  await transfer;
  reopened.release();
  const result = WorkbenchGitPeerState.acquire(fixture.workspace, location);
  t.after(result.release);
  assert.equal(result.state.getSnapshot().outcome?.progress, "senderUpdated");
});
