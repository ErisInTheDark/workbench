/* No production exports. Protect canonical/retained addressing and path isolation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranscriptAssetAddress, parseTranscriptAssetAddress } from "./transcript-asset-address.ts";

test("canonical and retained paths resolve the same owner and asset", () => {
  const threadId = "cf5b95a1-ec17-4f0a-bbcc-6cdf801d8737";
  const assetName = `${"a".repeat(64)}.png`;
  const canonical = createTranscriptAssetAddress(threadId, assetName);
  assert.deepEqual(parseTranscriptAssetAddress(canonical), { surface: "api", threadId, assetName });
  for (const surface of ["api", "daemon"]) {
    for (const prefix of ["", "codex/"]) {
      assert.deepEqual(parseTranscriptAssetAddress(`/${surface}/transcript-assets/${prefix}${threadId}/${assetName}`), {
        surface, threadId, assetName,
      });
    }
  }
  for (const invalid of [
    `${canonical}/extra`, `${canonical}?owner=other`, `${canonical}#other`,
    `https://example.com${canonical}`, createTranscriptAssetAddress("../other", assetName),
    createTranscriptAssetAddress(threadId, "../secret.png"),
  ]) assert.equal(parseTranscriptAssetAddress(invalid), null);
});
