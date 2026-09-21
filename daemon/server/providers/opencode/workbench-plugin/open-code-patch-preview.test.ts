/* No production exports. Tests protect incomplete JSON and patch target/count semantics. */
import assert from "node:assert/strict";
import test from "node:test";
import OpenCodePatchPreview from "./open-code-patch-preview";

test("waits for complete escaped headers, then streams counts and move targets", () => {
  const parser = new OpenCodePatchPreview("patch");
  assert.equal(parser.append('{"patchText":"*** Begin Patch\\n*** Update File: src/'), null);
  assert.equal(parser.append('a\\u00'), null);
  assert.equal(parser.append('e9.ts'), null);
  assert.deepEqual(parser.append('\\n@@\\n-old\\n+new\\n*** Move to: src/b.ts\\n'), [{
    path: "src/aé.ts", kind: { type: "update", move_path: "src/b.ts" }, additions: 1, deletions: 1,
  }]);
  assert.deepEqual(parser.append('*** Add File: src/c.ts\\n+hello\\n*** End Patch\\n"}'), [
    { path: "src/aé.ts", kind: { type: "update", move_path: "src/b.ts" }, additions: 1, deletions: 1 },
    { path: "src/c.ts", kind: { type: "add" }, additions: 1, deletions: 0 },
  ]);
});

test("publishes a complete edit path without waiting for content and does not invent counts", () => {
  const parser = new OpenCodePatchPreview("edit");
  assert.equal(parser.append('{"path":"src/a'), null);
  assert.deepEqual(parser.append('.ts","oldString":"'), [
    { path: "src/a.ts", kind: { type: "update", move_path: null } },
  ]);
  assert.equal(parser.append('old","newString":"new"}'), null);
});

test("rejects malformed arguments instead of interpreting them as patch instructions", () => {
  const parser = new OpenCodePatchPreview("patch");
  assert.throws(() => parser.append('{"patchText": nope}'));
});

test("long unfinished patch strings grow counts without duplicating earlier targets", () => {
  const parser = new OpenCodePatchPreview("patch");
  parser.append('{"patchText":"*** Begin Patch\\n*** Add File: large.ts\\n');
  const chunk = "+generated line\\n".repeat(4096);
  const first = parser.append(chunk)!;
  const second = parser.append(chunk)!;
  assert.equal(first[0]?.additions, 4096);
  assert.equal(second.length, 1);
  assert.equal(second[0]?.additions, 8192);
  assert.equal(first[0]?.additions, 4096, "already published previews remain immutable");
});

test("new writes stream decoded line counts before the content closes", () => {
  const parser = new OpenCodePatchPreview("write", true);
  parser.append('{"path":"new.ts","content":"');
  const first = parser.append('one\\r\\nsecond');
  assert.deepEqual(first, [{ path: "new.ts", kind: { type: "add" }, additions: 2, deletions: 0 }]);
  assert.equal(parser.append('\\n')?.[0]?.additions, 2);
  assert.equal(parser.append('third')?.[0]?.additions, 3);
  parser.append('"}');
  assert.equal(first?.[0]?.additions, 2, "later chunks cannot mutate admitted snapshots");
});
