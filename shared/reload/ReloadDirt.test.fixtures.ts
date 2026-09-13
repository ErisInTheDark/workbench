/*
 * Exports:
 * - RELOAD_DIRT_FIXTURE: real initialised Git baselines for both reload content graphs.
 * - createReloadContentController: construct a content controller with fresh lifecycle state.
 */
import type { GitTestFixtureSpec } from "../workbench/git/git-test-fixture.ts";
import ReloadDirtController, {
  type ReloadDirtControllerOptions,
  type ReloadDirtControllerState,
} from "./ReloadDirtController.ts";

const graphs = {
  content: {
    descriptors: [
      { access: "operator", description: "One", destructive: false, paths: ["shared/owner.ts"], safeAll: false, scope: "client:one" },
      { access: "operator", description: "Two", destructive: false, paths: ["shared/owner.ts"], safeAll: false, scope: "client:two" },
    ],
    snapshotRef: "refs/worktree/workbench/shared-test-reload-snapshot",
  },
  boundary: {
    descriptors: [{
      access: "operator",
      boundaryPatterns: ["shared/**", "!shared/generated/**"],
      description: "Boundary",
      destructive: false,
      paths: [],
      safeAll: false,
      scope: "client:boundary",
    }],
    snapshotRef: "refs/worktree/workbench/shared-test-boundary-snapshot",
  },
} satisfies Record<string, {
  descriptors: ReturnType<ReloadDirtControllerOptions["getSourceState"]>["descriptors"];
  snapshotRef: string;
}>;

interface PreparedController {
  baselines: Array<[string, string]>;
  descriptors: Array<[string, ReturnType<ReloadDirtControllerOptions["getSourceState"]>["descriptors"][number]]>;
  snapshotCommit: string;
}

function controllerOptions(repoRoot: string, graph: keyof typeof graphs): ReloadDirtControllerOptions {
  const { descriptors, snapshotRef } = graphs[graph];
  return {
    getSourceState: () => ({ descriptors, dependantClosure: scopes => [...scopes] }),
    repoRoot,
    snapshotRef,
    watchSource: (() => ({ close: () => {}, on: () => {} })) as never,
  };
}

export function createReloadContentController(repoRoot: string, graph: keyof typeof graphs, prepared: PreparedController) {
  const state: ReloadDirtControllerState = {
    baselines: new Map(prepared.baselines),
    descriptors: new Map(prepared.descriptors),
    error: null,
    pendingScopes: [],
    snapshotCommit: prepared.snapshotCommit,
    tail: Promise.resolve(),
  };
  return new ReloadDirtController(controllerOptions(repoRoot, graph), state);
}

async function prepareController(repoRoot: string, graph: keyof typeof graphs): Promise<PreparedController> {
  const controller = new ReloadDirtController(controllerOptions(repoRoot, graph));
  try {
    await controller.start();
    const snapshot = controller.getSnapshot();
    if (snapshot.error || snapshot.pendingScopes.length || snapshot.dirtyScopes.length) {
      throw new Error(`Reload fixture ${graph} did not initialise cleanly: ${snapshot.error ?? "unexpected dirt or pending scopes"}`);
    }
    const state = controller.detachForReload();
    return {
      baselines: [...state.baselines],
      descriptors: [...state.descriptors],
      snapshotCommit: state.snapshotCommit,
    };
  } finally {
    await controller.dispose();
  }
}

export const RELOAD_DIRT_FIXTURE = {
  name: "shared-reload-dirt",
  revision: 2,
  commits: [{
    files: {
      ".gitignore": ".workbench/\n",
      "shared/owner.ts": "export const value = 1;\n",
      "shared/generated/ignored.ts": "export const ignored = 1;\n",
    },
    message: "initial",
  }],
  prepare: async ({ repositoryRoot }) => ({
    boundary: await prepareController(repositoryRoot, "boundary"),
    content: await prepareController(repositoryRoot, "content"),
  }),
} satisfies GitTestFixtureSpec<Record<keyof typeof graphs, PreparedController>>;
