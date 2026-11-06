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
const CLAUDE_ACCOUNT_SCENARIO = "daemon/server/providers/claude/claude-account-privacy.scenario.test.ts";
const MODELESS_SCENARIOS = [INSTALL_SCENARIO, CLAUDE_ACCOUNT_SCENARIO] as const;

export const WORKBENCH_LIVE_SCENARIOS = {
  [THREAD_SCENARIO]: { entry: "test/run-live-provider-test.mjs" },
  [INSTALL_SCENARIO]: { entry: "test/run-live-install-test.mjs" },
  [CLAUDE_ACCOUNT_SCENARIO]: { entry: "test/run-live-claude-account-test.mjs" },
} as const;

const modeSchema = z.enum(["paid", "fake"]);
const MAX_LIVE_PROVIDERS = 16;
const providersSchema = z.record(ProviderKeySchema, modeSchema).refine(
  value => Object.keys(value).length >= 1 && Object.keys(value).length <= MAX_LIVE_PROVIDERS,
  "Select between one and 16 provider modes.",
);

const threadScenario = z.object({ file: z.literal(THREAD_SCENARIO), providers: providersSchema });
const modelessScenario = z.object({ file: z.enum(MODELESS_SCENARIOS) });
const isModelessScenario = (file: string): file is typeof MODELESS_SCENARIOS[number] => (MODELESS_SCENARIOS as readonly string[]).includes(file);
const cwd = { cwd: z.string().trim().min(1) };

/** One flat object, since a union cannot list as an MCP tool input; per-scenario rules move into the refinement. */
const scenarioSchema = z.object({
  file: z.enum([THREAD_SCENARIO, ...MODELESS_SCENARIOS]),
  providers: providersSchema.optional().describe("Provider journeys only: mode per provider, e.g. { codex: \"fake\" }."),
}).strict().superRefine((input, context) => {
  if (input.file === THREAD_SCENARIO && !input.providers) {
    context.addIssue({ code: "custom", path: ["providers"], message: "Provider journeys require provider modes." });
  }
  if (isModelessScenario(input.file) && input.providers) {
    context.addIssue({ code: "custom", path: ["providers"], message: "This scenario takes no provider modes." });
  }
});

export const WorkbenchLiveScenarioRequestSchema = z.discriminatedUnion("file", [
  threadScenario.extend(cwd).strict(),
  modelessScenario.extend(cwd).strict(),
]);

export type WorkbenchLiveScenarioRequest = z.output<typeof WorkbenchLiveScenarioRequestSchema>;

const liveScenario = defineWorkbenchAgentCommand({
  description: "Run an allowlisted live scenario (provider journeys, the installer sandbox or Claude account privacy) through the trusted daemon.",
  effects: { openWorld: true },
  helpGroups: [],
  mcpDeferred: true,
  words: ["test", "live"],
  usage: [
    `wb test live --<provider>=paid|fake [--<provider>=paid|fake ...] -- ${THREAD_SCENARIO}`,
    ...MODELESS_SCENARIOS.map(file => `wb test live -- ${file}`),
  ].join("\n"),
  inputSchema: scenarioSchema,
  parseCliArgs(args) {
    const delimiter = args.indexOf("--");
    if (delimiter < 0 || delimiter > MAX_LIVE_PROVIDERS || delimiter !== args.length - 2) {
      throw new Error("wb test live requires its exact scenario file after --, preceded by provider modes for provider journeys.");
    }
    const file = args[delimiter + 1];
    if (file !== undefined && isModelessScenario(file)) {
      if (delimiter !== 0) throw new Error("This scenario takes no provider modes.");
      return modelessScenario.parse({ file });
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
  mcpDeferred: true,
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
