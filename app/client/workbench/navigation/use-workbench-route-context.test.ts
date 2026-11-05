/* No production exports. Protect which thread's owner a route's context follows. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { createLogicalExistingThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchClientController } from "../../components/workbench/workbench-client-context";
import { resolveWorkbenchRouteContext } from "./use-workbench-route-context";

const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
const logicalId = LogicalProjectIdSchema.parse("00000000-0000-4000-8000-000000000003");
const parentId = ThreadReferenceSchema.parse("00000000-0000-4000-8000-000000000010");
const childId = ThreadReferenceSchema.parse("00000000-0000-4000-8000-000000000011");
const parentProject = ProjectIdSchema.parse("parent-folder");
const childProject = ProjectIdSchema.parse("child-folder");

function clientKnowing(known: ReadonlyMap<string, typeof parentProject>) {
  return { mounted: {
    threadContextFor: (id: string) => known.has(id)
      ? { daemonId, project: { id: known.get(id) }, registrationId: null } : null,
    threadOwnerFor: (id: string) => known.has(id) ? { daemonId, projectId: known.get(id) } : null,
    networkClient: { snapshot: () => ({ snapshot: null }) },
  } } as unknown as WorkbenchClientController;
}

const childRoute = createLogicalExistingThreadRoute(logicalId,
  { kind: "subagent", harness: "codex", parentThreadId: parentId, threadId: childId }, null);

test("a shown subagent's context is its own, while root facts stay with its parent", () => {
  const client = clientKnowing(new Map([[parentId, parentProject], [childId, childProject]]));
  const resolved = resolveWorkbenchRouteContext(client, childRoute, null);
  assert.equal(resolved.threadContext?.project.id, childProject);
  assert.equal(resolved.ownerMetadata?.projectId, childProject);
  assert.equal(resolved.rootContext?.project.id, parentProject);
});

test("the parent stands in until the subagent's owner lands", () => {
  const client = clientKnowing(new Map([[parentId, parentProject]]));
  const resolved = resolveWorkbenchRouteContext(client, childRoute, null);
  assert.equal(resolved.threadContext?.project.id, parentProject);
  assert.equal(resolved.ownerMetadata?.projectId, parentProject);
});

test("a root thread's route follows the root", () => {
  const client = clientKnowing(new Map([[parentId, parentProject], [childId, childProject]]));
  const resolved = resolveWorkbenchRouteContext(client, createLogicalExistingThreadRoute(logicalId,
    { kind: "provider", harness: "codex", threadId: parentId }, null), null);
  assert.equal(resolved.threadContext?.project.id, parentProject);
  assert.equal(resolved.rootContext?.project.id, parentProject);
});
