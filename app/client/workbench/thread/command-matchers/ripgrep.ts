/*
 * Default export:
 * - RipgrepCommand: build shared shell/MCP presentation from canonical ripgrep arguments.
 */
import { parseRipgrepArguments } from "workbench-shared/workbench/ripgrep/ripgrep-arguments";

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

interface RipgrepCommand {
  readonly operation: "listFiles" | "search";
  readonly path: string | null;
  readonly query: string | null;
  readonly syntax: "literal" | "regex";
}

function RipgrepCommand(args: readonly string[]): RipgrepCommand | null {
  const parsed = parseRipgrepArguments(args);
  if (parsed.kind === "rejected") return null;
  const { query } = parsed;
  return {
    operation: query.mode === "files" ? "listFiles" : "search",
    path: query.paths[0] ?? null,
    query: query.patterns[0] ?? null,
    syntax: query.fixedStrings ? "literal" : "regex",
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
    if (!command) return null;
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
