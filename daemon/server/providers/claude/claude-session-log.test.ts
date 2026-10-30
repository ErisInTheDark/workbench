/* No production exports. Protect Claude session-log location, turn-window reads, and moved sessions resuming from their new cwd. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import ClaudeSessionLog from "./claude-session-log";

test("a turn window reads only main-conversation lines between its start and the next turn's", async (t) => {
  const temporary = await WorkbenchTemporaryDirectory.create("claude-session-log-");
  t.after(() => temporary.dispose());
  const directory = path.join(temporary.path, "projects", "C--repo");
  await fs.mkdir(directory, { recursive: true });
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 1) + ms).toISOString();
  const line = (fields: object) => JSON.stringify(fields);
  await fs.writeFile(path.join(directory, "session.jsonl"), [
    line({ type: "user", uuid: "before", timestamp: at(0) }),
    line({ type: "user", uuid: "prompt", timestamp: at(10) }),
    line({ type: "assistant", uuid: "subagent", isSidechain: true, timestamp: at(11) }),
    line({ type: "attachment", uuid: "noise", timestamp: at(12) }),
    "{\"type\":\"assistant\", truncated",
    line({ type: "assistant", uuid: "reply", timestamp: at(13) }),
    line({ type: "user", uuid: "next-turn", timestamp: at(20) }),
  ].join("\n"));
  const log = new ClaudeSessionLog(temporary.path);
  assert.equal(await log.locate("missing"), null);
  const file = await log.locate("session");
  assert.ok(file);
  const from = Date.parse(at(10));
  const records = await log.read(file, { from, until: Date.parse(at(20)) });
  assert.deepEqual(records.map(record => record.uuid), ["prompt", "reply"]);
});

test("a session log found under its old cwd is copied once under the new cwd's project directory", async (t) => {
  const temporary = await WorkbenchTemporaryDirectory.create("claude-session-log-");
  t.after(() => temporary.dispose());
  const original = path.join(temporary.path, "projects", "C--git-rust-zoomie-lint", "session.jsonl");
  await fs.mkdir(path.dirname(original), { recursive: true });
  await fs.writeFile(original, "{\"type\":\"user\"}\n");
  const log = new ClaudeSessionLog(temporary.path);
  const moved = await log.ensureAt("session", "C:/git/rust/dxlint");
  assert.equal(moved, path.join(temporary.path, "projects", "C--git-rust-dxlint", "session.jsonl"));
  assert.equal(await fs.readFile(moved, "utf8"), "{\"type\":\"user\"}\n");
  await fs.writeFile(moved, "{\"type\":\"assistant\"}\n");
  assert.equal(await log.ensureAt("session", "C:/git/rust/dxlint"), moved);
  assert.equal(await fs.readFile(moved, "utf8"), "{\"type\":\"assistant\"}\n", "a later turn's log is never overwritten");
  assert.equal(await fs.readFile(original, "utf8"), "{\"type\":\"user\"}\n");
});
