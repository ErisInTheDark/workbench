/*
 * No exports. Tests protect parent-owned Codex process-generation retirement and child readiness.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type CodexAppServer from "./CodexAppServer";
import CodexAppServerNode from "./CodexAppServerNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonRuntimeObjects } from "./daemon-runtime-objects";
import type { ReloadableNodeBuild } from "./ReloadableNode";

function build(previousAppServer?: CodexAppServer) {
  return {
    get: (key: keyof DaemonRuntimeObjects) => {
      assert.equal(key, "codexLifecycle");
      return { requestRecovery() {} };
    },
    handoffState: previousAppServer ? { appServer: previousAppServer } : undefined,
  } as unknown as ReloadableNodeBuild<DaemonRuntimeObjects>;
}

const context = { daemonPackageRoot: "C:/workbench/daemon" } as DaemonProcessContext;

test("the harness node retires its predecessor before child process readiness", async () => {
  const calls: string[] = [];
  const previous = {
    async retirePrevious() { calls.push("ancestor"); },
    async stopAsync() { calls.push("predecessor"); },
  } as unknown as CodexAppServer;
  const instance = CodexAppServerNode.create(context, build(previous));
  const runtime = instance.registrations.codexAppServer!;
  let ready = false;
  const readiness = runtime.waitUntilReady().then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  instance.afterCommit?.();
  await readiness;
  assert.deepEqual(calls, ["ancestor", "predecessor"]);
  await instance.dispose();
});

test("a harness node without a predecessor is immediately ready", async () => {
  const instance = CodexAppServerNode.create(context, build());
  await instance.registrations.codexAppServer!.waitUntilReady();
  instance.afterCommit?.();
  await instance.dispose();
});
