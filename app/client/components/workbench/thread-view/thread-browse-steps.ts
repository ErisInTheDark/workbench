/*
 * Exports:
 * - BrowseOutcome: one Browse call's lifecycle outcome.
 * - getBrowseSteps: one Browse call's BrowseMD steps, merging requested rows, streamed progress output and recorded result entries; explicit screenshots show open, their receipts replaced by the image; acknowledgement-only stdout drops.
 * - getBrowseScreenshots: screenshots a call's steps explicitly took.
 * - getBrowseItemSteps: steps for a CLI or MCP command item when its matcher display claims Browse, else null.
 * - getLiftedBrowseSteps: a call's steps when they can replace its row as ordinary command rows; null keeps the call row.
 * - getCurrentBrowseStep: the step a live call is on.
 * - describeBrowseStep: one step as plain text, for single-line status.
 * - getBrowseScreenshotUrls: every screenshot asset Browse steps already show, so duplicate screenshot steers can fold into them.
 */
import type { WorkbenchBrowseResultEntry } from "workbench-shared/types";
import { formatDuration } from "workbench-shared/workbench/format-duration";
import {
  getThreadCommandExecutionOutcome,
  isBrowseCommandMatcherClaim,
  parseBrowseSequenceCommandOutput,
  type ThreadCommandDetailRow,
  type ThreadCommandSummaryDisplay,
} from "../../../workbench/thread/thread-command-matchers";
import { readBrowseAction } from "../../../workbench/thread/command-matchers/browse-actions";
import { formatToolCallOutput } from "./format-thread-tool-call";
import type { CommandSequenceItem } from "./thread-render-blocks";

export type BrowseOutcome = "completed" | "failed" | "inProgress";

function isEntryDetailATarget(entry: WorkbenchBrowseResultEntry) {
  return entry.detailKind === "text"
    && !entry.detailLabel
    && Boolean(entry.detailText?.trim())
    && /\b(?:directory|file|files|working directory)\b/iu.test(entry.action);
}

/** A screenshot step's stdout only acknowledges the capture; its image says it better. */
function isScreenshotReceipt(text: string | null | undefined) {
  if (!text?.trim().startsWith("{")) return false;
  try {
    const value = JSON.parse(text) as { screenshot?: unknown };
    return value.screenshot === "captured";
  } catch {
    return false;
  }
}

/**
 * An explicit screenshot is what the agent looked at, so it shows open and its capture receipt gives way to the image.
 * Navigation steps also carry automatic captures; those stay one click away.
 */
function presentScreenshot(row: ThreadCommandDetailRow): ThreadCommandDetailRow {
  const receipt = isScreenshotReceipt(row.detailText);
  if (!row.imageUrl || (row.label !== "Screenshot" && !receipt)) return row;
  return receipt
    ? { ...row, defaultOpen: true, detailKind: undefined, detailLabel: null, detailText: null }
    : { ...row, defaultOpen: true };
}

/** Steps whose output is the answer; every other step's stdout only acknowledges it ran. */
const DATA_ACTIONS: ReadonlySet<string> = new Set(["doctor", "eval", "get", "is", "refs", "sessions", "snapshot", "status"]);

function withoutAcknowledgement(row: ThreadCommandDetailRow): ThreadCommandDetailRow {
  return row.detailKind === "result" && row.action && !DATA_ACTIONS.has(row.action)
    ? { ...row, detailKind: undefined, detailLabel: null, detailText: null }
    : row;
}

function presentStep(row: ThreadCommandDetailRow) {
  return withoutAcknowledgement(presentScreenshot(row));
}

/** Screenshots the agent explicitly took, in step order. */
export function getBrowseScreenshots(steps: readonly ThreadCommandDetailRow[]) {
  return steps.flatMap((step) => step.defaultOpen && step.imageUrl ? [step.imageUrl] : []);
}

function getEntryRows(entries: readonly WorkbenchBrowseResultEntry[]): ThreadCommandDetailRow[] {
  return [...entries]
    .sort((left, right) => left.actionIndex - right.actionIndex || left.recordedAt - right.recordedAt)
    .map((entry) => {
      const { action, label } = readBrowseAction(entry.action);
      const detailIsTarget = isEntryDetailATarget(entry);
      return {
        action,
        detailKind: entry.detailKind ?? undefined,
        detailLabel: entry.detailLabel ?? null,
        detailText: detailIsTarget ? null : entry.detailText ?? null,
        durationMs: entry.durationMs ?? null,
        id: `browse-result:${entry.entryKey}`,
        imageUrl: entry.assetUrl ?? null,
        label,
        state: entry.state,
        summaryParts: [{ text: label, type: "text" as const }],
        target: detailIsTarget && entry.detailText ? { kind: "code" as const, text: entry.detailText } : null,
      };
    });
}

/**
 * Known states come from streamed progress or recorded results. Otherwise a live call is on its first unfinished step
 * and a failed call failed on its last.
 */
