/* No exports. Protect retained provisional aliases without overriding explicit identity evidence. */
import assert from "node:assert/strict";
import test from "node:test";
import { readRetainedTranscriptIdentityKind } from "./retained-transcript-identity.ts";

test("retained identity preserves explicit evidence before interpreting legacy aliases", () => {
  assert.equal(readRetainedTranscriptIdentityKind({ id: "item-12" }), "provisional");
  assert.equal(readRetainedTranscriptIdentityKind({ id: "item-12" }, "another-provider"), "stable");
  assert.equal(readRetainedTranscriptIdentityKind({ id: "item-12", workbenchIdentityKind: "stable" }), "stable");
  assert.equal(readRetainedTranscriptIdentityKind({ id: "completed-message", workbenchIdentityKind: "provisional" }), "provisional");
  assert.equal(readRetainedTranscriptIdentityKind({ id: "completed-message" }), "stable");
});
