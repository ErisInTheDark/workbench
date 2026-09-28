/*
 * Exports:
 * - ThreadTestProvider: supported thread scenario providers.
 * - parseThreadTestArguments: require one provider and explicit paid mode before trusted execution.
 */
export type ThreadTestProvider = "codex" | "opencode";

export function parseThreadTestArguments(args: readonly string[]): ThreadTestProvider {
  const values = args[0] === "--" ? args.slice(1) : args;
  if (values.length !== 2 || !values.includes("--paid")) {
    throw new Error("Run exactly one provider with explicit paid mode: pnpm test:thread --codex --paid or pnpm test:thread --opencode --paid.");
  }
  const provider = values.find(value => value !== "--paid");
  if (provider !== "--codex" && provider !== "--opencode") {
    throw new Error("The paid thread scenario requires exactly one supported provider.");
  }
  return provider.slice(2) as ThreadTestProvider;
}
