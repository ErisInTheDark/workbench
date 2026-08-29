/*
 * Exports:
 * - WORKBENCH_SHELL_MCP_TOOL_NAME: canonical MCP registration and exposure name for the sandboxed shell. Keywords: workbench, shell, MCP, name.
 * - WorkbenchShellInputSchema/WorkbenchShellInput: define the MCP-only sandboxed shell request. Keywords: workbench, shell, MCP, input, schema.
 * - WorkbenchShellResultSchema/WorkbenchShellResult: define resolved command output shared by the orchestrator and transcript renderer. Keywords: workbench, shell, result, cwd, exit.
 * - getWorkbenchShellAggregatedOutput: combine stdout and stderr with one boundary rule. Keywords: workbench, shell, output, stderr.
 */
import { z } from "zod";

export const WORKBENCH_SHELL_MCP_TOOL_NAME = "shell";

export const WorkbenchShellInputSchema = z.object({
  command: z.string().min(1).describe("Shell command string to run inside the current turn sandbox."),
  login: z.boolean().optional().describe("Use login-shell semantics. Defaults to true."),
  timeout_ms: z.number().int().nonnegative().optional().describe("Maximum command runtime in milliseconds. Codex's command default applies when omitted."),
  workdir: z.string().min(1).optional().describe("Working directory. Relative paths resolve from the current turn sandbox cwd."),
});

export type WorkbenchShellInput = z.infer<typeof WorkbenchShellInputSchema>;

export const WorkbenchShellResultSchema = z.object({
  cwd: z.string().min(1),
  exitCode: z.number().int(),
  stderr: z.string(),
  stdout: z.string(),
});

export type WorkbenchShellResult = z.infer<typeof WorkbenchShellResultSchema>;

export function getWorkbenchShellAggregatedOutput(result: Pick<WorkbenchShellResult, "stderr" | "stdout">) {
  if (!result.stdout) return result.stderr;
  if (!result.stderr) return result.stdout;
  return `${result.stdout}${result.stdout.endsWith("\n") ? "" : "\n"}${result.stderr}`;
}
