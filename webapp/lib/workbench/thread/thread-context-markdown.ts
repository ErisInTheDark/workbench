/*
 * Exports:
 * - renderUserInputMarkdown: convert UserInput records into reorientation-safe Markdown with image placeholders. Keywords: user input, image placeholder, markdown.
 * - renderWorkbenchThreadContextPieceMarkdown: render one chronological context piece without page chrome. Keywords: thread context, piece, markdown.
 * - getWorkbenchThreadContextPieceRef: derive one stable stateless ref for a projected context piece. Keywords: thread context, ref, pagination.
 * - renderWorkbenchThreadRecallHistoryMarkdown: render a bounded newest-anchored or historical Thread Recall page. Keywords: thread recall, history, pagination, markdown.
 */

import type { UserInput } from "../../codex/generated/app-server/v2/UserInput";
import { WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS } from "../../types.ts";
import {
  getQuestionnairePromptText,
  getQuestionnaireTopicLabel,
  getSingleQuestionnaireSummaryLabel,
} from "./thread-questionnaire-transcript.ts";
import type { WorkbenchThreadContextPiece } from "./thread-context-projection.ts";

const IMAGE_PLACEHOLDER = "<an image was sent>";
const NEWEST_PLAN_PREVIEW_CHARACTERS = 10_000;
const OLDER_PLAN_PREVIEW_CHARACTERS = 2_000;

interface ThreadRecallHistoryEntry {
  expansionRef: string;
  kindLabel: string;
  markdown: string;
  originalCharacters: number;
  ref: string;
}

function normalizeMarkdownPart(value: string) {
  return value.trim();
}

export function renderUserInputMarkdown(input: readonly UserInput[]) {
  const parts = input.map((item) => {
    switch (item.type) {
      case "text":
        return normalizeMarkdownPart(item.text) || "";
      case "image":
      case "localImage":
        return IMAGE_PLACEHOLDER;
      case "skill":
        return `Skill: ${item.name} (${item.path})`;
      case "mention":
        return `Mention: ${item.name} (${item.path})`;
    }
  }).filter(Boolean);

  return parts.length ? parts.join("\n\n") : "No user content captured.";
}

function renderQuestionnaireMarkdown(piece: Extract<WorkbenchThreadContextPiece, { kind: "questionnaire" }>) {
  const parts = piece.entry.request.questions.map((question, index) => {
    const answerLabels = piece.entry.response.answers[question.id]?.answers
      .map((answer) => answer.trim())
      .filter(Boolean) ?? [];
    if (!answerLabels.length) {
      return "";
    }

    const optionDescriptionsByLabel = new Map(question.options.map((option) => [option.label, option.description.trim()]));
    const prompt = getQuestionnairePromptText(piece.entry.request, question, index)
      || (piece.entry.request.questions.length === 1
        ? question.question.trim() || getSingleQuestionnaireSummaryLabel(piece.entry.request)
        : getQuestionnaireTopicLabel(question, index))
      || `Question ${index + 1}`;
    const answers = answerLabels.map((answer) => {
      const description = optionDescriptionsByLabel.get(answer);
      const answerLabel = `**${answer}**`;
      return description ? `${answerLabel} — ${description}` : answerLabel;
    }).join("; ");
    return `## Q: ${prompt}\nA: ${answers}`;
  }).filter(Boolean);

  return parts.join("\n\n");
}

export function renderWorkbenchThreadContextPieceMarkdown(piece: WorkbenchThreadContextPiece) {
  switch (piece.kind) {
    case "userMessage":
      return `## User Message\n\n${renderUserInputMarkdown(piece.input)}`;
    case "userSteer":
      return `## User Steer\n\n${renderUserInputMarkdown(piece.input)}`;
    case "questionnaire":
      return renderQuestionnaireMarkdown(piece);
    case "planBlock":
      return piece.planMarkdown;
  }
}

export function getWorkbenchThreadContextPieceRef(piece: WorkbenchThreadContextPiece) {
  switch (piece.kind) {
    case "userMessage":
      return `user:${piece.itemId}`;
    case "userSteer":
      return `steer:${piece.entry.entryKey}`;
    case "questionnaire":
      return `questionnaire:${piece.entry.requestKey}`;
    case "planBlock":
      return `plan-block:${piece.itemId}:${piece.blockIndex}`;
  }
}

function getContextPieceKindLabel(piece: WorkbenchThreadContextPiece) {
  switch (piece.kind) {
    case "userMessage":
      return "user message";
    case "userSteer":
      return "user steer";
    case "questionnaire":
      return "questionnaire response";
    case "planBlock":
      return "plan";
  }
}

function createTextFence(value: string) {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length));
  return "`".repeat(Math.max(4, longestRun + 1));
}

function renderPlanPreview({
  markdown,
  previewCharacters,
  ref,
  threadId,
}: {
  markdown: string;
  previewCharacters: number;
  ref: string;
  threadId: string;
}) {
  const preview = markdown.slice(0, previewCharacters);
  const fence = createTextFence(preview);
  return [
    "## Plan Preview",
    "",
    `Ref: \`${ref}\``,
    `Showing the first ${preview.length.toLocaleString("en-US")} of ${markdown.length.toLocaleString("en-US")} characters.`,
    "",
    `${fence}text`,
    preview,
    fence,
    "",
    `[${(markdown.length - preview.length).toLocaleString("en-US")} plan characters omitted.]`,
    `Expand: \`wb thread recall expand --thread ${threadId} --ref ${ref}\``,
  ].join("\n");
}

