/*
 * No production exports. Tests protect settlement release: each reached daemon is asked once, only confirmed daemons' history
 * entries are revoked so unreachable ones retry later, and overlapping settlement events release once.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type { NetworkHistoryEntry } from "workbench-shared/workbench/network/network-grants";
import WorkbenchNetworkSettlementController from "./WorkbenchNetworkSettlementController";

const thread = { threadId: WorkbenchThreadIdSchema.parse("settled"), title: "settled" };
const reachable = DaemonIdSchema.parse("22222222-2222-4222-8222-222222222222");
const asleep = DaemonIdSchema.parse("33333333-3333-4333-8333-333333333333");

const entry = (id: string, daemonId: DaemonId, revokedAt: number | null = null): NetworkHistoryEntry => ({
  id, approvedAt: 1, revokedAt,
  target: { kind: "folder", daemonId, hostname: daemonId === asleep ? "asleep" : "tower", projectId: ProjectIdSchema.parse("folder"), rootPath: "/f" },
});

function fixture(history: NetworkHistoryEntry[], release: (daemonId: DaemonId) => Promise<void>) {
  const calls = { targeting: 0, released: [] as DaemonId[], revoked: [] as string[], warnings: [] as string[] };
  const controller = new WorkbenchNetworkSettlementController({
    revokeTargeting: async () => { calls.targeting += 1; return 0; },
    history: {
      read: async () => history,
      revoke: async (_threadId, entryId) => { calls.revoked.push(entryId); },
    },
    release: async (_caller, daemonId) => { calls.released.push(daemonId); await release(daemonId); },
    warn: message => { calls.warnings.push(message); },
  });
  return { controller, calls };
}

test("each reached daemon is released once; only confirmed releases revoke their entries", async () => {
  const history = [
    entry("44444444-4444-4444-8444-444444444444", reachable),
    entry("55555555-5555-4555-8555-555555555555", reachable),
    entry("66666666-6666-4666-8666-666666666666", asleep),
    entry("77777777-7777-4777-8777-777777777777", reachable, 5),
  ];
  const { controller, calls } = fixture(history, async daemonId => {
    if (daemonId === asleep) throw new Error("unreachable");
  });

  await controller.settled(thread);

  assert.equal(calls.targeting, 1);
  assert.deepEqual(calls.released.sort(), [reachable, asleep].sort());
  assert.deepEqual(calls.revoked.sort(), ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"]);
  assert.equal(calls.warnings.length, 1);
});

test("settlement events arriving while a release runs do not release again", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const { controller, calls } = fixture([entry("44444444-4444-4444-8444-444444444444", reachable)], () => pending);

  const first = controller.settled(thread);
  await controller.settled(thread);
  finish();
  await first;

  assert.deepEqual(calls.released, [reachable]);
});
