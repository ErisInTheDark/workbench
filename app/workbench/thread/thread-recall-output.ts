/*
 * Exports:
 * - WorkbenchThreadRecallOutputSegment/WorkbenchThreadRecallOutputRecord: parsed recall command-output contracts. Keywords: thread recall, output, tags.
 * - parseWorkbenchThreadRecallOutput: split Markdown chrome from strict kind-tagged narrative records. Keywords: parser, HTML tags, fallback.
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

const RECALL_TAG_PATTERN = "user-message|user-steer|questionnaire|commentary|final-answer|agent-message|plan";
const OPEN_TAG_PATTERN = new RegExp(`^<(${RECALL_TAG_PATTERN})\\s+([^>]*)>$`, "u");

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
