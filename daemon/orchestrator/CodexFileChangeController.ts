/*
 * Keywords: patch attempt, current file evidence, recovery context, bounded read.
 * Exports:
 * - CodexFileChangeTarget: originating patch identity and validated filesystem scope.
 * - CodexFileChangeState: reload handoff for observed attempts and ordering cursors.
 * - default CodexFileChangeController: own patch observations and recovery context.
 */
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { analyseFileChange, type FileObservation } from "workbench-shared/workbench/thread/file-change-analysis";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import {
  getWorkbenchFileChangeFailureKey,
  mergeWorkbenchFileChange,
  withWorkbenchFileChangeFailure,
  type WorkbenchFileChangeFailureMarker,
  type WorkbenchFileChangeItem,
} from "workbench-shared/workbench/thread/workbench-file-change";
import type { JsonRpcNotification, JsonRpcResponse } from "./bridge-types";
import { asRecord, asString } from "./codex-transcript-normalizers";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_PATHS = 128;
const MAX_CONTEXT_BYTES = 8 * 1024;
const MAX_RETAINED_PATCHES = 2_048;

export interface CodexFileChangeState {
  items: Map<string, WorkbenchFileChangeFailureMarker>;
  turnCursors: Map<string, string>;
}

export interface CodexFileChangeTarget {
  cwd: string;
  item: WorkbenchFileChangeItem;
  roots: readonly string[];
  threadId: string;
  turnId: string;
}

function comparable(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function within(file: string, root: string) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sameFile(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function unavailable(reason: string): FileObservation {
  return { kind: "unavailable", reason };
}

function readFailure(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? code : "unknown error";
}

async function readRegularFile(file: string, root: string, budget: { bytes: number }): Promise<FileObservation> {
  try {
    // Reject links before opening, then compare the opened handle with that exact observation.
    const segments = path.relative(root, file).split(path.sep).filter(Boolean);
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      const info = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) return { kind: "missing" };
      if (info.isSymbolicLink()) return unavailable("Symbolic-link targets are not inspected.");
    }
    const canonical = await fs.realpath(file);
    if (!within(canonical, root)) return unavailable("Resolved target leaves its validated workspace root.");
    const before = await fs.lstat(file);
    if (!before.isFile()) return unavailable("Target is not a regular file.");
    if (before.size > MAX_FILE_BYTES) return unavailable("Target exceeds the 2 MiB file-read limit.");
    if (budget.bytes + before.size > MAX_TOTAL_BYTES) return unavailable("Patch exceeds the 16 MiB total-read limit.");
    budget.bytes += before.size;
    const handle = await fs.open(file, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(before, opened)) return unavailable("Target changed before it could be read.");
      const bytes = Buffer.alloc(before.size);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await handle.stat();
      const currentInfo = await fs.lstat(file);
      if (length !== before.size || !sameFile(before, after) || !sameFile(before, currentInfo)
        || comparable(await fs.realpath(file)) !== comparable(canonical)) {
        return unavailable("Target changed during the observation.");
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
        return text.includes("\0") ? unavailable("Binary content cannot establish text hunks.") : { kind: "file", text };
      } catch {
        return unavailable("Target is not valid UTF-8 text.");
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    return unavailable(`Could not observe target (${readFailure(error)}).`);
  }
}

function observationWindows(lines: readonly string[], candidateLines: readonly number[]) {
  if (lines.length <= 80) return [{ start: 1, end: lines.length }];
  const windows = (candidateLines.length ? candidateLines : [1]).map((line) => {
    const centre = Math.max(1, Math.min(lines.length, line));
    return { start: Math.max(1, centre - 3), end: Math.min(lines.length, centre + 3) };
  }).sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end + 1) previous.end = Math.max(previous.end, window.end);
    else merged.push(window);
  }
  return merged;
}

