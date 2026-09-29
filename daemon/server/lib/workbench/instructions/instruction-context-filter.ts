/*
 * Exports:
 * - WorkbenchInstructionFilterContext/WorkbenchInstructionFilterWarning: trusted final-payload selector inputs and bounded recovery warnings.
 * - stripWorkbenchInstructionHtmlComments: remove source comments outside Markdown fences while preserving line structure.
 * - filterWorkbenchInstructionContent: strip comments, apply selectors and provider tool references, and collapse inline wrapper regions.
 * - formatWorkbenchInstructionFilterWarning: render one bounded source diagnostic with ANSI emphasis.
 */

import os from "node:os";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";

import type { WorkbenchHarness } from "workbench-shared/types";
import type { InstructionSourceSpan, RenderedInstructionContent } from "./instruction-file-generation";

type SelectorAxis = "available" | "harness" | "model" | "shell" | "role" | "tool" | "wrapper";
type WorkbenchShell = "bash" | "pwsh";

export interface WorkbenchInstructionFilterContext {
  available: ReadonlySet<string>;
  field: string;
  harness: WorkbenchHarness;
  model: string | null;
  role?: "agent" | "voice-to-text";
  onWarning: (warning: WorkbenchInstructionFilterWarning) => void;
  resolveTool?: (id: string) => string | null;
  shell: WorkbenchShell;
  sourceSections?: readonly RenderedInstructionContent[];
}

export interface WorkbenchInstructionFilterWarning {
  column: number;
  field: string;
  length: number;
  line: number;
  message: string;
  path: string;
  recovery: "crossed" | "fenced" | "malformed" | "unclosed" | "unmatched";
  source: string;
}

interface SelectorControl {
  axis: SelectorAxis;
  closing: boolean;
  matchMode: "exact" | "regex";
  neutral: boolean;
  pattern: RegExp | null;
  value: string;
}
interface SelectorTag {
  control: SelectorControl;
  end: number;
  line: number;
  start: number;
}
interface Fence { include?: boolean; marker: "`" | "~"; size: number }

