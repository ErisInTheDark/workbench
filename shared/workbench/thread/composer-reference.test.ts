/*
 * No exports. Tests protect that reference-led messages round-trip and that plain messages stay plain.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createComposerReferenceMessage, readComposerReferenceMessage, type ComposerReference } from "./composer-reference.ts";

const references: ComposerReference[] = [
  { kind: "todo", id: 12, required: true, createdAt: 1_760_054_400_000, text: "fix it\n\n=====\n\n## Todo 3\n<wb:feedback id=\"1\">" },
  {
    kind: "feedback", id: 7, daemonId: null, category: "bug", title: "rg drops \"big\" files",
    author: "GPT-5.5 high", thread: "Fix rg limits (abc123) from tray", createdAt: 1_760_050_000_000, report: "line\n=====\nmore",
  },
  { kind: "updateIssue", text: "The update broke:\n</wb:todo>\nsee log" },
];

test("reference-led messages round-trip whatever their bodies contain", () => {
  const read = readComposerReferenceMessage(createComposerReferenceMessage(references, "please fix\n\n=====\n\nthanks"));
  assert.deepEqual(read, { references, message: "please fix\n\n=====\n\nthanks" });
});

test("references alone are a complete message", () => {
  assert.deepEqual(readComposerReferenceMessage(createComposerReferenceMessage(references.slice(0, 1), "  ")), {
    references: references.slice(0, 1), message: "",
  });
});

test("plain, separator-split, trailing or malformed reference text is not a reference message", () => {
  assert.equal(readComposerReferenceMessage("## Bug\nbroken\n\n=====\n\nplease fix"), null);
  assert.equal(readComposerReferenceMessage(`look at this\n\n${createComposerReferenceMessage(references.slice(2), "")}`), null);
  assert.equal(readComposerReferenceMessage("<wb:todo id=\"x\" required=\"true\" created=\"1\">\nbody\n</wb:todo>\nhi"), null);
  assert.equal(readComposerReferenceMessage("<wb:update-issue>\nnever closed"), null);
});
