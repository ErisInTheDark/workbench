/*
 * Exports:
 * - CommandShell: shell launcher id recognized by thread command summaries. Keywords: thread, command, shell.
 * - CommandShellGroup: shell family used for stage consumption and matcher selection. Keywords: thread, command, shell, matcher.
 * - CommandPathDisplayPart: structured path part for rendering command summaries with file pills. Keywords: thread, command, summary, path.
 * - CommandSeparatorDisplayPart: structured stage-separator part for procedural command summaries. Keywords: thread, command, summary, separator.
 * - ThreadCommandDisplayPart: structured text/path part for rendering command summaries with file pills. Keywords: thread, command, summary, path.
 * - ThreadCommandDisplay: parsed command-summary metadata for thread command rendering. Keywords: thread, command, summary, shell.
 * - CommandDisplayContext: public input for thread command display parsing. Keywords: thread, command, context.
 * - ParsedCommandDisplayContext: unwrapped command context shared by matcher helpers. Keywords: thread, command, context.
 * - CommandStage: next consumable command stage plus trailing remainder. Keywords: thread, command, stage.
 * - CommandMatcherContext: matcher input including current stage and accumulated summary parts. Keywords: thread, command, matcher, context.
 * - CommandMatcherResult: matcher output with rendered parts plus optional remaining command. Keywords: thread, command, matcher, result.
 * - CommandMatcherDefinition: shell-stage matcher definition for thread command summaries. Keywords: thread, command, matcher, definition.
 */

import type { CommandAction } from "../../codex/generated/app-server/v2/CommandAction";

export type CommandShell =
  | "bash"
  | "cmd"
  | "fish"
  | "powershell"
  | "pwsh"
  | "sh"
  | "shell"
  | "zsh"
  | null;

export type CommandShellGroup = "cmd" | "posix" | "powershell" | "unknown";

export interface CommandPathDisplayPart {
  columnNumber?: number | null;
  label?: string;
  lineNumber?: number | null;
  path: string;
  type: "path";
}

export interface CommandSeparatorDisplayPart {
  kind: "stage";
  type: "separator";
}

export interface CommandTextDisplayPart {
  clamp?: boolean;
  text: string;
  type: "text";
  variant?: "code" | "plain";
}

export type ThreadCommandDisplayPart =
  | CommandTextDisplayPart
  | CommandPathDisplayPart
  | CommandSeparatorDisplayPart;

export interface ThreadCommandDisplay {
  claimedBy: string | null;
  cwdDisplay: string | null;
  fullCommand: string;
  shell: CommandShell;
  showShell: boolean;
  summaryParts: ThreadCommandDisplayPart[];
  summaryKind: "matched" | "raw";
  summaryText: string;
  unwrappedCommand: string;
}

export interface CommandDisplayContext {
  command: string;
  commandActions: CommandAction[];
  cwd: string;
  projectRootPath?: string;
}

export interface ParsedCommandDisplayContext extends CommandDisplayContext {
  cwdDisplay: string | null;
  shell: CommandShell;
  shellGroup: CommandShellGroup;
  unwrappedCommand: string;
}

export interface CommandStage {
  remainingCommand: string | null;
  text: string;
}

export interface CommandMatcherContext extends ParsedCommandDisplayContext {
  stage: CommandStage;
  summaryParts: ThreadCommandDisplayPart[];
}

export interface CommandMatcherResult {
  remainingCommand?: string | null;
  stop?: boolean;
  summaryParts: ThreadCommandDisplayPart[];
}

export interface CommandMatcherDefinition {
  id: string;
  match: (context: CommandMatcherContext) => CommandMatcherResult | null;
}
