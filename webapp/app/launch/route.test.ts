/*
 * No production exports. Node tests protect direct Next launch memory-only behavior and cache isolation. Keywords: workbench, launch, memory, redirect, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "./route";

test("direct Next launches remain memory-only and uncached", () => {
  const response = GET();
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
