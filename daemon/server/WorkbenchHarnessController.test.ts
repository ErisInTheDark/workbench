/*
 * No production exports. Protect durable-first identity admission through WB providers.
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
