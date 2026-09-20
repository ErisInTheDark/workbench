/*
 * No exports. Tests protect OpenCode bridge access through declared reload-graph registrations.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import type { ReloadableNodeBuild } from "../../ReloadableNode";
import OpenCodeBridgeNode from "./OpenCodeBridgeNode";

test("creates the OpenCode bridge using only declared parent registrations", async () => {
  const registrations = {
    openCodeService: {
      acquire: async () => { throw new Error("Unexpected OpenCode acquisition."); },
      invalidateModelCatalogs() {},
      readModelCatalog: async () => ({ defaultModel: null, models: [] }),
    },
    projectCatalog: {},
    providerObservations: {},
    questionnaires: {},
    threadIdentity: {},
    transcript: {
      read: async () => null,
      readContextUsage: async () => ({ tokenUsage: null }),
    },
    transcriptIdentity: {},
    threadState: {},
  };
  const requested: string[] = [];
  const build = {
    get(key: keyof DaemonRuntimeObjects) {
      requested.push(key);
      assert.ok(key in registrations, `Unexpected parent registration ${key}.`);
      return registrations[key as keyof typeof registrations];
    },
  } as unknown as ReloadableNodeBuild<DaemonRuntimeObjects>;

  const instance = OpenCodeBridgeNode.create({
    localDaemonOrigin: "http://127.0.0.1:4500",
  } as DaemonProcessContext, build);

  assert.ok(requested.includes("transcript"));
  assert.ok(!requested.includes("database"));
  await instance.dispose();
});
