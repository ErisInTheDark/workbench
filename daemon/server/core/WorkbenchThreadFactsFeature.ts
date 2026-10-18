/*
 * Exports:
 * - default WorkbenchThreadFactsFeature: build the thread-owned facts (activatable skills, instruction selection, active skills, goals, todos,
 *   addressed feedback, vis sessions and agent context), fan their changes out to runtime observers and thread summaries, and answer which
 *   thread-owned work holds settlement.
 */
import path from "node:path";
import { WorkbenchThreadIdSchema, type WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type { ThreadRuntime, WorkbenchThreadSettlementHold, WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadSummaryFacts } from "workbench-shared/workbench/thread/thread-summary";
import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonDatabaseRegistration, DaemonRuntimeObjects } from "../daemon-runtime-objects";
import * as project from "../lib/project";
import * as workbenchPromptFiles from "../lib/workbench/instructions/WorkbenchPromptFiles";
import type WorkbenchServerSettings from "../lib/workbench/settings/WorkbenchServerSettings";
import * as workbenchLibrary from "../lib/workbench-library";
import type { ReloadableNodeBuild, ReloadableNodeLease } from "../ReloadableNode";
import WorkbenchVisBrowse from "../vis/WorkbenchVisBrowse";
import WorkbenchVisController from "../vis/WorkbenchVisController";
import { requireWorkbenchPowerShellExecutable } from "../windows-powershell-runtime";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "../workbench-agent-mcp-request-registry";
import WorkbenchAgentContextController from "../WorkbenchAgentContextController";
import WorkbenchAgentSkillCatalogController from "../WorkbenchAgentSkillCatalogController";
import type WorkbenchHarnessController from "../WorkbenchHarnessController";
import type WorkbenchProjectCatalogController from "../WorkbenchProjectCatalogController";
import type WorkbenchProviderDispatcher from "../WorkbenchProviderDispatcher";
import WorkbenchThreadAddressedFeedbackController from "../WorkbenchThreadAddressedFeedbackController";
import WorkbenchThreadGoalController from "../WorkbenchThreadGoalController";
import WorkbenchThreadInstructionSelectionController from "../WorkbenchThreadInstructionSelectionController";
import WorkbenchThreadSkillsController from "../WorkbenchThreadSkillsController";
import WorkbenchThreadTodoController from "../WorkbenchThreadTodoController";
import type { WorkbenchCoreTranscript } from "./WorkbenchTurnRuntimeFeature";
import type WorkbenchCoreThreadLookup from "./WorkbenchCoreThreadLookup";

export default class WorkbenchThreadFactsFeature {
  readonly skillCatalog: WorkbenchAgentSkillCatalogController;
  readonly instructionSelection: WorkbenchThreadInstructionSelectionController;
  readonly skills: WorkbenchThreadSkillsController;
  readonly goals: WorkbenchThreadGoalController;
  readonly todos: WorkbenchThreadTodoController;
  readonly addressedFeedback: WorkbenchThreadAddressedFeedbackController;
  readonly vis: WorkbenchVisController;
  readonly agentContext: WorkbenchAgentContextController;
  /** Cancels this generation's vis browser calls when the core node is disposed. */
  readonly #visBrowseLifetime = new AbortController();
  readonly #stops: Array<() => void> = [];
  readonly #lookup: WorkbenchCoreThreadLookup;
  readonly #lease: ReloadableNodeLease;

