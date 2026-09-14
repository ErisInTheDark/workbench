/* No production exports. This ward keeps historical table versions private to current Workbench schema modules. */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as coreSchemaModule from "workbench-shared/workbench/database/schema/core-schema";
import * as evidenceSchemaModule from "workbench-shared/workbench/database/schema/evidence-schema";
import * as interactionSchemaModule from "workbench-shared/workbench/database/schema/interaction-schema";
import * as itemSchemaModule from "workbench-shared/workbench/database/schema/item-schema";
import * as operationSourceSchemaModule from "workbench-shared/workbench/database/schema/operation-source-schema";
import * as threadStateSchemaModule from "./thread-state-schema.ts";

test("subsystem modules do not export versioned table descriptors", () => {
  const subsystemModules = [
    coreSchemaModule,
    itemSchemaModule,
    operationSourceSchemaModule,
    interactionSchemaModule,
    evidenceSchemaModule,
    threadStateSchemaModule,
  ];
  for (const subsystemModule of subsystemModules) {
    assert.deepEqual(Object.keys(subsystemModule).filter((name) => /V\d+$/.test(name)), []);
  }
});
