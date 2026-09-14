/*
 * Exports:
 * - UNBORN_FIXTURE: repository before its first commit.
 * - THREAD_GIT_BASE_FIXTURE: basic thread repository.
 * - PATH_MOVER_BASE_FIXTURE: source paths for move tests.
 * - PATH_MOVER_ARC_READY_FIXTURE: claimed move sources.
 * - THREAD_GIT_LINEAR_FIXTURE: linear thread commit graph.
 * - CONTROLLER_BASE_FIXTURE: controller test base.
 * - HISTORY_LINEAR_FIXTURE: linear rewrite history.
 * - HISTORY_ARC_READY_FIXTURE: active arc rewrite scenario.
 * - HISTORY_CONFLICT_READY_FIXTURE: conflicting rewrite scenario.
 * - HISTORY_ROOT_READY_FIXTURE: accepted parentless proposal ready for amendment.
 * - HISTORY_GLOBAL_REMAP_READY_FIXTURE: sibling rewrite state.
 * - HISTORY_PUSHED_READY_FIXTURE: published history.
 * - HISTORY_MERGE_READY_FIXTURE: nonlinear history.
 * - HISTORY_SIGNED_READY_FIXTURE: signed history.
 * - CONTROLLER_PARTIAL_READY_FIXTURE: partial acceptance scenario.
 * - partitionWorkbenchGitTestFiles: group nested Git, ordinary Git and non-Git suites in stable order.
 * - prepareWorkbenchGitTestFixtures/WorkbenchPreparedTestFixtures: prepare selected repository copies and clean them after all pools finish.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { APP_RELOAD_DIRT_FIXTURE } from "../../../../../app/server/runtime/AppReloadDirt.test.fixtures";
import { RELOAD_DIRT_FIXTURE } from "../../../../../shared/reload/ReloadDirt.test.fixtures";
import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import GitArcRegistry from "./GitArcRegistry";
import { CHECKPOINT_OPERATIONS_FIXTURE } from "./GitCheckpointTestFixtures";
import { CLAIM_LOSS_OPERATIONS_FIXTURE } from "./GitArcClaimLossTestFixtures";
import { HISTORY_ARC_READY_FIXTURE, HISTORY_CONFLICT_READY_FIXTURE, HISTORY_LINEAR_FIXTURE, HISTORY_ROOT_READY_FIXTURE } from "./GitHistoryRewriteTestFixtures";
import { CONTROLLER_BASE_FIXTURE, CONTROLLER_OPERATIONS_FIXTURE, CONTROLLER_PARTIAL_READY_FIXTURE } from "./GitArcControllerTestFixtures";
import GitTestFixtureCache, {
  GIT_TEST_FIXTURE_MANIFEST_ENV,
  gitTestFixtureKey,
  type GitTestFixturePrepareContext,
  type GitTestFixtureSpec,
} from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import {
  type ArcOutcome,
  outcomeRef,
  proposalMessage,
  type ProposalMetadata,
} from "workbench-shared/workbench/git/git-arc-storage";

const LINEAR_COMMITS = [
  {
    files: {
      "later.txt": "later base\n",
      "ordinary.txt": "ordinary base\n",
      "selected.txt": "selected base\n",
    },
    message: "base",
  },
  { files: { "selected.txt": "selected target\n" }, message: "target" },
  { files: { "later.txt": "later descendant\n" }, message: "descendant" },
];

export { CONTROLLER_BASE_FIXTURE, CONTROLLER_PARTIAL_READY_FIXTURE };
export { HISTORY_ARC_READY_FIXTURE, HISTORY_CONFLICT_READY_FIXTURE, HISTORY_LINEAR_FIXTURE, HISTORY_ROOT_READY_FIXTURE };

export const UNBORN_FIXTURE = {
  commits: [],
  name: "unborn",
} satisfies GitTestFixtureSpec;

async function write(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function createTranscript(
  repositoryRoot: string,
  harness: "codex" | "copilot" | "opencode",
  threadId: string,
) {
  const threadDirectory = path.join(
    repositoryRoot,
    ".workbench",
    "transcripts",
    harness,
    "threads",
    Buffer.from(threadId, "utf8").toString("base64url"),
  );
  await fs.mkdir(threadDirectory, { recursive: true });
  await fs.writeFile(path.join(threadDirectory, "thread.json"), "{}\n", "utf8");
}

async function targetAndHead(repositoryRoot: string, runGit: GitTestFixturePrepareContext["runGit"]) {
  return {
    head: (await runGit(["rev-parse", "HEAD"])).trim(),
    target: (await runGit(["rev-parse", "HEAD^"])).trim(),
  };
}

export const THREAD_GIT_BASE_FIXTURE = {
  commits: [{
    files: {
      "nested/one.txt": "one base\n",
      "nested/two.txt": "two base\n",
      "ordinary.txt": "ordinary base\n",
      "selected.txt": "selected base\n",
    },
    message: "base",
  }],
  name: "thread-git-base",
} satisfies GitTestFixtureSpec;

export const PATH_MOVER_BASE_FIXTURE = {
  commits: [{ files: { "src/one.test.ts": "one\n" }, message: "initial" }],
  name: "path-mover-base",
} satisfies GitTestFixtureSpec;

export const PATH_MOVER_ARC_READY_FIXTURE = {
  commits: PATH_MOVER_BASE_FIXTURE.commits,
  name: "path-mover-arc-ready",
  prepare: async ({ repositoryRoot }) => {
    const controller = new WorkbenchGitCheckpointController();
    const plan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "move one file",
      paths: ["src"],
      threadId: "move-thread",
    });
    await controller.startArc({
      checkpointCommit: plan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "move-thread",
    });
    return {};
  },
} satisfies GitTestFixtureSpec;

export const THREAD_GIT_LINEAR_FIXTURE = {
  commits: LINEAR_COMMITS,
  name: "thread-git-linear",
} satisfies GitTestFixtureSpec;

export const HISTORY_GLOBAL_REMAP_READY_FIXTURE = {
  commits: [
    {
      ...LINEAR_COMMITS[0],
      files: { ...LINEAR_COMMITS[0]!.files, "checkpoint.txt": "checkpoint base\n" },
    },
    ...LINEAR_COMMITS.slice(1),
  ],
  name: "history-global-remap-ready",
  prepare: async ({ repositoryRoot, runGit }) => {
    const repository = await WorkbenchGitRepository.open(repositoryRoot);
    const controller = new WorkbenchGitCheckpointController();
    const { head: oldHead, target } = await targetAndHead(repositoryRoot, runGit);
    const plan = await controller.createPlan({
      cwd: repositoryRoot,
      harness: "codex",
      intentName: "metadata witness",
      paths: ["later.txt"],
      threadId: "metadata-thread",
    });
    await controller.startArc({
      checkpointCommit: plan.checkpointCommit,
      cwd: repositoryRoot,
      harness: "codex",
      threadId: "metadata-thread",
    });
    const proposalMetadata: ProposalMetadata = {
      amendTargetSha: target,
      baseCommit: target,
      committedSha: target,
      description: "completed metadata witness",
      liveBaseCommit: oldHead,
      livePaths: ["later.txt"],
      mode: "commit",
      paths: ["later.txt"],
      proposalId: "synthetic-completed",
      sourceCheckpoint: plan.checkpointCommit,
      status: "superseded",
      supersededByProposalId: "replacement-proposal",
      supersededBySha: oldHead,
      title: "Completed metadata witness",
      unavailableReason: null,
      version: 2,
    };
    const proposalCommit = await repository.createCommitFromTree(
      await repository.resolveTree(oldHead),
      oldHead,
      proposalMessage(proposalMetadata),
    );
    const proposalRef = "refs/worktree/agents/codex/metadata-thread/checkpoint-proposals/synthetic-completed";
    const previousOutcomeRef = outcomeRef("codex", "metadata-thread", plan.checkpointCommit);
    const outcome: ArcOutcome = {
      committedSha: oldHead,
      proposalId: proposalMetadata.proposalId,
      sourceCheckpoint: plan.checkpointCommit,
      status: "partial",
      successorCheckpoint: plan.checkpointCommit,
      version: 1,
    };
    const outcomeBlob = await repository.writeBlob(`${JSON.stringify(outcome)}\n`);
    await repository.updateRefs([
      { newValue: proposalCommit, oldValue: "0".repeat(40), ref: proposalRef },
      { newValue: outcomeBlob, oldValue: "0".repeat(40), ref: previousOutcomeRef },
    ]);
    const checkpointPlan = await controller.createPlan({
      cwd: repositoryRoot,
      intentName: "remember me",
      paths: ["checkpoint.txt"],
      threadId: "arc-thread",
    });
    const brokenRefRelativePath = path.join(
      ".git",
      "refs",
      "worktree",
      "agents",
      "legacy-thread",
      "checkpoints",
      "legacy-11111111",
    );
    return {
      activePlanCheckpoint: plan.checkpointCommit,
      brokenRefRelativePath,
      checkpointPlanCheckpoint: checkpointPlan.checkpointCommit,
      previousOutcomeRef,
      proposalRef,
      target,
    };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{
  activePlanCheckpoint: string;
  brokenRefRelativePath: string;
  checkpointPlanCheckpoint: string;
  previousOutcomeRef: string;
  proposalRef: string;
  target: string;
}>;

export const HISTORY_PUSHED_READY_FIXTURE = {
  commits: LINEAR_COMMITS,
  name: "history-pushed-ready",
  prepare: async ({ bundleRoot, repositoryRoot, runGit }) => {
    const { target } = await targetAndHead(repositoryRoot, runGit);
    const remoteRoot = path.join(bundleRoot, "remote.git");
    await runGit(["init", "--bare", remoteRoot], { cwd: bundleRoot });
    await runGit(["remote", "add", "origin", "../remote.git"]);
    await runGit(["push", "--quiet", "origin", `${target}:refs/heads/main`]);
    return { target };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ target: string }>;

export const HISTORY_MERGE_READY_FIXTURE = {
  commits: LINEAR_COMMITS,
  name: "history-merge-ready",
  prepare: async ({ repositoryRoot, runGit }) => {
    const { target } = await targetAndHead(repositoryRoot, runGit);
    await runGit(["branch", "side", target]);
    await runGit(["checkout", "--quiet", "side"]);
    await write(repositoryRoot, "side.txt", "side branch\n");
    await runGit(["add", "side.txt"]);
    await runGit(["commit", "--quiet", "-m", "side"]);
    await runGit(["checkout", "--quiet", "main"]);
    await runGit(["merge", "--quiet", "--no-ff", "side", "-m", "merge"]);
    return { target };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ target: string }>;

export const HISTORY_SIGNED_READY_FIXTURE = {
  commits: LINEAR_COMMITS,
  name: "history-signed-ready",
  prepare: async ({ repositoryRoot, runGit }) => {
    const repository = await WorkbenchGitRepository.open(repositoryRoot);
    const oldHead = await repository.currentHead();
    const tree = (await runGit(["rev-parse", "HEAD^{tree}"])).trim();
    const signedCommit = (await repository.runWithInput(["hash-object", "-t", "commit", "-w", "--stdin"], [
      `tree ${tree}`,
      `parent ${oldHead}`,
      "author Signed Fixture <signed@workbench.invalid> 946684900 +0000",
      "committer Signed Fixture <signed@workbench.invalid> 946684900 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " fake-signature-for-policy-test",
      " -----END PGP SIGNATURE-----",
      "",
      "signed fixture",
      "",
    ].join("\n"))).trim();
    await repository.updateRef("refs/heads/main", signedCommit, oldHead);
    return { signedCommit };
  },
  revision: 1,
} satisfies GitTestFixtureSpec<{ signedCommit: string }>;

interface GitFixtureDemand {
  copies: number;
  spec: GitTestFixtureSpec<object>;
}

type GitTestFileSpec = {
  fixtures: GitFixtureDemand[];
  nested: boolean;
};

export interface WorkbenchPreparedTestFixtures {
  dispose: () => Promise<void>;
  environment: Record<string, string>;
}

function demand<State extends object>(spec: GitTestFixtureSpec<State>, copies: number): GitFixtureDemand {
  return { copies, spec: spec as GitTestFixtureSpec<object> };
}

const specsByGitTestFile = new Map<string, GitTestFileSpec>([
  ["ReloadDirtController.test.ts", { fixtures: [
    demand(RELOAD_DIRT_FIXTURE, 1),
  ], nested: false }],
  ["WorkbenchAppReloadDirtController.test.ts", { fixtures: [
    demand(APP_RELOAD_DIRT_FIXTURE, 1),
  ], nested: false }],
  ["GitArcLifecycleController.test.ts", { fixtures: [
    demand(PATH_MOVER_ARC_READY_FIXTURE, 1),
  ], nested: false }],
  ["GitArcPlanController.test.ts", { fixtures: [
    demand(THREAD_GIT_BASE_FIXTURE, 3),
  ], nested: false }],
  ["GitClaimRenameReader.test.ts", { fixtures: [
    demand(THREAD_GIT_BASE_FIXTURE, process.platform === "win32" ? 3 : 4),
  ], nested: false }],
  ["GitClaimHistoryReader.test.ts", { fixtures: [
    demand(THREAD_GIT_BASE_FIXTURE, 1),
  ], nested: false }],
  ["GitArcPathMover.test.ts", { fixtures: [
    demand(PATH_MOVER_BASE_FIXTURE, 4),
    demand(PATH_MOVER_ARC_READY_FIXTURE, 1),
  ], nested: false }],
  ["GitArcRetentionController.test.ts", { fixtures: [
    demand(CONTROLLER_PARTIAL_READY_FIXTURE, 1),
  ], nested: false }],
  ["GitArcClaimLossStore.test.ts", { fixtures: [
    demand(CLAIM_LOSS_OPERATIONS_FIXTURE, 1),
  ], nested: true }],
  ["WorkbenchGitCheckpointController.checkpoints.test.ts", { fixtures: [
    demand(CHECKPOINT_OPERATIONS_FIXTURE, 1),
  ], nested: true }],
  ["WorkbenchGitRepository.test.ts", { fixtures: [
    demand(UNBORN_FIXTURE, 1),
    demand(THREAD_GIT_BASE_FIXTURE, 5),
  ], nested: false }],
  ["WorkbenchGitHistoryRewriter.test.ts", { fixtures: [
    demand(HISTORY_ROOT_READY_FIXTURE, 1),
    demand(HISTORY_LINEAR_FIXTURE, 1),
    demand(HISTORY_CONFLICT_READY_FIXTURE, 1),
    demand(HISTORY_ARC_READY_FIXTURE, 1),
  ], nested: false }],
  ["WorkbenchGitHistoryRewriter.prepared.test.ts", { fixtures: [
    demand(HISTORY_LINEAR_FIXTURE, 1),
  ], nested: false }],
  ["WorkbenchThreadGit.test.ts", { fixtures: [
    demand(THREAD_GIT_BASE_FIXTURE, 8),
    demand(THREAD_GIT_LINEAR_FIXTURE, 2),
    demand(HISTORY_GLOBAL_REMAP_READY_FIXTURE, 1),
    demand(HISTORY_PUSHED_READY_FIXTURE, 1),
    demand(HISTORY_MERGE_READY_FIXTURE, 1),
    demand(HISTORY_SIGNED_READY_FIXTURE, 1),
  ], nested: false }],
  ["WorkbenchGitCheckpointController.unborn.test.ts", { fixtures: [
    demand(UNBORN_FIXTURE, 3),
  ], nested: true }],
  ["WorkbenchGitCheckpointController.test.ts", { fixtures: [
    demand(CONTROLLER_OPERATIONS_FIXTURE, 1),
  ], nested: true }],
]);

export function partitionWorkbenchGitTestFiles(testFiles: readonly string[]) {
  const gitFiles: string[] = [];
  const nestedGitFiles: string[] = [];
  const ordinaryFiles: string[] = [];
  for (const file of testFiles) {
    const spec = specsByGitTestFile.get(path.basename(file));
    (spec?.nested ? nestedGitFiles : spec ? gitFiles : ordinaryFiles).push(file);
  }
  return { gitFiles, nestedGitFiles, ordinaryFiles };
}

async function runBounded<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>) {
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < items.length; index += concurrency) await run(items[index]!);
  });
  await Promise.all(workers);
}

export async function prepareWorkbenchGitTestFixtures(
  testFiles: readonly string[],
  temporaryRootPath = WorkbenchTemporaryDirectory.rootPath,
): Promise<WorkbenchPreparedTestFixtures> {
  const cache = new GitTestFixtureCache({ temporaryRootPath });
  const requested = new Set(testFiles.map((file) => path.basename(file)));
  const jobs = [...requested].flatMap((testFile) => (
    specsByGitTestFile.get(testFile)?.fixtures.flatMap(({ copies, spec }) => (
      Array.from({ length: copies }, () => ({ spec, testFile }))
    )) ?? []
  ));
  if (!jobs.length) return { dispose: async () => undefined, environment: {} };

  const manifestDirectory = await WorkbenchTemporaryDirectory.create("workbench-git-fixture-manifest-", temporaryRootPath);
  const manifestRoot = manifestDirectory.path;
  const prepared: Array<Awaited<ReturnType<GitTestFixtureCache["prepareCopy"]>> & { testFile: string }> = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await runBounded(prepared, 2, async ({ fixture }) => await fixture.dispose());
    await manifestDirectory.dispose();
  };
  try {
    await runBounded(jobs, 2, async ({ spec, testFile }) => {
      prepared.push({ ...await cache.prepareCopy(spec), testFile });
    });
    const fixtures: Record<string, Record<string, object[]>> = {};
    for (const { fixture, key, testFile } of prepared) {
      const { dispose: _dispose, ...serialized } = fixture;
      ((fixtures[testFile] ??= {})[key] ??= []).push(serialized);
    }
    const manifestPath = path.join(manifestRoot, "fixtures.json");
    await fs.writeFile(manifestPath, `${JSON.stringify({ fixtures, version: 1 })}\n`, "utf8");
    return { dispose, environment: { [GIT_TEST_FIXTURE_MANIFEST_ENV]: manifestPath } };
  } catch (error) {
    await dispose();
    throw error;
  }
}
