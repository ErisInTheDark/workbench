/*
 * Exports:
 * - consumeNextCommandStage: consume the next shell-aware command stage and its trailing remainder. Keywords: thread, command, shell, stage.
 * - getCommandShellGroup: map shell launchers to matcher families. Keywords: thread, command, shell, matcher.
 * - unwrapShellCommand: unwrap shell launchers like powershell, bash, and cmd. Keywords: thread, command, shell, unwrap.
 */

import type {
  CommandShell,
  CommandShellGroup,
  CommandStage,
} from "./types";

const SHELL_WRAPPERS = [
  {
    pattern: /^(?:"([^"]*(?:powershell|pwsh)(?:\.exe)?)"|([^\s"]*(?:powershell|pwsh)(?:\.exe)?))\s+-(?:Command|c)\s+([\s\S]+)$/i,
    shell: (launcher: string) => /pwsh/i.test(launcher) ? "pwsh" : "powershell" as CommandShell,
  },
  {
    pattern: /^(?:"([^"]*(?:bash|zsh|sh|fish)(?:\.exe)?)"|([^\s"]*(?:bash|zsh|sh|fish)(?:\.exe)?))\s+-(?:lc|c)\s+([\s\S]+)$/i,
    shell: (launcher: string) => {
      const match = launcher.match(/(bash|zsh|sh|fish)(?:\.exe)?$/i);
      return (match?.[1]?.toLowerCase() ?? "shell") as CommandShell;
    },
  },
  {
    pattern: /^(?:"([^"]*cmd(?:\.exe)?)"|([^\s"]*cmd(?:\.exe)?))\s+\/[cCrR]\s+([\s\S]+)$/i,
    shell: () => "cmd" as CommandShell,
  },
];

export function unwrapShellCommand(command: string) {
  let currentCommand = String(command ?? "").trim();
  let shell: CommandShell = null;

  for (let index = 0; index < 4; index += 1) {
    const shellMatch = unwrapShellCommandOnce(currentCommand);
    if (!shellMatch) {
      break;
    }

    shell ??= shellMatch.shell;
    currentCommand = shellMatch.command;
  }

  return {
    command: normalizeShellCommandText(currentCommand),
    shell,
  };
}

export function getCommandShellGroup(shell: CommandShell): CommandShellGroup {
  switch (shell) {
    case "powershell":
    case "pwsh":
      return "powershell";
    case "cmd":
      return "cmd";
    case "bash":
    case "fish":
    case "sh":
    case "shell":
    case "zsh":
      return "posix";
    default:
      return "unknown";
  }
}

export function consumeNextCommandStage(command: string, shellGroup: CommandShellGroup): CommandStage | null {
  const normalizedCommand = stripLeadingJoiners(String(command ?? ""));
  if (!normalizedCommand) {
    return null;
  }

  switch (shellGroup) {
    case "powershell":
      return consumePowerShellStage(normalizedCommand);
    case "cmd":
      return consumeCmdStage(normalizedCommand);
    case "posix":
      return consumePosixStage(normalizedCommand);
    default:
      return consumeGenericStage(normalizedCommand);
  }
}

function unwrapShellCommandOnce(command: string) {
  const stdinWrapperMatch = unwrapPowerShellStdinShellCommandOnce(command);
  if (stdinWrapperMatch) {
    return stdinWrapperMatch;
  }

  for (const wrapper of SHELL_WRAPPERS) {
    const match = command.match(wrapper.pattern);
    if (!match) {
      continue;
    }

    const launcher = firstDefined(match[1], match[2]) ?? "";
    const innerCommand = normalizeShellCommandText(match[3] ?? "");
    if (!innerCommand.trim()) {
      continue;
    }

    return {
      command: innerCommand,
      shell: wrapper.shell(launcher),
    };
  }

  return null;
}

function unwrapPowerShellStdinShellCommandOnce(command: string) {
  const trimmedCommand = String(command ?? "").trim();
  const wrapperMatch = trimmedCommand.match(
    /^([\s\S]+)\|\s*(?:"([^"]*(?:powershell|pwsh)(?:\.exe)?)"|([^\s"]*(?:powershell|pwsh)(?:\.exe)?))\s+[\s\S]*?-(?:Command|c)\s+-\s*$/i,
  );
  if (!wrapperMatch) {
    return null;
  }

  const launcher = firstDefined(wrapperMatch[2], wrapperMatch[3]) ?? "";
  const innerCommand = unwrapPowerShellPipelineLiteralInput(wrapperMatch[1] ?? "");
  if (!innerCommand.trim()) {
    return null;
  }

  return {
    command: innerCommand,
    shell: /pwsh/i.test(launcher) ? "pwsh" : "powershell" as CommandShell,
  };
}

function consumePowerShellStage(command: string) {
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const nextCharacter = command[index + 1] ?? "";

    if (inSingleQuote) {
      if (character === "'" && nextCharacter === "'") {
        index += 1;
        continue;
      }

      if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (character === "`") {
        index += 1;
        continue;
      }

      if (character === "\"") {
        inDoubleQuote = false;
      }
      continue;
    }

    if (character === "'") {
      inSingleQuote = true;
      continue;
    }

    if (character === "\"") {
      inDoubleQuote = true;
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
      continue;
    }

    if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }

    if (character === "[") {
      bracketDepth += 1;
      continue;
    }

    if (character === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }

    if (character === "(") {
      parenthesisDepth += 1;
      continue;
    }

    if (character === ")" && parenthesisDepth > 0) {
      parenthesisDepth -= 1;
      continue;
    }

    if (braceDepth || bracketDepth || parenthesisDepth) {
      continue;
    }

    if (character === "|" || character === ";") {
      return finalizeCommandStage(command, index, 1);
    }
  }

  return finalizeCommandStage(command, command.length, 0);
}

