/*
 * Exports:
 * - default GitArcRegistry: own durable active arc claims and compare-and-swap registry transitions for one worktree. Keywords: git, arc, registry, claims, collision.
 * - GitArcIdentity/GitArcRegistryEntry/GitArcRegistryMutation: typed registry identities, entries, and prepared atomic transitions. Keywords: git, arc, registry, transaction.
 * - findGitArcCollisions/getGitArcLiveClaimPaths: share exact live-claim semantics with diagnostics and registry enforcement. Keywords: git, arc, collision, overlap, diagnostics.
 */
import { areDeeplyEqual } from "../deep-equality";
import type { OrchestratorReloadScope } from "../../types";
import { gitArcPathsOverlap } from "./git-arc-paths";
import WorkbenchGitRepository, { type GitRefUpdate } from "./WorkbenchGitRepository";

export const REGISTRY_REF = "refs/worktree/workbench/active-arcs";

export interface GitArcIdentity {
  harness: string;
  threadId: string;
}

export interface GitArcRegistryEntry extends GitArcIdentity {
  checkpointCommit: string;
  claimedPaths: string[];
  intentDescription: string;
  intentName: string;
  phase?: "active" | "plan" | "resolved";
  proposalId?: string | null;
  proposalIds?: string[];
  reloadScopes?: OrchestratorReloadScope[];
  retainedArc?: {
    checkpointCommit: string;
    claimedPaths: string[];
    intentDescription: string;
    intentName: string;
    phase: "active" | "resolved";
    proposalIds: string[];
    reloadScopes?: OrchestratorReloadScope[];
  } | null;
  updatedAt: string;
}

export function getGitArcLiveClaimPaths(entry: Pick<GitArcRegistryEntry, "claimedPaths" | "phase" | "retainedArc">) {
  if (entry.phase === "resolved") return [];
  if (entry.phase === "plan") return entry.retainedArc?.claimedPaths ?? entry.claimedPaths;
  return entry.claimedPaths;
}

export interface GitArcCollision {
  entry: GitArcRegistryEntry;
  overlaps: Array<{ claimedPath: string; requestedPath: string }>;
}

export class GitArcCollisionError extends Error {
  constructor(readonly collisions: GitArcCollision[]) {
    const details = collisions.map(({ entry, overlaps }) => (
      `${entry.harness}/${entry.threadId} (${entry.intentName}): ${overlaps.map(({ claimedPath, requestedPath }) => `${claimedPath} <> ${requestedPath}`).join(", ")}`
    ));
    super(`Arc claims overlap active sibling work: ${details.join("; ")}`);
    this.name = "GitArcCollisionError";
  }
}

interface GitArcRegistryState {
  entries: GitArcRegistryEntry[];
  version: 1;
}

export interface GitArcRegistryMutation {
  nextState: GitArcRegistryState;
  update: GitRefUpdate | null;
}

export interface GitArcRegistryReplaceOptions {
  commitRemaps?: ReadonlyMap<string, string>;
  expectedCheckpointCommit?: string;
}

function normalizeIdentityPart(value: string, label: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) throw new Error(`An arc ${label} is required.`);
  return normalized;
}

function identityKey(identity: GitArcIdentity) {
  return `${normalizeIdentityPart(identity.harness, "harness")}\0${normalizeIdentityPart(identity.threadId, "thread id")}`;
}

export function findGitArcCollisions(
  entries: readonly GitArcRegistryEntry[],
  identity: GitArcIdentity,
  requestedPaths: readonly string[],
) {
  const key = identityKey(identity);
  return entries
    .filter((candidate) => identityKey(candidate) !== key)
    .filter((candidate) => getGitArcLiveClaimPaths(candidate).length > 0)
    .map((candidate): GitArcCollision => ({
      entry: candidate,
      overlaps: getGitArcLiveClaimPaths(candidate).flatMap((claimedPath) => requestedPaths
        .filter((requestedPath) => gitArcPathsOverlap(claimedPath, requestedPath))
        .map((requestedPath) => ({ claimedPath, requestedPath }))),
    }))
    .filter((collision) => collision.overlaps.length > 0);
}

