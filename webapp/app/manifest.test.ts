/*
 * No production exports. Node tests protect Workbench standalone display, launch scope, and install icon metadata. Keywords: workbench, manifest, standalone, iOS, launch, icon, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import manifest from "./manifest";

test("the Workbench manifest launches a scoped standalone app through last-project restoration", () => {
  const value = manifest();
  assert.equal(value.display, "standalone");
  assert.equal(value.scope, "/");
  assert.equal(value.start_url, "/launch");
  assert.ok(value.icons?.some((icon) => icon.src === "/icon" && icon.sizes === "512x512"));
});
