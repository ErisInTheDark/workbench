/*
 * Exports:
 * - default WorkbenchThreadFactsFeature: build the thread-owned facts (activatable skills, components, instruction selection, goals, todos,
 *   addressed feedback, network history, vis sessions and agent context), fan their changes out to runtime observers and thread summaries, and answer which
 *   thread-owned work holds settlement.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { WorkbenchThreadIdSchema, type WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type { ThreadRuntime, WorkbenchThreadSettlementHold, WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadSummaryFacts } from "workbench-shared/workbench/thread/thread-summary";
import { ThreadNetworkAccess, type NetworkHistoryEntry, type NetworkTarget } from "workbench-shared/workbench/network/network-access";
import { readThreadComponentTree, ThreadCompiledComponentSchema, ThreadCompiledStyleSchema } from "workbench-shared/workbench/thread/thread-component-tree";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonDatabaseRegistration, DaemonRuntimeObjects } from "../daemon-runtime-objects";
import { listProjectSkillsFromRoot } from "../lib/workbench/project/project-agents-folder";
import * as workbenchPromptFiles from "../lib/workbench/instructions/WorkbenchPromptFiles";
import type WorkbenchServerSettings from "../lib/workbench/settings/WorkbenchServerSettings";
import * as workbenchLibrary from "../lib/workbench-library";
import type { ReloadableNodeBuild, ReloadableNodeLease } from "../runtime/ReloadableNode";
import WorkbenchVisBrowse from "../vis/WorkbenchVisBrowse";
import WorkbenchVisController from "../vis/WorkbenchVisController";
import WorkbenchVisHttpController from "../vis/WorkbenchVisHttpController";
import WorkbenchVisListener from "../vis/WorkbenchVisListener";
import WorkbenchComponentsController from "../skills/WorkbenchComponentsController";
import loadQuickJS from "../skills/load-quickjs";
import type McpDownloadStore from "../mcp-servers/McpDownloadStore";
import { fetchPublicHttps, readBoundedBody } from "../lib/public-https-fetch";
import { requireWorkbenchPowerShellExecutable } from "../runtime/windows-powershell-runtime";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "../agent/workbench-agent-mcp-request-registry";
import WorkbenchAgentContextController from "../agent/WorkbenchAgentContextController";
import WorkbenchAgentSkillCatalogController from "../agent/WorkbenchAgentSkillCatalogController";
import type WorkbenchHarnessController from "../providers/WorkbenchHarnessController";
import type WorkbenchProjectCatalogController from "../project/WorkbenchProjectCatalogController";
import type WorkbenchProviderDispatcher from "../providers/WorkbenchProviderDispatcher";
import WorkbenchThreadAddressedFeedbackController from "../thread/WorkbenchThreadAddressedFeedbackController";
import WorkbenchThreadGoalController from "../thread/WorkbenchThreadGoalController";
import WorkbenchThreadInstructionSelectionController from "../thread/WorkbenchThreadInstructionSelectionController";
import WorkbenchThreadSkillsController from "../thread/WorkbenchThreadSkillsController";
import WorkbenchThreadTodoController from "../thread/WorkbenchThreadTodoController";
import type { WorkbenchCoreTranscript } from "./WorkbenchTurnRuntimeFeature";
import type WorkbenchCoreThreadLookup from "./WorkbenchCoreThreadLookup";

/** Bounds one component image fetch; message renders have no caller signal. */
const COMPONENT_IMAGE_TIMEOUT_MS = 15_000;

