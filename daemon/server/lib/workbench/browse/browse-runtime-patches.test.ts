/*
 * Exports:
 * - No production exports; Node tests cover Workbench's Stagehand session options.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { patchStagehandOptions } from "./browse-runtime-patches.mjs";

function createManager(settings?: { downloadsPath?: string; userDataDir?: string }) {
  class FakeManager {
    async stagehandOptions(target: { kind: string }) {
      return target.kind === "remote"
        ? { env: "BROWSERBASE" }
        : { env: "LOCAL", localBrowserLaunchOptions: { headless: true } };
    }
  }
  patchStagehandOptions({ DriverSessionManager: FakeManager }, settings);
  return new FakeManager();
}

test("selector misses never fall back to LLM self-heal, whatever the target", async () => {
  const manager = createManager();
  for (const kind of ["managed-local", "cdp", "remote"]) {
    assert.equal((await manager.stagehandOptions({ kind }) as { selfHeal?: boolean }).selfHeal, false);
  }
});

test("download and profile launch options apply only to managed-local browsers", async () => {
  const manager = createManager({ downloadsPath: "downloads" });
  assert.deepEqual((await manager.stagehandOptions({ kind: "managed-local" }) as { localBrowserLaunchOptions?: object }).localBrowserLaunchOptions, {
    acceptDownloads: true, downloadsPath: "downloads", headless: true,
  });
  assert.deepEqual((await manager.stagehandOptions({ kind: "cdp" }) as { localBrowserLaunchOptions?: object }).localBrowserLaunchOptions, { headless: true });
});
