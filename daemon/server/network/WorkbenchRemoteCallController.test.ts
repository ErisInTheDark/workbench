/*
 * No production exports. Tests protect target-side authorization: relayed calls run only with this daemon's own grant or a
 * family tie it can verify, and refusals name the grant a prompt could ask for.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema, type WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { NetworkGrant } from "workbench-shared/workbench/network/network-grants";
import type { RemoteCall, RemoteCaller, SiblingRosterEntry } from "workbench-shared/workbench/network/network-remote-calls";
import type { RemoteCallPorts, RemoteCallThread } from "./remote-call-registry";
import WorkbenchRemoteCallController from "./WorkbenchRemoteCallController";

const self = DaemonIdSchema.parse("11111111-1111-4111-8111-111111111111");
const remote = DaemonIdSchema.parse("22222222-2222-4222-8222-222222222222");
const id = (value: string) => WorkbenchThreadIdSchema.parse(value);
const caller: RemoteCaller = { daemonId: remote, hostname: "tower", threadId: id("caller"), title: "caller" };

function harness(options: {
  grants?: NetworkGrant[];
  threads?: Record<string, RemoteCallThread["parent"]>;
  roster?: SiblingRosterEntry[];
  remoteChildOf?: WorkbenchThreadId[];
}) {
  const executed: string[] = [];
  const ports = {
    selfDaemonId: () => self,
    grants: async () => options.grants ?? [],
    thread: async (threadId: WorkbenchThreadId) => threadId in (options.threads ?? {})
      ? { threadId, parent: options.threads![threadId] ?? null } : null,
    roster: async () => options.roster ?? [],
    isRemoteChild: async (parentThreadId: WorkbenchThreadId) => (options.remoteChildOf ?? []).includes(parentThreadId),
    remoteParentsOf: async () => options.remoteChildOf ?? [],
    recall: async () => { executed.push("recall"); return "history"; },
    message: async () => { executed.push("message"); },
    childStop: async () => { executed.push("stop"); },
    subagentCreate: async () => { executed.push("create"); return { threadId: id("child"), cwd: "/p", harness: "codex" }; },
    release: async () => { executed.push("release"); return 0; },
  } as unknown as RemoteCallPorts;
  return { controller: new WorkbenchRemoteCallController(ports), executed };
}

const grant = (overrides: Partial<NetworkGrant>): NetworkGrant => ({
  id: "33333333-3333-4333-8333-333333333333", kind: "thread", callerDaemonId: remote, callerThreadId: caller.threadId,
  callerHostname: "tower", callerTitle: "caller", targetThreadId: id("target"), targetProjectId: null, targetLabel: "target", createdAt: 1,
  ...overrides,
});
const run = (controller: WorkbenchRemoteCallController, call: RemoteCall, who = caller) =>
  controller.execute({ caller: who, call }, new AbortController().signal);
const message = (threadId: string): RemoteCall => ({ kind: "message", threadId: id(threadId), senderName: "x", message: "hi", userVisibleSimpleVersion: "hi" });

test("reading a thread needs this daemon's own grant, and a refusal names it", async () => {
  const denied = harness({ threads: { target: null } });
  const refused = await run(denied.controller, { kind: "recall", threadId: id("target"), search: false, query: "", body: null });
  assert.deepEqual(refused.kind === "denied" ? refused.need : null, { kind: "thread", threadId: "target" });
  assert.deepEqual(denied.executed, []);

  const granted = harness({ threads: { target: null }, grants: [grant({})] });
  assert.equal((await run(granted.controller, { kind: "recall", threadId: id("target"), search: false, query: "", body: null })).kind, "ok");
  assert.deepEqual(granted.executed, ["recall"]);
});

test("a grant held by another thread of the same daemon does not transfer", async () => {
  const { controller, executed } = harness({ threads: { target: null }, grants: [grant({})] });
  assert.equal((await run(controller, message("target"), { ...caller, threadId: id("other") })).kind, "denied");
  assert.deepEqual(executed, []);
});

test("only a child's recorded parent may stop it", async () => {
  const { controller, executed } = harness({ threads: { child: { threadId: id("caller"), daemonId: remote } } });
  assert.equal((await run(controller, { kind: "childStop", threadIds: [id("child")] }, { ...caller, threadId: id("stranger") })).kind, "denied");
  assert.equal((await run(controller, { kind: "childStop", threadIds: [id("child")] }, { ...caller, daemonId: self })).kind, "denied");
  assert.equal((await run(controller, { kind: "childStop", threadIds: [id("child")] })).kind, "ok");
  assert.deepEqual(executed, ["stop"]);
});

test("a sibling on the child's parent-pushed roster may message it; anyone else needs a grant and gets no prompt-free path", async () => {
  const parent = { threadId: id("parent"), daemonId: DaemonIdSchema.parse("44444444-4444-4444-8444-444444444444") };
  const roster = [{ daemonId: remote, threadId: caller.threadId, name: "luna" }];
  const listed = harness({ threads: { child: parent }, roster });
  assert.equal((await run(listed.controller, message("child"))).kind, "ok");

  const stale = harness({ threads: { child: parent }, roster: [] });
  const refused = await run(stale.controller, message("child"));
  assert.equal(refused.kind, "denied");
  assert.deepEqual(stale.executed, []);
});

test("a remote child may message its local parent, and a local child's remote sibling may message it", async () => {
  const toParent = harness({ threads: { parent: null }, remoteChildOf: [id("parent")] });
  assert.equal((await run(toParent.controller, message("parent"))).kind, "ok");
  const toSibling = harness({ threads: { sibling: { threadId: id("parent"), daemonId: null } }, remoteChildOf: [id("parent")] });
  assert.equal((await run(toSibling.controller, message("sibling"))).kind, "ok");
});

test("creating subagents needs a folder grant for that exact folder", async () => {
  const create: RemoteCall = {
    kind: "subagentCreate", projectId: ProjectIdSchema.parse("folder"), profileId: "p", name: "n", title: "t", message: "m",
    userVisibleSimpleVersion: "m", directSubagentIndex: 0, siblings: [],
  };
  const other = harness({ grants: [grant({ kind: "folder", targetThreadId: null, targetProjectId: ProjectIdSchema.parse("other") })] });
  assert.equal((await run(other.controller, create)).kind, "denied");
  const granted = harness({ grants: [grant({ kind: "folder", targetThreadId: null, targetProjectId: ProjectIdSchema.parse("folder") })] });
  assert.equal((await run(granted.controller, create)).kind, "ok");
  assert.deepEqual(granted.executed, ["create"]);
});

test("a caller may always release its own grants", async () => {
  const { controller, executed } = harness({});
  assert.equal((await run(controller, { kind: "release" })).kind, "ok");
  assert.deepEqual(executed, ["release"]);
});
