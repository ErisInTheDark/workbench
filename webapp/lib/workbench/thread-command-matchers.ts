/*
 * Exports:
 * - CommandMatcher: builder namespace for command-summary matchers, results, and summary parts. Keywords: thread, command, matcher, builder.
 * - ThreadCommandDisplayPart: structured text/path part for rendering command summaries with file pills. Keywords: thread, command, summary, path.
 * - ThreadCommandDisplay: parsed command-summary metadata for thread command rendering. Keywords: thread, command, summary, shell.
 * - formatThreadCommandPath: resolve command paths into project-relative forward-slash display text. Keywords: path, command, relative, display.
 * - getThreadCommandDisplay: unwrap shell launchers and describe common command patterns with staged shell matchers. Keywords: thread, command, matcher, shell.
 */

import { CMD_COMMAND_MATCHERS } from "./thread-command-matchers/cmd";
import { CommandMatcher, runThreadCommandMatchers } from "./thread-command-matchers/core";
import {
  buildCommandPathPart,
  buildDisplayPathPart,
  formatThreadCommandPath,
  summarizeDisplayParts,
} from "./thread-command-matchers/helpers";
import { POSIX_COMMAND_MATCHERS } from "./thread-command-matchers/posix";
import { POWERSHELL_COMMAND_MATCHERS } from "./thread-command-matchers/powershell";
import {
  getCommandShellGroup,
  unwrapShellCommand,
} from "./thread-command-matchers/shells";
import { COMMON_COMMAND_MATCHERS } from "./thread-command-matchers/shared";
import type {
  CommandDisplayContext,
  ParsedCommandDisplayContext,
  ThreadCommandDisplay,
  ThreadCommandDisplayPart,
} from "./thread-command-matchers/types";

export { CommandMatcher, formatThreadCommandPath };
export type { ThreadCommandDisplay, ThreadCommandDisplayPart };

export function getThreadCommandDisplay({
  command,
  commandActions,
  cwd,
  projectRootPath,
}: CommandDisplayContext): ThreadCommandDisplay {
  const shellResult = unwrapShellCommand(command);
  const context: ParsedCommandDisplayContext = {
    command,
    commandActions,
    cwd,
    cwdDisplay: formatThreadCommandPath(cwd, { projectRootPath }),
    projectRootPath,
    shell: shellResult.shell,
    shellGroup: getCommandShellGroup(shellResult.shell),
    unwrappedCommand: shellResult.command,
  };
  const matchedDisplay = runThreadCommandMatchers(context, {
    commonMatchers: COMMON_COMMAND_MATCHERS,
    shellMatchers: getShellCommandMatchers(context.shellGroup),
  });

  if (matchedDisplay) {
    return {
      ...matchedDisplay,
      cwdDisplay: context.cwdDisplay,
      fullCommand: command,
      shell: context.shell,
      unwrappedCommand: context.unwrappedCommand,
    };
  }

  const actionSummaryParts = summarizeCommandActions(context);
  if (actionSummaryParts) {
    return {
      claimedBy: "command-action",
      cwdDisplay: context.cwdDisplay,
      fullCommand: command,
      shell: context.shell,
      showShell: false,
      summaryParts: actionSummaryParts,
      summaryKind: "matched",
      summaryText: summarizeDisplayParts(actionSummaryParts),
      unwrappedCommand: context.unwrappedCommand,
    };
  }

  const rawSummaryText = context.unwrappedCommand.replace(/\s+/g, " ").trim();
  return {
    claimedBy: null,
    cwdDisplay: context.cwdDisplay,
    fullCommand: command,
    shell: context.shell,
    showShell: Boolean(context.shell),
    summaryParts: [CommandMatcher.Code(rawSummaryText, { clamp: true })],
    summaryKind: "raw",
    summaryText: rawSummaryText,
    unwrappedCommand: context.unwrappedCommand,
  };
}

function getShellCommandMatchers(shellGroup: ParsedCommandDisplayContext["shellGroup"]) {
  switch (shellGroup) {
    case "powershell":
      return POWERSHELL_COMMAND_MATCHERS;
    case "cmd":
      return CMD_COMMAND_MATCHERS;
    case "posix":
      return POSIX_COMMAND_MATCHERS;
    default:
      return [];
  }
}

function summarizeCommandActions(context: ParsedCommandDisplayContext) {
  const supportedAction = context.commandActions.find((action) => action.type !== "unknown");
  if (!supportedAction) {
    return null;
  }

  switch (supportedAction.type) {
    case "read": {
      const pathPart = buildCommandPathPart(supportedAction.path, context);
      return pathPart
        ? [
          CommandMatcher.Text("Read "),
          pathPart,
        ]
        : [CommandMatcher.Text("Read file")];
    }
    case "listFiles": {
      const pathPart = supportedAction.path
        ? buildCommandPathPart(supportedAction.path, context)
        : buildDisplayPathPart(context.cwdDisplay);
      return pathPart
        ? [
          CommandMatcher.Text("List files under "),
          pathPart,
        ]
        : [CommandMatcher.Text("List files")];
    }
    case "search": {
      const queryText = supportedAction.query ? `"${supportedAction.query}"` : "\"text\"";
      const pathPart = supportedAction.path
        ? buildCommandPathPart(supportedAction.path, context)
        : null;
      return pathPart
        ? [
          CommandMatcher.Text("Search for "),
          CommandMatcher.Code(queryText),
          CommandMatcher.Text(" in "),
          pathPart,
        ]
        : [
          CommandMatcher.Text("Search for "),
          CommandMatcher.Code(queryText),
        ];
    }
    default:
      return null;
  }
}
