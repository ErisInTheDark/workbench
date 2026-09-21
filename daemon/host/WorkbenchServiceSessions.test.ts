/*
 * No production exports. Tests replacement-safe app registration ownership.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchServiceSessions from "./WorkbenchServiceSessions.ts";

test("closing an old session cannot remove a newer app registration", () => {
  let changes = 0;
  const sessions = new WorkbenchServiceSessions(() => { changes++; });
  const old = sessions.open();
  old.register({ appOrigin: "http://127.0.0.1:1234", previewOrigin: null, ingressToken: "a".repeat(64) });
  const next = sessions.open();
  next.register({ appOrigin: "http://127.0.0.1:1235", previewOrigin: null, ingressToken: "b".repeat(64) });
  old.close();
  assert.equal(sessions.current?.appOrigin, "http://127.0.0.1:1235");
  assert.equal(changes, 2);
  next.close();
  assert.equal(sessions.current, null);
  assert.equal(changes, 3);
});

test("closed and superseded sessions cannot reclaim app targets", () => {
  const sessions = new WorkbenchServiceSessions(() => {});
  const old = sessions.open();
  const registration = { appOrigin: "http://127.0.0.1:1234", previewOrigin: null, ingressToken: "a".repeat(64) };
  old.register(registration);
  sessions.open().register({ ...registration, appOrigin: "http://127.0.0.1:1235" });
  assert.throws(() => old.register(registration), /superseded/i);
  old.close();
  assert.throws(() => old.register(registration), /closed/i);
});
