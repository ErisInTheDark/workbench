/*
 * Exports:
 * - WORKBENCH_SHELL_MCP_TOOL_NAME: canonical MCP registration and exposure name for the sandboxed shell.
 * - WorkbenchShellSchema/WorkbenchShell: define the shell families selected by the sandboxed shell owner.
 * - WorkbenchShellInputSchema/WorkbenchShellInput: define the sandbox-only MCP shell request.
 * - WorkbenchEscalatingShellInputSchema/WorkbenchEscalatingShellInput: shell request for providers whose escalation goes through Workbench approval.
 * - WorkbenchShellResultSchema/WorkbenchShellResult: define resolved command output and shell evidence shared by the daemon and transcript renderer.
 * - getWorkbenchShellAggregatedOutput: combine stdout and stderr with one boundary rule.
 */
import { z } from "zod";

export const WORKBENCH_SHELL_MCP_TOOL_NAME = "shell";
export const WorkbenchShellSchema = z.enum(["bash", "fish", "pwsh", "sh", "shell", "zsh"]);
export type WorkbenchShell = z.infer<typeof WorkbenchShellSchema>;

export const WorkbenchShellInputSchema = z.object({
  command: z.string().min(1).describe("Shell command string to run inside the current turn sandbox."),
  login: z.boolean().optional().describe("Use login-shell semantics. Defaults to true."),
  timeout_ms: z.number().int().nonnegative().optional().describe("Maximum command runtime in milliseconds. Codex's command default applies when omitted."),
  workdir: z.string().min(1).optional().describe("Working directory. Relative paths resolve from the current turn sandbox cwd."),
});

export type WorkbenchShellInput = z.infer<typeof WorkbenchShellInputSchema>;

export const WorkbenchEscalatingShellInputSchema = WorkbenchShellInputSchema.extend({
  outside_sandbox: z.boolean().optional().describe("Ask Workbench to approve this exact command outside the sandbox."),
  justification: z.string().optional().describe("Why this command must run outside the sandbox; shown to the user when approval is requested."),
});

export type WorkbenchEscalatingShellInput = z.infer<typeof WorkbenchEscalatingShellInputSchema>;

export const WorkbenchShellResultSchema = z.object({
  cwd: z.string().min(1),
  exitCode: z.number().int(),
  shell: WorkbenchShellSchema.nullable().default(null),
  stderr: z.string(),
  stdout: z.string(),
});

export type WorkbenchShellResult = z.infer<typeof WorkbenchShellResultSchema>;

export function getWorkbenchShellAggregatedOutput(result: Pick<WorkbenchShellResult, "stderr" | "stdout">) {
  if (!result.stdout) return result.stderr;
  if (!result.stderr) return result.stdout;
  return `${result.stdout}${result.stdout.endsWith("\n") ? "" : "\n"}${result.stderr}`;
}
