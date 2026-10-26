/*
 * Exports:
 * - WorkbenchShellPartialOutput: what a shell printed before the failure or stop that ended it.
 * - withWorkbenchShellPartialOutput: carry that output on the error that ended the shell, keeping the error's identity.
 * - readWorkbenchShellPartialOutput: the output an error carries, recognised across module generations.
 */
export interface WorkbenchShellPartialOutput {
  stdout: string;
  stderr: string;
}

const PARTIAL_OUTPUT_KEY = Symbol.for("workbench.shellPartialOutput.v1");

export function withWorkbenchShellPartialOutput(error: unknown, output: WorkbenchShellPartialOutput): unknown {
  if (!(error instanceof Error) || (!output.stdout && !output.stderr)) return error;
  Reflect.set(error, PARTIAL_OUTPUT_KEY, { stdout: output.stdout, stderr: output.stderr });
  return error;
}

export function readWorkbenchShellPartialOutput(error: unknown): WorkbenchShellPartialOutput | null {
  if (!(error instanceof Error)) return null;
  const output: unknown = Reflect.get(error, PARTIAL_OUTPUT_KEY);
  if (!output || typeof output !== "object") return null;
  const { stdout, stderr } = output as Record<string, unknown>;
  return typeof stdout === "string" && typeof stderr === "string" ? { stdout, stderr } : null;
}
