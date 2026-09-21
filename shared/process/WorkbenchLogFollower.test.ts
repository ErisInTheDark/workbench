/*
 * No production exports. Protect bounded initial reads and gap-free owned log rotation.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchLogFollower from "./WorkbenchLogFollower.ts";

test("following starts with bounded recent output and drains rotation without replay", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-log-follow-"));
  const first = path.join(root, "workbench-host-0001.log");
  await fs.writeFile(first, Array.from({ length: 500 }, (_, index) => `line ${index}\n`).join(""));
  let text = "";
  const follower = new WorkbenchLogFollower({
    directory: root, prefix: "workbench-host", write: async chunk => { text += chunk; },
    failed: error => assert.fail(error),
  });
  context.after(async () => { await follower.close(); await fs.rm(root, { recursive: true, force: true }); });
  await follower.start();
  assert.ok(!text.includes("line 0\n"));
  assert.ok(text.includes("line 499\n"));
  text = "";
  await fs.appendFile(first, "last old\n");
  await fs.writeFile(path.join(root, "workbench-host-0002.log"), "first new\n");
  await follower.refresh();
  assert.equal(text, "last old\nfirst new\n");
  await follower.refresh();
  assert.equal(text, "last old\nfirst new\n");
});

test("a newer diagnostic file does not hide output from the still-running owner", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-log-owners-"));
  const active = path.join(root, "workbench-host-0001.log");
  await fs.writeFile(active, "earlier output\n");
  await fs.writeFile(path.join(root, "workbench-host-0002.log"), "duplicate launch refused\n");
  let text = "";
  const follower = new WorkbenchLogFollower({
    directory: root, prefix: "workbench-host", write: async chunk => { text += chunk; },
    failed: error => assert.fail(error),
  });
  context.after(async () => { await follower.close(); await fs.rm(root, { recursive: true, force: true }); });
  await follower.start();
  text = "";
  await fs.appendFile(active, "still running\n");
  await follower.refresh();
  assert.equal(text, "still running\n");
});
