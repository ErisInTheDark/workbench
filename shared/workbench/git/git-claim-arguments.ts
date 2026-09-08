/*
 * Keywords: git, claims, CLI, operands.
 * Exports:
 * - parseGitClaimOperands: decode CLI operation markers before path normalisation.
 * - parseGitClaimArguments: parse scope flags even when PowerShell consumes the separator.
 */
import { GitArcRejectionError } from "./git-arc-rejections";

export function parseGitClaimOperands(operands: readonly string[]) {
  const result = { addPaths: [] as string[], removePaths: [] as string[], adoptPaths: [] as string[] };
  for (const operand of operands) {
    const marker = operand[0];
    const target = marker === "-" || marker === "*" ? operand.slice(1) : operand;
    if (!target.trim()) throw new GitArcRejectionError({ reason: "emptyClaimOperand" }, "A claim operand requires a path after its operation marker.");
    if (marker === "-") result.removePaths.push(target);
    else if (marker === "*") result.adoptPaths.push(target);
    else result.addPaths.push(target);
  }
  return result;
}

export function parseGitClaimArguments(args: readonly string[], plan = false) {
  let inherit = false;
  const messages: string[] = [];
  let operands: readonly string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      operands = args.slice(index + 1);
      break;
    }
    if (arg === "--inherit") {
      if (inherit) throw new GitArcRejectionError({ reason: "duplicateInheritance" }, "--inherit was supplied twice.");
      inherit = true;
    } else if (arg === "-m" && plan) {
      const value = args[++index];
      if (!value?.trim()) throw new GitArcRejectionError({ reason: "missingArgument", argument: "-m" }, "-m requires an intent.");
      messages.push(value);
      if (messages.length > 2) throw new GitArcRejectionError({ reason: "tooManyPlanMessages" }, "A plan accepts at most two -m values.");
    } else if (arg.startsWith("--") || arg === "-m") {
      throw new GitArcRejectionError({ reason: "unknownArgument", argument: arg }, `Unknown claim option: ${arg}`);
    } else {
      operands = args.slice(index);
      break;
    }
  }
  if (!plan && !inherit) throw new GitArcRejectionError({ reason: "inheritanceRequired" }, "Active claim edits require --inherit.");
  return {
    ...parseGitClaimOperands(operands),
    inherit,
    roots: [],
    ...(messages[0] ? { intentName: messages[0] } : {}),
    ...(messages[1] ? { intentDescription: messages[1] } : {}),
  };
}
