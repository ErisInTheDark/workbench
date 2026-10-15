/* No exports. Resolves the current validated local daemon publication for wb CLI dispatch. */
import path from "node:path";

import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";
import { readDaemonEndpoint } from "workbench-shared/process/workbench-daemon-endpoint";
import verifyWorkbenchDaemonEndpoint from "workbench-shared/process/verify-workbench-daemon-endpoint";

try {
  const endpointPath = path.join(resolveWorkbenchDataRoot(), "daemon", "runtime.json");
  const endpoint = await readDaemonEndpoint(endpointPath);
  if (!endpoint) throw new Error("The Workbench daemon has not published an endpoint.");
  try {
    await verifyWorkbenchDaemonEndpoint(endpoint, fetch, AbortSignal.timeout(2_000));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown health verification failure.";
    throw new Error(
      `The published daemon endpoint is stale or unreachable (${detail}) Run \`wb ports\` to inspect active listeners; do not restart Workbench automatically.`,
      { cause: error },
    );
  }
  process.stdout.write(endpoint.origin);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown endpoint discovery failure.";
  process.stderr.write(`Workbench daemon is unavailable: ${message}\n`);
  process.exitCode = 1;
}
