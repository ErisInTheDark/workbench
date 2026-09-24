/*
 * No production exports. Protect UUID owner lookup, conflict fencing, and session revocation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchThreadRouter, { type WorkbenchThreadSource } from "./WorkbenchThreadRouter";

const threadId = WorkbenchThreadIdSchema.parse("4148c9ad-75b2-4a22-9732-6cb8bb82f414");
const projectId = ProjectIdSchema.parse("project");
const logicalProjectId = LogicalProjectIdSchema.parse("f93b5700-962e-4f04-b40d-5de66fb39000");
const firstId = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
const secondId = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");

const presentation = {
  drafts: [], members: [], locations: [{
    target: { daemonId: firstId, projectId }, logicalProjectId,
    identityKey: "remote://example.test/team/repo", name: "repo", rootPath: "/repo",
  }],
} as unknown as PresentationSnapshot;

function source(daemonId: typeof firstId, resolves: boolean) {
  let ready = true;
  const lookups: string[] = [];
  const daemon = {
    threads: {
      resolveIdentity: async ({ threadId: requested, allowProviderAdmission }: {
        threadId: string; allowProviderAdmission: boolean;
      }) => {
        assert.equal(allowProviderAdmission, false);
        lookups.push(requested);
        if (!resolves) throw new Error("not found");
        return { data: { threadId, projectId, harness: "codex" as const } };
      },
    },
  } as unknown as WorkbenchDaemonClient;
  return {
    daemonId, daemon, ready: () => ready,
    threads: null as unknown as WorkbenchThreadSource["threads"],
    revoke: () => { ready = false; },
    lookups,
  };
}

test("an unseen UUID resolves through verified daemons without provider admission and then uses its owning session", async () => {
  const first = source(firstId, true);
  const second = source(secondId, false);
  const router = new WorkbenchThreadRouter({
    presentation: () => presentation, rows: () => [], daemons: () => [first, second],
  });
  const owner = await router.resolve(threadId);
  assert.equal(owner.kind, "thread");
  assert.deepEqual(owner.location, { daemonId: firstId, projectId });
  assert.equal(owner.logicalProjectId, logicalProjectId);
  assert.deepEqual(first.lookups, [threadId]);
  assert.deepEqual(second.lookups, [threadId]);
  const routed = await router.withThread(threadId, async (_owner, selected) => selected.daemonId);
  assert.equal(routed, firstId);
  first.revoke();
  router.invalidateUnavailable();
  await assert.rejects(router.withThread(threadId, async () => "wrong daemon"), /unavailable/);
  router.dispose();
});

test("a UUID seen on two daemons fails closed instead of choosing one", async () => {
  const first = source(firstId, true);
  const second = source(secondId, true);
  const router = new WorkbenchThreadRouter({
    presentation: () => ({ ...presentation, locations: [] }), rows: () => [], daemons: () => [first, second],
  });
  await assert.rejects(router.resolve(threadId), /multiple daemons/);
  router.dispose();
});
