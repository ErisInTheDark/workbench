/*
 * No exports. Require explicit provider modes, then use the trusted daemon's isolated live-test owner.
 */
import { parseThreadTestArguments } from "./thread-test-arguments.ts";
import { runLiveScenario } from "./run-live-scenario.mjs";

let providers;
try {
  providers = parseThreadTestArguments(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

if (providers) {
  runLiveScenario([
    ...Object.entries(providers).map(([provider, mode]) => `--${provider}=${mode}`),
    "--", "test/scenarios/thread.scenario.test.ts",
  ]);
}
