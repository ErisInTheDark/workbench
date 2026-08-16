/* No production exports. Tests protect atomic reload, rollback, drain, disposal, and generation fencing. */
import assert from "node:assert/strict";
import test from "node:test";

import OrchestratorFeatureHost, { type OrchestratorFeatureModule } from "./OrchestratorFeatureHost";
import { createOrchestratorFeatureModuleLoader } from "./orchestrator-feature-loader";
import type { OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification } from "./orchestrator-feature-registry";

interface Features { value: { label: string } }
interface Context { effects: string[] }
type Notification = { value: string };

function moduleFor(label: string, options: { failStart?: boolean } = {}): OrchestratorFeatureModule<Context, Features, Notification> {
  return {
    createOrchestratorFeatureGeneration: (context, lease) => ({
      dispose: () => { context.effects.push(`dispose:${label}`); },
      get: () => ({ label }),
      observeProviderNotification: ({ value }) => {
        if (lease.isCurrent()) context.effects.push(`${label}:${value}`);
      },
      start: () => {
        context.effects.push(`start:${label}`);
        if (options.failStart) throw new Error("candidate failed");
      },
    }),
  };
}

test("failed candidate start preserves the current generation", async () => {
  const context: Context = { effects: [] };
  const modules = [moduleFor("old"), moduleFor("bad", { failStart: true })];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! });
  await host.start();
  await assert.rejects(host.reload(), /candidate failed/u);
  assert.equal(host.get("value").label, "old");
  await host.observeProviderNotification({ value: "event" });
  assert.deepEqual(context.effects, ["start:old", "start:bad", "dispose:bad", "old:event"]);
  await host.dispose();
});

test("successful reload swaps before draining and fences old generation effects", async () => {
  const context: Context = { effects: [] };
  const modules = [moduleFor("old"), moduleFor("new")];
  const host = new OrchestratorFeatureHost(context, { load: () => modules[0]!, reload: () => modules[1]! });
  await host.start();
  let release!: () => void;
  const held = host.run("value", async ({ label }) => {
    await new Promise<void>((resolve) => { release = resolve; });
    context.effects.push(`held:${label}`);
  });
  const reloading = host.reload();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(host.get("value").label, "new");
  await host.observeProviderNotification({ value: "event" });
  release();
  await Promise.all([held, reloading]);
  assert.deepEqual(context.effects, ["start:old", "start:new", "new:event", "held:old", "dispose:old"]);
  await host.dispose();
});

test("feature loader invalidates the registry root as one project-local subtree", () => {
  const loader = createOrchestratorFeatureModuleLoader<OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification>();
  const first = loader.load();
  const second = loader.reload();
  assert.notEqual(first, second);
  assert.equal(typeof second.createOrchestratorFeatureGeneration, "function");
});
