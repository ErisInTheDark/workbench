/* No production exports. Tests protect scoped proposal reads and receipt-history semantics and read costs. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHECKPOINT_METADATA_MARKER,
  checkpointMessage,
  checkpointNamespace,
  legacyCheckpointNamespace,
  legacyProposalNamespace,
  outcomeRef,
  proposalMessage,
  proposalNamespace,
  type ProposalMetadata,
} from "workbench-shared/workbench/git/git-arc-storage";
import GitCheckpointStore from "./GitCheckpointStore";
import GitArcProposalController from "./GitArcProposalController";
import { COMMIT_REWRITE_MAP_REF } from "./GitArcHistoryRewriter";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import type { GitBlobBatch, GitCommitBatch, GitCommitIdentity } from "./WorkbenchGitRepository";

function proposalMetadata(
  proposalId: string,
  status: ProposalMetadata["status"],
  committedSha: string | null,
): ProposalMetadata {
  return {
    amendTargetSha: null,
    baseCommit: "b".repeat(40),
    committedSha,
    description: "",
    liveBaseCommit: "b".repeat(40),
    livePaths: ["changed.ts"],
    mode: "commit",
    paths: ["changed.ts"],
    proposalId,
    sourceCheckpoint: "c".repeat(40),
    status,
    supersededByProposalId: null,
    supersededBySha: null,
    title: proposalId,
    unavailableReason: null,
    version: 2,
  };
}

function commitIdentity(message: string): GitCommitIdentity {
  return {
    authorDate: "0 +0000",
    authorEmail: "agent@example.com",
    authorName: "agent",
    committerDate: "0 +0000",
    committerEmail: "agent@example.com",
    committerName: "agent",
    message,
    parents: [],
    signed: false,
    tree: "d".repeat(40),
  };
}

class FakeProposalRepository {
  readonly commitReads: string[][] = [];
  readonly namespaceReads: string[][] = [];

  constructor(
    private readonly refs: Array<{ ref: string; value: string }>,
    private readonly commits: ReadonlyMap<string, GitCommitIdentity>,
  ) {}

  async listRefsWithValues(...namespaces: string[]) {
    this.namespaceReads.push(namespaces);
    return this.refs.filter(({ ref }) => namespaces.some((namespace) => (
      ref === namespace || ref.startsWith(`${namespace}/`)
    ))).map((entry) => ({ ...entry, objectType: "commit" }));
  }

  async readCommits(commits: string[]): Promise<GitCommitBatch> {
    this.commitReads.push(commits);
    return {
      commits: new Map(commits.flatMap((commit) => {
        const identity = this.commits.get(commit);
        return identity ? [[commit, identity]] : [];
      })),
      errors: new Map(),
    };
  }
}

test("proposal summary groups read only the requested thread proposal namespaces", async () => {
  const canonical = proposalNamespace("codex", "target-thread");
  const legacy = legacyProposalNamespace("target-thread");
  const proposedCommit = "1".repeat(40);
  const committedCommit = "2".repeat(40);
  const committedSha = "3".repeat(40);
  const repository = new FakeProposalRepository([
    { ref: `${canonical}/proposal-one`, value: proposedCommit },
    { ref: `${legacy}/proposal-two`, value: committedCommit },
    { ref: `${proposalNamespace("codex", "unrelated-thread")}/unrelated`, value: "4".repeat(40) },
  ], new Map([
    [proposedCommit, commitIdentity(proposalMessage(proposalMetadata("proposal-one", "proposed", null)))],
    [committedCommit, commitIdentity(proposalMessage(proposalMetadata("proposal-two", "committed", committedSha)))],
  ]));
  const store = new GitCheckpointStore(repository as unknown as WorkbenchGitRepository);

  const summaries = await store.readProposalSummaryGroups([{
    harness: "codex",
    proposalIds: ["proposal-one", "proposal-two", "proposal-one"],
    threadId: "target-thread",
  }]);

  assert.deepEqual(repository.namespaceReads, [[canonical, legacy]]);
  assert.deepEqual(repository.commitReads, [[proposedCommit, committedCommit]]);
  assert.deepEqual(summaries, [[
    { committedSha: null, proposalId: "proposal-one", status: "proposed" },
    { committedSha, proposalId: "proposal-two", status: "committed" },
  ]]);
});

test("proposal summary groups with no proposal ids do not enumerate refs", async () => {
  const repository = new FakeProposalRepository([], new Map());
  const store = new GitCheckpointStore(repository as unknown as WorkbenchGitRepository);

  assert.deepEqual(await store.readProposalSummaryGroups([
    { harness: "codex", proposalIds: [], threadId: "one" },
    { harness: "opencode", proposalIds: [], threadId: "two" },
  ]), [[], []]);
  assert.deepEqual(repository.namespaceReads, []);
  assert.deepEqual(repository.commitReads, []);
});

class HistoryRepository extends WorkbenchGitRepository {
  readonly identities = new Map<string, GitCommitIdentity>();
  readonly refs = new Map<string, string>();
  readonly outcomes = new Map<string, string>();
  reads = 0;

  constructor(length: number) {
    super(pathForHistory);
    for (let index = 1; index <= length; index += 1) {
      const commit = historyCommit(index);
      this.refs.set(`${checkpointNamespace("codex", "history")}/${index}`, commit);
      this.identities.set(commit, commitIdentity(checkpointMessage({
          amendedFrom: index > 1 ? historyCommit(index - 1) : null,
          kind: index === 1 ? "plan" : "arc",
          scopePaths: ["selected.txt"],
          version: 3,
      })));
    }
  }

  async readCommitAt(commit: string) {
    this.reads += 1;
    const identity = this.identities.get(commit);
    return identity ? { commit, identity } : null;
  }

  async readCommitRef(commit: string, ...namespaces: string[]) {
    this.reads += 1;
    const ref = [...this.refs].find(([ref, value]) => (
      value === commit && namespaces.some((namespace) => ref.startsWith(`${namespace}/`))
    ))?.[0];
    const identity = this.identities.get(commit);
    return ref && identity ? { commit, identity, ref } : null;
  }

  async refsPointingAt(commit: string, ...namespaces: string[]) {
    this.reads += 1;
    return [...this.refs].filter(([ref, value]) => (
      value === commit && namespaces.some((namespace) => ref.startsWith(`${namespace}/`))
    )).map(([ref]) => ref);
  }

  async readBlobAtRef(ref: string) {
    this.reads += 1;
    const contents = this.outcomes.get(ref);
    return contents === undefined ? null : { blob: "f".repeat(40), contents };
  }

  async currentHead() {
    this.reads += 1;
    return "e".repeat(40);
  }

  async listRefsWithValues(...namespaces: string[]) {
    this.reads += 1;
    return [...this.refs].filter(([ref]) => namespaces.some((namespace) => (
      ref.startsWith(`${namespace}/`)
    ))).map(([ref, value]) => ({ objectType: "commit", ref, value }));
  }

  async readCommits(commits: string[]): Promise<GitCommitBatch> {
    this.reads += 1;
    return {
      commits: new Map(commits.flatMap((commit) => {
        const identity = this.identities.get(commit);
        return identity ? [[commit, identity]] : [];
      })),
      errors: new Map(),
    };
  }

  async readBlobs(refs: string[]): Promise<GitBlobBatch> {
    this.reads += 1;
    return {
      blobs: new Map(refs.map((ref) => {
        const contents = this.outcomes.get(ref);
        return [ref, contents === undefined ? null : { blob: "f".repeat(40), contents }];
      })),
      errors: new Map(),
    };
  }
}

const pathForHistory = process.cwd();
const historyCommit = (index: number) => index.toString(16).padStart(40, "0");

test("owned checkpoint metadata uses one repository lookup", async () => {
  const repository = new HistoryRepository(1);
  const checkpoint = await new GitCheckpointStore(repository).readCheckpoint("codex", "history", historyCommit(1));
  assert.equal(checkpoint.checkpointCommit, historyCommit(1));
  assert.equal(checkpoint.metadata?.kind, "plan");
  assert.ok(repository.reads <= 1, `owned checkpoint needed ${repository.reads} reads`);
});

test("receipt history reads do not grow one repository round trip per ancestor", async (context) => {
  const short = new HistoryRepository(4);
  const long = new HistoryRepository(32);
  let repository = short;
  context.mock.method(WorkbenchGitRepository, "open", async () => repository);
  const controller = new GitArcProposalController();
  assert.deepEqual(await controller.readAcceptedOutcomes({
    cwd: pathForHistory, threadId: "history", checkpointCommit: historyCommit(4),
  }), []);
  repository = long;
  assert.deepEqual(await controller.readAcceptedOutcomes({
    cwd: pathForHistory, threadId: "history", checkpointCommit: historyCommit(32),
  }), []);
  assert.ok(long.reads <= short.reads + 2, `history reads grew from ${short.reads} to ${long.reads}`);
});

test("receipt history preserves nearest ledgers through empty outcomes and ignores unvisited corruption", async (context) => {
  const repository = new HistoryRepository(8);
  context.mock.method(WorkbenchGitRepository, "open", async () => repository);
  const receipt = { commitSha: "a".repeat(40), headSha: "b".repeat(40), proposalId: "accepted" };
  for (const index of [3, 6, 7]) {
    repository.outcomes.set(outcomeRef("codex", "history", historyCommit(index)), JSON.stringify({
      acceptedProposals: index === 3 ? [receipt] : [],
      committedSha: null, proposalId: null, sourceCheckpoint: historyCommit(index),
      status: "continued", successorCheckpoint: historyCommit(index + 1), version: 1,
    }));
  }
  repository.outcomes.set(outcomeRef("codex", "history", historyCommit(1)), "invalid older outcome");
  const corrupt = historyCommit(90);
  repository.refs.set(`${checkpointNamespace("codex", "history")}/unvisited`, corrupt);
  repository.identities.set(corrupt, { ...repository.identities.get(historyCommit(1))!, message: `${CHECKPOINT_METADATA_MARKER}\n{` });
  repository.outcomes.set(outcomeRef("codex", "history", corrupt), "invalid unrelated outcome");

  const controller = new GitArcProposalController();
  const input = { cwd: pathForHistory, threadId: "history", checkpointCommit: historyCommit(8) };
  assert.deepEqual(await controller.readAcceptedOutcomes(input), [receipt]);
  const newer = { ...receipt, proposalId: "newer" };
  repository.outcomes.set(outcomeRef("codex", "history", historyCommit(7)), JSON.stringify({
    acceptedProposals: [newer], committedSha: null, proposalId: null, sourceCheckpoint: historyCommit(7),
    status: "continued", successorCheckpoint: historyCommit(8), version: 1,
  }));
  assert.deepEqual(await controller.readAcceptedOutcomes(input), [newer]);
  await assert.rejects(controller.readAcceptedOutcomes({ ...input, checkpointCommit: corrupt }), /metadata is invalid/u);
});

test("receipt history retains legacy ownership, alias resolution, plan boundaries and failures", async (context) => {
  const repository = new HistoryRepository(4);
  context.mock.method(WorkbenchGitRepository, "open", async () => repository);
  const controller = new GitArcProposalController();
  const input = { cwd: pathForHistory, threadId: "history", checkpointCommit: historyCommit(4) };
  repository.refs.delete(`${checkpointNamespace("codex", "history")}/2`);
  repository.refs.set(`${legacyCheckpointNamespace("history")}/2`, historyCommit(2));
  repository.outcomes.set(outcomeRef("codex", "history", historyCommit(2)), JSON.stringify({
    committedSha: "a".repeat(40), proposalId: "legacy", sourceCheckpoint: historyCommit(2),
    status: "committed", successorCheckpoint: null, version: 1,
  }));
  const expected = [{ commitSha: "a".repeat(40), headSha: "e".repeat(40), proposalId: "legacy" }];
  assert.deepEqual(await controller.readAcceptedOutcomes(input), expected);

  const alias = historyCommit(99);
  repository.identities.set(alias, repository.identities.get(historyCommit(4))!);
  repository.outcomes.set(COMMIT_REWRITE_MAP_REF, JSON.stringify({ [alias]: historyCommit(4) }));
  assert.deepEqual(await controller.readAcceptedOutcomes({ ...input, checkpointCommit: alias }), expected);

  repository.refs.delete(`${legacyCheckpointNamespace("history")}/2`);
  await assert.rejects(controller.readAcceptedOutcomes(input), /not in this thread\/worktree checkpoint timeline/u);
  repository.identities.delete(historyCommit(2));
  await assert.rejects(controller.readAcceptedOutcomes(input), /missing/u);
  repository.identities.set(historyCommit(3), {
    ...repository.identities.get(historyCommit(3))!,
    message: checkpointMessage({ amendedFrom: historyCommit(2), kind: "plan", scopePaths: [], version: 3 }),
  });
  assert.deepEqual(await controller.readAcceptedOutcomes(input), []);
});
