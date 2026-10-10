/* No production exports. Protect which vis frame messages become answers or frame heights: answers only as JSON from the card's own focused frame within the size bound, heights only from its own frame and within bounds. */
import assert from "node:assert/strict";
import test from "node:test";
import { VIS_MAX_ANSWER_LENGTH } from "./vis-contract";
import { acceptVisFrameAnswer, readVisFrameHeight, VIS_FRAME_MAX_HEIGHT, VIS_FRAME_MIN_HEIGHT } from "./vis-frame";

const answer = (value: unknown) => ({ kind: "workbench-vis-answer", value });
const height = (value: unknown) => ({ kind: "workbench-vis-height", height: value });

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

test("frame heights come only from the card's own frame and stay within bounds", () => {
  assert.equal(readVisFrameHeight({ fromOwnFrame: true, data: height(320.2) }), 321);
  assert.equal(readVisFrameHeight({ fromOwnFrame: true, data: height(0) }), VIS_FRAME_MIN_HEIGHT);
  assert.equal(readVisFrameHeight({ fromOwnFrame: true, data: height(1e9) }), VIS_FRAME_MAX_HEIGHT);
  assert.equal(readVisFrameHeight({ fromOwnFrame: false, data: height(320) }), null);
  for (const data of [height("320"), height(Number.NaN), answer("1"), null]) {
    assert.equal(readVisFrameHeight({ fromOwnFrame: true, data }), null);
  }
});
