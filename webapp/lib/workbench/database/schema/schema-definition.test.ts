/* No production exports. This ward keeps historical table versions private to current Workbench schema modules. */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as coreSchemaModule from "./core-schema.ts";
import * as evidenceSchemaModule from "./evidence-schema.ts";
import * as interactionSchemaModule from "./interaction-schema.ts";
import * as itemSchemaModule from "./item-schema.ts";
import * as operationSourceSchemaModule from "./operation-source-schema.ts";

test("subsystem modules do not export versioned table descriptors", () => {
  const subsystemModules = [
    coreSchemaModule,
    itemSchemaModule,
    operationSourceSchemaModule,
    interactionSchemaModule,
    evidenceSchemaModule,
  ];
  for (const subsystemModule of subsystemModules) {
    assert.deepEqual(Object.keys(subsystemModule).filter((name) => /V\d+$/.test(name)), []);
  }
});
