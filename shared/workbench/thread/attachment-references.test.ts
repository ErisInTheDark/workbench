/* No production exports. Protect attachment identity through removal and numbered provider input. */
import assert from "node:assert/strict";
import test from "node:test";
import { applyAttachmentTextEdits, renumberAttachmentReferences } from "./attachment-references.ts";

test("removal rewrites repeated references by identity without cascading replacements", () => {
  const before = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const text = "compare #[attach:3] with #[attach:2], again #[attach:3]; #[other:3] #[attach:9]";
  const next = before.filter(item => item.id !== "b");
  const result = applyAttachmentTextEdits(text, renumberAttachmentReferences(text, before, next));
  assert.equal(result, "compare #[attach:2] with #[attach:removed], again #[attach:2]; #[other:3] #[attach:9]");
  assert.equal(applyAttachmentTextEdits(result, renumberAttachmentReferences(result, next, [{ id: "c" }])),
    "compare #[attach:1] with #[attach:removed], again #[attach:1]; #[other:3] #[attach:9]");
});
