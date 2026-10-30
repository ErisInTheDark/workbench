/*
 * No production exports. Tests protect the app relay's trust rules: a relayed call's origin comes from the asking connection,
 * nothing is dispatched to a daemon the app does not reach, and approval writes the target's grant before answering the prompt.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { NetworkTarget } from "workbench-shared/workbench/network/network-grants";
import WorkbenchAgentRelay from "./WorkbenchAgentRelay";

const originId = DaemonIdSchema.parse("11111111-1111-4111-8111-111111111111");
const targetId = DaemonIdSchema.parse("22222222-2222-4222-8222-222222222222");
const threadId = WorkbenchThreadIdSchema.parse("caller");
const target: NetworkTarget = {
  kind: "thread", daemonId: targetId, hostname: "tower", threadId: WorkbenchThreadIdSchema.parse("target"), title: "t", projectName: "p", daemonProject: false,
};

function source(id: typeof originId, hostname: string, log: string[], pending: unknown = null) {
  const summaries = { [threadId]: { projectId: ProjectIdSchema.parse("p"), summary: { facts: {}, row: { title: "caller", pendingQuestionnaire: pending } } } };
  return {
    id, available: true,
    retain: () => () => undefined,
    subscribe: () => () => undefined,
    getSnapshot: () => ({ daemonId: id, hostname, generation: 1, connection: "current" as const, failure: null }),
    observe: () => ({ getSnapshot: () => ({ phase: "current", failure: null, value: { kind: "threadSummaries", summaries } }), release: () => undefined, retarget: () => undefined }),
    request: async () => ({}),
    daemon: {
      network: {
        execute: async (params: unknown) => { log.push(`${hostname}:execute:${JSON.stringify((params as { caller: unknown }).caller)}`); return { kind: "ok", text: "done", data: null }; },
        grants: { create: async (grant: { kind: string }) => { log.push(`${hostname}:grant:${grant.kind}`); return { grant }; } },
      },
      threads: { questionnaire: { respond: async () => { log.push(`${hostname}:respond`); return { ok: true }; } } },
    },
  };
}

function relay(sources: ReturnType<typeof source>[]) {
  return new WorkbenchAgentRelay({
    sources: { all: () => sources as never, get: id => (sources.find(item => item.id === id) ?? null) as never },
    threads: { withThread: async (_id: string, action: (source: never, owner: never) => Promise<unknown>) => await action(sources[0] as never, {
      phase: "current", identity: { threadId, harness: "codex" }, location: { daemonId: originId, projectId: ProjectIdSchema.parse("p") }, logicalProjectId: null,
    } as never) } as never,
    workspace: { getSnapshot: () => ({ projects: [] }) },
    fetchPeer: async () => ({ kind: "failed", failure: "unused" }),
    signal: new AbortController().signal,
  });
}

test("a relayed call names the daemon whose connection asked, never one from its payload", async () => {
  const log: string[] = [];
  const origin = source(originId, "home", log);
  const answer = await relay([origin, source(targetId, "tower", log)]).answer(origin as never, {
    kind: "execute", targetDaemonId: targetId, caller: { threadId, title: "caller" }, call: { kind: "release" },
  }, () => log.push("accepted"));
  assert.equal(answer.kind, "answered");
  assert.deepEqual(log, ["accepted", `tower:execute:${JSON.stringify({ daemonId: originId, hostname: "home", threadId, title: "caller" })}`]);
});

test("a call is accepted before waiting for a sleeping target, and answered once the target connects", async () => {
  const log: string[] = [];
  const origin = source(originId, "home", log);
  const sleeping = source(targetId, "tower", log);
  let wake = () => undefined as unknown;
  Object.assign(sleeping, { available: false, subscribe: (listener: () => void) => { wake = listener; return () => undefined; } });
  const answering = relay([origin, sleeping]).answer(origin as never, {
    kind: "execute", targetDaemonId: targetId, caller: { threadId, title: "caller" }, call: { kind: "release" },
  }, () => log.push("accepted"));
  await Promise.resolve();
  assert.deepEqual(log, ["accepted"], "The asking daemon's acceptance deadline must not wait on the target's connection");
  sleeping.available = true;
  wake();
  assert.equal((await answering).kind, "answered");
});

test("a call for a daemon this app does not reach is refused before anything is dispatched", async () => {
  const log: string[] = [];
  const origin = source(originId, "home", log);
  const answer = await relay([origin]).answer(origin as never, {
    kind: "execute", targetDaemonId: targetId, caller: { threadId, title: "caller" }, call: { kind: "release" },
  }, () => log.push("accepted"));
  assert.equal(answer.kind, "unreachable");
  assert.deepEqual(log, []);
});

test("approval writes the target's grant and the reply grant before answering the prompt", async () => {
  const log: string[] = [];
  const pending = { requestKey: "key", request: { networkAccess: { target } } };
  const sources = [source(originId, "home", log, pending), source(targetId, "tower", log)];
  await relay(sources).approve(threadId, "key");
  assert.deepEqual(log, ["tower:grant:thread", "home:grant:message", "home:respond"]);
});

test("approval refuses a prompt that is no longer pending and writes nothing", async () => {
  const log: string[] = [];
  const sources = [source(originId, "home", log, { requestKey: "other", request: { networkAccess: { target } } }), source(targetId, "tower", log)];
  await assert.rejects(relay(sources).approve(threadId, "key"), /no longer pending/u);
  assert.deepEqual(log, []);
});
