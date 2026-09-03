/*
 * Exports:
 * - ThreadGitArcProposalTranscriptItem: associate one rendered proposal command with its receipt and editable message intent. Keywords: thread, git, arc, proposal, transcript.
 * - readThreadGitArcProposalTranscriptItem/readThreadGitArcMcpProposalTranscriptItem: read CLI or MCP proposal identity and editable message intent. Keywords: thread, command, MCP, proposal, intent.
 * - proposalIntentOwnsMessage: identify proposal intent that provides an explicit editable message. Keywords: proposal, intent, message, inheritance.
 * - default getThreadGitArcProposalIntents: index proposal message intents from the currently loaded transcript turns. Keywords: thread, git, arc, proposal, visible, intent.
 */

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { ThreadPayload, WorkbenchSkillSummary } from "workbench-shared/types";
import type { GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import {
  getGitArcMatcherAction,
  getWorkbenchMcpCommandRoute,
  getThreadCommandDisplay,
  parseGitArcReceipt,
  parseGitCheckpointCommitCommand,
  parseGitCheckpointProposalId,
  type GitCheckpointCommitCommandIntent,
  type ThreadCommandDisplay,
} from "../../../workbench/thread/thread-command-matchers";
import { formatToolCallOutput } from "./format-thread-tool-call";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;
type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

export interface ThreadGitArcProposalTranscriptItem {
  intent: GitCheckpointCommitCommandIntent | null;
  proposalId: string | null;
  receipt: GitArcReceipt | null;
}

export function proposalIntentOwnsMessage(intent: GitCheckpointCommitCommandIntent | null) {
  return Boolean(intent?.title.trim());
}

function readProposalIntent(item: CommandItem, commandDisplay: ThreadCommandDisplay) {
  const commands = [commandDisplay.unwrappedCommand, ...item.commandActions.map(({ command }) => command)];
  for (const command of commands) {
    const intent = parseGitCheckpointCommitCommand(command);
    if (intent) return intent;
  }
  return null;
}

export function readThreadGitArcProposalTranscriptItem(
  item: CommandItem,
  commandDisplay: ThreadCommandDisplay,
): ThreadGitArcProposalTranscriptItem | null {
  if (getGitArcMatcherAction(commandDisplay.claimedBy) !== "propose") return null;
  const receipt = parseGitArcReceipt(item.aggregatedOutput ?? "");
  return {
    intent: readProposalIntent(item, commandDisplay),
    proposalId: parseGitCheckpointProposalId(item.aggregatedOutput ?? "") ?? receipt?.proposalId ?? null,
    receipt,
  };
}

export function readThreadGitArcMcpProposalTranscriptItem(
  item: McpToolCallItem,
): ThreadGitArcProposalTranscriptItem | null {
  const route = getWorkbenchMcpCommandRoute({
    argumentsValue: item.arguments,
    server: item.server,
    tool: item.tool,
  });
  if (route?.kind !== "specialized" || route.operation.kind !== "gitArc" || route.operation.operation.action !== "propose") {
    return null;
  }
  const output = item.error?.message || formatToolCallOutput({
    content: item.result?.content,
    fallback: item.result?.structuredContent ?? item.result?._meta,
  }) || "";
  const receipt = parseGitArcReceipt(output);
  return {
    intent: route.operation.operation.proposalIntent ?? null,
    proposalId: parseGitCheckpointProposalId(output) ?? receipt?.proposalId ?? null,
    receipt,
  };
}

export default function getThreadGitArcProposalIntents({
  knownSkills,
  projectRootPath,
  turns,
  workspaceRoots,
}: {
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  turns: ThreadPayload["turns"];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const intents = new Map<string, GitCheckpointCommitCommandIntent>();
  for (const turn of turns) {
    for (const item of turn.items) {
      const proposal = item.type === "commandExecution"
        ? readThreadGitArcProposalTranscriptItem(item, getThreadCommandDisplay({
          command: item.command,
          commandActions: item.commandActions,
          cwd: item.cwd,
          knownSkills,
          projectRootPath,
          workspaceRoots,
        }))
        : item.type === "mcpToolCall" ? readThreadGitArcMcpProposalTranscriptItem(item) : null;
      if (proposal?.proposalId && proposal.intent) intents.set(proposal.proposalId, proposal.intent);
    }
  }
  return intents;
}