function consumePosixStage(command: string) {
  let escapeNext = false;
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const nextCharacter = command[index + 1] ?? "";

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (inSingleQuote) {
      if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (character === "\\") {
        escapeNext = true;
        continue;
      }

      if (character === "\"") {
        inDoubleQuote = false;
      }
      continue;
    }

    if (character === "\\") {
      escapeNext = true;
      continue;
    }

    if (character === "'") {
      inSingleQuote = true;
      continue;
    }

    if (character === "\"") {
      inDoubleQuote = true;
      continue;
    }

    if (character === "|" || character === ";") {
      return finalizeCommandStage(command, index, 1);
    }

    if ((character === "&" || character === "|") && nextCharacter === character) {
      return finalizeCommandStage(command, index, 2);
    }
  }

  return finalizeCommandStage(command, command.length, 0);
}

function consumeCmdStage(command: string) {
  let escapeNext = false;
  let inDoubleQuote = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const nextCharacter = command[index + 1] ?? "";

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (character === "^") {
      escapeNext = true;
      continue;
    }

    if (character === "\"") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (inDoubleQuote) {
      continue;
    }

    if (character === "|" || character === ";") {
      return finalizeCommandStage(command, index, 1);
    }

    if ((character === "&" || character === "|") && nextCharacter === character) {
      return finalizeCommandStage(command, index, 2);
    }
  }

  return finalizeCommandStage(command, command.length, 0);
}

function consumeGenericStage(command: string) {
  return consumePosixStage(command);
}

function finalizeCommandStage(command: string, splitIndex: number, separatorLength: number) {
  const text = command.slice(0, splitIndex).trim();
  if (!text) {
    return null;
  }

  const remainingCommand = separatorLength
    ? stripLeadingJoiners(command.slice(splitIndex + separatorLength))
    : null;

  return {
    remainingCommand: remainingCommand || null,
    text,
  } satisfies CommandStage;
}

function stripLeadingJoiners(command: string) {
  let remainingCommand = String(command ?? "");
  let changed = true;

  while (changed) {
    changed = false;
    remainingCommand = remainingCommand.trimStart();

    for (const joiner of ["&&", "||", "|", ";"]) {
      if (!remainingCommand.startsWith(joiner)) {
        continue;
      }

      remainingCommand = remainingCommand.slice(joiner.length);
      changed = true;
      break;
    }
  }

  return remainingCommand.trim();
}

function firstDefined<T>(...values: Array<T | null | undefined>) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return null;
}

function stripOuterQuotes(value: string) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function normalizeShellCommandText(value: string) {
  const trimmedValue = String(value ?? "").trim();
  const unwrappedValue = stripOuterQuotes(trimmedValue);
  if (unwrappedValue !== trimmedValue) {
    return unwrappedValue.trim();
  }

  if (trimmedValue.startsWith("\"") || trimmedValue.startsWith("'")) {
    return trimmedValue.slice(1).trimStart();
  }

  return trimmedValue;
}

function normalizeNestedShellCommandText(value: string) {
  let currentValue = String(value ?? "").trim();

  for (let index = 0; index < 4; index += 1) {
    const hereStringValue = unwrapPowerShellHereStringText(currentValue);
    if (hereStringValue !== null) {
      currentValue = hereStringValue.trim();
      continue;
    }

    if (!hasRecoverableLiteralWrapping(currentValue)) {
      break;
    }

    const nextValue = normalizeShellCommandText(currentValue);
    if (nextValue === currentValue) {
      break;
    }
    currentValue = nextValue;
  }

  return currentValue;
}

function unwrapPowerShellPipelineLiteralInput(value: string) {
  const trimmedValue = String(value ?? "").trim();
  if (!hasRecoverableLiteralWrapping(trimmedValue)) {
    return "";
  }

  return normalizeNestedShellCommandText(trimmedValue);
}

function hasRecoverableLiteralWrapping(value: string) {
  const trimmedValue = String(value ?? "").trim();
  return trimmedValue.startsWith("@'")
    || trimmedValue.startsWith("@\"")
    || (trimmedValue.startsWith("\"") && trimmedValue.endsWith("\""))
    || (trimmedValue.startsWith("'") && trimmedValue.endsWith("'"));
}

function unwrapPowerShellHereStringText(value: string) {
  const trimmedValue = String(value ?? "").trim();
  if (!(trimmedValue.startsWith("@'") || trimmedValue.startsWith("@\""))) {
    return null;
  }

  const quoteCharacter = trimmedValue[1];
  const terminator = `${quoteCharacter}@`;
  const terminatorIndex = trimmedValue.lastIndexOf(terminator);
  if (terminatorIndex <= 1) {
    return null;
  }

  let bodyStartIndex = 2;
  if (trimmedValue[bodyStartIndex] === "\r" && trimmedValue[bodyStartIndex + 1] === "\n") {
    bodyStartIndex += 2;
  } else if (trimmedValue[bodyStartIndex] === "\n") {
    bodyStartIndex += 1;
  }

  return trimmedValue.slice(bodyStartIndex, terminatorIndex);
}
