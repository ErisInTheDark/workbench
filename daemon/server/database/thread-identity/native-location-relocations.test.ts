/* No production exports. Tests protect relocated native locations mapping onto their destinations without capturing siblings. */
import assert from "node:assert/strict";
import { test } from "node:test";
import NativeLocationRelocations from "./native-location-relocations";

test("a relocated prefix moves itself and its subfolders but never a sibling sharing its name", () => {
  const relocations = new NativeLocationRelocations([{ from: "/git/old", to: "/git/new" }], "linux");
  assert.equal(relocations.relocate("/git/old"), "/git/new");
  assert.equal(relocations.relocate("/git/old/crates/core"), "/git/new/crates/core");
  assert.equal(relocations.relocate("/git/older"), "/git/older");
  assert.equal(relocations.key("/git/old/src"), relocations.key("/git/new/src"));
});

test("windows relocations ignore case and separators while keeping the stored spelling", () => {
  const relocations = new NativeLocationRelocations([{ from: "C:/git/rust/zoomie-lint", to: "C:/git/rust/dxlint" }], "win32");
  assert.equal(relocations.relocate("C:\\Git\\Rust\\Zoomie-Lint\\Src\\Lib"), "C:/git/rust/dxlint/Src/Lib");
  assert.equal(relocations.key("c:\\git\\rust\\zoomie-lint"), relocations.key("C:/git/rust/dxlint"));
});

test("chained relocations follow to the last destination and cycles are rejected", () => {
  const chained = new NativeLocationRelocations([{ from: "/a", to: "/b" }, { from: "/b", to: "/c" }], "linux");
  assert.equal(chained.relocate("/a/x"), "/c/x");
  const cyclic = new NativeLocationRelocations([{ from: "/a", to: "/b" }, { from: "/b", to: "/a" }], "linux");
  assert.throws(() => cyclic.relocate("/a"), /cycle/u);
});
