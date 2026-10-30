/*
 * No production exports. Tests protect which inbound grants authorize which relayed needs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "../identity.ts";
import { NetworkGrant, type NetworkGrant as Grant } from "./network-grants.ts";

const a = DaemonIdSchema.parse("11111111-1111-4111-8111-111111111111");
const b = DaemonIdSchema.parse("22222222-2222-4222-8222-222222222222");
const caller = { daemonId: a, threadId: WorkbenchThreadIdSchema.parse("caller") };
const target = WorkbenchThreadIdSchema.parse("target");
const project = ProjectIdSchema.parse("project");

function grant(overrides: Partial<Grant>): Grant {
  return {
    id: "33333333-3333-4333-8333-333333333333", kind: "thread", callerDaemonId: a, callerThreadId: caller.threadId,
    callerHostname: "a", callerTitle: "caller", targetThreadId: target, targetProjectId: null, targetLabel: "target", createdAt: 1,
    ...overrides,
  };
}

test("a thread grant covers reading and messaging only that thread, for only that caller", () => {
  const grants = [grant({})];
  assert.equal(NetworkGrant.authorizes(grants, caller, { kind: "thread", threadId: target }), true);
  assert.equal(NetworkGrant.authorizes(grants, caller, { kind: "message", threadId: target }), true);
  assert.equal(NetworkGrant.authorizes(grants, caller, { kind: "thread", threadId: WorkbenchThreadIdSchema.parse("other") }), false);
  assert.equal(NetworkGrant.authorizes(grants, { ...caller, daemonId: b }, { kind: "thread", threadId: target }), false);
  assert.equal(NetworkGrant.authorizes(grants, { ...caller, threadId: WorkbenchThreadIdSchema.parse("sibling") },
    { kind: "message", threadId: target }), false);
});

test("a reply grant lets the target message back but never read", () => {
  const grants = [grant({ kind: "message" })];
  assert.equal(NetworkGrant.authorizes(grants, caller, { kind: "message", threadId: target }), true);
  assert.equal(NetworkGrant.authorizes(grants, caller, { kind: "thread", threadId: target }), false);
});

test("folder and feedback grants cover only their own project", () => {
  const grants = [grant({ kind: "folder", targetThreadId: null, targetProjectId: project }),
    grant({ kind: "feedback", targetThreadId: null, targetProjectId: null })];
  assert.equal(NetworkGrant.authorizes(grants, caller, { kind: "folder", projectId: project }), true);
  assert.equal(NetworkGrant.authorizes(grants, caller, { kind: "folder", projectId: ProjectIdSchema.parse("other") }), false);
  assert.equal(NetworkGrant.authorizes(grants, caller, { kind: "feedback", projectId: null }), true);
  assert.equal(NetworkGrant.authorizes(grants, caller, { kind: "feedback", projectId: project }), false);
});

test("revoking a message need leaves a full thread grant alone", () => {
  assert.equal(NetworkGrant.matchesNeed(grant({}), { kind: "message", threadId: target }), false);
  assert.equal(NetworkGrant.matchesNeed(grant({ kind: "message" }), { kind: "message", threadId: target }), true);
  assert.equal(NetworkGrant.matchesNeed(grant({}), { kind: "thread", threadId: target }), true);
});
