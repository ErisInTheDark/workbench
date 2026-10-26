/*
 * Exports:
 * - McpPackageCommand: npm package, optional version and arguments of a stdio MCP server the user typed.
 * - parseMcpPackageCommand: read `package[@version] args...`, also accepting a pasted `npx -y ...`-style launcher, or explain why it can't.
 */
import { McpPackageArgsSchema, McpPackageNameSchema, McpPackageVersionSchema } from "./mcp-server-settings.ts";

export interface McpPackageCommand {
  package: string;
  version?: string;
  args: string[];
}

/** Launchers a README's install line starts with, and the flags of theirs that only skip a prompt. */
const LAUNCHERS: readonly { words: readonly string[]; flags: readonly string[] }[] = [
  { words: ["npx"], flags: ["-y", "--yes"] },
  { words: ["pnpm", "dlx"], flags: [] },
  { words: ["pnpx"], flags: [] },
  { words: ["yarn", "dlx"], flags: [] },
  { words: ["bunx"], flags: ["-y", "--yes"] },
];

/** Whitespace-separated words; single or double quotes keep spaces inside one argument. */
function words(text: string): string[] | null {
  const found: string[] = [];
  let current: string | null = null;
  let quote: string | null = null;
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "\"" || character === "'") {
      quote = character;
      current ??= "";
    } else if (/\s/u.test(character)) {
      if (current !== null) found.push(current);
      current = null;
    } else {
      current = (current ?? "") + character;
    }
  }
  if (quote) return null;
  if (current !== null) found.push(current);
  return found;
}

function withoutLauncher(input: string[]) {
  const launcher = LAUNCHERS.find(candidate => candidate.words.every((word, index) => input[index] === word));
  if (!launcher) return input;
  const rest = input.slice(launcher.words.length);
  while (rest[0] && launcher.flags.includes(rest[0])) rest.shift();
  return rest;
}

export function parseMcpPackageCommand(text: string): { command: McpPackageCommand } | { error: string } {
  const parsed = words(text);
  if (!parsed) return { error: "Close the quote." };
  const [spec, ...args] = withoutLauncher(parsed);
  if (!spec) return { error: "Type an npm package name." };
  // A scope's own `@` is never a version separator.
  const at = spec.indexOf("@", 1);
  const name = McpPackageNameSchema.safeParse(at < 0 ? spec : spec.slice(0, at));
  if (!name.success) return { error: name.error.issues[0]?.message ?? "Use an npm package name." };
  const version = at < 0 ? null : McpPackageVersionSchema.safeParse(spec.slice(at + 1));
  if (version && !version.success) return { error: version.error.issues[0]?.message ?? "Use an npm version." };
  const checkedArgs = McpPackageArgsSchema.safeParse(args);
  if (!checkedArgs.success) return { error: "Use at most 64 arguments of up to 4096 characters." };
  return { command: { package: name.data, ...version ? { version: version.data } : {}, args: checkedArgs.data } };
}