function parseState(contents: string): GitArcRegistryState {
  const parsed = JSON.parse(contents) as Partial<GitArcRegistryState>;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("The active arc registry is invalid.");
  return {
    entries: parsed.entries.map((entry) => {
      const proposalIds = Array.isArray(entry.proposalIds)
        ? entry.proposalIds.filter((proposalId): proposalId is string => typeof proposalId === "string" && Boolean(proposalId.trim()))
        : entry.proposalId ? [entry.proposalId] : [];
      const phase = entry.phase ?? "active";
      const { reloadScopes: _storedReloadScopes, ...storedEntry } = entry;
      const retainedArc = entry.retainedArc;
      const storedRetainedArc = retainedArc ? (() => {
        const { reloadScopes: _storedRetainedReloadScopes, ...value } = retainedArc;
        return value;
      })() : null;
      return {
        ...storedEntry,
        claimedPaths: phase === "resolved" ? [] : entry.claimedPaths,
        phase,
        proposalId: proposalIds.at(-1) ?? null,
        proposalIds,
        retainedArc: storedRetainedArc ? {
          ...storedRetainedArc,
          intentDescription: entry.retainedArc.intentDescription ?? entry.intentDescription,
          intentName: entry.retainedArc.intentName ?? entry.intentName,
          phase: entry.retainedArc.phase ?? "active",
          proposalIds: entry.retainedArc.proposalIds ?? [],
        } : null,
      };
    }),
    version: 1,
  };
}

function remapState(state: GitArcRegistryState, commits?: ReadonlyMap<string, string>): GitArcRegistryState {
  if (!commits?.size) return state;
  return {
    entries: state.entries.map((entry) => ({
      ...entry,
      checkpointCommit: commits.get(entry.checkpointCommit) ?? entry.checkpointCommit,
      ...(entry.retainedArc ? {
        retainedArc: {
          ...entry.retainedArc,
          checkpointCommit: commits.get(entry.retainedArc.checkpointCommit) ?? entry.retainedArc.checkpointCommit,
        },
      } : {}),
    })),
    version: 1,
  };
}

export default class GitArcRegistry {
  constructor(private readonly repository: WorkbenchGitRepository) {}

  async read() {
    const resolved = await this.repository.readBlobAtRef(REGISTRY_REF);
    if (!resolved) return { blob: null, state: { entries: [], version: 1 } satisfies GitArcRegistryState };
    return { blob: resolved.blob, state: parseState(resolved.contents) };
  }

  async find(identity: GitArcIdentity) {
    const { state } = await this.read();
    const key = identityKey(identity);
    return state.entries.find((entry) => identityKey(entry) === key) ?? null;
  }

  async list() {
    return (await this.read()).state.entries;
  }

  async prepareCommitRemap(commits: ReadonlyMap<string, string>) {
    const { blob, state } = await this.read();
    if (!blob) return null;
    const entries = remapState(state, commits).entries;
    if (areDeeplyEqual(entries, state.entries)) return null;
    const nextBlob = await this.repository.writeBlob(`${JSON.stringify({ entries, version: 1 } satisfies GitArcRegistryState)}\n`);
    return { newValue: nextBlob, oldValue: blob, ref: REGISTRY_REF };
  }

  async prepareClaim(
    entry: Omit<GitArcRegistryEntry, "updatedAt">,
    options?: GitArcRegistryReplaceOptions,
  ): Promise<GitArcRegistryMutation> {
    const { blob, state: storedState } = await this.read();
    const key = identityKey(entry);
    const current = storedState.entries.find((candidate) => identityKey(candidate) === key) ?? null;
    const state = remapState(storedState, options?.commitRemaps);
    if (options?.expectedCheckpointCommit) {
      if (!current) throw new Error("This thread no longer owns an active Git arc.");
      if (current.checkpointCommit !== options.expectedCheckpointCommit) {
        throw new Error("This thread's active Git arc changed before the registry update completed.");
      }
    } else if (current) {
      if (current.checkpointCommit === entry.checkpointCommit) return { nextState: state, update: null };
      throw new Error("This thread already owns a different active Git arc.");
    }
    const collisions = findGitArcCollisions(state.entries, entry, getGitArcLiveClaimPaths(entry));
    if (collisions.length) throw new GitArcCollisionError(collisions);
    const proposalIds = entry.proposalIds ?? (entry.proposalId ? [entry.proposalId] : []);
    const { reloadScopes: _inputReloadScopes, ...storedEntry } = entry;
    const nextEntry: GitArcRegistryEntry = {
      ...storedEntry,
      phase: entry.phase ?? "active",
      proposalId: proposalIds.at(-1) ?? null,
      proposalIds,
      retainedArc: entry.retainedArc ?? null,
      updatedAt: new Date().toISOString(),
    };
    const entries = [...state.entries.filter((candidate) => identityKey(candidate) !== key), nextEntry]
      .sort((left, right) => identityKey(left).localeCompare(identityKey(right)));
    const nextState = { entries, version: 1 } satisfies GitArcRegistryState;
    const nextBlob = await this.repository.writeBlob(`${JSON.stringify(nextState)}\n`);
    return {
      nextState,
      update: { newValue: nextBlob, oldValue: blob ?? "0".repeat(40), ref: REGISTRY_REF },
    };
  }

