/*
 * Exports:
 * - COMMAND_APPROVAL_CONFIRMATION: explicit single-command declaration.
 * - parseApprovalCommand: admit literal single-command argv or decline inference.
 * - canonicalApprovalWorkdir: normalise an absolute execution directory.
 * - matchesApprovalPrefix: compare literal argv at token boundaries.
 * - hasApprovalConfirmation: recognise the exact declaration in justification.
 */
import { posix, win32 } from "node:path";

export const COMMAND_APPROVAL_CONFIRMATION = "I confirm this command contains no additional shell code.";

export function parseApprovalCommand(command: string, wrapperDepth = 0): string[] | null {
  // This is an admission grammar, not a shell parser. Even quoted shell syntax
  // is refused so a provider's unspecified shell cannot reinterpret it.
  if (wrapperDepth > 4 || /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029;&|<>(){}$`%!*?#\[\]^,@~“”‘’]/u.test(command)) return null;
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "\\") {
      const next = command[index + 1] ?? "";
      if (/[\s"']/u.test(next)) return null;
      // Codex renders native Windows launcher paths with doubled separators.
      // Keep them literal, and never extend this allowance to command arguments.
      if (next === "\\" && !(quote && tokens.length === 0 && /^[A-Za-z]:(?:[\\/]|$)/u.test(token))) return null;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
        if (index + 1 < command.length && !/[ \t]/u.test(command[index + 1]!)) return null;
      }
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      // Reject concatenated quoting: its meaning differs across shell families.
      if (started && token) return null;
      quote = char;
      started = true;
    } else if (char === " " || char === "\t") {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) tokens.push(token);
  if (!tokens.length || !tokens[0] || tokens.some(value => value === "--%")) return null;
  if (/^[A-Za-z_][A-Za-z_0-9]*=/u.test(tokens[0])) return null;
  const executable = tokens[0].replaceAll("\\", "/").split("/").at(-1)!.replace(/\.(exe|cmd|bat|ps1)$/iu, "").toLowerCase();
  if (["bash", "sh", "zsh", "fish"].includes(executable)) {
    return tokens.length === 3 && ["-c", "-lc"].includes(tokens[1]!) ? parseApprovalCommand(tokens[2]!, wrapperDepth + 1) : null;
  }
  if (["pwsh", "powershell"].includes(executable)) {
    const commandIndex = tokens.findIndex(value => value.toLowerCase() === "-command");
    if (commandIndex < 1 || commandIndex !== tokens.length - 2) return null;
    if (!tokens.slice(1, commandIndex).every(value => ["-noprofile", "-noninteractive", "-nologo"].includes(value.toLowerCase()))) return null;
    return parseApprovalCommand(tokens[commandIndex + 1]!, wrapperDepth + 1);
  }
  if (["cmd", "env", "eval", "sudo"].includes(executable)) return null;
  return tokens;
}

export function canonicalApprovalWorkdir(cwd: string): string | null {
  if (!cwd || /[\0\r\n]/u.test(cwd)) return null;
  if (/^[A-Za-z]:[\\/]/u.test(cwd) || cwd.startsWith("\\\\") || cwd.startsWith("//")) {
    const normal = win32.normalize(cwd).replaceAll("\\", "/").toLowerCase();
    return /^[a-z]:\/$/u.test(normal) ? normal : normal.replace(/\/+$/u, "");
  }
  return posix.isAbsolute(cwd) ? posix.normalize(cwd).replace(/\/+$/u, "") || "/" : null;
}

export function matchesApprovalPrefix(argv: readonly string[], prefix: readonly string[]) {
  return prefix.length > 0 && prefix.length <= argv.length && prefix.every((token, index) => token === argv[index]);
}

export function hasApprovalConfirmation(reason: string | null | undefined) {
  return (reason ?? "").split(/\r?\n/).some(line => line.trim() === COMMAND_APPROVAL_CONFIRMATION);
}
