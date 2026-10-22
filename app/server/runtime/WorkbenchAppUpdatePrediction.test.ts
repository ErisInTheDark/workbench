import assert from "node:assert/strict";
import test from "node:test";
import type { ReloadDirtScope as WorkbenchReloadDirtScope } from "workbench-shared/reload/reload-dirt-scope";
import type { PredictedInstallationUpdate as InstallationUpdate } from "workbench-shared/workbench/installation-update-prediction";
import WorkbenchAppUpdatePrediction from "./WorkbenchAppUpdatePrediction.ts";

const update = (incomingPaths: string[] | null, state: InstallationUpdate["state"] = "available"): InstallationUpdate => ({
  state, reason: null, upstream: "origin/main", behind: 1, ahead: 0, conflicts: [], lockfileChanged: false,
  incomingPaths, predictedScopes: null, checkedAt: 1, projectId: null, failure: null,
});
const scope = (name: string): WorkbenchReloadDirtScope => ({ scope: name, description: name, destructive: false, dependantScopes: [] });

function controlled() {
  const calls: Array<{ paths: readonly string[]; resolve(scopes: WorkbenchReloadDirtScope[]): void; signal: AbortSignal }> = [];
  const prediction = new WorkbenchAppUpdatePrediction({
    predict: (paths, _target, signal) => new Promise(resolve => { calls.push({ paths, resolve, signal }); }),
    warn: () => {},
  });
  return { calls, prediction };
}

test("a superseded prediction finishing late never replaces the newer change set's result", async () => {
  const { calls, prediction } = controlled();
  prediction.accept(update(["app/server/a.ts"]));
  prediction.accept(update(["app/server/b.ts"]));
  assert.equal(calls[0]!.signal.aborted, true);
  calls[1]!.resolve([scope("client:b")]);
  await new Promise(resolve => setImmediate(resolve));
  calls[0]!.resolve([scope("client:a")]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prediction.read()?.map(item => item.scope), ["client:b"]);
});

test("rechecking the same change set reuses the prediction, and an unknown change set clears it", async () => {
  const { calls, prediction } = controlled();
  prediction.accept(update(["app/server/a.ts"]));
  calls[0]!.resolve([scope("client:a")]);
  await new Promise(resolve => setImmediate(resolve));
  prediction.accept({ ...update(["app/server/a.ts"]), checkedAt: 2 });
  assert.equal(calls.length, 1);
  prediction.accept(update(null));
  assert.equal(prediction.read(), null);
  prediction.accept(update(["app/server/a.ts"], "current"));
  assert.equal(calls.length, 1, "a current checkout predicts nothing");
});
