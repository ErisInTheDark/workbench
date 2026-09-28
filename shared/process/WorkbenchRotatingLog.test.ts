/*
 * No production exports. Protect bounded retention without deleting unrelated logs.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory.ts";
import WorkbenchRotatingLog from "./WorkbenchRotatingLog.ts";

test("rotation retains recent complete output and leaves other log owners alone", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-rotating-log-");
  const root = temporary.path;
  context.after(() => temporary.dispose());
  await fs.writeFile(path.join(root, "another-owner.log"), "keep");
  const log = new WorkbenchRotatingLog(root, "workbench-host", 2, 2);
  try {
    log.write("one\ntwo\nthree\nfour\nfive\nsix\n");
  } finally { log.close(); }
  const files = (await fs.readdir(root)).filter(file => file.startsWith("workbench-host-")).sort();
  assert.equal(files.length, 2);
  assert.equal((await Promise.all(files.map(file => fs.readFile(path.join(root, file), "utf8")))).join(""), "three\nfour\nfive\nsix\n");
  assert.equal(await fs.readFile(path.join(root, "another-owner.log"), "utf8"), "keep");
});
