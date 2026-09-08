/*
 * Keywords: database, releases, inspection, read-only.
 * No exports. Validate existing seals and print only an unsealed final release's candidate fingerprint.
 */
import { createRequire } from "node:module";
import { register } from "tsx/cjs/api";

const database = process.argv[2];
if (process.argv.length !== 3 || (database !== "orchestrator" && database !== "app")) {
  console.error("Usage: node scripts/inspect-database-releases.mjs <orchestrator|app>");
  process.exitCode = 1;
} else {
  // All schema tokens must stay within one loader's module registry.
  const unregister = register();
  try {
    const require = createRequire(import.meta.url);
    const { inspectSchemaReleases } = require("../shared/database/schema/schema-release-manifest.ts");
    const schema = database === "orchestrator"
      ? require("../daemon/orchestrator/database/workbench-database-schema.ts").workbenchDatabaseSchema
      : require("../shared/state/workbench-app-state-schema.ts").appStateSchema;
    const releases = database === "orchestrator"
      ? require("../shared/workbench/database/schema/releases.ts").default
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
