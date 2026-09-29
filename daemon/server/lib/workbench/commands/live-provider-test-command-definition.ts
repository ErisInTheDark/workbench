/*
 * Exports:
 * - WorkbenchLiveProviderTestRequestSchema/WorkbenchLiveProviderTestRequest: validate explicit provider modes and exact scenario.
 * - WORKBENCH_LIVE_PROVIDER_TEST_COMMANDS: expose the bounded thread journey to the CLI.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";

import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const LIVE_PROVIDER_SCENARIO = "test/scenarios/thread.scenario.test.ts";
const modeSchema = z.enum(["paid", "fake"]);
const MAX_LIVE_PROVIDERS = 16;
const providersSchema = z.record(ProviderKeySchema, modeSchema).refine(
  value => Object.keys(value).length >= 1 && Object.keys(value).length <= MAX_LIVE_PROVIDERS,
  "Select between one and 16 provider modes.",
);

export const WorkbenchLiveProviderTestRequestSchema = z.object({
  cwd: z.string().trim().min(1),
  file: z.literal(LIVE_PROVIDER_SCENARIO),
  providers: providersSchema,
}).strict();

export type WorkbenchLiveProviderTestRequest = z.output<typeof WorkbenchLiveProviderTestRequestSchema>;

const liveProviderTest = defineWorkbenchAgentCommand({
  description: "Run explicitly selected provider journeys through the trusted daemon.",
  effects: { openWorld: true },
  helpGroups: [],
  hideFromMcp: true,
  words: ["test", "live"],
  usage: "wb test live --<provider>=paid|fake [--<provider>=paid|fake ...] -- <exact-scenario-file>",
  inputSchema: z.object({
    file: z.literal(LIVE_PROVIDER_SCENARIO),
    providers: providersSchema,
  }).strict(),
  parseCliArgs(args) {
    const delimiter = args.indexOf("--");
    if (delimiter < 1 || delimiter > MAX_LIVE_PROVIDERS || delimiter !== args.length - 2) {
      throw new Error("wb test live requires explicit provider modes and its exact scenario file after --.");
    }
    const providers: Record<string, "paid" | "fake"> = {};
    for (const flag of args.slice(0, delimiter)) {
      const match = /^--([a-z][a-z0-9_-]*)=(paid|fake)$/u.exec(flag);
      if (!match) throw new Error(`Unsupported live provider selection: ${flag}`);
      const provider = match[1]!;
      if (providers[provider]) throw new Error(`Duplicate live provider selection: ${provider}`);
      providers[provider] = match[2] as "paid" | "fake";
    }
    return {
      providers: providersSchema.parse(providers),
      file: z.literal(LIVE_PROVIDER_SCENARIO).parse(args[delimiter + 1]),
    };
  },
  buildRequest(input, { cwd }) {
    return postWorkbenchAgentCommand("/internal/test/live-provider", { cwd, ...input });
  },
});

const cancelLiveProviderTest = defineWorkbenchAgentCommand({
  description: "Cancel the active allowlisted real-provider journey.",
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
    return postWorkbenchAgentCommand("/internal/test/live-provider/cancel", {});
  },
});

export const WORKBENCH_LIVE_PROVIDER_TEST_COMMANDS = [cancelLiveProviderTest, liveProviderTest] as const;
