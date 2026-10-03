/*
 * Exports:
 * - WORKBENCH_LIVE_SCENARIOS: allowlisted scenario files the trusted daemon may run, mapped to their runner entries.
 * - WorkbenchLiveScenarioRequestSchema/WorkbenchLiveScenarioRequest: validate one allowlisted scenario and its provider modes.
 * - WORKBENCH_LIVE_SCENARIO_COMMANDS: expose the bounded live scenarios and their cancellation to the CLI.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";

import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const THREAD_SCENARIO = "test/scenarios/thread.scenario.test.ts";
const INSTALL_SCENARIO = "test/install/InstallSandbox.scenario.test.ts";

export const WORKBENCH_LIVE_SCENARIOS = {
  [THREAD_SCENARIO]: { entry: "test/run-live-provider-test.mjs" },
  [INSTALL_SCENARIO]: { entry: "test/run-live-install-test.mjs" },
} as const;

const modeSchema = z.enum(["paid", "fake"]);
const MAX_LIVE_PROVIDERS = 16;
const providersSchema = z.record(ProviderKeySchema, modeSchema).refine(
  value => Object.keys(value).length >= 1 && Object.keys(value).length <= MAX_LIVE_PROVIDERS,
  "Select between one and 16 provider modes.",
);

const threadScenario = z.object({ file: z.literal(THREAD_SCENARIO), providers: providersSchema });
const installScenario = z.object({ file: z.literal(INSTALL_SCENARIO) });
const cwd = { cwd: z.string().trim().min(1) };

const scenarioSchema = z.discriminatedUnion("file", [threadScenario.strict(), installScenario.strict()]);

export const WorkbenchLiveScenarioRequestSchema = z.discriminatedUnion("file", [
  threadScenario.extend(cwd).strict(),
  installScenario.extend(cwd).strict(),
]);

export type WorkbenchLiveScenarioRequest = z.output<typeof WorkbenchLiveScenarioRequestSchema>;

const liveScenario = defineWorkbenchAgentCommand({
  description: "Run an allowlisted live scenario (provider journeys or the installer sandbox) through the trusted daemon.",
  effects: { openWorld: true },
  helpGroups: [],
  hideFromMcp: true,
  words: ["test", "live"],
  usage: `wb test live --<provider>=paid|fake [--<provider>=paid|fake ...] -- ${THREAD_SCENARIO}\nwb test live -- ${INSTALL_SCENARIO}`,
  inputSchema: scenarioSchema,
  parseCliArgs(args) {
    const delimiter = args.indexOf("--");
    if (delimiter < 0 || delimiter > MAX_LIVE_PROVIDERS || delimiter !== args.length - 2) {
      throw new Error("wb test live requires its exact scenario file after --, preceded by provider modes for provider journeys.");
    }
    const file = args[delimiter + 1];
    if (file === INSTALL_SCENARIO) {
      if (delimiter !== 0) throw new Error("The installer scenario takes no provider modes.");
      return installScenario.parse({ file });
    }
    const providers: Record<string, "paid" | "fake"> = {};
    for (const flag of args.slice(0, delimiter)) {
      const match = /^--([a-z][a-z0-9_-]*)=(paid|fake)$/u.exec(flag);
      if (!match) throw new Error(`Unsupported live provider selection: ${flag}`);
      const provider = match[1]!;
      if (providers[provider]) throw new Error(`Duplicate live provider selection: ${provider}`);
      providers[provider] = match[2] as "paid" | "fake";
    }
    return threadScenario.parse({ file, providers });
  },
  buildRequest(input, { cwd }) {
    return postWorkbenchAgentCommand("/internal/test/live-scenario", { cwd, ...input });
  },
});

const cancelLiveScenario = defineWorkbenchAgentCommand({
  description: "Cancel the active allowlisted live scenario.",
  effects: { openWorld: true },
  helpGroups: [],
  hideFromMcp: true,
  words: ["test", "live", "cancel"],
  usage: "wb test live cancel",
  inputSchema: z.object({}).strict(),
  parseCliArgs(args) {
    if (args.length) throw new Error("wb test live cancel accepts no arguments.");
    return {};
  },
  buildRequest() {
    return postWorkbenchAgentCommand("/internal/test/live-scenario/cancel", {});
  },
});

export const WORKBENCH_LIVE_SCENARIO_COMMANDS = [cancelLiveScenario, liveScenario] as const;
