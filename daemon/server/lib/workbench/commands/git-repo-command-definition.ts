/*
 * Exports:
 * - splitRepositoryOperand: split `<url>[@<ref>]` without mistaking ssh users or hosts for refs.
 * - WORKBENCH_GIT_REPO_COMMANDS: warm a read-only virtual repository folder through CLI and MCP.
 */
import { z } from "zod";

import { VirtualRepoRefKindSchema, VirtualRepoWarmRequestSchema } from "workbench-shared/workbench/repo/virtual-repo-contract";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

/** A ref separator is the first @ inside the repository path, never one in the authority. */
export function splitRepositoryOperand(operand: string): { url: string; ref?: string } {
  const scheme = operand.indexOf("://");
  const pathStart = scheme >= 0 ? operand.indexOf("/", scheme + 3) : operand.indexOf(":");
  const at = pathStart < 0 ? -1 : operand.indexOf("@", pathStart);
  if (at < 0) return { url: operand };
  const ref = operand.slice(at + 1);
  if (!ref) throw new Error("Pass a branch or tag after @, or omit @ for the default branch.");
  return { url: operand.slice(0, at), ref };
}

const repo = defineWorkbenchAgentCommand({
  description: "Warm a git repository as a read-only folder pinned to one commit, then print its path. Not a clone: files load lazily on first read. Warming renews a 24-hour lease; if a returned path no longer exists, warm again.",
  effects: { idempotent: true, openWorld: true, readOnly: true },
  helpGroups: ["git"],
  words: ["git", "repo"],
  usage: "wb git repo <url>[@<branch|tag>] [--kind branch|tag]",
  inputSchema: VirtualRepoWarmRequestSchema,
  parseCliArgs(args) {
    const [operand, ...rest] = args;
    if (!operand || operand.startsWith("-")) throw new Error("wb git repo requires a repository URL.");
    const flags = new WorkbenchAgentCommandFlags(rest, { values: ["--kind"] });
    const kind = flags.optional("--kind");
    return {
      ...splitRepositoryOperand(operand),
      ...(kind === null ? {} : { kind: VirtualRepoRefKindSchema.parse(kind) }),
    } satisfies z.input<typeof VirtualRepoWarmRequestSchema>;
  },
  buildRequest(input) {
    return postWorkbenchAgentCommand("/internal/repo/warm", {
      url: input.url,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
    });
  },
});

export const WORKBENCH_GIT_REPO_COMMANDS = [repo] as const;