  async prepareRelease(identity: GitArcIdentity, options?: GitArcRegistryReplaceOptions): Promise<GitArcRegistryMutation | null> {
    const { blob, state: storedState } = await this.read();
    const key = identityKey(identity);
    const current = storedState.entries.find((candidate) => identityKey(candidate) === key) ?? null;
    if (options?.expectedCheckpointCommit) {
      if (!current) throw new Error("This thread no longer owns an active Git arc.");
      if (current.checkpointCommit !== options.expectedCheckpointCommit) {
        throw new Error("This thread's active Git arc changed before the registry update completed.");
      }
    }
    if (!blob || !current) return null;
    const state = remapState(storedState, options?.commitRemaps);
    const entries = state.entries.filter((candidate) => identityKey(candidate) !== key);
    const nextState = { entries, version: 1 } satisfies GitArcRegistryState;
    const nextBlob = await this.repository.writeBlob(`${JSON.stringify(nextState)}\n`);
    return { nextState, update: { newValue: nextBlob, oldValue: blob, ref: REGISTRY_REF } };
  }

  async claim(entry: Omit<GitArcRegistryEntry, "updatedAt">) {
    const mutation = await this.prepareClaim(entry);
    if (mutation.update) await this.repository.updateRefs([mutation.update]);
    return mutation.nextState.entries.find((candidate) => identityKey(candidate) === identityKey(entry))!;
  }

  async set(entry: Omit<GitArcRegistryEntry, "updatedAt">, expectedCheckpointCommit?: string) {
    const mutation = await this.prepareSet(entry, expectedCheckpointCommit);
    if (mutation.update) await this.repository.updateRefs([mutation.update]);
    return mutation.nextState.entries.find((candidate) => identityKey(candidate) === identityKey(entry))!;
  }

  async prepareSet(entry: Omit<GitArcRegistryEntry, "updatedAt">, expectedCheckpointCommit?: string): Promise<GitArcRegistryMutation> {
    const { blob, state } = await this.read();
    const key = identityKey(entry);
    const current = state.entries.find((candidate) => identityKey(candidate) === key) ?? null;
    if (expectedCheckpointCommit && current?.checkpointCommit !== expectedCheckpointCommit) {
      throw new Error("This thread's current Git arc changed before the registry update completed.");
    }
    const proposalIds = entry.proposalIds ?? (entry.proposalId ? [entry.proposalId] : []);
    const { reloadScopes: _inputReloadScopes, ...storedEntry } = entry;
    const nextEntry: GitArcRegistryEntry = {
      ...storedEntry,
      claimedPaths: entry.phase === "resolved" ? [] : entry.claimedPaths,
      phase: entry.phase ?? "active",
      proposalId: proposalIds.at(-1) ?? null,
      proposalIds,
      retainedArc: entry.retainedArc ?? null,
      updatedAt: new Date().toISOString(),
    };
    const entries = [...state.entries.filter((candidate) => identityKey(candidate) !== key), nextEntry]
      .sort((left, right) => identityKey(left).localeCompare(identityKey(right)));
    const nextBlob = await this.repository.writeBlob(`${JSON.stringify({ entries, version: 1 } satisfies GitArcRegistryState)}\n`);
    return {
      nextState: { entries, version: 1 },
      update: { newValue: nextBlob, oldValue: blob ?? "0".repeat(40), ref: REGISTRY_REF },
    };
  }

  async release(identity: GitArcIdentity) {
    const mutation = await this.prepareRelease(identity);
    if (mutation) await this.repository.updateRefs([mutation.update]);
  }
}
