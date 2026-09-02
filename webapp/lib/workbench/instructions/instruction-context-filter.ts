/*
 * Exports:
 * - WorkbenchInstructionFilterContext/WorkbenchInstructionFilterWarning: trusted final-payload selector inputs and bounded recovery warnings. Keywords: instructions, selector, warning.
 * - stripWorkbenchInstructionHtmlComments: remove source comments outside Markdown fences while preserving line structure. Keywords: instructions, comments, fences, source.
 * - filterWorkbenchInstructionContent: strip HTML comments and apply harness, shell, and mechanics-availability blocks without rejecting prompt assembly. Keywords: filter, tolerant parser, final payload.
 */

import type { WorkbenchHarness } from "../../types";

type SelectorAxis = "available" | "harness" | "shell";
type WorkbenchShell = "bash" | "pwsh";

export interface WorkbenchInstructionFilterContext {
  available: ReadonlySet<string>;
  field: string;
  harness: WorkbenchHarness;
  onWarning: (warning: WorkbenchInstructionFilterWarning) => void;
  shell: WorkbenchShell;
}

export interface WorkbenchInstructionFilterWarning {
  field: string;
  line: number;
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
  "thread-status",
  "thread-title",
]);

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
  if (axis === "harness") return value === "codex" || value === "copilot" || value === "opencode";
  if (axis === "shell") return value === "pwsh" || value === "bash";
  return AVAILABLE_VALUE.test(value) && KNOWN_AVAILABLE_VALUES.has(value);
}

function matches(control: SelectorControl, context: WorkbenchInstructionFilterContext) {
  if (control.axis === "harness") return control.value === context.harness;
  if (control.axis === "shell") return control.value === context.shell;
  return context.available.has(control.value);
}

function warn(context: WorkbenchInstructionFilterContext, line: number, recovery: WorkbenchInstructionFilterWarning["recovery"], source: string) {
  context.onWarning({ field: context.field, line: line + 1, recovery, source: source.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 240) });
}

export function filterWorkbenchInstructionContent(value: string | null | undefined, context: WorkbenchInstructionFilterContext) {
  if (!value) return null;
  const lines = stripWorkbenchInstructionHtmlComments(value.replace(/\r\n?/gu, "\n")).split("\n");
  const controls = new Map<number, SelectorControl>();
  const openLines: number[] = [];
  let fence: Fence | null = null;

  lines.forEach((line, lineIndex) => {
    if (fence) { if (closesFence(line, fence)) fence = null; return; }
    const openedFence = readFence(line);
    if (openedFence) { fence = openedFence; return; }
    const match = SELECTOR_LINE.exec(line);
    if (!match) { if (SELECTOR_LOOKALIKE.test(line)) warn(context, lineIndex, "malformed", line); return; }
    const control: SelectorControl = { axis: match[2] as SelectorAxis, closing: Boolean(match[1]), neutral: false, value: match[3]?.trim() ?? "" };
    controls.set(lineIndex, control);
    if (!isKnownValue(control.axis, control.value)) { control.neutral = true; warn(context, lineIndex, "malformed", line); return; }
    if (!control.closing) { openLines.push(lineIndex); return; }
    const matchingStackIndex = findLastMatchingIndex(openLines, (openLine) => {
      const opened = controls.get(openLine);
      return opened?.axis === control.axis && opened.value === control.value;
    });
    if (matchingStackIndex < 0) { control.neutral = true; warn(context, lineIndex, "unmatched", line); return; }
    if (matchingStackIndex !== openLines.length - 1) {
      control.neutral = true;
      openLines.slice(matchingStackIndex).forEach((openLine) => { const opened = controls.get(openLine); if (opened) opened.neutral = true; });
      warn(context, lineIndex, "crossed", line);
    }
    openLines.splice(matchingStackIndex, 1);
  });
  openLines.forEach((lineIndex) => { const control = controls.get(lineIndex); if (control) { control.neutral = true; warn(context, lineIndex, "unclosed", lines[lineIndex] ?? ""); } });

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
