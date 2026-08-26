/*
 * Default export:
 * - RipgrepCommand: parse native ripgrep arguments and build the shared shell/MCP presentation. Keywords: ripgrep, search, files, arguments, rendering.
 */
import { CommandMatcher } from "./core";
import {
  buildCommandPathPart,
  buildDisplayPathPart,
  formatThreadCommandPath,
} from "./helpers";
import type {
  CommandMatcherResult,
  ParsedCommandDisplayContext,
  ThreadCommandDisplayPart,
} from "./types";

const VALUE_FLAGS = new Set([
  "-A", "--after-context",
  "-B", "--before-context",
  "-C", "--context",
  "-e", "--regexp",
  "-f", "--file",
  "-g", "--glob", "--iglob",
  "-j", "--threads",
  "-M", "--max-columns",
  "-m", "--max-count",
  "--max-depth", "--max-filesize", "--path-separator",
  "--pre", "--pre-glob", "--replace", "--sort", "--sortr",
  "-t", "--type",
  "-T", "--type-not",
]);

interface RipgrepCommand {
  readonly operation: "listFiles" | "search";
  readonly path: string | null;
  readonly query: string | null;
  readonly syntax: "literal" | "regex";
}

function matchValueFlag(argument: string) {
  for (const flag of VALUE_FLAGS) {
    if (argument === flag) return { flag, value: null };
    if (flag.startsWith("--") && argument.startsWith(`${flag}=`)) {
      return { flag, value: argument.slice(flag.length + 1) };
    }
    if (flag.length === 2 && argument.startsWith(flag) && argument.length > flag.length) {
      return { flag, value: argument.slice(flag.length) };
    }
  }
  return null;
}

function RipgrepCommand(args: readonly string[]): RipgrepCommand {
  const positional: string[] = [];
  let explicitQuery: string | null = null;
  let fixedStrings = false;
  let searchesFiles = false;
  let afterTerminator = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (afterTerminator) {
      positional.push(argument);
      continue;
    }
    if (argument === "--") {
      afterTerminator = true;
      continue;
    }
    if (argument === "-F" || argument === "--fixed-strings") {
      fixedStrings = true;
      continue;
    }
    if (argument === "--files") {
      searchesFiles = true;
      continue;
    }
    const valueFlag = matchValueFlag(argument);
    if (valueFlag) {
      const value = valueFlag.value ?? args[index + 1] ?? null;
      if (valueFlag.value === null && index + 1 < args.length) index += 1;
      if ((valueFlag.flag === "-e" || valueFlag.flag === "--regexp") && explicitQuery === null) {
        explicitQuery = value;
      }
      continue;
    }
    if (argument.startsWith("-")) continue;
    positional.push(argument);
  }
  return {
    operation: searchesFiles ? "listFiles" : "search",
    path: searchesFiles
      ? positional[0] ?? null
      : explicitQuery
        ? positional[0] ?? null
        : positional[1] ?? null,
    query: searchesFiles ? null : explicitQuery ?? positional[0] ?? null,
    syntax: fixedStrings ? "literal" : "regex",
  };
}

namespace RipgrepCommand {
  export interface PresentationContext {
    readonly cwd?: string;
    readonly cwdDisplay?: string | null;
    readonly projectRootPath?: string;
    readonly workspaceRoots?: ParsedCommandDisplayContext["workspaceRoots"];
  }

  export function presentationResult(
    args: readonly string[],
    context: PresentationContext = {},
  ): CommandMatcherResult | null {
    const command = RipgrepCommand(args);
    const pathPart = command.path
      ? context.cwd
        ? buildCommandPathPart(command.path, {
          cwd: context.cwd,
          projectRootPath: context.projectRootPath,
          workspaceRoots: context.workspaceRoots,
        })
        : buildDisplayPathPart(command.path)
      : buildDisplayPathPart(context.cwdDisplay ?? formatThreadCommandPath(context.cwd, context));

    if (command.operation === "listFiles") {
      const summaryParts: ThreadCommandDisplayPart[] = [CommandMatcher.Text("Listed files")];
      const ongoingSummaryParts: ThreadCommandDisplayPart[] = [CommandMatcher.Text("Listing files")];
      if (pathPart) {
        summaryParts.push(CommandMatcher.Text(" in "), pathPart);
        ongoingSummaryParts.push(CommandMatcher.Text(" in "), pathPart);
      }
      return CommandMatcher.Result({
        ongoingSummaryParts,
        summaryParts,
        summaryStats: { searchedFiles: 1 },
      });
    }

    if (!command.query) return null;

    const query = command.query;
    const summaryParts = [CommandMatcher.Text("Search for "), CommandMatcher.Pattern(query, command.syntax)];
    const ongoingSummaryParts = [CommandMatcher.Text("Searching for "), CommandMatcher.Pattern(query, command.syntax)];
    if (pathPart) {
      summaryParts.push(CommandMatcher.Text(" in "), pathPart);
      ongoingSummaryParts.push(CommandMatcher.Text(" in "), pathPart);
    }

    return CommandMatcher.Result({
      ongoingSummaryParts,
      summaryParts,
      summaryStats: { searchedFiles: 1 },
    });
  }
}

export default RipgrepCommand;
