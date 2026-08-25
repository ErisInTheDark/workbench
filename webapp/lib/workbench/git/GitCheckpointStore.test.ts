/* No production exports. Tests protect proposal summary reads from unrelated agent-ref history. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  legacyProposalNamespace,
  proposalMessage,
  proposalNamespace,
  type ProposalMetadata,
} from "./git-arc-storage";
import GitCheckpointStore from "./GitCheckpointStore";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";
import type { GitCommitBatch, GitCommitIdentity } from "./WorkbenchGitRepository";

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

function proposalIdentity(metadata: ProposalMetadata): GitCommitIdentity {
  return {
    authorDate: "0 +0000",
    authorEmail: "agent@example.com",
    authorName: "agent",
    committerDate: "0 +0000",
    committerEmail: "agent@example.com",
    committerName: "agent",
    message: proposalMessage(metadata),
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
    [proposedCommit, proposalIdentity(proposalMetadata("proposal-one", "proposed", null))],
    [committedCommit, proposalIdentity(proposalMetadata("proposal-two", "committed", committedSha))],
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
