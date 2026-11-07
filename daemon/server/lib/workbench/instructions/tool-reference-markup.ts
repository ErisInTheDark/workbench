/*
 * Exports:
 * - WorkbenchToolReferenceMarkup: one parsed `<tool id args>` reference; `args` is the validated JSON object text as written.
 * - WORKBENCH_TOOL_REFERENCE_INPUT_DESCRIPTION: how agent-facing command input names Workbench tools.
 * - hasWorkbenchToolReferences: whether text may hold tool markup, so callers skip catalogue reads.
 * - findWorkbenchToolReferenceProblems: send-time problems with markup outside code: malformed tags, unknown ids and non-object args.
 * - replaceWorkbenchToolReferences: render each well-formed reference outside code; malformed or unrendered markup stays as written.
 */
import { closesMarkdownFence, readMarkdownFence, skipMarkdownCodeSpan, type MarkdownFence } from "./markdown-code";

export interface WorkbenchToolReferenceMarkup {
  readonly id: string;
  readonly args: string | null;
}

type ScannedTag =
  | { kind: "reference"; start: number; end: number; reference: WorkbenchToolReferenceMarkup; argsValid: boolean }
  | { kind: "malformed"; start: number; end: number };

export const WORKBENCH_TOOL_REFERENCE_INPUT_DESCRIPTION = "Agent-facing text. Name Workbench tools as <tool id=\"git_arc_status\" /> or "
  + "<tool id=\"git_arc_release\" args='{\"fromPlan\":true}' />; each renders as the recipient's own call.";

const TOOL_TAG = /<tool id="([a-z][a-z0-9_]*)"(?: args='([^'\n]*)')?\s*\/>/uy;
const TOOL_LOOKALIKE = /<tool[\s/>]/uy;
const HARNESS_PREFIX = /^(?:mcp__wb(?:ex)?__|wbex_)/u;
const MAX_QUOTED_MARKUP_LENGTH = 120;

/** Parsed only to validate; renderers reuse the text as written, so arbitrary JSON never enters Workbench state. */
function isJsonObjectText(text: string) {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function scanLine(line: string, lineStart: number, tags: ScannedTag[]) {
  for (let index = 0; index < line.length;) {
    if (line[index] === "`") { index = skipMarkdownCodeSpan(line, index); continue; }
    if (line[index] !== "<") { index += 1; continue; }
    TOOL_TAG.lastIndex = index;
    const match = TOOL_TAG.exec(line);
    if (match) {
      const args = match[2] === undefined ? null : match[2].trim();
      tags.push({
        kind: "reference",
        start: lineStart + index,
        end: lineStart + index + match[0].length,
        reference: { id: match[1]!, args },
        argsValid: args === null || isJsonObjectText(args),
      });
      index += match[0].length;
      continue;
    }
    TOOL_LOOKALIKE.lastIndex = index;
    if (TOOL_LOOKALIKE.test(line)) {
      const close = line.indexOf(">", index);
      const end = close < 0 ? line.length : close + 1;
      tags.push({ kind: "malformed", start: lineStart + index, end: lineStart + end });
      index = end;
      continue;
    }
    index += 1;
  }
}

function scanToolReferences(text: string) {
  const tags: ScannedTag[] = [];
  let fence: MarkdownFence | null = null;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    if (fence) {
      if (closesMarkdownFence(line, fence)) fence = null;
    } else {
      fence = readMarkdownFence(line);
      if (!fence) scanLine(line, lineStart, tags);
    }
    lineStart += line.length + 1;
  }
  return tags;
}

export function hasWorkbenchToolReferences(text: string) {
  return text.includes("<tool");
}

export function findWorkbenchToolReferenceProblems(text: string, knownToolIds: ReadonlySet<string>): string[] {
  const problems = new Set<string>();
  for (const tag of scanToolReferences(text)) {
    if (tag.kind === "malformed") {
      const markup = JSON.stringify(text.slice(tag.start, tag.end).slice(0, MAX_QUOTED_MARKUP_LENGTH));
      problems.add(`Malformed tool markup ${markup}; write <tool id="git_arc_status" /> or <tool id="git_arc_release" args='{"fromPlan":true}' />.`);
      continue;
    }
    const { id } = tag.reference;
    if (!knownToolIds.has(id)) {
      const bare = id.replace(HARNESS_PREFIX, "");
      const hint = bare !== id && knownToolIds.has(bare)
        ? `use ${JSON.stringify(bare)}`
        : "name tools by their bare Workbench id, such as \"git_arc_status\"";
      problems.add(`Unknown Workbench tool id ${JSON.stringify(id)}; ${hint}.`);
    } else if (!tag.argsValid) {
      problems.add(`Tool markup args for ${JSON.stringify(id)} must be one JSON object.`);
    }
  }
  return [...problems];
}

export function replaceWorkbenchToolReferences(
  text: string,
  render: (reference: WorkbenchToolReferenceMarkup) => string | null,
) {
  let output = "";
  let cursor = 0;
  for (const tag of scanToolReferences(text)) {
    if (tag.kind !== "reference" || !tag.argsValid) continue;
    const rendered = render(tag.reference);
    if (rendered === null) continue;
    output += text.slice(cursor, tag.start) + rendered;
    cursor = tag.end;
  }
  return output + text.slice(cursor);
}
