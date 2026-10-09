/*
 * No exports. Validate existing seals and print only an unsealed final release's candidate fingerprint.
 */
import { createRequire } from "node:module";
import { register } from "tsx/cjs/api";

const database = process.argv[2];
if (process.argv.length !== 3 || !["daemon", "app", "service", "presentation"].includes(database)) {
  console.error("Usage: node scripts/inspect-database-releases.mjs <daemon|app|service|presentation>");
  process.exitCode = 1;
} else {
  // All schema tokens must stay within one loader's module registry.
  const unregister = register();
  try {
    const require = createRequire(import.meta.url);
    const { inspectSchemaReleases } = require("../shared/database/schema/schema-release-manifest.ts");
    const sources = {
      daemon: ["../daemon/server/database/workbench-database-schema.ts", "workbenchDatabaseSchema", "../shared/workbench/database/schema/releases.ts"],
      service: ["../shared/state/workbench-service-schema.ts", "serviceSchema", "../shared/state/workbench-service-releases.ts"],
      app: ["../shared/state/workbench-app-state-schema.ts", "appStateSchema", "../shared/state/workbench-app-state-releases.ts"],
      presentation: ["../shared/state/workbench-presentation-schema.ts", "presentationSchema", "../shared/state/workbench-presentation-releases.ts"],
    };
    const [schemaPath, schemaExport, releasesPath] = sources[database];
    const schema = require(schemaPath)[schemaExport];
    const releases = require(releasesPath).default;
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
