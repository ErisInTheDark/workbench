/* No exports. Resolves the current validated local daemon publication for wb CLI dispatch. */
import path from "node:path";

import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";
import { readDaemonEndpoint } from "workbench-shared/process/workbench-daemon-endpoint";

try {
  const endpointPath = path.join(resolveWorkbenchDataRoot(), "daemon", "runtime.json");
  const endpoint = await readDaemonEndpoint(endpointPath);
  if (!endpoint) throw new Error("The Workbench daemon has not published an endpoint.");
  process.stdout.write(endpoint.origin);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown endpoint discovery failure.";
  process.stderr.write(`Workbench daemon is unavailable: ${message}\n`);
  process.exitCode = 1;
}
