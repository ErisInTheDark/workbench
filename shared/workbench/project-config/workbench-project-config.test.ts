/* No production exports. Protect that the published `.wb.json` editor schema describes exactly what Workbench parses. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { workbenchProjectConfigJsonSchema } from "./workbench-project-config";

test("package/wb.schema.json matches the project config parser", async () => {
  const published = JSON.parse(await readFile(new URL("../../../package/wb.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(published, workbenchProjectConfigJsonSchema(),
    "Regenerate package/wb.schema.json from workbenchProjectConfigJsonSchema() after changing a .wb.json section.");
});
