/*
 * No production exports. Protect durable-first identity admission and usage backfill selection through WB providers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchHarnessController from "./WorkbenchHarnessController";
import { NativeThreadIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

test("durable-only identity resolution never probes the provider while default resolution can admit metadata", async () => {
  let admitted = false;
  let providerReads = 0;
  const identity = {
    bindings: [],
    projectId: ProjectIdSchema.parse("project"),
    projectRoot: "C:/project",
    threadId: WorkbenchThreadIdSchema.parse("workbench-thread-one"),
  };
  const controller = new WorkbenchHarnessController({
    identities: {
      resolve: async () => admitted ? identity : null,
    } as never,
    providers: {
      get: () => ({
        threads: {
          read: async () => {
            providerReads += 1;
            admitted = true;
            return {} as never;
          },
        },
      }) as never,
      hydratesUsage: async () => false,
    },
  });
  const lookup = {
    harness: "codex" as const,
    projectId: identity.projectId,
    threadId: NativeThreadIdSchema.parse("thread-one"),
  };
  assert.equal(await controller.resolveThreadIdentity(lookup, { allowProviderAdmission: false }), null);
  assert.equal(providerReads, 0);
  assert.equal((await controller.resolveThreadIdentity(lookup))?.threadId, identity.threadId);
  assert.equal(providerReads, 1);
  assert.equal((await controller.resolveThreadIdentity(lookup))?.threadId, identity.threadId);
  assert.equal(providerReads, 1);
});

test("usage backfill lists hydrating providers and leaves out a provider that fails to open", async (t) => {
  const warnings = t.mock.method(console, "warn", () => undefined);
  const controller = new WorkbenchHarnessController({
    identities: {} as never,
    providers: {
      get: () => { throw new Error("Listing must not run provider operations"); },
      hydratesUsage: async (key) => {
        if (key === "opencode") throw new Error("bridge failed to start");
        return key === "claude";
      },
    },
  });
  assert.deepEqual(await controller.listUsageHydrationHarnesses(), ["claude"]);
  assert.equal(warnings.mock.callCount(), 1);
});
