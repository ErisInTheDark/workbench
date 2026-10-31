/* No production exports. Protect vis URL routing: frame paths reach the right daemon and session, and no path escapes the build root. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema } from "../identity";
import { parseDaemonVisPath, parseVisFramePath, visFramePath } from "./vis-url";

const daemonId = DaemonIdSchema.parse("11111111-1111-4111-8111-111111111111");
const sessionId = "22222222-2222-4222-8222-222222222222";

test("a frame path and its assets reach the owning daemon's session, document first", () => {
  const frame = visFramePath(daemonId, sessionId, "live");
  const forwarded = parseVisFramePath(frame);
  assert.equal(forwarded?.daemonId, daemonId);
  assert.deepEqual(parseDaemonVisPath(forwarded!.daemonPath), { sessionId, variant: "live", file: "" });
  const asset = parseVisFramePath(`${visFramePath(daemonId, sessionId, "end")}static/image/a%20b.png`);
  assert.deepEqual(parseDaemonVisPath(asset!.daemonPath), { sessionId, variant: "end", file: "static/image/a b.png" });
});

test("paths that could leave the build root or name no session are refused", () => {
  const base = `/daemon/vis/${sessionId}/live/`;
  for (const escape of ["../secret", "a/../../secret", "%2e%2e/secret", "a%2fb", "a%5cb", "a//b", "%00", "%E0%A4%A"]) {
    assert.equal(parseDaemonVisPath(`${base}${escape}`), null, escape);
  }
  assert.equal(parseDaemonVisPath(`/daemon/vis/not-a-session/live/`), null);
  assert.equal(parseDaemonVisPath(`/daemon/vis/${sessionId}/draft/`), null);
  assert.equal(parseVisFramePath(`/not-a-daemon/${sessionId}/live/`), null);
});
