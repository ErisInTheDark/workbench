/*
 * Exports:
 * - ThreadTestProvider/ThreadTestMode/ThreadTestSelection: explicit test-only provider modes.
 * - parseThreadTestArguments: reject absent, duplicate or unsupported selections before trusted execution.
 */
export type ThreadTestProvider = "codex" | "opencode" | "claude";
export type ThreadTestMode = "paid" | "fake";
export type ThreadTestSelection = Partial<Record<ThreadTestProvider, ThreadTestMode>>;

export function parseThreadTestArguments(args: readonly string[]): ThreadTestSelection {
  const values = args[0] === "--" ? args.slice(1) : args;
  const selected: ThreadTestSelection = {};
  if (values.length < 1 || values.length > 3) {
    throw new Error("Select providers explicitly: --codex=paid|fake --opencode=paid|fake --claude=paid|fake.");
  }
  for (const value of values) {
    const match = /^--(codex|opencode|claude)=(paid|fake)$/u.exec(value);
    if (!match) throw new Error(`Unsupported thread test selection: ${value}`);
    const provider = match[1] as ThreadTestProvider;
    if (selected[provider]) throw new Error(`Duplicate thread test provider: ${provider}`);
    selected[provider] = match[2] as ThreadTestMode;
  }
  return selected;
}
