/*
 * No production exports. Protect that a streamed live scenario's exit code survives the round trip, and that a stream which
 * broke off before its exit line never reads as success.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LiveScenarioExit } from "./live-scenario-exit";

test("the exit line round-trips at the end of any output, and only there", () => {
  assert.equal(LiveScenarioExit.read(`journey\n${LiveScenarioExit.format(0)}`), 0);
  assert.equal(LiveScenarioExit.read(`journey${LiveScenarioExit.format(3)}`), 3);
  assert.equal(LiveScenarioExit.read(`${LiveScenarioExit.format(0)}more output\n`), null);
  assert.equal(LiveScenarioExit.read("journey cut off mid"), null);
});