const SELECTOR_TAG = /<(\/)?(available|harness|model|shell|role):([^<>]+)>/uy;
const MODEL_MATCHES_TAG = /<model matches="([^"\n]+)">/uy;
const MODEL_NAME_CLOSE_TAG = /<\/model>/uy;
const MODEL_ATTR_CLOSE_TAG = /<\/model(\s[^>]*)>/uy;
const WRAPPER_TAG = /<(\/)?>/uy;
const TOOL_TAG = /<tool id="([a-z][a-z0-9_]*)"\s*\/>/uy;
const SELECTOR_LOOKALIKE = /^\s*<\/?(?:available|harness|model|shell|role|tool)(?::|\s|>)/u;
const AVAILABLE_VALUE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const MODEL_VALUE = /^[^\s<>]{1,200}$/u;
const MAX_MODEL_REGEX_LENGTH = 200;
const KNOWN_AVAILABLE_VALUES = new Set([
  "browse",
  "browse-raw",
  "long-waits",
  "messages",
  "multi-root",
  "subagents",
  "thread-git",
  "thread-recall",
  "thread-refresh",
  "task-status",
  "task-title",
]);
const ANSI_RED = "\u001b[31m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RESET = "\u001b[0m";
const MAX_WARNING_PATH_LENGTH = 500;
const MAX_WARNING_POINTER_LENGTH = 120;
const MAX_WARNING_SOURCE_LENGTH = 240;
const MAX_WARNING_VALUE_LENGTH = 120;

interface LocatedInstructionSourceSpan extends InstructionSourceSpan {
  readonly generatedStart: number;
}

function findLastMatchingIndex<T>(values: readonly T[], predicate: (value: T) => boolean) {
  for (let index = values.length - 1; index >= 0; index -= 1) if (predicate(values[index] as T)) return index;
  return -1;
}

// Closing tags repeat their name but never attributes or values, so a valueless closer such as
// `</model>` pairs with the innermost opener of the same tag name.
function pairsWithCloser(opened: SelectorControl, closing: SelectorControl) {
  return opened.axis === closing.axis
    && opened.matchMode === closing.matchMode
    && (closing.value === "" || opened.value === closing.value);
}

function scanSelectorTags(line: string, lineIndex: number, onMalformed: (column: number) => void) {
  const tags: SelectorTag[] = [];
  for (let index = 0; index < line.length;) {
    if (line[index] === "`") {
      let runEnd = index + 1;
      while (line[runEnd] === "`") runEnd += 1;
      let close = runEnd;
      while (close < line.length) {
        close = line.indexOf("`", close);
        if (close < 0) break;
        let closeEnd = close + 1;
        while (line[closeEnd] === "`") closeEnd += 1;
        if (closeEnd - close === runEnd - index) break;
        close = closeEnd;
      }
      if (close >= 0) { index = close + runEnd - index; continue; }
      index = runEnd;
      continue;
    }
    if (line[index] !== "<") { index += 1; continue; }
    TOOL_TAG.lastIndex = index;
    const toolMatch = TOOL_TAG.exec(line);
    if (toolMatch) {
      tags.push({
        control: {
          axis: "tool",
          closing: false,
          matchMode: "exact",
          neutral: false,
          pattern: null,
          value: toolMatch[1] ?? "",
        },
        end: index + toolMatch[0].length,
        line: lineIndex,
        start: index,
      });
      index += toolMatch[0].length;
      continue;
    }
    WRAPPER_TAG.lastIndex = index;
    const wrapperMatch = WRAPPER_TAG.exec(line);
    if (wrapperMatch) {
      tags.push({
        control: {
          axis: "wrapper",
          closing: Boolean(wrapperMatch[1]),
          matchMode: "exact",
          neutral: false,
          pattern: null,
          value: "",
        },
        end: index + wrapperMatch[0].length,
        line: lineIndex,
        start: index,
      });
      index += wrapperMatch[0].length;
      continue;
    }
    MODEL_NAME_CLOSE_TAG.lastIndex = index;
    const modelNameClose = MODEL_NAME_CLOSE_TAG.exec(line);
    if (modelNameClose) {
      // Closing tags never carry attributes, so the bare `</model>` name closes `<model matches="...">`.
      tags.push({
        control: {
          axis: "model",
          closing: true,
          matchMode: "regex",
          neutral: false,
          pattern: null,
          value: "",
        },
        end: index + modelNameClose[0].length,
        line: lineIndex,
        start: index,
      });
      index += modelNameClose[0].length;
      continue;
    }
    MODEL_ATTR_CLOSE_TAG.lastIndex = index;
    const modelAttrClose = MODEL_ATTR_CLOSE_TAG.exec(line);
    if (modelAttrClose) {
      // Closing tags cannot carry attributes. Keeping the junk as the value fails model validation,
      // so the malformed recovery strips the tag and warns instead of pairing it.
      tags.push({
        control: {
          axis: "model",
          closing: true,
          matchMode: "exact",
          neutral: false,
          pattern: null,
          value: modelAttrClose[1] ?? "",
        },
        end: index + modelAttrClose[0].length,
        line: lineIndex,
        start: index,
      });
      index += modelAttrClose[0].length;
      continue;
    }
    MODEL_MATCHES_TAG.lastIndex = index;
    SELECTOR_TAG.lastIndex = index;
    const regexMatch = MODEL_MATCHES_TAG.exec(line);
    const match = regexMatch ?? SELECTOR_TAG.exec(line);
    if (match) {
      tags.push({
        control: {
          axis: regexMatch ? "model" : match[2] as SelectorAxis,
          closing: regexMatch ? false : Boolean(match[1]),
          matchMode: regexMatch ? "regex" : "exact",
          neutral: false,
          pattern: null,
          value: regexMatch ? regexMatch[1] ?? "" : match[3]?.trim() ?? "",
        },
        end: index + match[0].length,
        line: lineIndex,
        start: index,
      });
      index += match[0].length;
      continue;
    }
    if (SELECTOR_LOOKALIKE.test(line.slice(index))) {
      onMalformed(index);
      const end = line.indexOf(">", index);
      index = end < 0 ? line.length : end + 1;
      continue;
    }
    index += 1;
  }
  return tags;
}

function readFence(line: string): Fence | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/u.exec(line);
  return match?.[1] ? { marker: match[1][0] as Fence["marker"], size: match[1].length } : null;
}

