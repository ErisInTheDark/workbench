/*
 * No exports. Validate existing seals and print only an unsealed final release's candidate fingerprint.
 */
import { createRequire } from "node:module";
import { register } from "tsx/cjs/api";

const database = process.argv[2];
if (process.argv.length !== 3 || !["daemon", "app", "service"].includes(database)) {
  console.error("Usage: node scripts/inspect-database-releases.mjs <daemon|app|service>");
  process.exitCode = 1;
} else {
  // All schema tokens must stay within one loader's module registry.
  const unregister = register();
  try {
    const require = createRequire(import.meta.url);
    const { inspectSchemaReleases } = require("../shared/database/schema/schema-release-manifest.ts");
    const schema = database === "daemon"
      ? require("../daemon/server/database/workbench-database-schema.ts").workbenchDatabaseSchema
      : database === "service"
        ? require("../shared/state/workbench-service-schema.ts").serviceSchema
        : require("../shared/state/workbench-app-state-schema.ts").appStateSchema;
    const releases = database === "daemon"
      ? require("../shared/workbench/database/schema/releases.ts").default
      : database === "service"
        ? require("../shared/state/workbench-service-releases.ts").default
        : require("../shared/state/workbench-app-state-releases.ts").default;
    const candidates = inspectSchemaReleases(schema, releases);
    console.log(`${database}: sealed history verified through version ${schema.currentVersion - candidates.length}`);
    for (const candidate of candidates) console.log(`${candidate.name}@${candidate.version}: ${candidate.fingerprint}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    unregister();
  }
}
