/*
 * No exports. Tests protect Workbench's cross-platform per-user data location.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import resolveWorkbenchDataRoot from "./workbench-data-root.ts";

test("resolves the Windows local application data directory", () => {
  assert.equal(resolveWorkbenchDataRoot({
    environment: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    homeDirectory: "C:\\Users\\tester",
    platform: "win32",
  }), "C:\\Users\\tester\\AppData\\Local\\inthedark\\wb");
});

test("resolves the macOS application support directory", () => {
  assert.equal(resolveWorkbenchDataRoot({
    environment: {},
    homeDirectory: "/Users/tester",
    platform: "darwin",
  }), "/Users/tester/Library/Application Support/inthedark/wb");
});

test("uses an absolute XDG data directory on Unix", () => {
  assert.equal(resolveWorkbenchDataRoot({
    environment: { XDG_DATA_HOME: "/var/user-data" },
    homeDirectory: "/home/tester",
    platform: "linux",
  }), "/var/user-data/inthedark/wb");
});

test("falls back from a relative XDG directory to the Unix user data directory", () => {
  assert.equal(resolveWorkbenchDataRoot({
    environment: { XDG_DATA_HOME: "relative-data" },
    homeDirectory: "/home/tester",
    platform: "linux",
  }), "/home/tester/.local/share/inthedark/wb");
});

test("an explicit Workbench data root overrides the platform convention", () => {
  const override = path.resolve("private-workbench-data");
  assert.equal(resolveWorkbenchDataRoot({
    environment: { WORKBENCH_DATA_ROOT: override },
    homeDirectory: "/ignored",
    platform: process.platform,
  }), override);
});