function closesFence(line: string, fence: Fence) {
  const marker = fence.marker === "`" ? "`" : "~";
  return new RegExp(`^(?: {0,3})${marker}{${fence.size},}\\s*$`, "u").test(line);
}

export function stripWorkbenchInstructionHtmlComments(value: string) {
  const lines = value.split("\n");
  let fence: Fence | null = null;
  let output = "";
  let pendingComment: string | null = null;

  const appendPlainText = (fragment: string) => {
    let remaining = fragment;
    while (remaining) {
      const openingIndex = remaining.indexOf("<!--");
      if (openingIndex < 0) {
        output += remaining;
        return;
      }

      output += remaining.slice(0, openingIndex);
      const closingIndex = remaining.indexOf("-->", openingIndex + 4);
      if (closingIndex < 0) {
        pendingComment = remaining.slice(openingIndex);
        return;
      }

      const comment = remaining.slice(openingIndex, closingIndex + 3);
      output += comment.replace(/[^\n]/gu, "");
      remaining = remaining.slice(closingIndex + 3);
    }
  };

  lines.forEach((line, lineIndex) => {
    const fragment = `${lineIndex > 0 ? "\n" : ""}${line}`;
    if (fence) {
      output += fragment;
      if (closesFence(line, fence)) fence = null;
      return;
    }

    if (pendingComment !== null) {
      pendingComment += fragment;
      const closingIndex = pendingComment.indexOf("-->");
      if (closingIndex < 0) return;

      const comment = pendingComment.slice(0, closingIndex + 3);
      const remainder = pendingComment.slice(closingIndex + 3);
      output += comment.replace(/[^\n]/gu, "");
      pendingComment = null;
      appendPlainText(remainder);
      return;
    }

    const openedFence = readFence(line);
    if (openedFence) {
      output += fragment;
      fence = openedFence;
      return;
    }

    appendPlainText(fragment);
  });

  return output + (pendingComment ?? "");
}

function isKnownValue(axis: SelectorAxis, value: string) {
  if (axis === "wrapper") return true;
  if (axis === "tool") return false;
  if (axis === "role") return value === "agent" || value === "voice-to-text";
  if (axis === "harness") return ProviderKeySchema.safeParse(value).success;
  if (axis === "model") return MODEL_VALUE.test(value);
  if (axis === "shell") return value === "pwsh" || value === "bash";
  return AVAILABLE_VALUE.test(value) && KNOWN_AVAILABLE_VALUES.has(value);
}

function matches(control: SelectorControl, context: WorkbenchInstructionFilterContext) {
  if (control.axis === "wrapper") return true;
  if (control.axis === "tool") return true;
  if (control.axis === "role") return control.value === (context.role ?? "agent");
  if (control.axis === "harness") return control.value === context.harness;
  if (control.axis === "model") {
    if (context.model === null) return false;
    return control.matchMode === "regex"
      ? control.pattern?.test(context.model) ?? false
      : control.value === context.model;
  }
  if (control.axis === "shell") return control.value === context.shell;
  return context.available.has(control.value);
}

function sanitizeWarningSource(source: string) {
  return source.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "?");
}

function windowWarningSource(source: string, column: number, length: number) {
  const sanitized = sanitizeWarningSource(source);
  const windowStart = column > MAX_WARNING_SOURCE_LENGTH - 40 ? column - 40 : 0;
  const prefix = windowStart > 0 ? "..." : "";
  const displayedSource = `${prefix}${sanitized.slice(
    windowStart,
    windowStart + MAX_WARNING_SOURCE_LENGTH - prefix.length,
  )}`;
  const displayedColumn = prefix.length + column - windowStart + 1;
  return {
    column: displayedColumn,
    length: Math.min(
      Math.max(1, length),
      MAX_WARNING_POINTER_LENGTH,
      Math.max(1, displayedSource.length - displayedColumn + 1),
    ),
    source: displayedSource,
  };
}

function locateInstructionSources(value: string, sections: readonly RenderedInstructionContent[] | undefined) {
  if (!sections?.length) return [];
  const located: LocatedInstructionSourceSpan[] = [];
  let searchStart = 0;
  for (const section of sections) {
    if (!section.content) continue;
    const sectionStart = value.indexOf(section.content, searchStart);
    if (sectionStart < 0) continue;
    located.push(...section.sources.map((source) => ({
      ...source,
      generatedStart: sectionStart + source.outputStart,
    })));
    searchStart = sectionStart + section.content.length;
  }
  return located;
}

