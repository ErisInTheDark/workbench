/*
 * Exports:
 * - default GitArcRegistry: own durable active arc claims and compare-and-swap registry transitions for one worktree. Keywords: git, arc, registry, claims, collision.
 * - GitArcIdentity/GitArcRegistryEntry/GitArcRegistryMutation: typed registry identities, entries, and prepared atomic transitions. Keywords: git, arc, registry, transaction.
 */
import WorkbenchGitRepository, { type GitRefUpdate } from "./WorkbenchGitRepository";

const REGISTRY_REF = "refs/worktree/workbench/active-arcs";

export interface GitArcIdentity {
  harness: string;
  threadId: string;
}

export interface GitArcRegistryEntry extends GitArcIdentity {
  checkpointCommit: string;
  claimedPaths: string[];
  intentDescription: string;
  intentName: string;
  proposalId: string | null;
  updatedAt: string;
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
  expectedCheckpointCommit: string;
}

function normalizeIdentityPart(value: string, label: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) throw new Error(`An arc ${label} is required.`);
  return normalized;
}

function identityKey(identity: GitArcIdentity) {
  return `${normalizeIdentityPart(identity.harness, "harness")}\0${normalizeIdentityPart(identity.threadId, "thread id")}`;
}

function pathsOverlap(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function parseState(contents: string): GitArcRegistryState {
  const parsed = JSON.parse(contents) as Partial<GitArcRegistryState>;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("The active arc registry is invalid.");
  return { entries: parsed.entries, version: 1 };
}

export default class GitArcRegistry {
  constructor(private readonly repository: WorkbenchGitRepository) {}

  async read() {
    const blob = await this.repository.readRef(REGISTRY_REF);
    if (!blob) return { blob: null, state: { entries: [], version: 1 } satisfies GitArcRegistryState };
    return { blob, state: parseState(await this.repository.readBlob(blob)) };
  }

  async find(identity: GitArcIdentity) {
    const { state } = await this.read();
    const key = identityKey(identity);
    return state.entries.find((entry) => identityKey(entry) === key) ?? null;
  }

  async list() {
    return (await this.read()).state.entries;
  }

  async prepareClaim(
    entry: Omit<GitArcRegistryEntry, "updatedAt">,
    options?: GitArcRegistryReplaceOptions,
  ): Promise<GitArcRegistryMutation> {
    const { blob, state } = await this.read();
    const key = identityKey(entry);
    const current = state.entries.find((candidate) => identityKey(candidate) === key) ?? null;
    if (options) {
      if (!current) throw new Error("This thread no longer owns an active Git arc.");
      if (current.checkpointCommit !== options.expectedCheckpointCommit) {
        throw new Error("This thread's active Git arc changed before the registry update completed.");
      }
    } else if (current) {
      if (current.checkpointCommit === entry.checkpointCommit) return { nextState: state, update: null };
      throw new Error("This thread already owns a different active Git arc.");
    }
    const collisions = state.entries
      .filter((candidate) => identityKey(candidate) !== key)
      .map((candidate): GitArcCollision => ({
        entry: candidate,
        overlaps: candidate.claimedPaths.flatMap((claimedPath) => entry.claimedPaths
          .filter((requestedPath) => pathsOverlap(claimedPath, requestedPath))
          .map((requestedPath) => ({ claimedPath, requestedPath }))),
      }))
      .filter((collision) => collision.overlaps.length > 0);
    if (collisions.length) throw new GitArcCollisionError(collisions);
    const nextEntry: GitArcRegistryEntry = { ...entry, updatedAt: new Date().toISOString() };
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
    const { blob, state } = await this.read();
    const key = identityKey(identity);
    const current = state.entries.find((candidate) => identityKey(candidate) === key) ?? null;
    if (options) {
      if (!current) throw new Error("This thread no longer owns an active Git arc.");
      if (current.checkpointCommit !== options.expectedCheckpointCommit) {
        throw new Error("This thread's active Git arc changed before the registry update completed.");
      }
    }
    if (!blob || !current) return null;
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

  async release(identity: GitArcIdentity) {
    const mutation = await this.prepareRelease(identity);
    if (mutation) await this.repository.updateRefs([mutation.update]);
  }
}
