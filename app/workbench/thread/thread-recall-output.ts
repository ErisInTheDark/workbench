/*
 * Exports:
 * - WorkbenchThreadRecallOutputSegment/WorkbenchThreadRecallOutputRecord: parsed recall command-output contracts. Keywords: thread recall, output, tags.
 * - WorkbenchThreadRecallOutputSummary/WorkbenchThreadRecallRecordGroup: compact parsed result statistics for recall disclosures.
 * - parseWorkbenchThreadRecallOutput: split Markdown chrome from strict kind-tagged narrative records. Keywords: parser, HTML tags, fallback.
 * - summarizeWorkbenchThreadRecallOutput: count captured records and strict search-page metadata without inventing fallback semantics.
 */

import type { WorkbenchThreadRecallKind } from "workbench-shared/types";

export interface WorkbenchThreadRecallOutputRecord {
  kind: WorkbenchThreadRecallKind;
  ref: string;
  text: string;
  turnId: string | null;
}

export type WorkbenchThreadRecallOutputSegment =
  | { markdown: string; type: "markdown" }
  | { record: WorkbenchThreadRecallOutputRecord; type: "record" };

export type WorkbenchThreadRecallRecordGroup = "agent" | "plan" | "questionnaire" | "user";

export interface WorkbenchThreadRecallOutputSummary {
  mode: "history" | "record" | "search";
  recordCount: number;
  recordCounts: Record<WorkbenchThreadRecallRecordGroup, number>;
  searchMatches: { shown: number; total: number } | null;
}

const RECALL_TAG_PATTERN = "user-message|user-steer|questionnaire|commentary|final-answer|agent-message|plan";
const OPEN_TAG_PATTERN = new RegExp(`^<(${RECALL_TAG_PATTERN})\\s+([^>]*)>$`, "u");
const SEARCH_MATCHES_PATTERN = /^Matches:\s+([\d,]+)\s+total;\s+([\d,]+)\s+shown on this newest-first page\.$/mu;

function decodeAttribute(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function readAttribute(attributes: string, name: string) {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"(?:\\s|$)`, "u").exec(attributes);
  return match?.[1] === undefined ? null : decodeAttribute(match[1]);
}

function decodeEscapedClosingTagLines(value: string, kind: WorkbenchThreadRecallKind) {
  const escaped = `&lt;/${kind}&gt;`;
  return value.split("\n").map((line) => (
    line.trim() === escaped ? line.replace(escaped, `</${kind}>`) : line
  )).join("\n");
}

export function parseWorkbenchThreadRecallOutput(markdown: string): WorkbenchThreadRecallOutputSegment[] {
  const normalized = markdown.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const segments: WorkbenchThreadRecallOutputSegment[] = [];
  let markdownLines: string[] = [];

  const flushMarkdown = () => {
    const value = markdownLines.join("\n").trim();
    if (value) segments.push({ markdown: value, type: "markdown" });
    markdownLines = [];
  };

  for (let index = 0; index < lines.length;) {
    const opening = OPEN_TAG_PATTERN.exec(lines[index]!.trim());
    if (!opening?.[1] || opening[2] === undefined) {
      markdownLines.push(lines[index]!);
      index += 1;
      continue;
    }
    const kind = opening[1] as WorkbenchThreadRecallKind;
    const id = readAttribute(opening[2], "id");
    const closingTag = `</${kind}>`;
    let closingIndex = index + 1;
    while (closingIndex < lines.length && lines[closingIndex]!.trim() !== closingTag) {
      closingIndex += 1;
    }
    if (!id?.startsWith("ref:") || closingIndex >= lines.length) {
      markdownLines.push(lines[index]!);
      index += 1;
      continue;
    }

    flushMarkdown();
    const text = decodeEscapedClosingTagLines(lines.slice(index + 1, closingIndex).join("\n").trim(), kind);
    segments.push({
      record: {
        kind,
        ref: id.slice("ref:".length),
        text,
        turnId: readAttribute(opening[2], "turn"),
      },
      type: "record",
    });
    index = closingIndex + 1;
  }

  flushMarkdown();
  return segments.length ? segments : [{ markdown: normalized.trim(), type: "markdown" }];
}

function getRecordGroup(kind: WorkbenchThreadRecallKind): WorkbenchThreadRecallRecordGroup {
  if (kind === "user-message" || kind === "user-steer") return "user";
  if (kind === "plan") return "plan";
  if (kind === "questionnaire") return "questionnaire";
  return "agent";
}

function parseCount(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function summarizeWorkbenchThreadRecallOutput(markdown: string): WorkbenchThreadRecallOutputSummary | null {
  const normalized = markdown.replace(/\r\n?/gu, "\n").trim();
  const mode = normalized.startsWith("# Thread Recall Search")
    ? "search"
    : normalized.startsWith("# Thread Recall Record")
      ? "record"
      : normalized.startsWith("# Thread Recall History")
        ? "history"
        : null;
  if (!mode) return null;

  const records = parseWorkbenchThreadRecallOutput(normalized)
    .flatMap((segment) => segment.type === "record" ? [segment.record] : []);
  const expectedRecordCount = normalized.split("\n").filter((line) => {
    const opening = OPEN_TAG_PATTERN.exec(line.trim());
    return opening?.[2] !== undefined && readAttribute(opening[2], "id")?.startsWith("ref:");
  }).length;
  if (records.length !== expectedRecordCount) return null;

  const recordCounts: WorkbenchThreadRecallOutputSummary["recordCounts"] = {
    agent: 0,
    plan: 0,
    questionnaire: 0,
    user: 0,
  };
  for (const record of records) {
    recordCounts[getRecordGroup(record.kind)] += 1;
  }

  const searchMatch = mode === "search" ? SEARCH_MATCHES_PATTERN.exec(normalized) : null;
  const total = parseCount(searchMatch?.[1]);
  const shown = parseCount(searchMatch?.[2]);
  const searchMatches = total !== null && shown !== null && shown <= total
    ? { shown, total }
    : null;

  return {
    mode,
    recordCount: records.length,
    recordCounts,
    searchMatches,
  };
}
