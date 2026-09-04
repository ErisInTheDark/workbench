/*
 * Exports:
 * - default WorkbenchSubagentStore: own parent-scoped durable subagent relationship metadata, legacy migration, and bounded cursor pages. Keywords: subagent, store, parent, relationship, pagination, migration.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type {
  WorkbenchHarness,
  WorkbenchSubagentRelationship,
} from "workbench-shared/types";
import AtomicJsonStore from "./AtomicJsonStore";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";
import {
  getProcessWorkbenchSubagentStoreState,
  type WorkbenchSubagentStoreState,
} from "./workbench-subagent-store-state";

interface StoredParentSubagents {
  nextDirectSubagentIndex: number;
  parentThreadId: string;
  schemaVersion: 4;
  subagents: Record<string, WorkbenchSubagentRelationship>;
}

type WorkbenchSubagentReservation = Omit<WorkbenchSubagentRelationship, "directSubagentIndex">;

interface SubagentCursor {
  createdAt: number;
  parentThreadId: string;
  projectId: string;
  threadId: string;
  version: 2;
}

interface WorkbenchSubagentShadowNotifier {
  replaceRelationships(relationships: readonly WorkbenchSubagentRelationship[]): void;
}

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 20;
const LOAD_CONCURRENCY = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeRelationship(value: unknown): WorkbenchSubagentRelationship | null {
  if (!isRecord(value)) return null;
  const harness = value.harness === "codex" || value.harness === "copilot" || value.harness === "opencode"
    ? value.harness
    : null;
  const strings = ["cwd", "name", "parentThreadId", "profileId", "profileName", "projectId", "threadId", "title"] as const;
  if (!harness || strings.some((key) => typeof value[key] !== "string" || !String(value[key]).trim())) return null;
  const createdAt = finiteNumber(value.createdAt, 0);
  const updatedAt = finiteNumber(value.updatedAt, createdAt);
  return {
    createdAt,
    cwd: String(value.cwd),
    directSubagentIndex: Number.isSafeInteger(value.directSubagentIndex) && Number(value.directSubagentIndex) >= 0
      ? Number(value.directSubagentIndex)
      : -1,
    harness,
    name: String(value.name),
    parentThreadId: String(value.parentThreadId),
    profileId: String(value.profileId),
    profileName: String(value.profileName),
    projectId: String(value.projectId),
    threadId: String(value.threadId),
    title: String(value.title),
    updatedAt,
  };
}

function compareSubagents(left: WorkbenchSubagentRelationship, right: WorkbenchSubagentRelationship) {
  return right.createdAt - left.createdAt
    || left.threadId.localeCompare(right.threadId);
}

function compareSubagentToCursor(record: WorkbenchSubagentRelationship, cursor: SubagentCursor) {
  return cursor.createdAt - record.createdAt
    || record.threadId.localeCompare(cursor.threadId);
}

function encodeCursor(record: WorkbenchSubagentRelationship): string {
  const cursor: SubagentCursor = {
    createdAt: record.createdAt,
    parentThreadId: record.parentThreadId,
    projectId: record.projectId,
    threadId: record.threadId,
    version: 2,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function stabilizeDirectSubagentIndexes(records: readonly WorkbenchSubagentRelationship[]) {
  const sorted = records.slice().sort((left, right) => left.createdAt - right.createdAt || left.threadId.localeCompare(right.threadId));
  const validIndexes = sorted
    .map(({ directSubagentIndex }) => directSubagentIndex)
    .filter((index) => index >= 0);
  let nextIndex = validIndexes.length ? Math.max(...validIndexes) + 1 : 0;
  const seenIndexes = new Set<number>();
  const recordsByThreadId = new Map<string, WorkbenchSubagentRelationship>();
  for (const record of sorted) {
    const directSubagentIndex = record.directSubagentIndex >= 0 && !seenIndexes.has(record.directSubagentIndex)
      ? record.directSubagentIndex
      : nextIndex++;
    seenIndexes.add(directSubagentIndex);
    recordsByThreadId.set(record.threadId, { ...record, directSubagentIndex });
  }
  return {
    nextDirectSubagentIndex: Math.max(nextIndex, ...Array.from(seenIndexes, (index) => index + 1), 0),
    records: records.map((record) => recordsByThreadId.get(record.threadId)!),
  };
}

function decodeCursor(value: string, parentThreadId: string, projectId: string): SubagentCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid subagent list cursor.");
  }
  if (
    !isRecord(parsed)
    || parsed.version !== 2
    || parsed.parentThreadId !== parentThreadId
    || parsed.projectId !== projectId
    || typeof parsed.threadId !== "string"
    || !parsed.threadId
    || typeof parsed.createdAt !== "number"
    || !Number.isFinite(parsed.createdAt)
  ) {
    throw new Error("Invalid subagent list cursor.");
  }
  return parsed as unknown as SubagentCursor;
}

async function mapWithConcurrency<T>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<void>) {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const value = values[nextIndex++];
      if (value !== undefined) await operation(value);
    }
  }));
}

export default class WorkbenchSubagentStore {
  private readonly directoryPath: string;
  private readonly jsonStore: AtomicJsonStore;
  private readonly legacyPath: string;
  private readonly state: WorkbenchSubagentStoreState;
  private readonly shadow?: WorkbenchSubagentShadowNotifier;

  constructor(
    storageRoot: string,
    options: {
      jsonStore?: AtomicJsonStore;
      shadow?: WorkbenchSubagentShadowNotifier;
      state?: WorkbenchSubagentStoreState;
    } = {},
  ) {
    const runtimePath = path.join(storageRoot, ".workbench", "runtime");
    this.directoryPath = path.join(runtimePath, "subagents");
    this.legacyPath = path.join(runtimePath, "subagents.json");
    this.jsonStore = options.jsonStore ?? new AtomicJsonStore();
    this.shadow = options.shadow;
    this.state = options.state ?? getProcessWorkbenchSubagentStoreState(storageRoot);
  }

  initialize() {
    this.state.initializationPromise ??= this.initializeStore();
    return this.state.initializationPromise;
  }

  async list({
    cursor,
    limit,
    parentThreadId,
    projectId,
  }: {
    cursor?: string | null;
    limit?: number | null;
    parentThreadId?: string | null;
    projectId: string;
  }) {
    await this.initialize();
    const normalizedParentThreadId = parentThreadId?.trim() ?? "";
    if (!normalizedParentThreadId) {
      if (cursor || limit !== null && limit !== undefined) throw new Error("Subagent pagination requires parentThreadId.");
      const subagents = Array.from(this.state.parents.values())
        .flatMap((records) => Array.from(records.values()))
        .filter((record) => record.projectId === projectId && !record.threadId.startsWith("pending:"))
        .sort((left, right) => left.createdAt - right.createdAt || left.threadId.localeCompare(right.threadId));
      return { nextCursor: null, subagents };
    }

    const pageLimit = limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_PAGE_LIMIT) {
      throw new Error(`Subagent list limit must be between 1 and ${MAX_PAGE_LIMIT}.`);
    }
    const records = Array.from(this.state.parents.get(normalizedParentThreadId)?.values() ?? [])
      .filter((record) => record.projectId === projectId && !record.threadId.startsWith("pending:"))
      .sort(compareSubagents);
    const decodedCursor = cursor?.trim() ? decodeCursor(cursor.trim(), normalizedParentThreadId, projectId) : null;
    const startIndex = decodedCursor
      ? (() => {
        const index = records.findIndex((record) => compareSubagentToCursor(record, decodedCursor) > 0);
        return index < 0 ? records.length : index;
      })()
      : 0;
    const subagents = records.slice(startIndex, startIndex + pageLimit);
    const hasMore = startIndex + subagents.length < records.length;
    return {
      nextCursor: hasMore && subagents.length ? encodeCursor(subagents[subagents.length - 1]!) : null,
      subagents,
    };
  }

  async reserve(record: WorkbenchSubagentReservation) {
    await this.initialize();
    return await this.enqueueParent(record.parentThreadId, async () => {
      const records = this.parentRecords(record.parentThreadId);
      if (Array.from(records.values()).some((entry) => entry.name.toLocaleLowerCase() === record.name.toLocaleLowerCase())) {
        throw new Error(`Subagent name is already in use by this parent: ${record.name}`);
      }
      const indexedRecord: WorkbenchSubagentRelationship = {
        ...record,
        directSubagentIndex: this.nextDirectSubagentIndex(record.parentThreadId),
      };
      records.set(record.threadId, indexedRecord);
      await this.persistParent(record.parentThreadId);
      return indexedRecord;
    });
  }

  async replace(parentThreadId: string, previousThreadId: string, record: WorkbenchSubagentRelationship) {
    await this.initialize();
    await this.enqueueParent(parentThreadId, async () => {
      const records = this.parentRecords(parentThreadId);
      records.delete(previousThreadId);
      records.set(record.threadId, record);
      await this.persistParent(parentThreadId);
    });
  }

  async remove(parentThreadId: string, threadId: string) {
    await this.initialize();
    await this.enqueueParent(parentThreadId, async () => {
      const records = this.state.parents.get(parentThreadId);
      if (!records?.delete(threadId)) return;
      await this.persistParent(parentThreadId);
    });
  }

  async getOwned(parentThreadId: string, projectId: string, threadId: string) {
    await this.initialize();
    const record = this.state.parents.get(parentThreadId)?.get(threadId) ?? null;
    return record?.projectId === projectId ? record : null;
  }

  async getOwnedMany(parentThreadId: string, projectId: string, threadIds: readonly string[]) {
    const records = await Promise.all(threadIds.map((threadId) => this.getOwned(parentThreadId, projectId, threadId)));
    return records.every((record): record is WorkbenchSubagentRelationship => Boolean(record)) ? records : null;
  }

  async waitForIdle() {
    await this.initialize();
    await Promise.allSettled(Array.from(this.state.operations.values()));
    return this.jsonStore.waitForIdle();
  }

  private async initializeStore() {
    await fs.mkdir(this.directoryPath, { recursive: true });
    const entries = await fs.readdir(this.directoryPath, { withFileTypes: true });
    const fileNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
    await mapWithConcurrency(fileNames, LOAD_CONCURRENCY, async (fileName) => {
      const raw = await this.jsonStore.read<unknown>(path.join(this.directoryPath, fileName), null);
      const stored = this.normalizeParent(raw);
      if (stored) {
        this.installParent(stored.parentThreadId, Object.values(stored.subagents), stored.nextDirectSubagentIndex);
        if (!isRecord(raw) || raw.schemaVersion !== 4) await this.persistParent(stored.parentThreadId);
      }
    });
    await this.migrateLegacyStore();
    this.publishShadowRelationships();
  }

  private async migrateLegacyStore() {
    const raw = await this.jsonStore.read<unknown>(this.legacyPath, null);
    if (!isRecord(raw) || !isRecord(raw.subagents)) return;
    const grouped = new Map<string, WorkbenchSubagentRelationship[]>();
    for (const value of Object.values(raw.subagents)) {
      const record = normalizeRelationship(value);
      if (!record) continue;
      grouped.set(record.parentThreadId, [...(grouped.get(record.parentThreadId) ?? []), record]);
    }
    for (const [parentThreadId, records] of grouped) {
      const existing = new Map(this.parentRecords(parentThreadId));
      for (const record of records) {
        const previous = existing.get(record.threadId);
        if (!previous || record.updatedAt >= previous.updatedAt) existing.set(record.threadId, record);
      }
      const stabilized = stabilizeDirectSubagentIndexes(Array.from(existing.values()));
      this.installParent(parentThreadId, stabilized.records, Math.max(
        this.state.nextDirectSubagentIndexes.get(parentThreadId) ?? 0,
        stabilized.nextDirectSubagentIndex,
      ));
      await this.persistParent(parentThreadId);
    }
    await fs.rm(this.legacyPath, { force: true });
  }

  private normalizeParent(value: unknown): StoredParentSubagents | null {
    if (!isRecord(value) || typeof value.parentThreadId !== "string" || !value.parentThreadId.trim() || !isRecord(value.subagents)) return null;
    const normalizedRecords = Object.values(value.subagents)
      .flatMap((entry) => normalizeRelationship(entry) ?? [])
      .filter((record) => record.parentThreadId === value.parentThreadId);
    const stabilized = stabilizeDirectSubagentIndexes(normalizedRecords);
    const storedNextIndex = Number.isSafeInteger(value.nextDirectSubagentIndex) && Number(value.nextDirectSubagentIndex) >= 0
      ? Number(value.nextDirectSubagentIndex)
      : 0;
    return {
      nextDirectSubagentIndex: Math.max(storedNextIndex, stabilized.nextDirectSubagentIndex),
      parentThreadId: value.parentThreadId,
      schemaVersion: 4,
      subagents: Object.fromEntries(stabilized.records.map((record) => [record.threadId, record])),
    };
  }

  private installParent(parentThreadId: string, summaries: readonly WorkbenchSubagentRelationship[], nextDirectSubagentIndex?: number) {
    const records = new Map(summaries.map((record) => [record.threadId, record]));
    this.state.parents.set(parentThreadId, records);
    this.state.nextDirectSubagentIndexes.set(parentThreadId, Math.max(
      nextDirectSubagentIndex ?? 0,
      ...summaries.map(({ directSubagentIndex }) => directSubagentIndex + 1),
    ));
  }

  private nextDirectSubagentIndex(parentThreadId: string) {
    const index = this.state.nextDirectSubagentIndexes.get(parentThreadId) ?? 0;
    this.state.nextDirectSubagentIndexes.set(parentThreadId, index + 1);
    return index;
  }

  private parentRecords(parentThreadId: string) {
    let records = this.state.parents.get(parentThreadId);
    if (!records) {
      records = new Map();
      this.state.parents.set(parentThreadId, records);
    }
    return records;
  }

  private async enqueueParent<TValue>(parentThreadId: string, operation: () => Promise<TValue>) {
    const previous = this.state.operations.get(parentThreadId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(() => undefined, () => undefined);
    this.state.operations.set(parentThreadId, completion);
    try {
      return await result;
    } finally {
      if (this.state.operations.get(parentThreadId) === completion) this.state.operations.delete(parentThreadId);
    }
  }

  private parentPath(parentThreadId: string) {
    return path.join(this.directoryPath, `${encodeTranscriptPathSegment(parentThreadId)}.json`);
  }

  private async persistParent(parentThreadId: string) {
    const records = this.parentRecords(parentThreadId);
    const stored: StoredParentSubagents = {
      nextDirectSubagentIndex: this.state.nextDirectSubagentIndexes.get(parentThreadId) ?? 0,
      parentThreadId,
      schemaVersion: 4,
      subagents: Object.fromEntries(records),
    };
    await this.jsonStore.update(this.parentPath(parentThreadId), {
      nextDirectSubagentIndex: 0,
      parentThreadId,
      schemaVersion: 4,
      subagents: {},
    }, () => stored);
    this.publishShadowRelationships();
  }

  private publishShadowRelationships() {
    const relationships = Array.from(this.state.parents.values())
      .flatMap((records) => Array.from(records.values()))
      .sort((left, right) => (
        left.projectId.localeCompare(right.projectId)
        || left.harness.localeCompare(right.harness)
        || left.threadId.localeCompare(right.threadId)
      ));
    this.shadow?.replaceRelationships(relationships);
  }
}
