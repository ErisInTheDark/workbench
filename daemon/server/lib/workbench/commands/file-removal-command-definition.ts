/*
 * Exports:
 * - WorkbenchFileRemovalExecutionRequestSchema: validate claim-checked file removal requests from one managed caller.
 * - WorkbenchFileRemovalExecutionRequest: parsed file removal request.
 * - WORKBENCH_FILE_REMOVAL_COMMANDS: expose claim-checked file deletion as wb rm for Claude callers.
 */
import { z } from "zod";

import {
  defineWorkbenchAgentCommand,
  managedWorkbenchAgentCommandBody,
  postWorkbenchAgentCommand,
} from "./workbench-agent-command-definition";

const removalPath = z.string().trim().min(1).max(32_768).refine(value => !value.includes("\0"), "Paths cannot contain NUL.");
const removalPaths = z.array(removalPath).min(1).max(200)
  .describe("Files to delete, relative to the thread cwd or absolute. Directories require recursive.");
const recursive = z.boolean().default(false).describe("Allow deleting directories and their contents.");

export const WorkbenchFileRemovalExecutionRequestSchema = z.object({
  cwd: z.string().trim().min(1),
  harness: z.string().trim().min(1),
  paths: removalPaths,
  recursive,
  threadId: z.string().trim().min(1),
}).strict();

export type WorkbenchFileRemovalExecutionRequest = z.output<typeof WorkbenchFileRemovalExecutionRequestSchema>;

const rm = defineWorkbenchAgentCommand({
  description: "Delete claimed files, or claimed directories with recursive. Every path must be covered by this thread's active claims.",
  effects: { destructive: true, idempotent: false },
  harnesses: ["claude"],
  helpGroups: [],
  words: ["rm"],
  usage: "wb rm [--recursive] [--] <path>...",
  inputSchema: z.object({ paths: removalPaths, recursive }).strict(),
  parseCliArgs(args) {
    let recursiveFlag = false;
    const paths: string[] = [];
    let operandsOnly = false;
    for (const arg of args) {
      if (!operandsOnly && arg === "--") operandsOnly = true;
      else if (!operandsOnly && (arg === "--recursive" || arg === "-r")) recursiveFlag = true;
      else if (!operandsOnly && arg.startsWith("-")) throw new Error(`Unknown wb rm option: ${arg}. Use -- before paths starting with -.`);
      else paths.push(arg);
    }
    if (!paths.length) throw new Error("wb rm requires at least one path.");
    return { paths, recursive: recursiveFlag };
  },
  buildRequest(input, context) {
    return postWorkbenchAgentCommand("/api/rm", { ...managedWorkbenchAgentCommandBody(context), paths: input.paths, recursive: input.recursive });
  },
});

export const WORKBENCH_FILE_REMOVAL_COMMANDS = [rm] as const;
