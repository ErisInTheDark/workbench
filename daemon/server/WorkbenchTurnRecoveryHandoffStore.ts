/*
 * Exports:
 * - WorkbenchObservedTurnCandidate: live provider-neutral turn-start state.
 * - WorkbenchTurnRecoveryHandoffCandidate/WorkbenchTurnRecoveryHandoff: versioned manual-resume state.
 * - createCodexTurnRecoveryResumeRequest: derive a cold-resume request from a captured turn start.
 * - WorkbenchRecoveryHarness: retained provider identity, independent of recovery availability.
 * - default WorkbenchTurnRecoveryHandoffStore: validate, update and remove bounded recovery handoffs atomically.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { WorkbenchHarness } from "workbench-shared/types";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import type { JsonRpcRequest } from "./bridge-types";
import { WORKBENCH_THREAD_RECOVERY_ID_PREFIX } from "workbench-shared/workbench/thread/thread-recovery-message";

export type WorkbenchRecoveryHarness = WorkbenchHarness;

export interface WorkbenchObservedTurnCandidate {
  goalOwned?: boolean;
  harness: WorkbenchHarness;
  key: string;
  lastEventAt: number;
  request: JsonRpcRequest;
  recoveryId: string;
  resumeRequest?: JsonRpcRequest | null;
  startedAt: number;
  threadId: string;
  turnId: string | null;
}

export interface WorkbenchTurnRecoveryHandoffCandidate extends WorkbenchObservedTurnCandidate {
  harness: WorkbenchRecoveryHarness;
}

export interface WorkbenchTurnRecoveryHandoff {
  candidates: WorkbenchTurnRecoveryHandoffCandidate[];
  createdAt: number;
  generation: string;
  id: string;
  kind: "manual-resume";
  schemaVersion: 2;
}

const MAX_HANDOFF_AGE_MS = 10 * 60 * 1000;
const MAX_HANDOFF_CANDIDATES = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value)) return false;
  const params = isRecord(value.params) ? value.params : null;
  return value.method === "turn/start"
    && typeof value.id !== "undefined"
    && Array.isArray(params?.input)
    && typeof params?.threadId === "string";
}

function isResumeRequest(value: unknown, threadId: string): value is JsonRpcRequest {
  if (!isRecord(value)) return false;
  const params = isRecord(value.params) ? value.params : null;
  return value.method === "thread/resume" && params?.threadId === threadId;
}

export function createCodexTurnRecoveryResumeRequest(request: JsonRpcRequest, threadId: string): JsonRpcRequest {
  const params = isRecord(request.params) ? request.params : {};
  const { id: _id, method: _method, params: _params, ...extensions } = request;
  return {
    ...extensions,
    method: "thread/resume",
    params: {
      ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
      ...(typeof params.model === "string" ? { model: params.model } : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "serviceTier") ? { serviceTier: params.serviceTier } : {}),
      threadId,
    },
  };
}

function readCandidate(value: unknown): WorkbenchTurnRecoveryHandoffCandidate | null {
  if (!isRecord(value)) return null;
  const harness = value.harness;
  if (!ProviderKeySchema.safeParse(harness).success) return null;
  if (
    typeof value.key !== "string"
    || !Number.isFinite(value.lastEventAt)
    || !isRequest(value.request)
    || typeof value.recoveryId !== "string"
    || !value.recoveryId.startsWith(WORKBENCH_THREAD_RECOVERY_ID_PREFIX)
    || !Number.isFinite(value.startedAt)
    || typeof value.threadId !== "string"
    || !(typeof value.turnId === "string" || value.turnId === null)
  ) return null;
  const requestParams = isRecord(value.request.params) ? value.request.params : null;
  if (value.key !== `${harness}:${value.threadId}` || requestParams?.threadId !== value.threadId) return null;
  let resumeRequest: JsonRpcRequest | null = null;
  if (harness === "codex") {
    if (isResumeRequest(value.resumeRequest, value.threadId)) resumeRequest = value.resumeRequest;
    else if (value.resumeRequest === undefined) resumeRequest = createCodexTurnRecoveryResumeRequest(value.request, value.threadId);
    else return null;
  } else if (value.resumeRequest !== null && value.resumeRequest !== undefined) {
    return null;
  }
  return {
    ...(value as unknown as WorkbenchTurnRecoveryHandoffCandidate),
    resumeRequest,
  };
}

export default class WorkbenchTurnRecoveryHandoffStore {
  readonly filePath: string;

  constructor(storageRoot: string) {
    this.filePath = path.join(storageRoot, ".workbench", "runtime", "turn-recovery-handoff.json");
  }

  async load(now = Date.now()): Promise<WorkbenchTurnRecoveryHandoff | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      await this.remove();
      return null;
    }
    if (
      !isRecord(parsed)
      || parsed.schemaVersion !== 2
      || parsed.kind !== "manual-resume"
      || typeof parsed.createdAt !== "number"
      || !Number.isFinite(parsed.createdAt)
      || typeof parsed.generation !== "string"
      || !parsed.generation.startsWith(WORKBENCH_THREAD_RECOVERY_ID_PREFIX)
      || typeof parsed.id !== "string"
      || !parsed.id.startsWith(WORKBENCH_THREAD_RECOVERY_ID_PREFIX)
      || !Array.isArray(parsed.candidates)
    ) {
      await this.remove();
      return null;
    }
    if (parsed.createdAt > now || now - parsed.createdAt > MAX_HANDOFF_AGE_MS || parsed.candidates.length > MAX_HANDOFF_CANDIDATES) {
      await this.remove();
      return null;
    }
    const candidates = parsed.candidates.map(readCandidate);
    if (candidates.some((candidate) => candidate === null)) {
      await this.remove();
      return null;
    }
    const typedCandidates = candidates as WorkbenchTurnRecoveryHandoffCandidate[];
    if (new Set(typedCandidates.map((candidate) => candidate.key)).size !== typedCandidates.length) {
      await this.remove();
      return null;
    }
    return { candidates: typedCandidates, createdAt: parsed.createdAt, generation: parsed.generation, id: parsed.id, kind: "manual-resume", schemaVersion: 2 };
  }

  async write(handoff: WorkbenchTurnRecoveryHandoff) {
    if (handoff.candidates.length > MAX_HANDOFF_CANDIDATES) {
      throw new Error(`Recovery handoff exceeds the ${MAX_HANDOFF_CANDIDATES}-thread safety limit.`);
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(handoff)}\n`, "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }

  async updateCandidates(handoff: WorkbenchTurnRecoveryHandoff, candidates: WorkbenchTurnRecoveryHandoffCandidate[]) {
    if (!candidates.length) {
      await this.remove();
      return;
    }
    await this.write({ ...handoff, candidates });
  }

  async remove() {
    await fs.rm(this.filePath, { force: true });
  }
}
