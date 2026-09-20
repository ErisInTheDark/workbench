/*
 * No production exports. Tests protect semantic rate-window labels. Keywords: rate limit, label, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatRateLimitIdentity, formatRateLimitWindowLabel } from "./rate-limit-display.ts";

test("rate-limit windows use their real duration names", () => {
  assert.equal(formatRateLimitWindowLabel(10_080, "Primary"), "Weekly");
  assert.equal(formatRateLimitWindowLabel(300, "Primary"), "5h");
  assert.equal(formatRateLimitWindowLabel(43_200, "Primary"), "Monthly");
  assert.equal(formatRateLimitWindowLabel(null, "Primary"), "Primary");
});

test("rate-limit identity suppresses duplicate provider names", () => {
  assert.equal(formatRateLimitIdentity("codex", "codex", null), "Codex");
  assert.equal(formatRateLimitIdentity("codex", "codex", "codex"), "Codex");
  assert.equal(formatRateLimitIdentity("codex", "account", "Team quota"), "Codex · Team quota");
});
