/*
 * No exports. Run the real wb installer sandbox scenario through the trusted daemon's live-test owner.
 */
import { runLiveScenario } from "./run-live-scenario.mjs";

if (process.argv.slice(2).filter(value => value !== "--").length) {
  console.error("Run: pnpm test:install");
  process.exitCode = 1;
} else {
  runLiveScenario(["--", "test/install/InstallSandbox.scenario.test.ts"]);
}
