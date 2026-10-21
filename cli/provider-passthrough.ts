/*
 * No exports. `wb codex|claude|opencode ...` runs the daemon's pinned provider executable in the caller's terminal.
 */
import WorkbenchBootstrapCommand, { WorkbenchChildExitError } from "../package/WorkbenchBootstrapCommand.mjs";
import { locateCodexRuntime } from "../daemon/server/codex-executable.ts";
import { captureProviderRuntimePins, resolveProviderRuntime } from "../daemon/server/providers/provider-runtimes.ts";
import { ProviderRuntimeKeySchema } from "../shared/workbench/provider/provider-runtime.ts";
import resolveWorkbenchDataRoot from "../shared/workbench-data-root.ts";

function managedExecutable(provider: string | undefined, dataRoot: string) {
  if (provider === "codex") return locateCodexRuntime({ dataRoot });
  const key = ProviderRuntimeKeySchema.parse(provider);
  return resolveProviderRuntime(dataRoot, key, captureProviderRuntimePins()[key]()).executable;
}

async function run([provider, ...args]: string[]) {
  try {
    await new WorkbenchBootstrapCommand().run(managedExecutable(provider, resolveWorkbenchDataRoot()), args, { interactive: true });
  } catch (error) {
    if (error instanceof WorkbenchChildExitError) process.exitCode = error.exitCode;
    else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}

void run(process.argv.slice(2));
