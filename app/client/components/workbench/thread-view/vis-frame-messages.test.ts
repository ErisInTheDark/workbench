/* No production exports. Protect which vis frame messages become answers: only JSON from the card's own focused frame, within the size bound. */
import assert from "node:assert/strict";
import test from "node:test";
import { VIS_MAX_ANSWER_LENGTH } from "workbench-shared/workbench/vis/vis-contract";
import { acceptVisFrameAnswer } from "./vis-frame-messages";

const answer = (value: unknown) => ({ kind: "workbench-vis-answer", value });

test("the card's own focused frame can send a JSON answer", () => {
  assert.equal(acceptVisFrameAnswer({ fromOwnFrame: true, frameFocused: true, data: answer("{\"pick\":\"a\"}") }), "{\"pick\":\"a\"}");
});

test("messages from other windows, or while the frame is unfocused, are dropped", () => {
  assert.equal(acceptVisFrameAnswer({ fromOwnFrame: false, frameFocused: true, data: answer("1") }), null);
  assert.equal(acceptVisFrameAnswer({ fromOwnFrame: true, frameFocused: false, data: answer("1") }), null);
});

test("malformed, non-JSON and oversized payloads are dropped", () => {
  for (const data of [null, "1", { kind: "other", value: "1" }, answer(1), answer(""), answer("{nope"), answer(`"${"x".repeat(VIS_MAX_ANSWER_LENGTH)}"`)]) {
    assert.equal(acceptVisFrameAnswer({ fromOwnFrame: true, frameFocused: true, data }), null);
  }
});
