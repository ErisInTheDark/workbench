/* No exports. Tests protect fixture overrides and local context admission. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseThreadRenderInput } from "./thread-render-lab-input";
import { parseThreadRenderContext, withThreadRenderStatus } from "./thread-render-lab-options";

test("status controls update only the latest turn and its history without mutating input", () => {
  const source = parseThreadRenderInput(JSON.stringify({ turns: [
    { id: "old", items: [], status: "completed" }, { id: "new", items: [], status: "completed" },
  ] })).thread!;
  const next = withThreadRenderStatus(source, "inProgress")!;
  assert.equal(next.turns[0], source.turns[0]);
  assert.equal(next.turns[1].status, "inProgress");
  assert.equal(next.turnHistory[1].status, "inProgress");
  assert.equal(source.turns[1].status, "completed");
  assert.equal(withThreadRenderStatus(source, "preserve"), source);
});

test("context rejects typos and wrong containers while preserving arbitrary renderer data", () => {
  assert.throws(() => parseThreadRenderContext('{"projectFiles":[]}'), /Unsupported/);
  assert.throws(() => parseThreadRenderContext('{"knownSkills":{}}'), /array/);
  assert.throws(() => parseThreadRenderContext("[]"), /object/);
  const context = { projectId: null, projectFilePaths: ["src/example.ts"], relatedThreadsById: {} };
  assert.deepEqual(parseThreadRenderContext(JSON.stringify(context)), context);
});