function resolveWarningLocation(
  context: WorkbenchInstructionFilterContext,
  locatedSources: readonly LocatedInstructionSourceSpan[],
  generatedLine: number,
  generatedLineStart: number,
  column: number,
  length: number,
  source: string,
) {
  const generatedOffset = generatedLineStart + column;
  const located = locatedSources.find((candidate) => (
    candidate.generatedStart <= generatedOffset
    && candidate.generatedStart + candidate.outputEnd - candidate.outputStart > generatedOffset
  ));
  if (!located) {
    return {
      ...windowWarningSource(source, column, length),
      line: generatedLine + 1,
      path: sanitizeWarningSource(context.field).slice(0, MAX_WARNING_PATH_LENGTH),
    };
  }

  const sourceOffset = located.sourceStart + generatedOffset - located.generatedStart;
  const sourceLineStart = located.sourceContent.lastIndexOf("\n", sourceOffset - 1) + 1;
  const sourceLineEnd = located.sourceContent.indexOf("\n", sourceOffset);
  const sourceLine = located.sourceContent.slice(
    sourceLineStart,
    sourceLineEnd < 0 ? located.sourceContent.length : sourceLineEnd,
  );
  return {
    ...windowWarningSource(sourceLine, sourceOffset - sourceLineStart, length),
    line: located.sourceContent.slice(0, sourceLineStart).split("\n").length,
    path: sanitizeWarningSource(located.absolutePath).slice(0, MAX_WARNING_PATH_LENGTH),
  };
}

function warningMessage(
  recovery: WorkbenchInstructionFilterWarning["recovery"],
  axis?: SelectorAxis,
  value?: string,
) {
  if (recovery === "fenced") return "Instruction wrapper cannot contain a fenced code block";
  if (recovery === "malformed" && axis === "available" && value) {
    return `Unable to check availability of ${sanitizeWarningSource(value).slice(0, MAX_WARNING_VALUE_LENGTH)}`;
  }
  if (recovery === "malformed" && axis === "tool") return "Unknown Workbench tool id";
  if (recovery === "malformed") return "Malformed instruction selector";
  if (recovery === "unclosed") return "Instruction selector is not closed";
  if (recovery === "unmatched") return "Instruction selector has no matching opener";
  return "Instruction selectors cross";
}

function formatWarningPath(value: string) {
  const normalizedPath = value.replaceAll("\\", "/");
  const normalizedHome = os.homedir().replaceAll("\\", "/").replace(/\/+$/u, "");
  const comparablePath = process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
  const comparableHome = process.platform === "win32" ? normalizedHome.toLowerCase() : normalizedHome;
  if (comparablePath === comparableHome) return "~";
  return comparablePath.startsWith(`${comparableHome}/`)
    ? `~${normalizedPath.slice(normalizedHome.length)}`
    : normalizedPath;
}

function warn(
  context: WorkbenchInstructionFilterContext,
  locatedSources: readonly LocatedInstructionSourceSpan[],
  line: number,
  lineStart: number,
  recovery: WorkbenchInstructionFilterWarning["recovery"],
  source: string,
  detail: { axis?: SelectorAxis; column?: number; length?: number; value?: string } = {},
) {
  const column = detail.column ?? source.search(/\S/u);
  const location = resolveWarningLocation(
    context,
    locatedSources,
    line,
    lineStart,
    Math.max(0, column),
    detail.length ?? Math.max(1, source.trim().length),
    source,
  );
  context.onWarning({
    ...location,
    field: context.field,
    message: warningMessage(recovery, detail.axis, detail.value),
    recovery,
  });
}

export function formatWorkbenchInstructionFilterWarning(warning: WorkbenchInstructionFilterWarning) {
  const lineLabel = String(warning.line);
  const pointerIndent = " ".repeat(lineLabel.length + warning.column);
  const pointer = "^".repeat(Math.max(1, warning.length));
  return [
    `${ANSI_RED}INSTR ${formatWarningPath(warning.path)}:${warning.line} ${warning.recovery}: ${warning.message}${ANSI_RESET}`,
    `${ANSI_RED}INSTR${ANSI_RESET} ${ANSI_YELLOW}${lineLabel}${ANSI_RESET} ${warning.source}`,
    `${ANSI_RED}INSTR ${pointerIndent}${pointer}${ANSI_RESET}`,
  ].join("\n");
}

