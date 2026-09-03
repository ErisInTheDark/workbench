/*
 * Exports:
 * - GitArcMoveArguments/GitArcMoveMapping: describe normalized operand, explicit-map, and regex move requests. Keywords: git, arc, move, CLI, mapping.
 * - parseGitArcMoveArguments: parse the shared `wb git arc mv` argument grammar without filesystem access. Keywords: git, arc, move, parser.
 */

export interface GitArcMoveMapping {
  destination: string;
  source: string;
}

export type GitArcMoveArguments =
  | { kind: "operands"; operands: string[] }
  | { kind: "maps"; mappings: GitArcMoveMapping[] }
  | { confirm: boolean; kind: "regex"; pattern: string; replacement: string; roots: string[] };

function requireValue(args: readonly string[], index: number, flag: string) {
  const value = args[index];
  if (!value || value === "--") throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseGitArcMoveArguments(rawArgs: readonly string[]): GitArcMoveArguments {
  const args = [...rawArgs];
  if (!args.length) throw new Error("Arc mv requires source and destination operands, --map pairs, or regex options.");

  if (args.includes("--map")) {
    const mappings: GitArcMoveMapping[] = [];
    for (let index = 0; index < args.length;) {
      if (args[index] !== "--map") throw new Error("Arc mv cannot mix --map pairs with operands or regex options.");
      const source = requireValue(args, index + 1, "--map");
      const destination = requireValue(args, index + 2, "--map");
      mappings.push({ destination, source });
      index += 3;
    }
    return { kind: "maps", mappings };
  }

  const regexIndex = args.indexOf("--regex");
  const replaceIndex = args.indexOf("--replace");
  const confirmIndexes = args.flatMap((value, index) => value === "--confirm" ? [index] : []);
  if (regexIndex >= 0 || replaceIndex >= 0 || confirmIndexes.length) {
    if (regexIndex < 0 || replaceIndex < 0) throw new Error("Regex arc mv requires both --regex and --replace.");
    if (confirmIndexes.length > 1) throw new Error("--confirm may only be supplied once.");
    const separatorIndex = args.indexOf("--");
    if (separatorIndex < 0 || separatorIndex === args.length - 1) {
      throw new Error("Regex arc mv requires at least one search root after --.");
    }
    const optionArgs = args.slice(0, separatorIndex);
    const allowedIndexes = new Set([regexIndex, regexIndex + 1, replaceIndex, replaceIndex + 1, ...confirmIndexes]);
    if (optionArgs.some((_value, index) => !allowedIndexes.has(index))) {
      throw new Error("Regex arc mv only accepts --regex, --replace, and optional --confirm before --.");
    }
    return {
      confirm: confirmIndexes.length === 1,
      kind: "regex",
      pattern: requireValue(args, regexIndex + 1, "--regex"),
      replacement: requireValue(args, replaceIndex + 1, "--replace"),
      roots: args.slice(separatorIndex + 1),
    };
  }

  const operands = args[0] === "--" ? args.slice(1) : args;
  if (operands.length < 2) throw new Error("Arc mv requires at least one source and one destination.");
  if (operands.some((operand) => operand === "--" || operand.startsWith("--"))) {
    throw new Error("Arc mv operands cannot be mixed with unsupported options.");
  }
  return { kind: "operands", operands };
}