function recoveryText(target: CodexFileChangeTarget, item: WorkbenchFileChangeItem, observations: ReadonlyMap<string, FileObservation>) {
  const lines = [
    "Workbench automatically rejected the escalated apply_patch retry. This was not a user rejection.",
    `Originating thread ${target.threadId}, turn ${target.turnId}, patch item ${item.id}.`,
    "Some writes may have happened before the retry. Findings describe current requested-change evidence, not who wrote it or untouched-file integrity.",
    "Do not replay the whole patch or escalate it. Re-read uncertain targets, then fix only remaining path, context, or syntax errors in the sandbox.",
    "Line numbers below belong to this observation, not the attempted patch or future edits.",
    "",
    ...item.changes.map((change) => `${JSON.stringify(change.path)}: ${change.workbenchAnalysis?.outcome ?? "uncertain"} (+${change.workbenchAnalysis?.additions ?? 0}/-${change.workbenchAnalysis?.deletions ?? 0})${change.workbenchAnalysis?.detail ? `. ${change.workbenchAnalysis.detail}` : ""}`),
  ];
  let omittedLines = 0;
  const excerpted = new Set<string>();
  for (const change of item.changes) {
    const analysis = change.workbenchAnalysis;
    if (!analysis || (analysis.outcome !== "uncertain" && !analysis.hunks.some((hunk) => hunk.outcome === "uncertain"))) continue;
    const paths = [change.path, ...(change.kind.type === "update" && change.kind.move_path ? [change.kind.move_path] : [])];
    for (const file of paths) {
      if (excerpted.has(file)) continue;
      excerpted.add(file);
      const observation = observations.get(file);
      if (observation?.kind !== "file") continue;
      const textLines = observation.text.replace(/\r\n/g, "\n").split("\n");
      if (textLines.at(-1) === "") textLines.pop();
      const candidates = analysis.hunks.filter((hunk) => hunk.outcome === "uncertain").flatMap((hunk) => hunk.candidates);
      const hints = analysis.hunks.flatMap((hunk) => [hunk.oldStart, hunk.newStart].filter((line): line is number => line !== null));
      const windows = observationWindows(textLines, candidates.length ? candidates : hints);
      lines.push("", `Current ${JSON.stringify(file)}${candidates.length ? " (candidate matches)" : " (expected locations are hints only)"}`);
      for (const window of windows) {
        for (let line = window.start; line <= window.end; line += 1) lines.push(`${line} | ${textLines[line - 1]}`);
      }
      omittedLines += textLines.length - windows.reduce((count, window) => count + window.end - window.start + 1, 0);
    }
  }
  const footer = (count: number) => `\n${count} lines omitted by excerpt or output limits.\n`;
  const budget = MAX_CONTEXT_BYTES - Buffer.byteLength(footer(omittedLines + lines.length));
  const included: string[] = [];
  let bytes = 0;
  for (const [index, line] of lines.entries()) {
    const size = Buffer.byteLength(`${line}\n`);
    if (bytes + size > budget) {
      omittedLines += lines.length - index;
      break;
    }
    included.push(line);
    bytes += size;
  }
  return `${included.join("\n")}\n${footer(omittedLines)}`;
}

export default class CodexFileChangeController {
  constructor(readonly state: CodexFileChangeState = { items: new Map(), turnCursors: new Map() }) {}

  clear() {
    this.state.items.clear();
    this.state.turnCursors.clear();
  }

  get(threadId: string, turnId: string, itemId: string) {
    return this.state.items.get(getWorkbenchFileChangeFailureKey({ threadId, turnId, itemId }));
  }

  remember(threadId: string, turnId: string, item: WorkbenchFileChangeItem) {
    const key = getWorkbenchFileChangeFailureKey({ threadId, turnId, itemId: item.id });
    const previous = this.state.items.get(key);
    if (previous?.item.workbenchFailureKind === "unclaimed") return;
    this.state.items.set(key, {
      threadId, turnId,
      item: previous ? mergeWorkbenchFileChange(item, previous.item) : item,
      insertAfterItemId: previous ? previous.insertAfterItemId : this.state.turnCursors.get(`${threadId}\0${turnId}`) ?? null,
    });
    while (this.state.items.size > MAX_RETAINED_PATCHES) this.state.items.delete(this.state.items.keys().next().value!);
  }

  recordFailure(marker: WorkbenchFileChangeFailureMarker) {
    if (this.get(marker.threadId, marker.turnId, marker.item.id)?.item.workbenchFailureKind === "unclaimed") return false;
    this.remember(marker.threadId, marker.turnId, marker.item);
    return true;
  }

  recordTurnCursor(value: unknown) {
    const params = asRecord(value);
    const item = asRecord(params?.item);
    const itemId = asString(item?.id);
    const threadId = asString(params?.threadId);
    const turnId = asString(params?.turnId);
    if (!itemId || !threadId || !turnId) return;
    if (item?.type === "fileChange") this.remember(threadId, turnId, item as WorkbenchFileChangeItem);
    const key = `${threadId}\0${turnId}`;
    this.state.turnCursors.delete(key);
    this.state.turnCursors.set(key, itemId);
    while (this.state.turnCursors.size > MAX_RETAINED_PATCHES) this.state.turnCursors.delete(this.state.turnCursors.keys().next().value!);
  }

  clearTurnCursor(value: unknown) {
    const params = asRecord(value);
    const threadId = asString(params?.threadId);
    const turnId = asString(asRecord(params?.turn)?.id);
    if (threadId && turnId) this.state.turnCursors.delete(`${threadId}\0${turnId}`);
  }

