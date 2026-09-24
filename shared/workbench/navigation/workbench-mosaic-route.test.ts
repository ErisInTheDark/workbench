/*
 * No production exports. Protect UUID thread and source-qualified file mosaic panes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ThreadReferenceSchema } from "../identity";
import {
  createWorkbenchMosaicSplit, createWorkbenchMosaicTarget,
  parseWorkbenchMosaicRouteExpression, serializeWorkbenchMosaicRouteExpression,
} from "./workbench-mosaic-route";
import { createLogicalMosaicRoute, createWorkbenchHref, parseWorkbenchRouteFromPath } from "./workbench-route";

test("equal file paths and project ids on separate daemons keep independent mosaic owners", () => {
  const logicalProjectId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const first = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
  const second = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
  const projectId = ProjectIdSchema.parse("same");
  const node = createWorkbenchMosaicSplit([first, second].map(daemonId =>
    createWorkbenchMosaicTarget({
      kind: "file", filePath: "src/a.ts",
      source: { logicalProjectId, location: { daemonId, projectId } },
    })));
  const expression = serializeWorkbenchMosaicRouteExpression(node);
  const parsed = parseWorkbenchMosaicRouteExpression(expression);
  assert.equal(parsed.ok, true);
  if (parsed.ok && parsed.node.type === "split") {
    assert.deepEqual(parsed.node.children.map(child => child.type === "target" && child.target.kind === "file"
      ? [child.target.filePath, child.target.source?.location?.daemonId] : null), [
      ["src/a.ts", first], ["src/a.ts", second],
    ]);
  }
  const route = createLogicalMosaicRoute(logicalProjectId, node);
  const roundTrip = parseWorkbenchRouteFromPath(createWorkbenchHref(route));
  assert.equal(roundTrip.view, "mosaic");
  if (roundTrip.mosaicNode?.type === "split") {
    assert.deepEqual(roundTrip.mosaicNode.children.map(child => child.type === "target" && child.target.source?.location?.daemonId),
      [first, second]);
  }
  assert.throws(() => createLogicalMosaicRoute(logicalProjectId,
    createWorkbenchMosaicTarget({ kind: "file", filePath: "src/a.ts" })), /source/u);
});

test("existing-thread mosaic panes retain only UUID targets across URL round trips", () => {
  const logicalProjectId = LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const node = createWorkbenchMosaicSplit([
    createWorkbenchMosaicTarget({ kind: "thread", target: {
      kind: "provider", threadId: ThreadReferenceSchema.parse("4148c9ad-75b2-4a22-9732-6cb8bb82f414"),
    } }),
    createWorkbenchMosaicTarget({ kind: "thread", target: {
      kind: "subagent", parentThreadId: ThreadReferenceSchema.parse("842451f1-7656-4440-b893-c2233968680b"),
      threadId: ThreadReferenceSchema.parse("36b4010d-f272-43be-be48-271e153194b5"),
    } }),
  ]);
  const route = createLogicalMosaicRoute(logicalProjectId, node);
  const href = createWorkbenchHref(route);
  assert.match(href, /thread\/id\/4148c9ad-75b2-4a22-9732-6cb8bb82f414/u);
  const parsed = parseWorkbenchRouteFromPath(href);
  assert.equal(parsed.view, "mosaic");
  assert.deepEqual(parsed.mosaicNode?.type === "split"
    ? parsed.mosaicNode.children.map(child => child.type === "target" ? child.target : null)
    : null, node.type === "split"
      ? node.children.map(child => child.type === "target" ? child.target : null) : null);
});
