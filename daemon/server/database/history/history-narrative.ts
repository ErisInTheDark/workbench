/*
 * Exports:
 * - HistoryNarrativeItem: one stored item with the facts narrative classification needs.
 * - isNarrativeUserMessage: whether a user message reads as user-visible conversation, deciding each turn's first message.
 * - narrativeRecords: the user-visible records of one item under selected kinds: messages, steers, agent messages,
 *   questionnaire answers and extracted plans, with plans dropped when their parent message is already selected.
 * - retainedNarrativeRecord: best-effort record for retained text of a retention-expired item.
 * - extractPlanBlocks: collect outer `<plan>` blocks from assistant Markdown, ignoring fenced code.
 */
import type { WorkbenchUserInputRequest, WorkbenchUserInputResponse } from "workbench-shared/types";
import type { WorkbenchProjectedTranscriptItem } from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";
import { readWorkbenchAgentMessageInput, readWorkbenchAgentMessageItem, type WorkbenchAgentMessage } from "workbench-shared/workbench/thread/thread-agent-message";
import { isThreadItemVisible } from "workbench-shared/workbench/thread/thread-item-visibility";
import {
  getQuestionnairePromptText,
  getQuestionnaireTopicLabel,
  getSingleQuestionnaireSummaryLabel,
} from "workbench-shared/workbench/thread/thread-questionnaire-transcript";
import { isWorkbenchHiddenSystemSteerInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import { unwrapWorkbenchSteerDisplayInput } from "workbench-shared/workbench/thread/thread-steer-display";
import { isAgentScreenshotSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-markers";
import type { UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { HistoryNarrativeKind, HistoryRecord } from "./history-query-contract.ts";

const IMAGE_PLACEHOLDER = "<an image was sent>";

export interface HistoryNarrativeItem {
  publicId: string;
  threadId: string;
  turnId: string;
  harness: string;
  item: WorkbenchProjectedTranscriptItem;
  /** Stored delivery route of a user message; steers stay steers wherever they land. */
  inputKind: string | null;
  /** The turn's first user-visible user message opens it; every later one is a steer. */
  opensTurn: boolean;
}

export function isNarrativeUserMessage(item: WorkbenchProjectedTranscriptItem) {
  return item.type === "userMessage"
    && !isAgentScreenshotSteerUserMessage(item)
    && !isWorkbenchHiddenSystemSteerInput(item.content)
    && !readWorkbenchAgentMessageInput(item.content)
    && unwrapWorkbenchSteerDisplayInput(item.content).length > 0;
}

function renderUserInput(input: readonly UserInput[]) {
  return unwrapWorkbenchSteerDisplayInput(input).map((part) => {
    switch (part.type) {
      case "text": return part.text.trim();
      case "image":
      case "localImage": return IMAGE_PLACEHOLDER;
      case "skill": return `Skill: ${part.name} (${part.path})`;
      case "mention": return `Mention: ${part.name} (${part.path})`;
    }
  }).filter(Boolean).join("\n\n");
}

function renderAgentMessage(message: WorkbenchAgentMessage) {
  return `Agent message from ${message.senderName} (${message.senderThreadId})\n\n${message.message}`;
}

function renderQuestionnaire(request: WorkbenchUserInputRequest, response: WorkbenchUserInputResponse) {
  return request.questions.map((question, index) => {
    const answers = response.answers[question.id]?.answers.map(answer => answer.trim()).filter(Boolean) ?? [];
    if (!answers.length) return "";
    const descriptions = new Map(question.options.map(option => [option.label, option.description.trim()]));
    const prompt = getQuestionnairePromptText(request, question, index)
      || (request.questions.length === 1
        ? question.question.trim() || getSingleQuestionnaireSummaryLabel(request)
        : getQuestionnaireTopicLabel(question, index))
      || `Question ${index + 1}`;
    const rendered = answers.map((answer) => {
      const description = descriptions.get(answer);
      return description ? `**${answer}** — ${description}` : `**${answer}**`;
    }).join("; ");
    return `**Q: ${prompt}**\n\nA: ${rendered}`;
  }).filter(Boolean).join("\n\n");
}

interface CodeFence { marker: "`" | "~"; size: number }

export function extractPlanBlocks(markdown: string) {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: string[] = [];
  let fence: CodeFence | null = null;
  let start: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence) {
      if (new RegExp(`^(?: {0,3})${fence.marker}{${fence.size},}\\s*$`, "u").test(line)) fence = null;
      continue;
    }
    const opener = /^(?: {0,3})(`{3,}|~{3,})/u.exec(line)?.[1];
    if (opener) {
      fence = { marker: opener[0] as CodeFence["marker"], size: opener.length };
      continue;
    }
    if (start === null) {
      if (/^<plan>\s*$/iu.test(line.trim())) start = index;
      continue;
    }
    if (/^<\/plan>\s*$/iu.test(line.trim())) {
      blocks.push(lines.slice(start, index + 1).join("\n").trim());
      start = null;
    }
  }
  return blocks;
}

function stripOuterPlanTag(value: string) {
  const normalized = value.trim();
  return /^<plan>\s*\n?([\s\S]*?)\n?\s*<\/plan>$/iu.exec(normalized)?.[1]?.trim() ?? normalized;
}

/** The item's own record before kind selection, or null when it is not user-visible narrative. */
function primaryRecord(source: HistoryNarrativeItem): { kind: HistoryNarrativeKind; text: string } | null {
  const { item } = source;
  if (!isThreadItemVisible(source.harness, item)) return null;
  switch (item.type) {
    case "userMessage": {
      if (isAgentScreenshotSteerUserMessage(item) || isWorkbenchHiddenSystemSteerInput(item.content)) return null;
      const agentMessage = readWorkbenchAgentMessageInput(item.content);
      if (agentMessage) return { kind: "agent-message", text: renderAgentMessage(agentMessage) };
      const steer = source.inputKind === "steer" || !source.opensTurn;
      return { kind: steer ? "user-steer" : "user-message", text: renderUserInput(item.content) };
    }
    case "functionCallOutput": {
      const message = readWorkbenchAgentMessageItem(item);
      return message ? { kind: "agent-message", text: renderAgentMessage(message) } : null;
    }
    case "questionnaire":
    case "approval":
      return "request" in item ? { kind: "questionnaire", text: renderQuestionnaire(item.request, item.response) } : null;
    case "agentMessage":
      return { kind: item.phase === "final_answer" ? "final-answer" : "commentary", text: item.text };
    default:
      return null;
  }
}

export function narrativeRecords(source: HistoryNarrativeItem, kinds: ReadonlySet<HistoryNarrativeKind>): HistoryRecord[] {
  const primary = primaryRecord(source);
  if (!primary) return [];
  const base = { itemId: source.publicId, threadId: source.threadId, turnId: source.turnId, retained: false };
  const records: HistoryRecord[] = [];
  const text = primary.text.trim();
  if (text && kinds.has(primary.kind)) records.push({ ...base, kind: primary.kind, ref: source.publicId, text });
  if (source.item.type === "agentMessage" && kinds.has("plan") && !kinds.has(primary.kind)) {
    extractPlanBlocks(source.item.text).forEach((block, index) => {
      const plan = stripOuterPlanTag(block);
      if (plan) records.push({ ...base, kind: "plan", ref: `${source.publicId}:plan${index}`, text: plan });
    });
  }
  return records;
}

export function retainedNarrativeRecord(
  retained: { itemId: string; threadId: string; turnId: string | null; role: "assistant" | "user"; text: string },
  kinds: ReadonlySet<HistoryNarrativeKind>,
): HistoryRecord | null {
  const kind: HistoryNarrativeKind = retained.role === "user" ? "user-message" : "commentary";
  const text = retained.text.trim();
  if (!text || !kinds.has(kind)) return null;
  return { itemId: retained.itemId, kind, ref: retained.itemId, retained: true, text, threadId: retained.threadId, turnId: retained.turnId };
}
