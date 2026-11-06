/*
 * No exports. Run the Claude account privacy scenario through the trusted daemon's live-test owner.
 */
import { runLiveScenario } from "./run-live-scenario.mjs";

if (process.argv.slice(2).filter(value => value !== "--").length) {
  console.error("Run: pnpm test:claude-account");
  process.exitCode = 1;
} else {
  runLiveScenario(["--", "daemon/server/providers/claude/claude-account-privacy.scenario.test.ts"]);
}
