/*
 * No production exports. Tests protect the requester side: a target's refusal prompts the user once, approval records history and
 * dispatches a new request, and denial or a failure never dispatches again.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { NetworkAccessDecision, type NetworkTarget } from "workbench-shared/workbench/network/network-grants";
import type { RemoteCallOutcome } from "workbench-shared/workbench/network/network-remote-calls";
import WorkbenchNetworkAccessController, { NetworkDeniedError } from "./WorkbenchNetworkAccessController";

const daemonId = DaemonIdSchema.parse("22222222-2222-4222-8222-222222222222");
const target = {
  kind: "thread", daemonId, hostname: "tower", threadId: WorkbenchThreadIdSchema.parse("target"), title: "t", projectName: "p", daemonProject: false,
} satisfies NetworkTarget;
const caller = { threadId: WorkbenchThreadIdSchema.parse("caller"), cwd: "/p", title: "caller", projectId: ProjectIdSchema.parse("p") };
const denied: RemoteCallOutcome = { kind: "denied", need: { kind: "thread", threadId: target.threadId }, failure: "no grant" };
const ok: RemoteCallOutcome = { kind: "ok", text: "history", data: null };

function harness(outcomes: RemoteCallOutcome[], approve: boolean) {
  const dispatched: unknown[] = [];
  const prompts: string[] = [];
  const recorded: NetworkTarget[] = [];
  const controller = new WorkbenchNetworkAccessController({
    relay: { request: async (request: unknown) => { dispatched.push(request); return outcomes.shift()!; } } as never,
    prompt: async (_caller, _target, reason) => { prompts.push(reason); return NetworkAccessDecision.response(approve); },
    recordApproval: async (_threadId, approved) => { recorded.push(approved); },
  });
  const call = () => controller.call(caller, {
    daemonId, call: { kind: "recall", threadId: target.threadId, search: false, query: "", body: null }, reason: "why", target: async () => target,
  }, new AbortController().signal);
  return { call, dispatched, prompts, recorded };
}

test("a granted call dispatches once and never prompts", async () => {
  const { call, dispatched, prompts } = harness([ok], true);
  assert.equal((await call()).text, "history");
  assert.equal(dispatched.length, 1);
  assert.deepEqual(prompts, []);
});

test("a refusal prompts, and approval records the target and dispatches once more", async () => {
  const { call, dispatched, prompts, recorded } = harness([denied, ok], true);
  assert.equal((await call()).text, "history");
  assert.deepEqual(prompts, ["why"]);
  assert.deepEqual(recorded, [target]);
  assert.equal(dispatched.length, 2);
});

test("a denied prompt never dispatches again", async () => {
  const { call, dispatched, recorded } = harness([denied], false);
  await assert.rejects(call(), NetworkDeniedError);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(recorded, []);
});

test("a failure or a refusal naming no grant is final without prompting", async () => {
  const failed = harness([{ kind: "failed", failure: "boom" }], true);
  await assert.rejects(failed.call(), /boom/u);
  assert.deepEqual(failed.prompts, []);
  const family = harness([{ kind: "denied", need: null, failure: "not your child" }], true);
  await assert.rejects(family.call(), /not your child/u);
  assert.deepEqual(family.prompts, []);
});
