/*
 * WorkbenchTranscriptCaptureGapEntry: bounded durable identity for one thread affected by failed shadow recording. Keywords: transcript, capture gap, thread.
 * WorkbenchTranscriptCaptureGapMarker: durable set of threads that cannot contribute to cutover evidence. Keywords: transcript, capture gap, marker.
 * WorkbenchTranscriptCaptureGapControllerOptions: filesystem and clock inputs for capture-gap ownership. Keywords: transcript, capture gap, lifecycle.
 * default WorkbenchTranscriptCaptureGapController: record shadow gaps, expose provider recovery work, and guard cutover only. Keywords: transcript, capture gap, recovery.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

import type { WorkbenchTranscriptCaptureGapObservation } from "./workbench-transcript-types.ts";

export interface WorkbenchTranscriptCaptureGapEntry {
  errorText: string;
  id: string;
  openedAt: number;
  recoverability: "provider" | "unrecoverable";
  threadId: string;
  turnId: string | null;
}

export interface WorkbenchTranscriptCaptureGapMarker {
  entries: WorkbenchTranscriptCaptureGapEntry[];
  version: 1;
}

export interface WorkbenchTranscriptCaptureGapControllerOptions {
  markerPath: string;
  now?: () => number;
  randomId?: () => string;
  resolveReference?: (
    reference: Pick<WorkbenchTranscriptCaptureGapEntry, "threadId" | "turnId">,
  ) => Promise<Pick<WorkbenchTranscriptCaptureGapEntry, "threadId" | "turnId">>;
}

const MAX_ERROR_TEXT_LENGTH = 500;

function boundedErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_TEXT_LENGTH);
}

function entriesEqual(
  left: WorkbenchTranscriptCaptureGapEntry,
  right: WorkbenchTranscriptCaptureGapEntry,
) {
  return left.errorText === right.errorText
    && left.id === right.id
    && left.openedAt === right.openedAt
    && left.recoverability === right.recoverability
    && left.threadId === right.threadId
    && left.turnId === right.turnId;
}

function isEntry(value: unknown): value is WorkbenchTranscriptCaptureGapEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<WorkbenchTranscriptCaptureGapEntry>;
  return typeof entry.id === "string"
    && entry.id.length > 0
    && typeof entry.threadId === "string"
    && entry.threadId.length > 0
    && (entry.turnId === null || typeof entry.turnId === "string")
    && typeof entry.openedAt === "number"
    && Number.isFinite(entry.openedAt)
    && (entry.recoverability === "provider" || entry.recoverability === "unrecoverable")
    && typeof entry.errorText === "string";
}

function isMarker(value: unknown): value is WorkbenchTranscriptCaptureGapMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Partial<WorkbenchTranscriptCaptureGapMarker>;
  return marker.version === 1
    && Array.isArray(marker.entries)
    && marker.entries.length > 0
    && marker.entries.every(isEntry)
    && new Set(marker.entries.map(({ threadId }) => threadId)).size === marker.entries.length
    && new Set(marker.entries.map(({ id }) => id)).size === marker.entries.length;
}

async function readMarker(markerPath: string) {
  try {
    const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    if (!isMarker(parsed)) throw new Error("Capture-gap marker has an invalid shape.");
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export default class WorkbenchTranscriptCaptureGapController {
  readonly #markerPath: string;
  readonly #now: NonNullable<WorkbenchTranscriptCaptureGapControllerOptions["now"]>;
  readonly #randomId: NonNullable<WorkbenchTranscriptCaptureGapControllerOptions["randomId"]>;
  readonly #resolveReference: WorkbenchTranscriptCaptureGapControllerOptions["resolveReference"];
  #pendingWrite = Promise.resolve();
  #marker: WorkbenchTranscriptCaptureGapMarker | null = null;
  #markerFailure: Error | null = null;
  #started = false;

  constructor({
    markerPath,
    now = Date.now,
    randomId = randomUUID,
    resolveReference,
  }: WorkbenchTranscriptCaptureGapControllerOptions) {
    this.#markerPath = markerPath;
    this.#now = now;
    this.#randomId = randomId;
    this.#resolveReference = resolveReference;
  }

  get cutoverFailure() {
    if (this.#markerFailure) return this.#markerFailure;
    return this.#marker
      ? new Error(`SQLite transcript shadow has capture gaps for ${this.#marker.entries.length} thread(s).`)
      : null;
  }

  get pendingRecoveryThreadIds() {
    return this.#marker?.entries
      .filter(({ recoverability }) => recoverability === "provider")
      .map(({ threadId }) => threadId)
      .sort((left, right) => left.localeCompare(right)) ?? [];
  }

  async start() {
    if (this.#started) return;
    try {
      this.#marker = await readMarker(this.#markerPath);
      await this.#resolveMarker();
    } catch (error) {
      this.#markerFailure = new Error(
        `SQLite transcript capture-gap marker is unreadable: ${boundedErrorText(error)}`,
        { cause: error },
      );
    }
    this.#started = true;
  }

  async prepareReferences() {
    this.#assertStarted();
    if (!this.#marker || !this.#resolveReference || this.#markerFailure) return;
    await this.#mutate(async () => {
      try {
        await this.#resolveMarker();
      } catch (error) {
        this.#markerFailure = new Error(
          `SQLite transcript capture-gap identity conversion failed: ${boundedErrorText(error)}`,
          { cause: error },
        );
        throw this.#markerFailure;
      }
    });
  }

  assertCutoverReady() {
    this.#assertStarted();
    const failure = this.cutoverFailure;
    if (failure) throw failure;
  }

  hasGap(threadId: string) {
    this.#assertStarted();
    if (this.#markerFailure) return true;
    return this.#marker?.entries.some((entry) => entry.threadId === threadId) ?? false;
  }

  async captureFailure(input: {
    error: unknown;
    recoverability: WorkbenchTranscriptCaptureGapEntry["recoverability"];
    threadId: string;
    turnId: string | null;
  }) {
    return await this.#mutate(async () => {
      if (this.#markerFailure) return await this.#captureFailure(input);
      try {
        await this.#resolveMarker();
        const reference = await this.#resolveReference?.(input) ?? input;
        return await this.#captureFailure({ ...input, ...reference });
      } catch (error) {
        this.#markerFailure = new Error(
          `SQLite transcript capture-gap identity conversion failed: ${boundedErrorText(error)}`,
          { cause: error },
        );
        return this.#markerFailure;
      }
    });
  }

  async #captureFailure({
    error,
    recoverability,
    threadId,
    turnId,
  }: {
    error: unknown;
    recoverability: WorkbenchTranscriptCaptureGapEntry["recoverability"];
    threadId: string;
    turnId: string | null;
  }) {
    this.#assertStarted();
    if (this.#markerFailure) {
      return new Error(
        `SQLite transcript settlement failed and its capture-gap marker is unavailable: ${boundedErrorText(error)}`,
        { cause: error },
      );
    }
    const existingMarker = this.#marker;
    const existingEntry = existingMarker?.entries.find((entry) => entry.threadId === threadId);
    const entry: WorkbenchTranscriptCaptureGapEntry = existingEntry
      ? {
        ...existingEntry,
        recoverability: existingEntry.recoverability === "unrecoverable" || recoverability === "unrecoverable"
          ? "unrecoverable"
          : "provider",
        turnId: existingEntry.turnId === turnId ? turnId : null,
      }
      : {
        errorText: boundedErrorText(error),
        id: this.#randomId(),
        openedAt: this.#now(),
        recoverability,
        threadId,
        turnId,
      };
    const marker: WorkbenchTranscriptCaptureGapMarker = {
      entries: [
        ...(existingMarker?.entries.filter((candidate) => candidate.threadId !== threadId) ?? []),
        entry,
      ].sort((left, right) => left.threadId.localeCompare(right.threadId)),
      version: 1,
    };
    if (!existingEntry || !entriesEqual(entry, existingEntry)) {
      try {
        await this.#writeMarker(marker);
      } catch (markerError) {
        this.#markerFailure = new Error(
          `SQLite transcript settlement and capture-gap marker write failed: ${boundedErrorText(markerError)}`,
          { cause: markerError },
        );
        return this.#markerFailure;
      }
    }
    this.#marker = marker;
    return new Error(`SQLite transcript shadow settlement failed for thread ${threadId}.`, { cause: error });
  }

  requireRecovery(threadId: string) {
    this.#assertStarted();
    const entry = this.#marker?.entries.find((candidate) => candidate.threadId === threadId);
    if (!entry) throw new Error(`SQLite transcript capture recovery has no entry for thread ${threadId}.`);
    if (entry.recoverability !== "provider") {
      throw new Error(`SQLite transcript capture gap for thread ${threadId} is not provider-recoverable.`);
    }
    return entry;
  }

  createRecoveryObservation(
    entry: WorkbenchTranscriptCaptureGapEntry,
    turnId: string | null,
  ): WorkbenchTranscriptCaptureGapObservation {
    this.#assertStarted();
    if (!this.#marker?.entries.some((candidate) => candidate.id === entry.id)) {
      throw new Error("SQLite transcript capture recovery marker changed before settlement.");
    }
    if (entry.recoverability !== "provider") {
      throw new Error(`SQLite transcript capture gap for thread ${entry.threadId} is not provider-recoverable.`);
    }
    return {
      closedAt: this.#now(),
      errorText: entry.errorText,
      gapId: entry.id,
      kind: "captureGap",
      openedAt: entry.openedAt,
      reason: "sqlite transcript settlement failed",
      state: "reconciled",
      threadId: entry.threadId,
      turnId,
    };
  }

  async completeRecovery(entry: WorkbenchTranscriptCaptureGapEntry) {
    return await this.#mutate(() => this.#completeRecovery(entry));
  }

  async #completeRecovery(entry: WorkbenchTranscriptCaptureGapEntry) {
    this.#assertStarted();
    const marker = this.#marker;
    if (!marker?.entries.some((candidate) => candidate.id === entry.id)) {
      throw new Error("SQLite transcript capture recovery marker changed before completion.");
    }
    if (marker.entries.find((candidate) => candidate.id === entry.id)?.recoverability !== "provider") {
      throw new Error(`SQLite transcript capture gap for thread ${entry.threadId} is not provider-recoverable.`);
    }
    const remaining = marker.entries.filter((candidate) => candidate.id !== entry.id);
    if (remaining.length) {
      const nextMarker = { ...marker, entries: remaining };
      await this.#writeMarker(nextMarker);
      this.#marker = nextMarker;
      return;
    }
    await rm(this.#markerPath);
    this.#marker = null;
  }

  async #resolveMarker() {
    if (!this.#marker || !this.#resolveReference) return;
    const entries = new Map<string, WorkbenchTranscriptCaptureGapEntry>();
    for (const previous of [...this.#marker.entries].sort((left, right) => left.openedAt - right.openedAt)) {
      const resolved = { ...previous, ...await this.#resolveReference(previous) };
      const existing = entries.get(resolved.threadId);
      entries.set(resolved.threadId, existing ? {
        ...existing,
        recoverability: existing.recoverability === "unrecoverable" || resolved.recoverability === "unrecoverable"
          ? "unrecoverable" : "provider",
        turnId: existing.turnId === resolved.turnId ? existing.turnId : null,
      } : resolved);
    }
    const next = [...entries.values()].sort((left, right) => left.threadId.localeCompare(right.threadId));
    if (next.length === this.#marker.entries.length
      && next.every((entry, index) => entriesEqual(entry, this.#marker!.entries[index]!))) return;
    const marker: WorkbenchTranscriptCaptureGapMarker = { version: 1, entries: next };
    await this.#writeMarker(marker);
    this.#marker = marker;
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pendingWrite.then(operation);
    // Each caller receives its failure. The tail only sequences the next marker mutation.
    this.#pendingWrite = result.then(() => undefined, () => undefined);
    return result;
  }

  #assertStarted() {
    if (!this.#started) throw new Error("SQLite transcript capture-gap controller is not started.");
  }

  async #writeMarker(marker: WorkbenchTranscriptCaptureGapMarker) {
    const temporaryPath = `${this.#markerPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, "utf8");
    await rename(temporaryPath, this.#markerPath);
  }
}
