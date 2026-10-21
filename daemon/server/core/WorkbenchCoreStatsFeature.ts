/*
 * Exports:
 * - default WorkbenchCoreStatsFeature: build usage and claim statistics (rename history, catalogue claim reconciliation and history import,
 *   tool prompt cost, the wb feedback project) and account limit tracking.
 */
import path from "node:path";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonDatabaseRegistration, DaemonRuntimeObjects } from "../daemon-runtime-objects";
import { resolveGitDirectory } from "../lib/git";
import { readWorkbenchInstructionSources } from "../lib/workbench/instructions/instruction-source";
import type { ReloadableNodeBuild } from "../runtime/ReloadableNode";
import { reconcileCatalogClaims } from "../stats/reconcile-catalog-claims";
import WorkbenchClaimRenameController from "../stats/WorkbenchClaimRenameController";
import WorkbenchStatsController from "../stats/WorkbenchStatsController";
import WorkbenchToolCatalogueTokens from "../stats/WorkbenchToolCatalogueTokens";
import WorkbenchAccountLimitsController from "../providers/WorkbenchAccountLimitsController";
import type WorkbenchGitArcFeature from "../git/WorkbenchGitArcFeature";
import type WorkbenchHarnessController from "../providers/WorkbenchHarnessController";
import type WorkbenchProjectCatalogController from "../project/WorkbenchProjectCatalogController";
import type WorkbenchProviderDispatcher from "../providers/WorkbenchProviderDispatcher";

export default class WorkbenchCoreStatsFeature {
  readonly stats: WorkbenchStatsController;
  readonly accountLimits: WorkbenchAccountLimitsController;

  constructor(ports: {
    context: Pick<DaemonProcessContext, "legacyMigrationProjectRoot">;
    database: DaemonDatabaseRegistration;
    providers: WorkbenchProviderDispatcher;
    harnesses: WorkbenchHarnessController;
    projectCatalog: WorkbenchProjectCatalogController;
    gitArc: WorkbenchGitArcFeature;
    run: ReloadableNodeBuild<DaemonRuntimeObjects>["run"];
    warn(message: string): void;
  }) {
    const { projectCatalog, gitArc, providers, run } = ports;
    const stats = this.stats = new WorkbenchStatsController({
      providers,
      renames: new WorkbenchClaimRenameController({
        listRoots: async (projectId) => {
          const catalog = await projectCatalog.readCatalog();
          return catalog.data.filter((project) => projectId === null || project.id === projectId).flatMap((project) => (
            project.roots.map((root) => ({ projectId: project.id, rootId: root.id, workspaceRoot: root.rootPath }))
          ));
        },
      }),
      claims: {
        reconcile: async (signal) => await reconcileCatalogClaims({
          isCheckout: async (rootPath) => Boolean(await resolveGitDirectory(rootPath)),
          projects: projectCatalog.getCurrentSnapshot().data,
          reconcile: async (rootPath) => await gitArc.reconcileClaimSnapshots(rootPath),
          reportFailure: (projectId, error) => stats.reportCaptureFailure(null, `claim reconciliation for project ${projectId}`, error),
          signal,
        }),
        discover: async () => {
          const catalog = await projectCatalog.readCatalog();
          const discoveries = await Promise.all(catalog.data.flatMap((project) => project.roots.map(async (root) => (
            await gitArc.discoverClaimHistory({
              projectId: project.id,
              rootId: root.id,
              workspaceRoot: root.rootPath,
            })
          ))));
          return {
            candidates: discoveries.flatMap(({ candidates }) => candidates),
            unsupported: discoveries.reduce((total, discovery) => total + discovery.unsupported, 0),
          };
        },
        hydrate: async (candidate) => await gitArc.hydrateClaimHistory(candidate),
      },
      database: ports.database,
      harnesses: ports.harnesses,
      log: (message) => {
        console.warn("[stats]", message.slice(0, 500));
      },
      // wb feedback belongs to the project whose root is this daemon's own Workbench checkout.
      resolveWorkbenchProjectId: async () => {
        const key = (value: string) => {
          const resolved = path.resolve(value);
          return process.platform === "win32" ? resolved.toLowerCase() : resolved;
        };
        const workbenchRoot = key(ports.context.legacyMigrationProjectRoot);
        const catalog = await projectCatalog.readCatalog();
        return catalog.data.find((candidate) => candidate.roots.some((root) => key(root.rootPath) === workbenchRoot))?.id ?? null;
      },
      toolCatalogue: new WorkbenchToolCatalogueTokens({
        harnesses: installedProviderKeys,
        readToolSpecs: harness => run("mcp", mcp => mcp.listToolSpecs(harness), "Stats tool spec catalogue"),
        readInstructionTools: () => run("mcp", mcp => mcp.listInstructionTools(), "Stats instruction tool catalogue"),
        readInstructionSources: () => readWorkbenchInstructionSources(),
      }),
    });
    this.accountLimits = new WorkbenchAccountLimitsController({
      read: harness => {
        const key = installedProviderKeys.find(candidate => candidate === harness);
        return key ? providers.get(key).account?.limits.read() ?? null : null;
      },
      record: (harness, limits) => stats.observeAccountLimits(harness, limits),
      warn: ports.warn,
    });
  }
}
