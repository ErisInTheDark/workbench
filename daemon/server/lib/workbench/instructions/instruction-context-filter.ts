/*
 * Exports:
 * - WorkbenchInstructionFilterContext/WorkbenchInstructionFilterWarning: trusted final-payload selector inputs and bounded recovery warnings.
 * - stripWorkbenchInstructionHtmlComments: remove source comments outside Markdown fences while preserving line structure.
 * - filterWorkbenchInstructionContent: strip HTML comments and apply harness, shell, and mechanics-availability blocks without rejecting prompt assembly.
 * - formatWorkbenchInstructionFilterWarning: render one bounded source diagnostic with ANSI emphasis.
 */

import os from "node:os";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";

import type { WorkbenchHarness } from "workbench-shared/types";
import type { InstructionSourceSpan, RenderedInstructionContent } from "./instruction-file-generation";

type SelectorAxis = "available" | "harness" | "shell";
type WorkbenchShell = "bash" | "pwsh";

export interface WorkbenchInstructionFilterContext {
  available: ReadonlySet<string>;
  field: string;
  harness: WorkbenchHarness;
  onWarning: (warning: WorkbenchInstructionFilterWarning) => void;
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
  recovery: "crossed" | "malformed" | "unclosed" | "unmatched";
  source: string;
}

interface SelectorControl { axis: SelectorAxis; closing: boolean; neutral: boolean; value: string }
interface Fence { include?: boolean; marker: "`" | "~"; size: number }

const SELECTOR_LINE = /^\s*<(\/)?(available|harness|shell):([^<>]+)>\s*$/u;
const SELECTOR_LOOKALIKE = /^\s*<\/?(?:available|harness|shell)(?::|\s|>)/u;
const AVAILABLE_VALUE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const KNOWN_AVAILABLE_VALUES = new Set([
  "browse",
  "browse-raw",
  "long-waits",
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
  if (axis === "harness") return ProviderKeySchema.safeParse(value).success;
  if (axis === "shell") return value === "pwsh" || value === "bash";
  return AVAILABLE_VALUE.test(value) && KNOWN_AVAILABLE_VALUES.has(value);
}

function matches(control: SelectorControl, context: WorkbenchInstructionFilterContext) {
  if (control.axis === "harness") return control.value === context.harness;
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
  if (recovery === "malformed" && axis === "available" && value) {
    return `Unable to check availability of ${sanitizeWarningSource(value).slice(0, MAX_WARNING_VALUE_LENGTH)}`;
  }
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
  const controls = new Map<number, SelectorControl>();
  const openLines: number[] = [];
  let fence: Fence | null = null;

  lines.forEach((line, lineIndex) => {
    if (fence) { if (closesFence(line, fence)) fence = null; return; }
    const openedFence = readFence(line);
    if (openedFence) { fence = openedFence; return; }
    const match = SELECTOR_LINE.exec(line);
    if (!match) {
      if (SELECTOR_LOOKALIKE.test(line)) {
        warn(context, locatedSources, lineIndex, lineStarts[lineIndex] ?? 0, "malformed", line);
      }
      return;
    }
    const control: SelectorControl = { axis: match[2] as SelectorAxis, closing: Boolean(match[1]), neutral: false, value: match[3]?.trim() ?? "" };
    controls.set(lineIndex, control);
    const valueColumn = control.value ? line.indexOf(control.value) : Math.max(0, line.indexOf(":") + 1);
    const detail = {
      axis: control.axis,
      column: valueColumn,
      length: Math.max(1, control.value.length),
      value: control.value,
    };
    if (!isKnownValue(control.axis, control.value)) {
      control.neutral = true;
      warn(context, locatedSources, lineIndex, lineStarts[lineIndex] ?? 0, "malformed", line, detail);
      return;
    }
    if (!control.closing) { openLines.push(lineIndex); return; }
    const matchingStackIndex = findLastMatchingIndex(openLines, (openLine) => {
      const opened = controls.get(openLine);
      return opened?.axis === control.axis && opened.value === control.value;
    });
    if (matchingStackIndex < 0) {
      control.neutral = true;
      warn(context, locatedSources, lineIndex, lineStarts[lineIndex] ?? 0, "unmatched", line, detail);
      return;
    }
    if (matchingStackIndex !== openLines.length - 1) {
      control.neutral = true;
      openLines.slice(matchingStackIndex).forEach((openLine) => { const opened = controls.get(openLine); if (opened) opened.neutral = true; });
      warn(context, locatedSources, lineIndex, lineStarts[lineIndex] ?? 0, "crossed", line, detail);
    }
    openLines.splice(matchingStackIndex, 1);
  });
  openLines.forEach((lineIndex) => {
    const control = controls.get(lineIndex);
    if (!control) return;
    control.neutral = true;
    const source = lines[lineIndex] ?? "";
    const valueColumn = control.value ? source.indexOf(control.value) : Math.max(0, source.indexOf(":") + 1);
    warn(context, locatedSources, lineIndex, lineStarts[lineIndex] ?? 0, "unclosed", source, {
      axis: control.axis,
      column: valueColumn,
      length: Math.max(1, control.value.length),
      value: control.value,
    });
  });

  const output: string[] = [];
  const active: SelectorControl[] = [];
  fence = null;
  lines.forEach((line, lineIndex) => {
    if (fence) { if (fence.include !== false) output.push(line); if (closesFence(line, fence)) fence = null; return; }
    const openedFence = readFence(line);
    if (openedFence) { const include = active.every((control) => control.neutral || matches(control, context)); if (include) output.push(line); fence = { ...openedFence, include }; return; }
    const control = controls.get(lineIndex);
    if (control) {
      if (!control.closing && control.value) active.push(control);
      else if (control.closing) { const index = findLastMatchingIndex(active, (opened) => opened.axis === control.axis && opened.value === control.value); if (index >= 0) active.splice(index, 1); }
      return;
    }
    if (active.every((opened) => opened.neutral || matches(opened, context))) output.push(line);
  });
  return output.join("\n");
}
