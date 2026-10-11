/*
 * No exports. Tests protect the boot-time React Scan opt-in: off by default and never broken by bad stored values.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readReactScanPreference, writeReactScanPreference } from "./react-scan-preference";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test("defaults off and round-trips the device choice", () => {
  const storage = memoryStorage();
  assert.equal(readReactScanPreference(storage), false);
  writeReactScanPreference(true, storage);
  assert.equal(readReactScanPreference(storage), true);
  writeReactScanPreference(false, storage);
  assert.equal(readReactScanPreference(storage), false);
});

test("malformed stored values fall back to off instead of breaking boot", () => {
  for (const raw of ["{", "true", "{\"enabled\":\"yes\"}", "null"]) {
    assert.equal(readReactScanPreference(memoryStorage({ "workbench.reactScan": raw })), false, raw);
  }
});