export default class WorkbenchThreadFactsFeature {
  readonly skillCatalog: WorkbenchAgentSkillCatalogController;
  readonly instructionSelection: WorkbenchThreadInstructionSelectionController;
  readonly skills: WorkbenchThreadSkillsController;
  readonly components: WorkbenchComponentsController;
  readonly goals: WorkbenchThreadGoalController;
  readonly todos: WorkbenchThreadTodoController;
  readonly addressedFeedback: WorkbenchThreadAddressedFeedbackController;
  /**
   * Remote targets the user approved for each thread; changes refresh its networked-daemon summary fact, as does `refresh`
   * when the thread gains a parent on another daemon.
   */
  readonly networkHistory: {
    read(threadId: string): Promise<NetworkHistoryEntry[]>;
    record(threadId: string, target: NetworkTarget): Promise<NetworkHistoryEntry[]>;
    revoke(threadId: string, entryId: string): Promise<NetworkHistoryEntry[]>;
    refresh(threadId: string): Promise<NetworkHistoryEntry[]>;
  };
  readonly vis: WorkbenchVisController;
  /** Serves vis pages to this daemon's headless checks, on an origin that reaches no daemon API. */
  readonly #visListener: WorkbenchVisListener;
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
    keptResults: () => Pick<McpDownloadStore, "readKept">;
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
        return workbenchLibrary.resolveWorkbenchActivatedSkills(await listProjectSkillsFromRoot(owner.rootPath), paths);
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
    const workbenchRoot = path.resolve(import.meta.dirname, "..", "..", "..");
    const componentScript = path.join(workbenchRoot, "scripts", "skill-component-build.mts");
    const componentScratch = path.join(context.dataRootPath, "daemon", "components");
    const runAsThread = async (
      session: { harness: string; threadId: string; cwd: string }, command: string[], cwd: string, signal: AbortSignal,
    ) => {
      const key = installedProviderKeys.find(candidate => candidate === session.harness);
      const prepare = key ? providers().get(key).tools?.prepareExecution : undefined;
      if (!prepare) throw new Error(`Provider ${session.harness} cannot run sandboxed commands.`);
      const prepared = await prepare({
        caller: { harness: session.harness, threadId: WorkbenchThreadIdSchema.parse(session.threadId), cwd: session.cwd },
        command, cwd, permissions: { mode: "restricted", writableRoots: [], network: false },
      }, signal);
      return await getProcessWorkbenchAgentMcpRequestRegistry().executeShell(prepared, signal);
    };
    const executeComponent = async (threadId: string, args: string[], signal?: AbortSignal) => {
      const resolved = await target(threadId);
      if (!resolved) throw new Error("This thread has no installed provider for components.");
      const owner = await projectCatalog.resolveProjectById(resolved.identity.projectId);
      const cancellation = signal ? AbortSignal.any([visBrowseLifetime.signal, signal]) : visBrowseLifetime.signal;
      const output = await this.vis.runComponentCommand(
        { harness: resolved.harness, threadId: resolved.identity.threadId, cwd: owner.rootPath },
        [process.execPath, "--disable-warning=ExperimentalWarning", "--import", "tsx", componentScript, ...args],
        path.join(workbenchRoot, "daemon"), cancellation,
      );
      try { return JSON.parse(output) as unknown; }
      catch { throw new Error("Component command returned invalid output."); }
    };
    const withComponentInput = async <Result>(value: object, runInput: (file: string) => Promise<Result>) => {
      await mkdir(componentScratch, { recursive: true });
      const file = path.join(componentScratch, `${randomUUID()}.json`);
      try {
        await writeFile(file, JSON.stringify(value), "utf8");
        return await runInput(file);
      } finally {
        await rm(file, { force: true });
      }
    };
    this.components = new WorkbenchComponentsController({
      skills: async threadId => {
        const resolved = await target(threadId);
        if (!resolved) return [];
        const owner = await projectCatalog.resolveProjectById(resolved.identity.projectId);
        const active = await skills.read(resolved.identity.threadId);
        return await workbenchLibrary.listActivatedSkillDefinitions(
          await listProjectSkillsFromRoot(owner.rootPath), active.map(skill => skill.path),
        );
      },
      compile: async (file, threadId, signal, skillRoot) => {
        const parsed = conformToZodSchema(ThreadCompiledComponentSchema, await executeComponent(
          threadId, ["compile", file, skillRoot ?? path.dirname(file)], signal,
        ));
        if (!parsed.success || parsed.repairedPaths.length || parsed.discardedPaths.length) throw new Error("Component compiler returned invalid output.");
        return parsed.data;
      },
      compileStyles: async (files, threadId, root) => await withComponentInput({ files, root }, async file => {
        const parsed = conformToZodSchema(ThreadCompiledStyleSchema, await executeComponent(threadId, ["styles", file]));
        if (!parsed.success || parsed.repairedPaths.length || parsed.discardedPaths.length) throw new Error("Component styles compiler returned invalid output.");
        return parsed.data;
      }),
      evaluate: async (compiled, name, markup, results, threadId, signal) => await withComponentInput({ compiled, name, markup, results }, async file =>
        readThreadComponentTree(await executeComponent(threadId, ["render", file], signal), { remoteImages: true })),
      results: async (threadId, names) => {
        const resolved = await target(threadId);
        if (!resolved) return {};
        const store = ports.keptResults();
        const entries = await Promise.all(names.map(async name => [name, await store.readKept(resolved.identity.threadId, name)] as const));
        return Object.fromEntries(entries.filter(([, value]) => value !== null));
      },
      fetchImage: async (url, maxBytes, signal) => {
        const bounded = AbortSignal.any([AbortSignal.timeout(COMPONENT_IMAGE_TIMEOUT_MS), ...signal ? [signal] : []]);
        const { response } = await fetchPublicHttps(url, bounded);
        return { contentType: response.headers.get("content-type") ?? "", bytes: await readBoundedBody(response, maxBytes) };
      },
      preview: async (result, threadId, signal) => await withComponentInput(result, async file => {
        const parsed = conformToZodSchema(z.string().max(6 * 1024 * 1024), await executeComponent(threadId, ["preview", file], signal));
        if (!parsed.success || parsed.repairedPaths.length || parsed.discardedPaths.length) throw new Error("Component preview returned invalid output.");
        return parsed.data;
      }),
      read: target => database.readTranscriptComponent(target),
      write: (target, result) => database.writeTranscriptComponent(target, result),
      calls: {
        compileMatchers: async (files, root, threadId) => await withComponentInput({ files, root }, async file => {
          const parsed = ThreadCompiledComponentSchema.safeParse(await executeComponent(threadId, ["matchers", file]));
          if (!parsed.success) throw new Error("MCP matcher compiler returned invalid output.");
          return parsed.data;
        }),
        renderProps: async (components, renders, threadId, signal) => await withComponentInput({ components, renders }, async file => {
          const output = await executeComponent(threadId, ["render-props", file], signal);
          if (!Array.isArray(output)) throw new Error("Component render returned invalid output.");
          return output.map(tree => readThreadComponentTree(tree, { remoteImages: true }));
        }),
        quickjs: loadQuickJS,
        read: target => database.readTranscriptCallComponent(target),
        write: (target, result) => database.writeTranscriptCallComponent(target, result),
      },
    });
    const visLog = (message: string) => console.warn(`[vis] ${message.slice(0, 500)}`);
    const visPages = new WorkbenchVisHttpController({ serve: (sessionId, variant) => this.vis.serve(sessionId, variant) });
    this.#visListener = new WorkbenchVisListener((request, response) => visPages.handleHttpRequest(request, response), visLog);
    void this.#visListener.start().catch(error => visLog(`Vis listener could not start: ${error instanceof Error ? error.message : String(error)}`));
    this.vis = new WorkbenchVisController({
      store: command => database.executeThreadVis(command),
      componentPreview: (threadId, markup, signal) => this.components.previewMarkup(threadId, markup, signal),
      matcherTest: (threadId, call, signal) => this.components.testMatcher(threadId, call, signal),
      resolveRoot: async session => {
        try {
          return (await projectCatalog.resolveAgentEndpointProjectFromCwd(session.cwd, { endpointName: "Vis session", ownerThreadId: session.threadId })).root.rootPath;
        } catch {
          // Expected when the project left the catalogue; its session simply stops being live here.
          return null;
        }
      },
      // Project vis commands run as the session's thread, in its sandbox, with nothing writable and no network.
      runCommand: session => async ({ command, cwd }, signal) => await runAsThread(session, command, cwd, signal),
      scratchDirectory: path.join(context.dataRootPath, "daemon", "vis"),
      powerShellExecutable: () => requireWorkbenchPowerShellExecutable(context.dataRootPath),
      // This file lives at daemon/server/core in the Workbench checkout the kit vis context builds from.
      workbenchRoot,
      browse: new WorkbenchVisBrowse({
        directory: path.join(context.dataRootPath, "daemon", "vis", "browse"),
        // Browse is its own reload node; these run as the session's thread through its agent entry points.
        port: {
          execute: (request, signal) => run("browseExecution", execution => execution.executeBrowseRequest(
            Buffer.from(JSON.stringify(request)), signal ? AbortSignal.any([visBrowseLifetime.signal, signal]) : visBrowseLifetime.signal,
          ), "Vis browser"),
          stop: async request => {
            const response = await run("browseExecution", execution => execution.executeSessionRequest({
              body: Buffer.from(JSON.stringify({ action: "stop", ...request })), method: "POST", url: "/",
            }, new AbortController().signal), "Vis browser stop");
            await WorkbenchVisBrowse.checkStopResponse(response);
          },
        },
        visOrigin: () => this.#visListener.origin(),
        log: visLog,
      }),
      log: visLog,
    });
    this.addressedFeedback = new WorkbenchThreadAddressedFeedbackController({
      store: command => database.executeThreadAddressedFeedback(command),
      resolve: resolveCanonicalThread,
      changed: (threadId, addressedFeedback) => {
        ports.setSummaryFacts(threadId, { addressedFeedbackCount: addressedFeedback.length });
        ports.publishRuntime(threadId, { addressedFeedback });
      },
    });
    const historyChanged = async (threadId: string, history: NetworkHistoryEntry[]) => {
      const entry = await lookup.entry(threadId);
      const parentDaemonId = entry?.entryKind === "subagent" ? entry.parentDaemonId ?? null : null;
      ports.setSummaryFacts(threadId, { networkDaemonIds: ThreadNetworkAccess.daemonIds(history, parentDaemonId) });
      ports.publishRuntime(threadId, { networkHistory: history });
      return history;
    };
    const readHistory = async (threadId: string) => await database.executeThreadNetworkHistory({ kind: "read", threadId });
    this.networkHistory = {
      read: readHistory,
      refresh: async threadId => await historyChanged(threadId, await readHistory(threadId)),
      record: async (threadId, target) => await historyChanged(threadId, await database.executeThreadNetworkHistory({
        kind: "record", threadId, id: randomUUID(), approvedAt: Date.now(), target,
      })),
      revoke: async (threadId, entryId) => await historyChanged(threadId, await database.executeThreadNetworkHistory({
        kind: "revoke", threadId, entryId, revokedAt: Date.now(),
      })),
    };
    const agentContext: WorkbenchAgentContextController = this.agentContext = new WorkbenchAgentContextController({
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
    void this.#visListener.close().catch(error => console.warn(`[vis] Vis listener could not close: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`));
  }
}
