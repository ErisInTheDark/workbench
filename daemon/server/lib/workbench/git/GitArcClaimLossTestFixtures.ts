/*
 * Exports:
 * - CLAIM_LOSS_OPERATIONS_FIXTURE: shared active states for atomic loss and final-loss routes.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { CONTROLLER_BASE_FIXTURE } from "./GitArcControllerTestFixtures";
import type { GitTestFixtureSpec } from "./GitTestFixtureCache";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController";

export const CLAIM_LOSS_OPERATIONS_FIXTURE = {
  commits: CONTROLLER_BASE_FIXTURE.commits,
  name: "claim-loss-shared-states",
  revision: 1,
  prepare: async ({ bundleRoot, repositoryRoot, runGit }) => {
    const controller = new WorkbenchGitCheckpointController();
    const threadId = "claim-loss";
    await controller.createAndStartPlan({
      cwd: repositoryRoot, harness: "codex", threadId,
      intentName: "claim loss", paths: ["one.txt", "two.txt"],
    });
    const fork = async (relativeRoot: string, source: string) => {
      const root = path.join(bundleRoot, relativeRoot);
      await fs.cp(source, root, { recursive: true, errorOnExist: true, force: false });
      return root;
    };
    const planning = await fork("r/p", repositoryRoot);
    const onePathArc = await controller.editArcClaims({
      cwd: planning, harness: "codex", threadId, inherit: true, removePaths: ["two.txt"],
    });
    const routes = { planning: "r/p", removal: "r/m", restore: "r/r", settlement: "r/s" };
    for (const route of ["removal", "restore", "settlement"] as const) {
      await fork(routes[route], planning);
    }
    for (const relativeRoot of Object.values(routes)) {
      await runGit(["fsck", "--strict"], { cwd: path.join(bundleRoot, relativeRoot) });
    }
    return {
      atomicRoot: path.relative(bundleRoot, repositoryRoot),
      routeCheckpoint: onePathArc.checkpointCommit,
      routes,
      threadId,
    };
  },
} satisfies GitTestFixtureSpec<object>;
