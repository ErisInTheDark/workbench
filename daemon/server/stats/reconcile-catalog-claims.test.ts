/* No production exports. Protect claim reconciliation skipping stale catalogue entries while still reporting real failures. */
import assert from "node:assert/strict";
import test from "node:test";

import { reconcileCatalogClaims } from "./reconcile-catalog-claims.ts";

const project = (id: string, ...roots: string[]) => ({ id, rootPath: roots[0]!, roots: roots.map((rootPath) => ({ rootPath })) });

test("projects without a usable checkout are skipped silently while failing checkouts still report", async () => {
  const reconciled: string[] = [];
  const failures: string[] = [];
  await reconcileCatalogClaims({
    isCheckout: async (rootPath) => rootPath !== "gone" && rootPath !== "broken",
    projects: [project("deleted", "gone"), project("broken-git", "broken"), project("healthy", "ok"), project("failing", "bad"), project("workspace", "gone", "ok-root")],
    reconcile: async (rootPath) => {
      if (rootPath === "bad") throw new Error("reconcile failed");
      reconciled.push(rootPath);
    },
    reportFailure: (projectId, error) => failures.push(`${projectId}: ${(error as Error).message}`),
    signal: new AbortController().signal,
  });
  assert.deepEqual(reconciled, ["ok", "gone"], "a workspace with any live root still reconciles");
  assert.deepEqual(failures, ["failing: reconcile failed"]);
});

test("an unexpected checkout probe failure is reported, and abort stops the walk", async () => {
  const failures: string[] = [];
  const controller = new AbortController();
  await reconcileCatalogClaims({
    isCheckout: async () => { throw new Error("EACCES"); },
    projects: [project("locked", "x")],
    reconcile: async () => {},
    reportFailure: (projectId) => { failures.push(projectId); controller.abort(); },
    signal: controller.signal,
  });
  assert.deepEqual(failures, ["locked"]);
});
