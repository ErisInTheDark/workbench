/*
 * No production exports. Node tests protect topology-node queue ownership and handoff state transfer. Keywords: topology, reload, queue, handoff, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import WorkbenchTopologyNode from "./WorkbenchTopologyNode";

test("the topology node transfers hard-reload admission state into its replacement", () => {
  const context = Object.assign(Object.create(null) as OrchestratorProcessContext, {
    executeReloadScopes: async () => undefined,
    getReloadScopeCatalog: () => [
      { access: "agent" as const, description: "Topology", safeAll: false, scope: "server:topology" },
      { access: "operator" as const, description: "Process", safeAll: false, scope: "server:process" },
    ],
    hardReload: { exitProcess: () => undefined, notifications: () => [] },
  });
  const gitArc = Object.assign(Object.create(null) as OrchestratorRuntimeObjects["gitArc"], {
    listReloadScopeClaims: async () => [],
  });
  const objects = Object.create(null) as OrchestratorRuntimeObjects;
  objects.gitArc = gitArc;
  const build = (handoffState?: unknown) => ({
    get: <TKey extends keyof OrchestratorRuntimeObjects>(key: TKey) => {
      assert.equal(key, "gitArc");
      return objects[key];
    },
    handoffState,
    isReplacing: () => true,
    lease: { isCurrent: () => true },
    mode: handoffState ? "replacement" as const : "initial" as const,
  });
  const first = WorkbenchTopologyNode.create(context, build());
  const firstController = first.registrations.reloadController!;
  firstController.admitHardReload();
  const state = first.detachForReload!({ isReplacing: () => true });

  const replacement = WorkbenchTopologyNode.create(context, build(state));
  const replacementController = replacement.registrations.reloadController!;
  assert.equal(replacementController.isHardReloadPending(), true);
  replacementController.cancelHardReloadAdmission();
  assert.equal(replacementController.isHardReloadPending(), false);
});
