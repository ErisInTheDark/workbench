/*
 * No production exports. Protect bounded initial reads and gap-free owned log rotation.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory.ts";
import WorkbenchLogFollower from "./WorkbenchLogFollower.ts";

test("combined following retains recent output and rotation independently for both owners", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-log-combined-");
  const root = temporary.path;
  await fs.writeFile(path.join(root, "workbench-app-0001.log"), "app recent\n");
  for (let index = 0; index < 20; index++) {
    await fs.writeFile(path.join(root, `workbench-host-${String(index).padStart(4, "0")}.log`), `host ${index}\n`);
  }
  let output = "";
  const follower = new WorkbenchLogFollower({
    directory: root, prefix: ["workbench-app", "workbench-host"], schedule: () => () => {},
    write: async text => { output += text; }, failed: error => assert.fail(error),
  });
  context.after(async () => { await follower.close(); await temporary.dispose(); });
  await follower.start();
  assert.equal(output, "app recent\nhost 19\n");
  output = "";
  await fs.appendFile(path.join(root, "workbench-app-0001.log"), "app live\n");
  await fs.writeFile(path.join(root, "workbench-host-0020.log"), "host rotated\n");
  await follower.refresh();
  assert.equal(output, "app live\nhost rotated\n");
});

test("scheduled following reads open-file appends and stops scheduling on detach", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-log-live-");
  const root = temporary.path;
  const filename = path.join(root, "workbench-host-0001.log");
  const writer = await fs.open(filename, "a");
  let next: (() => Promise<void>) | null = null;
  let text = "";
  let blocked: Promise<void> | null = null;
  let writing: (() => void) | null = null;
  const options = {
    directory: root, prefix: "workbench-host",
    write: async (chunk: string) => { text += chunk; writing?.(); await blocked; },
    failed: (error: Error) => assert.fail(error),
    schedule: (callback: () => Promise<void>) => {
      assert.equal(next, null, "only one tail check may be scheduled");
      next = callback;
      return () => { next = null; };
    },
  };
  const follower = new WorkbenchLogFollower(options);
  context.after(async () => {
    await follower.close();
    await writer.close();
    await temporary.dispose();
  });
  await writer.write("before attachment\n");
  await follower.start();
  text = "";
  await writer.write("still open\n");
  const scheduled = next as (() => Promise<void>) | null;
  assert.ok(scheduled, "following must progress without a directory notification");
  next = null;
  await scheduled();
  assert.equal(text, "still open\n");
  assert.ok(next);
  let release!: () => void;
  blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { writing = resolve; });
  await writer.write("slow output\n");
  const queued = next as (() => Promise<void>) | null;
  assert.ok(queued);
  next = null;
  const reading = queued();
  await entered;
  assert.equal(next, null, "backpressure must finish before scheduling another read");
  const closing = follower.close();
  release();
  await Promise.all([reading, closing]);
  await queued();
  assert.equal(next, null);
});

test("a failed scheduled read reports once and does not keep retrying", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-log-failure-");
  const root = temporary.path;
  let next: (() => Promise<void>) | null = null;
  const errors: Error[] = [];
  const follower = new WorkbenchLogFollower({
    directory: root, prefix: "workbench-host", write: async () => {},
    failed: error => { errors.push(error); },
    schedule: callback => { next = callback; return () => { next = null; }; },
  });
  context.after(async () => { await follower.close(); await temporary.dispose(); });
  await follower.start();
  const failure = new Error("log directory unavailable");
  context.mock.method(fs, "readdir", async () => { throw failure; });
  const scheduled = next as (() => Promise<void>) | null;
  assert.ok(scheduled);
  next = null;
  await scheduled();
  assert.deepEqual(errors, [failure]);
  assert.equal(next, null);
});

test("following starts with bounded recent output and drains rotation without replay", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-log-follow-");
  const root = temporary.path;
  const first = path.join(root, "workbench-host-0001.log");
  await fs.writeFile(first, Array.from({ length: 500 }, (_, index) => `line ${index}\n`).join(""));
  let text = "";
  const follower = new WorkbenchLogFollower({
    directory: root, prefix: "workbench-host", write: async chunk => { text += chunk; },
    failed: error => assert.fail(error),
  });
  context.after(async () => { await follower.close(); await temporary.dispose(); });
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
  const temporary = await WorkbenchTemporaryDirectory.create("wb-log-owners-");
  const root = temporary.path;
  const active = path.join(root, "workbench-host-0001.log");
  await fs.writeFile(active, "earlier output\n");
  await fs.writeFile(path.join(root, "workbench-host-0002.log"), "duplicate launch refused\n");
  let text = "";
  const follower = new WorkbenchLogFollower({
    directory: root, prefix: "workbench-host", write: async chunk => { text += chunk; },
    failed: error => assert.fail(error),
  });
  context.after(async () => { await follower.close(); await temporary.dispose(); });
  await follower.start();
  text = "";
  await fs.appendFile(active, "still running\n");
  await follower.refresh();
  assert.equal(text, "still running\n");
});