  present<TMessage extends JsonRpcNotification | JsonRpcResponse>(message: TMessage): TMessage {
    const decorate = (item: WorkbenchFileChangeItem, marker: WorkbenchFileChangeFailureMarker) => (
      marker.item.workbenchFailureKind === "unclaimed" && item.status === "failed"
        ? withWorkbenchFileChangeFailure(item, "unclaimed")
        : mergeWorkbenchFileChange(item, marker.item)
    );
    if ("method" in message && (message.method === "item/completed" || message.method === "item/started")) {
      const params = asRecord(message.params);
      const item = asRecord(params?.item);
      if (item?.type !== "fileChange") return message;
      const threadId = asString(params?.threadId);
      const turnId = asString(params?.turnId);
      const itemId = asString(item.id);
      if (!threadId || !turnId || !itemId) return message;
      const marker = this.get(threadId, turnId, itemId);
      return marker ? { ...message, params: { ...params, item: decorate(item as WorkbenchFileChangeItem, marker) } } as TMessage : message;
    }
    if (!("result" in message)) return message;
    const result = asRecord(message.result);
    const thread = asRecord(result?.thread) as Thread | null;
    if (!thread?.id) return message;
    const markersByTurnId = new Map<string, WorkbenchFileChangeFailureMarker[]>();
    for (const marker of this.state.items.values()) {
      if (marker.threadId !== thread.id || (!marker.item.workbenchFailureKind && !marker.item.workbenchPolicy && !marker.item.changes.some((change) => change.workbenchAnalysis))) continue;
      const entries = markersByTurnId.get(marker.turnId) ?? [];
      entries.push(marker);
      markersByTurnId.set(marker.turnId, entries);
    }
    if (!markersByTurnId.size) return message;
    const turns = thread.turns.map((turn) => {
      const markers = markersByTurnId.get(turn.id);
      if (!markers?.length) return turn;
      const markerById = new Map(markers.map((marker) => [marker.item.id, marker]));
      const items = turn.items.map((item) => {
        const marker = markerById.get(item.id);
        return marker && item.type === "fileChange" ? decorate(item, marker) : item;
      });
      const itemIds = new Set(items.map((item) => item.id));
      const byAnchor = new Map<string | null, WorkbenchFileChangeFailureMarker[]>();
      const orphaned: WorkbenchFileChangeFailureMarker[] = [];
      for (const marker of markers.filter((entry) => !itemIds.has(entry.item.id))) {
        if (marker.insertAfterItemId !== null && !itemIds.has(marker.insertAfterItemId)) {
          orphaned.push(marker);
          continue;
        }
        const entries = byAnchor.get(marker.insertAfterItemId) ?? [];
        entries.push(marker);
        byAnchor.set(marker.insertAfterItemId, entries);
      }
      const ordered: ThreadItem[] = (byAnchor.get(null) ?? []).map((marker) => marker.item);
      for (const item of items) {
        ordered.push(item, ...(byAnchor.get(item.id) ?? []).map((marker) => marker.item));
      }
      ordered.push(...orphaned.map((marker) => marker.item));
      return { ...turn, items: ordered };
    });
    return { ...message, result: { ...result, thread: { ...thread, turns } } } as TMessage;
  }

  async analyse(target: CodexFileChangeTarget) {
    if (target.item.workbenchFailureKind === "unclaimed") return { item: target.item, recoveryText: "" };
    const observations = new Map<string, FileObservation>();
    const roots: string[] = [];
    let rootFailure: string | null = null;
    for (const root of target.roots) {
      try {
        roots.push(await fs.realpath(root));
      } catch (error) {
        rootFailure = `Validated workspace root could not be observed (${readFailure(error)}).`;
      }
    }
    const budget = { bytes: 0 };
    const resolvedObservations = new Map<string, FileObservation>();
    const paths = new Set(target.item.changes.flatMap((change) => [
      change.path, ...(change.kind.type === "update" && change.kind.move_path ? [change.kind.move_path] : []),
    ]));
    for (const [index, name] of [...paths].entries()) {
      if (index >= MAX_PATHS) {
        observations.set(name, unavailable("Patch exceeds the 128-path observation limit."));
        continue;
      }
      const resolved = path.resolve(target.cwd, name);
      const root = roots.filter((candidate) => within(resolved, candidate)).sort((left, right) => right.length - left.length)[0];
      if (!name || name.includes("\0") || (process.platform === "win32" && resolved.slice(path.parse(resolved).root.length).includes(":")) || !root) {
        observations.set(name, unavailable(rootFailure ?? "Target is outside validated workspace roots or has an unsafe path."));
        continue;
      }
      const key = comparable(resolved);
      const observation = resolvedObservations.get(key) ?? await readRegularFile(resolved, root, budget);
      resolvedObservations.set(key, observation);
      observations.set(name, observation);
    }
    const item: WorkbenchFileChangeItem = {
      ...target.item,
      changes: target.item.changes.map((change) => ({
        ...change,
        workbenchAnalysis: change.kind.type === "update" && change.kind.move_path
          && comparable(path.resolve(target.cwd, change.path)) === comparable(path.resolve(target.cwd, change.kind.move_path))
          ? { additions: 0, deletions: 0, detail: "Move resolves to the same source and destination.", hunks: [], outcome: "uncertain" }
          : analyseFileChange(change, observations),
      })),
    };
    return { item, recoveryText: recoveryText(target, item, observations) };
  }
}
