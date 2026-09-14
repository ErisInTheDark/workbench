/* No production exports. Tests protect provider-key admission independent of installation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderKeySchema } from "./provider-key.ts";

test("stored provider identities admit future implementations without a product enum", () => {
  for (const key of ["codex", "opencode2", "future-provider", "local_provider"]) {
    assert.equal(ProviderKeySchema.parse(key), key);
  }
});

test("provider keys reject ambiguous spellings instead of coercing identity", () => {
  for (const key of ["", "Codex", " codex", "codex ", "provider/thread", "provider:thread"]) {
    assert.equal(ProviderKeySchema.safeParse(key).success, false);
  }
});