function createHistoryEntry(
  piece: WorkbenchThreadContextPiece,
  {
    isNewestPlan,
    threadId,
  }: {
    isNewestPlan: boolean;
    threadId: string;
  },
): ThreadRecallHistoryEntry | null {
  const fullMarkdown = renderWorkbenchThreadContextPieceMarkdown(piece).trim();
  if (!fullMarkdown) {
    return null;
  }

  const ref = getWorkbenchThreadContextPieceRef(piece);
  const planPreviewCharacters = isNewestPlan
    ? NEWEST_PLAN_PREVIEW_CHARACTERS
    : OLDER_PLAN_PREVIEW_CHARACTERS;
  const markdown = piece.kind === "planBlock" && fullMarkdown.length > planPreviewCharacters
    ? renderPlanPreview({ markdown: fullMarkdown, previewCharacters: planPreviewCharacters, ref, threadId })
    : fullMarkdown;

  return {
    expansionRef: ref,
    kindLabel: getContextPieceKindLabel(piece),
    markdown,
    originalCharacters: fullMarkdown.length,
    ref,
  };
}

function renderOversizedHistoryEntry(entry: ThreadRecallHistoryEntry, threadId: string): ThreadRecallHistoryEntry {
  return {
    ...entry,
    markdown: [
      `## Oversized ${entry.kindLabel} omitted`,
      "",
      `Ref: \`${entry.ref}\``,
      `The complete item is ${entry.originalCharacters.toLocaleString("en-US")} characters and cannot fit safely in one recall response.`,
      `Expand: \`wb thread recall expand --thread ${threadId} --ref ${entry.expansionRef}\``,
    ].join("\n"),
  };
}

function renderHistoryPage({
  before,
  endExclusive,
  entries,
  startIndex,
  threadId,
  totalEntries,
}: {
  before: string | null;
  endExclusive: number;
  entries: readonly ThreadRecallHistoryEntry[];
  startIndex: number;
  threadId: string;
  totalEntries: number;
}) {
  const historical = before !== null;
  const header = historical
    ? [
      "# Thread Recall History — Historical Page",
      "",
      "WARNING: Newer thread evidence is intentionally omitted from this page. Do not infer the current objective or approval state from this page alone.",
      "",
      `Return to newest: \`wb thread recall --thread ${threadId}\``,
    ].join("\n")
    : [
      "# Thread Recall History",
      "",
      "Newest chronological evidence for reorientation. Older entries may be completed, rejected, or superseded; they are not automatically the current task.",
    ].join("\n");

  const footer: string[] = [];
  if (startIndex > 0 && entries[0]) {
    footer.push(
      `${startIndex.toLocaleString("en-US")} older ${startIndex === 1 ? "entry was" : "entries were"} omitted.`,
      `Previous page: \`wb thread recall --thread ${threadId} --before ${entries[0].ref}\``,
    );
  }
  if (historical) {
    const newerCount = totalEntries - endExclusive;
    footer.push(`${newerCount.toLocaleString("en-US")} newer ${newerCount === 1 ? "entry is" : "entries are"} intentionally omitted from this historical page.`);
  }

  return [
    header,
    ...entries.map((entry) => entry.markdown),
    ...(footer.length ? ["---", ...footer] : []),
  ].map((part) => part.trim()).filter(Boolean).join("\n\n");
}

export function renderWorkbenchThreadRecallHistoryMarkdown(
  pieces: readonly WorkbenchThreadContextPiece[],
  {
    before = null,
    threadId,
  }: {
    before?: string | null;
    threadId: string;
  },
) {
  const visiblePieces = pieces.filter((piece) => Boolean(renderWorkbenchThreadContextPieceMarkdown(piece).trim()));
  const newestPlanPiece = [...visiblePieces].reverse().find((piece) => piece.kind === "planBlock");
  const newestPlanRef = newestPlanPiece ? getWorkbenchThreadContextPieceRef(newestPlanPiece) : null;
  const allEntries = visiblePieces.map((piece) => createHistoryEntry(piece, {
    isNewestPlan: getWorkbenchThreadContextPieceRef(piece) === newestPlanRef,
    threadId,
  })).filter((entry): entry is ThreadRecallHistoryEntry => entry !== null);
  const endExclusive = before === null
    ? allEntries.length
    : allEntries.findIndex((entry) => entry.ref === before);
  if (endExclusive < 0) {
    throw new Error(`Unknown Thread Recall history ref: ${before}`);
  }

  let entries: ThreadRecallHistoryEntry[] = [];
  let startIndex = endExclusive;
  for (let index = endExclusive - 1; index >= 0; index -= 1) {
    const entry = allEntries[index];
    const candidateEntries = [entry, ...entries];
    const candidate = renderHistoryPage({
      before,
      endExclusive,
      entries: candidateEntries,
      startIndex: index,
      threadId,
      totalEntries: allEntries.length,
    });
    if (candidate.length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS) {
      entries = candidateEntries;
      startIndex = index;
      continue;
    }

    if (!entries.length) {
      const stub = renderOversizedHistoryEntry(entry, threadId);
      entries = [stub];
      startIndex = index;
      continue;
    }
    break;
  }

  const markdown = renderHistoryPage({
    before,
    endExclusive,
    entries,
    startIndex,
    threadId,
    totalEntries: allEntries.length,
  });
  if (markdown.length > WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS) {
    throw new Error("Thread Recall could not render a response inside the safe character budget.");
  }
  return markdown;
}
