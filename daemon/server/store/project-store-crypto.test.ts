/* No production exports. Tests store values only open for their exact identity and binding. */
import assert from "node:assert/strict";
import test from "node:test";
import { deriveProjectStoreKey, openProjectStoreValue, sealProjectStoreValue } from "./project-store-crypto";

const identity = { deviceId: "synthetic-device", user: "synthetic-user", projectLocation: "local://synthetic/project" };

test("values round-trip only with the same device, user and project location", () => {
  const key = deriveProjectStoreKey(identity);
  const sealed = sealProjectStoreValue(key, "project", "API_KEY", "multi\nline value");
  assert.equal(openProjectStoreValue(key, "project", "API_KEY", sealed), "multi\nline value");
  assert.deepEqual(deriveProjectStoreKey(identity), key);
  for (const changed of [{ deviceId: "other" }, { user: "other" }, { projectLocation: "local://moved" }]) {
    assert.equal(openProjectStoreValue(deriveProjectStoreKey({ ...identity, ...changed }), "project", "API_KEY", sealed), null);
  }
});

test("ciphertext cannot be moved to another key or project, or altered", () => {
  const key = deriveProjectStoreKey(identity);
  const sealed = sealProjectStoreValue(key, "project", "API_KEY", "value");
  assert.equal(openProjectStoreValue(key, "project", "OTHER", sealed), null);
  assert.equal(openProjectStoreValue(key, "other-project", "API_KEY", sealed), null);
  const tampered = Buffer.from(sealed.ciphertext);
  tampered[0]! ^= 1;
  assert.equal(openProjectStoreValue(key, "project", "API_KEY", { ...sealed, ciphertext: tampered }), null);
  assert.notDeepEqual(sealProjectStoreValue(key, "project", "API_KEY", "value").nonce, sealed.nonce);
});