function getDefaultStepState(known: readonly (ThreadCommandDetailRow["state"] | undefined)[], outcome: BrowseOutcome, index: number) {
  if (outcome === "completed") return "completed";
  if (outcome === "failed") {
    // BrowseMD stops at the first failure; steps after it never ran.
    const failedIndex = known.findIndex((state) => state === "failed");
    if (failedIndex >= 0) return index < failedIndex ? "completed" : "queued";
    return index === known.length - 1 ? "failed" : "completed";
  }
  const activeIndex = known.findIndex((state) => state === "inProgress");
  const current = activeIndex >= 0 ? activeIndex : known.findIndex((state) => state !== "completed" && state !== "failed");
  return current < 0 || index < current ? "completed" : index === current ? "inProgress" : "queued";
}

export function getBrowseSteps({ entries = [], outcome, output, rows }: {
  entries?: readonly WorkbenchBrowseResultEntry[];
  outcome: BrowseOutcome;
  output: string | null;
  rows: readonly ThreadCommandDetailRow[] | undefined;
}): ThreadCommandDetailRow[] {
  if (!rows?.length) return getEntryRows(entries).map(presentStep);
  const outputRows = parseBrowseSequenceCommandOutput(output);
  const entriesByIndex = new Map(entries.map((entry) => [entry.actionIndex, entry]));
  const known = rows.map((row, index) => row.state ?? entriesByIndex.get(index)?.state ?? outputRows[index]?.state ?? undefined);
  return rows.map((row, index) => {
    const entry = entriesByIndex.get(index);
    const outputRow = outputRows[index];
    const durationMs = row.durationMs ?? entry?.durationMs ?? outputRow?.durationMs ?? null;
    const waitRepeatsTarget = row.label === "Wait"
      && row.target?.kind === "text"
      && durationMs !== null
      && formatDuration(durationMs) === row.target.text;
    return presentStep({
      ...row,
      detailKind: row.detailKind ?? entry?.detailKind ?? outputRow?.detailKind,
      detailLabel: row.detailLabel ?? entry?.detailLabel ?? outputRow?.detailLabel ?? null,
      detailText: row.detailText ?? entry?.detailText ?? outputRow?.detailText ?? null,
      durationMs: waitRepeatsTarget ? null : durationMs,
      imageUrl: row.imageUrl ?? entry?.assetUrl ?? outputRow?.imageUrl ?? null,
      state: known[index] ?? getDefaultStepState(known, outcome, index),
    });
  });
}

function getItemOutcome(item: CommandSequenceItem): BrowseOutcome {
  if (item.type === "commandExecution") {
    const outcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
    return outcome === "completed" || outcome === "inProgress" ? outcome : "failed";
  }
  if (item.status === "inProgress") return "inProgress";
  const failed = item.type === "mcpToolCall" ? item.status === "failed" || Boolean(item.error) : item.success === false || item.status === "failed";
  return failed ? "failed" : "completed";
}

function getItemOutput(item: CommandSequenceItem) {
  if (item.type === "commandExecution") return item.aggregatedOutput ?? null;
  if (item.type === "mcpToolCall") {
    return formatToolCallOutput({ content: item.result?.content, fallback: item.result?.structuredContent ?? item.result?._meta }) ?? null;
  }
  return formatToolCallOutput({ content: item.contentItems }) ?? null;
}

export function getBrowseItemSteps(
  item: CommandSequenceItem,
  display: Pick<ThreadCommandSummaryDisplay, "claimedBy" | "detailRows"> | null,
  entries: readonly WorkbenchBrowseResultEntry[],
) {
  if (!display || !isBrowseCommandMatcherClaim(display.claimedBy)) return null;
  return getBrowseSteps({
    entries: entries.filter((entry) => entry.commandItemId === item.id),
    outcome: getItemOutcome(item),
    output: getItemOutput(item),
    rows: display.detailRows,
  });
}

/**
 * Steps that can stand in for their call as ordinary command rows. A failed call whose failure no step explains
 * keeps its full call row, so the raw error stays visible.
 */
export function getLiftedBrowseSteps(...args: Parameters<typeof getBrowseItemSteps>) {
  const steps = getBrowseItemSteps(...args);
  if (!steps?.length) return null;
  const failed = getItemOutcome(args[0]) === "failed";
  return !failed || steps.some((step) => step.state === "failed" && step.detailKind === "error") ? steps : null;
}

export function getCurrentBrowseStep(steps: readonly ThreadCommandDetailRow[]) {
  return steps.find((step) => step.state === "inProgress") ?? steps.find((step) => step.state === "queued") ?? null;
}

export function describeBrowseStep(step: ThreadCommandDetailRow) {
  const label = step.label ?? "Browse step";
  const target = step.target?.text.trim().split("\n")[0];
  return target ? `${label} ${target}` : label;
}

/** Screenshots captured by Browse calls, read from recorded entries and streamed CLI progress. */
export function getBrowseScreenshotUrls(
  commands: readonly Pick<Extract<CommandSequenceItem, { type: "commandExecution" }>, "aggregatedOutput" | "command">[],
  entries: readonly WorkbenchBrowseResultEntry[],
) {
  const urls = new Set(entries.flatMap((entry) => entry.assetUrl ? [entry.assetUrl] : []));
  for (const item of commands) {
    if (!/\bbrowse\b/u.test(item.command)) continue;
    for (const row of parseBrowseSequenceCommandOutput(item.aggregatedOutput)) {
      if (row.imageUrl) urls.add(row.imageUrl);
    }
  }
  return urls;
}
