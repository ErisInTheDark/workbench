/*
 * No production exports. Protect source-qualified mosaic expressions used by dormant layout state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "../identity";
import {
  createWorkbenchMosaicSplit, createWorkbenchMosaicTarget,
  parseWorkbenchMosaicRouteExpression, serializeWorkbenchMosaicRouteExpression,
} from "./workbench-mosaic-route";

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
});