  constructor(ports: {
    context: Pick<DaemonProcessContext, "dataRootPath" | "localDaemonOrigin">;
    database: DaemonDatabaseRegistration;
    transcript: Pick<WorkbenchCoreTranscript, "subscribeContextCompaction">;
    lookup: WorkbenchCoreThreadLookup;
    projectCatalog: WorkbenchProjectCatalogController;
    settings: WorkbenchServerSettings;
    run: ReloadableNodeBuild<DaemonRuntimeObjects>["run"];
    lease: ReloadableNodeLease;
    /** Built after this feature, read at call time. */
    providers: () => WorkbenchProviderDispatcher;
    harnesses: () => WorkbenchHarnessController;
    publishRuntime(threadId: string, change: Partial<ThreadRuntime>): void;
    setSummaryFacts(threadId: string, facts: ThreadSummaryFacts): void;
  }) {
    const { context, database, lookup, projectCatalog, run, lease, providers } = ports;
    this.#lookup = lookup;
    this.#lease = lease;
    const skillCatalog = this.skillCatalog = new WorkbenchAgentSkillCatalogController(
      (projectId) => projectCatalog.resolveProjectById(projectId),
      (provider, sections) => providers().get(ports.harnesses().resolveHarness(provider)).configuration.guidance.contains(sections),
    );
    this.instructionSelection = new WorkbenchThreadInstructionSelectionController({
      store: command => database.executeThreadInstructionSelection(command),
      readThreadKind: async threadId => (await lookup.entry(threadId))?.entryKind ?? null,
      readSkills: threadId => this.readThreadSkills(threadId),
      recordSkillActivations: (threadId, paths) => skills.recordActivations(threadId, paths, "user"),
      now: Date.now,
      warn: message => console.warn(`[instruction-selection] ${message.slice(0, 500)}`),
    });
    const target = async (threadId: string) => {
      const identity = await lookup.identity(threadId);
      const harness = installedProviderKeys.find(key => key === identity?.bindings[0]?.harness);
      return identity && harness ? { identity, harness } : null;
    };
    const skills = this.skills = new WorkbenchThreadSkillsController({
      store: command => database.executeThreadSkills(command),
      target: async threadId => {
        const resolved = await target(threadId);
        return resolved ? { harness: resolved.harness, threadId: resolved.identity.threadId } : null;
      },
      resolve: async (thread, paths) => {
        const resolved = await target(thread.threadId);
        if (!resolved) return [];
        const owner = await projectCatalog.resolveProjectById(resolved.identity.projectId);
        return workbenchLibrary.resolveWorkbenchActivatedSkills(await project.listProjectSkillDefinitionsFromRoot(owner.rootPath), paths);
      },
      buildCatalog: async (thread, paths) => {
        const resolved = await target(thread.threadId);
        if (!resolved) return null;
        const owner = await projectCatalog.resolveProjectById(resolved.identity.projectId);
        const profile = await lookup.requireThreadState().controller.readComposerProfileTarget({
          harness: thread.harness, kind: "thread", projectId: owner.id, threadId: resolved.identity.threadId,
        });
        return workbenchPromptFiles.buildWorkbenchManagedThreadActivatedSkills({
          cwd: owner.rootPath, projectId: owner.id, threadId: resolved.identity.threadId,
          roots: owner.roots.map(root => ({
            id: root.id, name: root.name, relativePath: root.relativePath ?? ".",
            rootPath: root.rootPath, isPrimary: root.rootPath === owner.rootPath,
          })),
          harness: thread.harness, managedThread: true, model: profile?.settings.model ?? null,
          activatedSkillPaths: paths, workbenchOrigin: context.localDaemonOrigin,
          readInstructionTools: () => run("mcp", mcp => mcp.listInstructionTools(), "Thread skill instruction tool catalogue"),
        }, () => ports.settings.readLocalCapabilities());
      },
      publish: (thread, text) => agentContext.publish(thread, text),
      broadcast: (thread, active) => ports.publishRuntime(thread.threadId, { skills: [...active] }),
      warn: message => { console.warn("[thread-skills]", message.slice(0, 500)); },
    });
    const goals = this.goals = new WorkbenchThreadGoalController({
      store: command => database.executeThreadGoals(command),
      target: async threadId => {
        const resolved = await target(threadId);
        return resolved ? { harness: resolved.harness, threadId: resolved.identity.threadId } : null;
      },
      publish: (thread, text) => agentContext.publish(thread, text),
      changed: (threadId, goal) => ports.publishRuntime(threadId, { goal }),
      warn: message => { console.warn("[thread-goal]", message.slice(0, 500)); },
    });
    const resolveCanonicalThread = async (threadId: string) => (await lookup.identity(threadId))?.threadId ?? null;
    this.todos = new WorkbenchThreadTodoController({
      store: command => database.executeThreadTodos(command),
      resolve: resolveCanonicalThread,
      changed: (threadId, todos) => {
        ports.setSummaryFacts(threadId, { requiredTodoCount: todos.filter(({ required }) => required).length });
        ports.publishRuntime(threadId, { todos });
      },
    });
    const visBrowseLifetime = this.#visBrowseLifetime;
    this.vis = new WorkbenchVisController({
      store: command => database.executeThreadVis(command),
      resolveRoot: async session => {
        try {
          return (await projectCatalog.resolveAgentEndpointProjectFromCwd(session.cwd, { endpointName: "Vis session" })).root.rootPath;
        } catch {
          // Expected when the project left the catalogue; its session simply stops being live here.
          return null;
        }
      },
      // Project vis commands run as the session's thread, in its sandbox, with nothing writable and no network.
      runCommand: session => async ({ command, cwd }, signal) => {
        const key = installedProviderKeys.find(key => key === session.harness);
        const prepare = key ? providers().get(key).tools?.prepareExecution : undefined;
        if (!prepare) throw new Error(`Provider ${session.harness} cannot run sandboxed commands.`);
        const prepared = await prepare({
          caller: { harness: session.harness, threadId: WorkbenchThreadIdSchema.parse(session.threadId), cwd: session.cwd },
          command, cwd, permissions: { mode: "restricted", writableRoots: [], network: false },
        }, signal);
        return await getProcessWorkbenchAgentMcpRequestRegistry().executeShell(prepared, signal);
      },
      scratchDirectory: path.join(context.dataRootPath, "daemon", "vis"),
      powerShellExecutable: () => requireWorkbenchPowerShellExecutable(context.dataRootPath),
      // This file lives at daemon/server/core in the Workbench checkout the kit vis context builds from.
      workbenchRoot: path.resolve(import.meta.dirname, "..", "..", ".."),
      browse: new WorkbenchVisBrowse({
        directory: path.join(context.dataRootPath, "daemon", "vis", "browse"),
        // Browse is its own reload node; these run as the session's thread through its agent entry points.
        port: {
          execute: request => run("browseExecution", execution => execution.executeBrowseRequest(Buffer.from(JSON.stringify(request)), visBrowseLifetime.signal), "Vis browser"),
          stop: async request => {
            const response = await run("browseExecution", execution => execution.executeSessionRequest({
              body: Buffer.from(JSON.stringify({ action: "stop", ...request })), method: "POST", url: "/",
            }, visBrowseLifetime.signal), "Vis browser stop");
            if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? `Browse stop failed with status ${response.status}.`);
          },
        },
        log: message => console.warn(`[vis] ${message.slice(0, 500)}`),
      }),
      log: message => console.warn(`[vis] ${message.slice(0, 500)}`),
    });
    this.addressedFeedback = new WorkbenchThreadAddressedFeedbackController({
      store: command => database.executeThreadAddressedFeedback(command),
      resolve: resolveCanonicalThread,
      changed: (threadId, addressedFeedback) => {
        ports.setSummaryFacts(threadId, { addressedFeedbackCount: addressedFeedback.length });
        ports.publishRuntime(threadId, { addressedFeedback });
      },
    });
    const agentContext = this.agentContext = new WorkbenchAgentContextController({
      sources: [skills.contextSource, goals.contextSource],
      inject: async (thread, text, signal) => {
        if (!lease.isCurrent()) throw new Error("Agent context generation has retired.");
        return await providers().get(thread.harness).context?.inject({ threadId: thread.threadId, text }, signal) ?? "unsupported";
      },
      warn: message => { console.warn("[agent-context]", message); },
    });
    this.#stops.push(ports.transcript.subscribeContextCompaction(async completion => {
      if (!lease.isCurrent()) return;
      // Observers reread token usage when the transcript settles; agents get their skills and goal re-sent.
      await skills.observeCompaction(completion.threadId);
      if (lease.isCurrent()) await goals.observeCompaction(completion.threadId);
    }));
  }

  /** The skills a thread's messages can activate: its project's catalog, as the composer reads it. */
  async readThreadSkills(threadId: string) {
    const identity = await this.#lookup.identity(threadId);
    return identity ? await this.skillCatalog.readActivatableSkills(identity.projectId) : [];
  }

  recordUserSkillActivations(threadId: string, paths: readonly string[]) {
    return this.skills.recordActivations(threadId, paths, "user");
  }

  /** Required todos and unresolved addressed feedback keep a thread from settling, exactly like live claims. */
  async settlementHold(threadId: WorkbenchThreadId): Promise<WorkbenchThreadSettlementHold | null> {
    if ((await this.todos.read(threadId)).some(({ required }) => required)) return "requiredTodos";
    return await this.addressedFeedback.holdsSettlement(threadId) ? "addressedFeedback" : null;
  }

  /** A settled thread's live vis sessions end with a final snapshot, so no live card outlives its thread. */
  endVisOnSettlement(subscribe: (listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void) => () => void) {
    this.#stops.push(subscribe((_projectId, entry) => {
      if (this.#lease.isCurrent() && entry.entryKind !== "draft" && entry.lifecycle.settled) void this.vis.endThread(entry.identity.threadId);
    }));
  }

  stopObserving() {
    for (const stop of this.#stops.splice(0)) stop();
  }

  disposeVis() {
    this.vis.dispose();
    this.#visBrowseLifetime.abort(new Error("Vis browser calls are reloading."));
  }
}