export function filterWorkbenchInstructionContent(value: string | null | undefined, context: WorkbenchInstructionFilterContext) {
  if (!value) return null;
  const normalizedValue = value.replace(/\r\n?/gu, "\n");
  const lines = stripWorkbenchInstructionHtmlComments(normalizedValue).split("\n");
  const sourceLines = normalizedValue.split("\n");
  const lineStarts: number[] = [];
  let nextLineStart = 0;
  sourceLines.forEach((line) => {
    lineStarts.push(nextLineStart);
    nextLineStart += line.length + 1;
  });
  const locatedSources = locateInstructionSources(normalizedValue, context.sourceSections);
  const tagsByLine = new Map<number, SelectorTag[]>();
  const openTags: SelectorTag[] = [];
  let fence: Fence | null = null;

  lines.forEach((line, lineIndex) => {
    if (fence) { if (closesFence(line, fence)) fence = null; return; }
    const openedFence = readFence(line);
    if (openedFence) {
      fence = openedFence;
      // A wrapper-level fence would be collapsed into one line, so neutralise the wrappers instead.
      if (openTags.every((tag) => tag.control.axis === "wrapper")) {
        openTags.forEach((tag) => {
          tag.control.neutral = true;
          const wrapperSource = lines[tag.line] ?? "";
          warn(context, locatedSources, tag.line, lineStarts[tag.line] ?? 0, "fenced", wrapperSource, {
            axis: "wrapper",
            column: tag.start,
            length: Math.max(1, tag.end - tag.start),
          });
        });
      }
      return;
    }
    const tags = scanSelectorTags(line, lineIndex, (column) => {
      warn(context, locatedSources, lineIndex, lineStarts[lineIndex] ?? 0, "malformed", line, { column });
    });
    if (tags.length) tagsByLine.set(lineIndex, tags);
    tags.forEach((tag) => {
      const { control } = tag;
      if (control.axis === "tool" && !openTags.every(opened => opened.control.neutral || matches(opened.control, context))) return;
      const valueColumn = control.value
        ? tag.start + line.slice(tag.start, tag.end).indexOf(control.value)
        : tag.start + Math.max(0, line.slice(tag.start, tag.end).indexOf(":") + 1);
      const detail = {
        axis: control.axis,
        column: valueColumn,
        length: Math.max(1, control.value.length),
        value: control.value,
      };
      let valid = control.axis === "tool"
        ? Boolean(context.resolveTool?.(control.value))
        : control.matchMode === "regex"
        ? control.value.length <= MAX_MODEL_REGEX_LENGTH
        : isKnownValue(control.axis, control.value);
      if (valid && control.matchMode === "regex") {
        try { control.pattern = new RegExp(control.value, "u"); }
        catch { valid = false; }
      }
      if (!valid) {
        control.neutral = true;
        warn(context, locatedSources, lineIndex, lineStarts[lineIndex] ?? 0, "malformed", line, detail);
        return;
      }
      if (control.axis === "tool") return;
      if (!control.closing) { openTags.push(tag); return; }
      const matchingStackIndex = findLastMatchingIndex(openTags, (opened) => pairsWithCloser(opened.control, control));
      if (matchingStackIndex < 0) {
        control.neutral = true;
        warn(context, locatedSources, lineIndex, lineStarts[lineIndex] ?? 0, "unmatched", line, detail);
        return;
      }
      if (matchingStackIndex !== openTags.length - 1) {
        control.neutral = true;
        openTags.slice(matchingStackIndex).forEach((opened) => { opened.control.neutral = true; });
        warn(context, locatedSources, lineIndex, lineStarts[lineIndex] ?? 0, "crossed", line, detail);
      }
      openTags.splice(matchingStackIndex, 1);
    });
  });
  openTags.forEach((tag) => {
    const { control } = tag;
    control.neutral = true;
    const lineIndex = tag.line;
    const source = lines[lineIndex] ?? "";
    const valueColumn = control.value
      ? tag.start + source.slice(tag.start, tag.end).indexOf(control.value)
      : tag.start + Math.max(0, source.slice(tag.start, tag.end).indexOf(":") + 1);
    warn(context, locatedSources, lineIndex, lineStarts[lineIndex] ?? 0, "unclosed", source, {
      axis: control.axis,
      column: valueColumn,
      length: Math.max(1, control.value.length),
      value: control.value,
    });
  });

  const output: string[] = [];
  const active: SelectorControl[] = [];
  const included = () => active.every((opened) => opened.neutral || matches(opened, context));
  // An open inline wrapper buffers its region into one rendered line. Segments split wrapper-level
  // text (whitespace collapses) from nested selector interiors (byte-preserved).
  let inline: { beforeWs: string; depth: number; segments: Array<{ text: string; verbatim: boolean }> } | null = null;
  let rendered = "";
  let flushed = false;
  const emit = (text: string) => {
    if (!inline) { rendered += text; return; }
    const verbatim = active.length > 0;
    const last = inline.segments[inline.segments.length - 1];
    if (last && last.verbatim === verbatim) last.text += text;
    else inline.segments.push({ text, verbatim });
  };
  const flushInline = (afterWs: string) => {
    const state = inline!;
    inline = null;
    let middle = "";
    state.segments.forEach((segment, index) => {
      if (segment.verbatim) { middle += segment.text; return; }
      let collapsed = segment.text.replace(/\s+/gu, " ");
      if (index === 0 && !state.beforeWs) collapsed = collapsed.trimStart();
      if (index === state.segments.length - 1 && !afterWs) collapsed = collapsed.trimEnd();
      middle += collapsed;
    });
    rendered += middle;
    flushed = true;
  };
  fence = null;
  lines.forEach((line, lineIndex) => {
    flushed = false;
    if (fence) {
      if (fence.include !== false) {
        if (inline) { emit(line); emit("\n"); }
        else output.push(line);
      }
      if (closesFence(line, fence)) fence = null;
      return;
    }
    const openedFence = readFence(line);
    if (openedFence) {
      const include = included();
      if (include) {
        if (inline) { emit(line); emit("\n"); }
        else output.push(line);
      }
      fence = { ...openedFence, include };
      return;
    }
    const tags = tagsByLine.get(lineIndex);
    if (!tags?.length) {
      if (inline) { if (included()) { emit(line); emit("\n"); } return; }
      if (included()) output.push(line);
      return;
    }
    const lineTagOnly = tags.length === 1
      && !line.slice(0, tags[0]!.start).trim()
      && !line.slice(tags[0]!.end).trim();
    let cursor = 0;
    for (const tag of tags) {
      if (included()) emit(line.slice(cursor, tag.start));
      const { control } = tag;
      if (control.axis === "wrapper") {
        if (!control.closing) {
          if (inline) inline.depth += 1;
          else if (!control.neutral && active.length === 0) {
            const beforeWs = /(\s*)$/u.exec(rendered)?.[1] ?? "";
            rendered = rendered.slice(0, rendered.length - beforeWs.length);
            inline = { beforeWs, depth: 1, segments: [] };
            emit(beforeWs);
          }
          cursor = tag.end;
          continue;
        }
        if (!inline) { cursor = tag.end; continue; }
        inline.depth -= 1;
        if (inline.depth > 0) { cursor = tag.end; continue; }
        const afterWs = /^\s*/u.exec(line.slice(tag.end))?.[0] ?? "";
        cursor = tag.end + afterWs.length;
        emit(afterWs);
        flushInline(afterWs);
        continue;
      }
      if (control.axis === "tool") {
        if (included()) emit(control.neutral ? line.slice(tag.start, tag.end) : `\`${context.resolveTool!(control.value)}\``);
        cursor = tag.end;
        continue;
      }
      if (!control.closing && control.value) active.push(control);
      else if (control.closing) {
        const index = findLastMatchingIndex(active, (opened) => pairsWithCloser(opened, control));
        if (index >= 0) active.splice(index, 1);
      }
      cursor = tag.end;
    }
    if (included()) emit(line.slice(cursor));
    if (inline) { if (included()) emit("\n"); return; }
    if (rendered && !(lineTagOnly && !flushed)) output.push(rendered);
    rendered = "";
  });
  return output.join("\n");
}
