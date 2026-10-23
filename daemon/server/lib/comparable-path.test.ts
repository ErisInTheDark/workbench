import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { isPathInside, normalizePathKey } from "./comparable-path";

test("path keys keep a filesystem root's separator and strip every other trailing one", () => {
  assert.equal(normalizePathKey("/", "linux"), "/");
  assert.equal(normalizePathKey("///", "linux"), "/");
  assert.equal(normalizePathKey("/etc/", "linux"), "/etc");
  assert.equal(normalizePathKey("C:\\", "win32"), "c:/");
  assert.equal(normalizePathKey("C:/Git/Repo\\", "win32"), "c:/git/repo");
  assert.equal(normalizePathKey("/Work/Repo", "linux"), "/Work/Repo");
});

test("filesystem roots contain their paths without admitting sibling prefixes", () => {
  const root = path.parse(process.cwd()).root;
  const etc = path.join(root, "etc");
  assert.ok(isPathInside(root, root));
  assert.ok(isPathInside(path.join(etc, "hosts"), root));
  assert.ok(isPathInside(path.join(etc, "hosts"), `${etc}${path.sep}`));
  assert.ok(!isPathInside(path.join(root, "etcetera"), etc));
  assert.ok(!isPathInside(root, etc));
});
