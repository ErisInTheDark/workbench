/*
 * Exports:
 * - WorkbenchLiveProviderTestRequestSchema/WorkbenchLiveProviderTestRequest: validate one allowlisted real-provider journey.
 * - WORKBENCH_LIVE_PROVIDER_TEST_COMMANDS: expose exact live journeys to the CLI without an arbitrary command boundary.
 */
import { z } from "zod";

import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const LIVE_PROVIDER_SCENARIOS = {
  codex: "test/scenarios/codex.scenario.test.ts",
  opencode: "test/scenarios/opencode.scenario.test.ts",
} as const;

const providerSchema = z.enum(["codex", "opencode"]);

export const WorkbenchLiveProviderTestRequestSchema = z.object({
  cwd: z.string().trim().min(1),
  file: z.string().trim().min(1),
  provider: providerSchema,
}).strict().superRefine((input, context) => {
  if (input.file !== LIVE_PROVIDER_SCENARIOS[input.provider]) {
    context.addIssue({
      code: "custom",
      message: `Live ${input.provider} testing requires ${LIVE_PROVIDER_SCENARIOS[input.provider]}.`,
      path: ["file"],
    });
  }
});

export type WorkbenchLiveProviderTestRequest = z.output<typeof WorkbenchLiveProviderTestRequestSchema>;

const liveProviderTest = defineWorkbenchAgentCommand({
  description: "Run one allowlisted real-provider journey through the trusted daemon.",
  effects: { openWorld: true },
  helpGroups: [],
  hideFromMcp: true,
  words: ["test", "live"],
  usage: "wb test live <codex|opencode> -- <exact-scenario-file>",
  inputSchema: z.object({
    file: z.string().trim().min(1),
    provider: providerSchema,
  }).strict().superRefine((input, context) => {
    if (input.file !== LIVE_PROVIDER_SCENARIOS[input.provider]) {
      context.addIssue({
        code: "custom",
        message: `Live ${input.provider} testing requires ${LIVE_PROVIDER_SCENARIOS[input.provider]}.`,
        path: ["file"],
      });
    }
  }),
  parseCliArgs(args) {
    if (args.length !== 3 || args[1] !== "--") {
      throw new Error("wb test live requires one provider and its exact scenario file after --.");
    }
    return { provider: providerSchema.parse(args[0]), file: args[2] };
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
