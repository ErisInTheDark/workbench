/*
 * Exports:
 * - WORKBENCH_SHELL_MCP_TOOL_NAME: canonical MCP registration and exposure name for the sandboxed shell.
 * - WorkbenchShellSchema/WorkbenchShell: define the shell families selected by the sandboxed shell owner.
 * - WorkbenchShellInputSchema/WorkbenchShellInput: define the MCP shell request, including its Workbench-approved outside-sandbox escalation.
 * - WorkbenchParallelShellInputFields/WorkbenchYieldShellInputFields/getWorkbenchShellInputSchema: the opt-in `parallel` and `yield_ms` fields, and one provider's accepted shell input.
 * - WorkbenchShellResultSchema/WorkbenchShellResult: define resolved command output, queue wait and shell evidence shared by the daemon and transcript renderer.
 * - WorkbenchShellCallResultSchema: what a yielding shell call answers: a resolved result, or a still-running one with its shell id and output so far.
 * - WORKBENCH_SHELL_WAIT_MCP_TOOL_NAME/WorkbenchShellWaitInputSchema: collect a yielded shell's result.
 * - getWorkbenchShellAggregatedOutput: combine stdout and stderr with one boundary rule. */
import { z } from "zod";

export const WORKBENCH_SHELL_MCP_TOOL_NAME = "shell";
export const WorkbenchShellSchema = z.enum(["bash", "fish", "pwsh", "sh", "shell", "zsh"]);
export type WorkbenchShell = z.infer<typeof WorkbenchShellSchema>;

export const WorkbenchShellInputSchema = z.object({
  command: z.string().min(1).describe("Shell command string to run inside the current turn sandbox."),
  login: z.boolean().optional().describe("Use login-shell semantics. Defaults to true."),
  timeout_ms: z.number().int().nonnegative().optional().describe("Maximum command runtime in milliseconds. Codex's command default applies when omitted."),
  workdir: z.string().min(1).optional().describe("Working directory. Relative paths resolve from the current turn sandbox cwd."),
  expensive: z.boolean().optional().describe("Set true when running known-expensive tasks. DO NOT set for builds or tests already optimised to be good citizens. This queues tasks machine-wide. Mixing long, serial, low-cpu work with marking as expensive means a LOT of burnt time. Queue time is a Workbench Long Wait; steers interrupt it before the command starts."),
  outside_sandbox: z.boolean().optional().describe("Ask Workbench to approve this exact command outside the sandbox."),
  justification: z.string().optional().describe("Why this command must run outside the sandbox; shown to the user when approval is requested."),
});

export type WorkbenchShellInput = z.infer<typeof WorkbenchShellInputSchema>;

/** Added to the shell input only for providers that run marked shells in parallel. */
export const WorkbenchParallelShellInputFields = {
  parallel: z.boolean().optional().describe("Start at once alongside other calls in this batch. Omit when this command depends on an earlier call: unmarked shells run in batch order after earlier shells finish, and are skipped if an earlier call failed."),
};

/** Added to the shell input only for providers whose agents cannot leave a running call. */
export const WorkbenchYieldShellInputFields = {
  yield_ms: z.number().int().positive().optional().describe("Return after this many milliseconds if the command still runs; it keeps running until your turn ends. Collect it with shell_wait."),
};

/** The shell input a provider accepts, from its parallel and yield support. */
export function getWorkbenchShellInputSchema({ parallel, yields }: { parallel: boolean; yields: boolean }): z.ZodType<
  WorkbenchShellInput & { parallel?: boolean; yield_ms?: number }
> {
  if (parallel && yields) return WorkbenchShellInputSchema.extend({ ...WorkbenchParallelShellInputFields, ...WorkbenchYieldShellInputFields });
  if (parallel) return WorkbenchShellInputSchema.extend(WorkbenchParallelShellInputFields);
  if (yields) return WorkbenchShellInputSchema.extend(WorkbenchYieldShellInputFields);
  return WorkbenchShellInputSchema;
}

export const WORKBENCH_SHELL_WAIT_MCP_TOOL_NAME = "shell_wait";

export const WorkbenchShellWaitInputSchema = z.object({
  shellId: z.string().min(1).describe("Shell id a yielded shell call returned."),
}).strict();

export const WorkbenchShellResultSchema = z.object({
  cwd: z.string().min(1),
  exitCode: z.number().int(),
  /** Time an expensive command waited for a machine-wide slot; absent when it never waited. */
  queuedMs: z.number().nonnegative().optional(),
  shell: WorkbenchShellSchema.nullable().default(null),
  stderr: z.string(),
  stdout: z.string(),
});

export type WorkbenchShellResult = z.infer<typeof WorkbenchShellResultSchema>;

/** A null exit code means the command still runs: `stdout` holds its newest output and `shellId` collects it. */
export const WorkbenchShellCallResultSchema = WorkbenchShellResultSchema.extend({
  exitCode: z.number().int().nullable(),
  shellId: z.string().min(1).optional(),
});

export function getWorkbenchShellAggregatedOutput(result: Pick<WorkbenchShellResult, "stderr" | "stdout">) {
  if (!result.stdout) return result.stderr;
  if (!result.stderr) return result.stdout;
  return `${result.stdout}${result.stdout.endsWith("\n") ? "" : "\n"}${result.stderr}`;
}
