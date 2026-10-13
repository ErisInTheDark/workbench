/* No exports. Tests protect bounded nested diagnostics without serializing arbitrary rejection payloads. */
import assert from "node:assert/strict";
import test from "node:test";
import { describeErrorCauseChain } from "./error-cause-chain";

test("nested aggregate and standard causes retain useful failure context", () => {
  const error = new AggregateError([
    new Error("candidate failed", { cause: new Error("spawn denied") }),
    new Error("resume failed"),
  ], "replacement failed");
  const message = describeErrorCauseChain(error);
  for (const detail of ["replacement failed", "candidate failed", "spawn denied", "resume failed"]) {
    assert.ok(message.includes(detail));
  }
});

test("diagnostics bound cyclic and wide causes and keep output on one line", () => {
  const cyclic = new Error("cycle\nwith\u001b[31m controls");
  cyclic.cause = cyclic;
  const error = new AggregateError(Array.from({ length: 100 }, () => cyclic), "wide failure");
  const message = describeErrorCauseChain(error, 120);
  assert.ok(message.length <= 120);
  assert.doesNotMatch(message, /[\u0000-\u001f\u007f]/u);
  assert.ok(message.includes("cycle"));
});

test("non-error objects cannot execute string conversion or expose their payload", () => {
  const payload = { toString() { assert.fail("arbitrary payload conversion"); }, secret: "private-value" };
  assert.doesNotThrow(() => describeErrorCauseChain(payload));
  assert.ok(!describeErrorCauseChain(payload).includes(payload.secret));
});
