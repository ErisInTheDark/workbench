/*
 * Exports:
 * - WorkbenchVisControllerOptions: storage, project, sandboxed project-command, browser and file-watching ports.
 * - VisServed: one served document, its build root and its bridge's starting controls.
 * - default WorkbenchVisController: own live vis sessions for one daemon generation. Starting and ending snapshot the
 *   rendered file; between them a change to the file (or, for built components, any file the build read) keeps the
 *   last render and marks one in flight, and only a finished render replaces it. Live sessions survive reloads
 *   through storage and resume on start. Each session builds in its caller's project, another folder's `.wb.json`,
 *   or Workbench's kit, keeps its file's synced control state (which outlives the session), and has a headless browser
 *   agents check it in with that state, whose page follows every render. Observers see only render metadata; the
 *   documents and the build root they load files from are served on request. Also screenshots skill component markup
 *   and MCP matcher tests in throwaway pages.
 */
import { randomUUID } from "node:crypto";
import { watch as watchDirectory } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  isVisPath, VIS_MAX_DOCUMENT_LENGTH, VIS_MAX_SOURCE_BYTES, VisControlIdSchema, VisControlValueSchema,
  type VisControls, type VisLiveSession, type VisProject, type VisSnapshot, type VisSnapshotKind, type VisThread,
} from "workbench-shared/workbench/vis/vis-contract";
import type { VisVariant } from "workbench-shared/workbench/vis/vis-url";
import { renderVisDocument, visWantsCss } from "workbench-shared/workbench/vis/vis-document";
import type { ThreadVisCommand, ThreadVisResult, ThreadVisStoredBuild, ThreadVisStoredSession } from "../database/vis/WorkbenchThreadVisStore";
import { WORKBENCH_PROJECT_CONFIG_FILE } from "workbench-shared/workbench/project-config/workbench-project-config";
import {
  buildVisDocument, compileVisCss, runVisCommand, VisRenderRuns, WORKBENCH_KIT_VIS_CONFIG,
  type VisBuildContext, type VisCommandRunner,
} from "./vis-project-command";
import type WorkbenchVisBrowse from "./WorkbenchVisBrowse";
import type { SkillMcpCall } from "workbench-shared/workbench/skills/skill-mcp-matcher-contract";

export interface WorkbenchVisControllerOptions {
  store(command: ThreadVisCommand): Promise<ThreadVisResult>;
  /** The project root a stored session's path is relative to; null once the project is gone. */
  resolveRoot(session: ThreadVisStoredSession): Promise<string | null>;
  /** Runs a project's vis command as the session's thread, in that thread's sandbox. */
  runCommand(session: Pick<ThreadVisStoredSession, "threadId" | "harness" | "cwd">): VisCommandRunner;
  /** Workbench-owned directory for project command input files. */
  scratchDirectory: string;
  /** Workbench's checkout, where the kit context's commands run. */
  workbenchRoot: string;
  /** Resolves the verified absolute pwsh.exe path used for Windows project commands. */
  powerShellExecutable?(): Promise<string>;
  /** Each session's headless browser, opened with it and stopped when it ends. */
  browse?: Pick<WorkbenchVisBrowse, "end" | "inspect" | "inspectDocument" | "open" | "refresh">;
  /** Renders active skill component markup through the native component renderer. */
  componentPreview?(threadId: string, markup: string, signal: AbortSignal): Promise<string>;
  /** Runs active skills' MCP matchers on a sample call; `preview` is its component's document, when one rendered. */
  matcherTest?(threadId: string, call: SkillMcpCall, signal: AbortSignal): Promise<{ report: string; preview: string | null }>;
  /** Calls `onChange` whenever the file may have changed; returns a stop function. */
  watch?(file: string, onChange: () => void): () => void;
  now?(): number;
  log(message: string): void;
}

interface Rendered {
  document: string | null;
  failure: string | null;
  /** Absolute project files a component build read; null when the file is rendered on its own. */
  inputs: string[] | null;
}

/** A document to serve, the build root its relative URLs read from, and the controls its bridge starts with. */
export interface VisServed {
  document: string;
  rootPath: string;
  controls: VisControls;
}

interface Live {
  stored: ThreadVisStoredSession;
  /** The latest finished render; `state.render` describes it to observers. */
  document: string | null;
  file: string;
  /** The caller's project root; the file lives inside it. */
  rootPath: string;
  context: VisBuildContext;
  state: VisLiveSession;
  /** Aborts this session's in-flight render; replaced only by ending. */
  readonly cancel: AbortController;
  running: Promise<void> | null;
  /** A change arrived while a render was running; one more render follows it. */
  again: boolean;
  /** Stop functions by watched absolute path: the file, plus whatever its last build read. */
  readonly watched: Map<string, () => void>;
}

function message(error: unknown) {
  return (error instanceof Error ? error.message : "Vis rendering failed.").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").slice(0, 2_000);
}

/** Directory watches survive editors that save by renaming a temporary file over the original. */
function defaultWatch(file: string, onChange: () => void) {
  const name = path.basename(file);
  const watcher = watchDirectory(path.dirname(file), (_event, changed) => {
    if (!changed || changed.toString() === name) onChange();
  });
  watcher.on("error", () => onChange());
  return () => watcher.close();
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const isComponent = (file: string) => /\.[jt]sx$/iu.test(file);

export default class WorkbenchVisController {
  readonly #options: WorkbenchVisControllerOptions;
  readonly #live = new Map<string, Live>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #lifetime = new AbortController();
  readonly #runs = new VisRenderRuns();
  #restoring: Promise<void> | null = null;

  constructor(options: WorkbenchVisControllerOptions) {
    this.#options = options;
  }

  /** Resumes sessions the previous generation left live. */
  start() {
    this.#restoring ??= this.#restore().catch(error => this.#options.log(`Vis sessions could not resume: ${message(error)}`));
    return this.#restoring;
  }

  /** `wb vis render` delivers a project command's piped output here. */
  acceptRender(runId: string, content: string) {
    return this.#runs.accept(runId, content);
  }

  async startSession(input: {
    threadId: string; harness: string; cwd: string; projectId: string; rootPath: string; path: string; project: VisProject;
  }) {
    await this.start();
    const { file, display } = await this.#resolve(input.rootPath, input.cwd, input.path);
    const build = await this.#resolveBuild(input.cwd, input.project);
    const stored: ThreadVisStoredSession = {
      sessionId: randomUUID(), threadId: input.threadId, harness: input.harness, cwd: input.cwd,
      projectId: input.projectId, path: display, build, startedAt: this.#now(), endedAt: null,
    };
    if (this.#findLive(input.threadId, display)) throw new Error(`A vis session is already live on ${display}; end it first.`);
    const context = this.#context(build, input.rootPath);
    const rendered = await this.#render(stored, file, input.rootPath, context, this.#lifetime.signal);
    if (rendered.document === null) throw new Error(rendered.failure ?? `Unable to read ${display}.`);
    const { endedAt: _, ...session } = stored;
    await this.#options.store({ kind: "start", session, snapshot: { capturedAt: stored.startedAt, document: rendered.document, failure: rendered.failure } });
    const controls = await this.#controls(stored);
    const live = this.#begin(stored, file, input.rootPath, context, rendered.document, stored.startedAt, rendered.failure, controls);
    this.#watch(live, rendered.inputs);
    // Warms the session's browser without holding up the start; it never rejects.
    void this.#options.browse?.open(this.#browseTarget(live));
    return { sessionId: stored.sessionId, path: display, failure: rendered.failure };
  }

  /**
   * Checks the session's latest render in its headless browser: an accessibility snapshot, or a screenshot sent to the
   * agent. A check right after an edit waits for its rebuild, and says when that build failed.
   */
  async inspect(input: { threadId: string; cwd: string; rootPath: string; path: string }, kind: "snapshot" | "screenshot") {
    await this.start();
    const { display } = await this.#resolve(input.rootPath, input.cwd, input.path, false);
    const live = this.#findLive(input.threadId, display);
    if (!live) throw new Error(`No vis session is live on ${display}.`);
    await live.running?.catch(() => undefined);
    if (this.#live.get(live.stored.sessionId) !== live) throw new Error(`The vis session on ${display} ended while it was rebuilding.`);
    if (!live.state.render) throw new Error(`${display} has not rendered yet; try again once it has.`);
    if (!this.#options.browse) throw new Error("Vis browser checks are unavailable.");
    const failure = live.state.failure;
    const result = await this.#options.browse.inspect(this.#browseTarget(live), kind);
    return failure ? `${result}The latest build failed, so this shows the last good render:\n${failure}\n` : result;
  }

  /**
   * What the vis origin serves for a session: the live render, or a stored start or end snapshot, each with the build
   * root its files come from. Null when there is nothing to serve, such as a session that is no longer live.
   */
  async serve(sessionId: string, variant: VisVariant): Promise<VisServed | null> {
    await this.start();
    if (variant === "live") {
      const live = this.#live.get(sessionId);
      if (!live?.document) return null;
      return { document: live.document, rootPath: live.context.rootPath, controls: live.state.controls };
    }
    const { sessions: [stored], snapshot } = await this.#options.store({ kind: "readSnapshot", sessionId, snapshotKind: variant });
    if (!stored || !snapshot?.document) return null;
    const projectRoot = await this.#options.resolveRoot(stored);
    if (!projectRoot) return null;
    return { document: snapshot.document, rootPath: this.#context(stored.build, projectRoot).rootPath, controls: await this.#controls(stored) };
  }

  async testMarkup(input: { threadId: string; cwd: string; markup: string }, signal?: AbortSignal) {
    const { browse, componentPreview } = this.#options;
    if (!browse || !componentPreview) throw new Error("Component markup testing is unavailable.");
    const cancellation = signal ? AbortSignal.any([this.#lifetime.signal, signal]) : this.#lifetime.signal;
    cancellation.throwIfAborted();
    const document = await componentPreview(input.threadId, input.markup, cancellation);
    cancellation.throwIfAborted();
    return await this.#screenshot({ threadId: input.threadId, cwd: input.cwd, path: "component markup", document }, cancellation);
  }

  /** How active skills' matchers present a sample call, then a screenshot of the component they name. */
  async testMatcher(input: { threadId: string; cwd: string; call: SkillMcpCall }, signal?: AbortSignal) {
    const { browse, matcherTest } = this.#options;
    if (!browse || !matcherTest) throw new Error("MCP matcher testing is unavailable.");
    const cancellation = signal ? AbortSignal.any([this.#lifetime.signal, signal]) : this.#lifetime.signal;
    cancellation.throwIfAborted();
    const { report, preview } = await matcherTest(input.threadId, input.call, cancellation);
    cancellation.throwIfAborted();
    if (preview === null) return report;
    return `${report}\n${await this.#screenshot({ threadId: input.threadId, cwd: input.cwd, path: "call component", document: preview }, cancellation)}`;
  }

  async #screenshot(input: { threadId: string; cwd: string; path: string; document: string }, cancellation: AbortSignal) {
    const browse = this.#options.browse;
    if (!browse) throw new Error("Component screenshots are unavailable.");
    const target = {
      sessionId: randomUUID(), threadId: input.threadId, cwd: input.cwd,
      path: input.path, document: input.document, controls: {}, signal: cancellation,
    };
    let output: string | null = null;
    let failure: Error | null = null;
    try { output = await browse.inspectDocument(target); }
    catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    try { await browse.end(target, { strict: true }); }
    catch (error) {
      const cleanup = error instanceof Error ? error : new Error(String(error));
      if (failure) throw new AggregateError([failure, cleanup], `Screenshot failed: ${failure.message}; cleanup failed: ${cleanup.message}`);
      throw cleanup;
    }
    if (failure) throw failure;
    if (output === null) throw new Error("Component screenshot returned no output.");
    return output;
  }

  async runComponentCommand(
    caller: Pick<ThreadVisStoredSession, "threadId" | "harness" | "cwd">,
    command: readonly string[], cwd: string, signal: AbortSignal,
  ) {
    return await runVisCommand({
      command, cwd, label: "component", run: this.#options.runCommand(caller),
      runs: this.#runs, signal, powerShellExecutable: this.#options.powerShellExecutable,
    });
  }

  async endSession(input: { threadId: string; cwd: string; rootPath: string; path: string }) {
    await this.start();
    const { display } = await this.#resolve(input.rootPath, input.cwd, input.path, false);
    const live = this.#findLive(input.threadId, display);
    if (!live) throw new Error(`No vis session is live on ${display}.`);
    return await this.#end(live);
  }

  /** Ends every live session of a thread, such as when it settles. */
  async endThread(threadId: string) {
    await this.start();
    for (const live of [...this.#live.values()]) {
      if (live.stored.threadId !== threadId) continue;
      try { await this.#end(live); }
      catch (error) { this.#options.log(`Vis session ${live.stored.path} could not end: ${message(error)}`); }
    }
  }

  /** Retention: expired threads lose their sessions and snapshots. */
  async prune(threadIds: readonly string[]) {
    for (const live of [...this.#live.values()]) if (threadIds.includes(live.stored.threadId)) this.#drop(live);
    await this.#options.store({ kind: "delete", threadIds });
  }

  async readSnapshot(sessionId: string, kind: VisSnapshotKind): Promise<VisSnapshot | null> {
    const snapshot = (await this.#options.store({ kind: "readSnapshot", sessionId, snapshotKind: kind })).snapshot;
    if (!snapshot) return null;
    const { document, ...rest } = snapshot;
    return { ...rest, bytes: document === null ? null : Buffer.byteLength(document) };
  }

  /** The user's force-end from the card; its caller records the transcript item, the agent is never told. */
  async endById(threadId: string, sessionId: string) {
    await this.start();
    const live = this.#live.get(sessionId);
    if (!live || live.stored.threadId !== threadId) throw new Error("That vis session is no longer live.");
    return await this.#end(live, "user");
  }

  /**
   * One control the user's vis set through `wb.state`; the card only forwards changes from its own focused frame. Every
   * frame of the session follows the published state, so other devices and later rebuilds start from it.
   */
  async setControl(threadId: string, sessionId: string, controlId: string, value: string) {
    if (!VisControlIdSchema.safeParse(controlId).success) throw new Error("Vis control ids are 1-200 characters.");
    if (!VisControlValueSchema.safeParse(value).success) throw new Error("Vis control values are limited to 16 KB of JSON.");
    try { JSON.parse(value); }
    catch { throw new Error("Vis control values must be JSON."); }
    const { sessions } = await this.#options.store({ kind: "setControl", threadId, sessionId, controlId, value, updatedAt: this.#now() });
    const live = this.#live.get(sessionId);
    if (!sessions.length || !live) throw new Error("That vis session is no longer live.");
    live.state = { ...live.state, controls: { ...live.state.controls, [controlId]: value } };
    this.#publish(threadId);
    this.#refreshBrowser(live);
  }

  /** The control state of the caller's file, live or from an ended session. */
  async readControls(input: { threadId: string; cwd: string; rootPath: string; path: string }) {
    const { display } = await this.#resolve(input.rootPath, input.cwd, input.path, false);
    const { controls = {} } = await this.#options.store({ kind: "readControls", threadId: input.threadId, path: display });
    return { path: display, controls, live: this.#findLive(input.threadId, display) !== null };
  }

  read(threadId: string): VisThread {
    return {
      sessions: [...this.#live.values()].filter(({ stored }) => stored.threadId === threadId)
        .map(({ state }) => state).sort((left, right) => left.startedAt - right.startedAt),
    };
  }

  observe(threadId: string, onChange: () => void) {
    let listeners = this.#listeners.get(threadId);
    if (!listeners) this.#listeners.set(threadId, listeners = new Set());
    const listener = () => onChange();
    listeners.add(listener);
    return {
      read: () => this.read(threadId),
      release: () => {
        listeners.delete(listener);
        if (!listeners.size) this.#listeners.delete(threadId);
      },
    };
  }

  /** Stops watching and rendering; live sessions stay stored for the next generation. */
  dispose() {
    this.#lifetime.abort(new Error("Vis sessions are reloading."));
    for (const live of this.#live.values()) this.#unwatch(live);
    this.#live.clear();
    this.#listeners.clear();
  }

  async #restore() {
    const { sessions } = await this.#options.store({ kind: "readActive" });
    for (const stored of sessions) {
      if (this.#lifetime.signal.aborted) return;
      const rootPath = await this.#options.resolveRoot(stored);
      if (!rootPath) continue;
      const controls = await this.#controls(stored);
      if (this.#lifetime.signal.aborted) return;
      const live = this.#begin(stored, path.resolve(rootPath, stored.path), rootPath, this.#context(stored.build, rootPath), null, 0, null, controls);
      this.#watch(live, null);
      this.#changed(live);
    }
  }

  async #resolve(rootPath: string, cwd: string, requested: string, mustExist = true) {
    if (!isVisPath(requested)) throw new Error("Vis sessions render .html, .htm, .svg, .tsx or .jsx files.");
    const root = await realpath(rootPath);
    const candidate = path.resolve(cwd, requested);
    const file = mustExist ? await realpath(candidate) : await realpath(candidate).catch(() => candidate);
    if (!isWithin(root, file)) throw new Error("Vis files must live inside the caller's project.");
    return { file, display: path.relative(root, file).replaceAll("\\", "/") };
  }

  async #resolveBuild(cwd: string, project: VisProject): Promise<ThreadVisStoredBuild> {
    if (project.kind !== "folder") return project;
    const root = await realpath(path.resolve(cwd, project.path)).catch(() => null);
    if (!root || !(await stat(root)).isDirectory()) throw new Error(`The vis project ${project.path} is not a folder.`);
    const config = await stat(path.join(root, WORKBENCH_PROJECT_CONFIG_FILE)).catch(() => null);
    if (!config?.isFile()) throw new Error(`The vis project ${project.path} has no ${WORKBENCH_PROJECT_CONFIG_FILE}.`);
    return { kind: "folder", root };
  }

  #context(build: ThreadVisStoredBuild, projectRoot: string): VisBuildContext {
    if (build.kind === "kit") return { rootPath: this.#options.workbenchRoot, config: WORKBENCH_KIT_VIS_CONFIG };
    return { rootPath: build.kind === "folder" ? build.root : projectRoot, config: null };
  }

  #findLive(threadId: string, display: string) {
    return [...this.#live.values()].find(({ stored }) => stored.threadId === threadId && stored.path === display) ?? null;
  }

  /** The file's stored control state; it outlives sessions, so a new one starts where the user left off. */
  async #controls(stored: ThreadVisStoredSession) {
    return (await this.#options.store({ kind: "readControls", threadId: stored.threadId, path: stored.path })).controls ?? {};
  }

  #begin(
    stored: ThreadVisStoredSession, file: string, rootPath: string, context: VisBuildContext,
    document: string | null, renderedAt: number, failure: string | null, controls: VisControls,
  ) {
    const live: Live = {
      stored, document, file, rootPath, context, running: null, again: false, watched: new Map(),
      cancel: new AbortController(),
      state: {
        sessionId: stored.sessionId, path: stored.path, startedAt: stored.startedAt,
        render: document === null ? null : { renderedAt, bytes: Buffer.byteLength(document) },
        rendering: false, failure, controls,
      },
    };
    this.#live.set(stored.sessionId, live);
    this.#publish(stored.threadId);
    return live;
  }

  /** The watch set is the file plus whatever its latest build read; a failed build (null) keeps the previous set. */
  #watch(live: Live, inputs: string[] | null) {
    if (inputs === null && live.watched.size) return;
    const wanted = new Set([live.file, ...(inputs ?? [])]);
    for (const [file, stop] of live.watched) {
      if (wanted.has(file)) continue;
      stop();
      live.watched.delete(file);
    }
    for (const file of wanted) {
      if (!live.watched.has(file)) live.watched.set(file, (this.#options.watch ?? defaultWatch)(file, () => this.#changed(live)));
    }
  }

  #unwatch(live: Live) {
    for (const stop of live.watched.values()) stop();
    live.watched.clear();
  }

  #changed(live: Live) {
    if (this.#live.get(live.stored.sessionId) !== live) return;
    if (!live.state.rendering) {
      live.state = { ...live.state, rendering: true };
      this.#publish(live.stored.threadId);
    }
    if (live.running) {
      live.again = true;
      return;
    }
    live.running = this.#rerender(live).finally(() => { live.running = null; });
  }

  async #rerender(live: Live) {
    const signal = AbortSignal.any([this.#lifetime.signal, live.cancel.signal]);
    do {
      live.again = false;
      const rendered = await this.#render(live.stored, live.file, live.rootPath, live.context, signal);
      if (signal.aborted || this.#live.get(live.stored.sessionId) !== live) return;
      this.#watch(live, rendered.inputs);
      // A failed step keeps the previous render; with nothing to keep, an unstyled document is better than none.
      const replace = rendered.document !== null && (!rendered.failure || !live.state.render);
      if (replace) live.document = rendered.document;
      live.state = {
        ...live.state,
        render: replace ? { renderedAt: this.#now(), bytes: Buffer.byteLength(rendered.document!) } : live.state.render,
        failure: rendered.failure,
        rendering: live.again,
      };
      this.#publish(live.stored.threadId);
      if (replace) this.#refreshBrowser(live);
    } while (live.again);
  }

  /** The session's browser page follows the card, so a reload there shows the latest render; it never rejects. */
  #refreshBrowser(live: Live) {
    if (live.state.render) void this.#options.browse?.refresh(this.#browseTarget(live));
  }

  #browseTarget(live: Live) {
    return { ...live.stored, revision: live.state.render?.renderedAt ?? 0 };
  }

  async #end(live: Live, endedBy: "agent" | "user" = "agent") {
    this.#drop(live);
    await live.running?.catch(() => undefined);
    const rendered = await this.#render(live.stored, live.file, live.rootPath, live.context, this.#lifetime.signal);
    const capturedAt = this.#now();
    await this.#options.store({
      kind: "end", threadId: live.stored.threadId, path: live.stored.path, endedBy,
      snapshot: { capturedAt, document: rendered.document, failure: rendered.failure },
    });
    return { sessionId: live.stored.sessionId, path: live.stored.path, failure: rendered.failure };
  }

  #drop(live: Live) {
    if (this.#live.get(live.stored.sessionId) !== live) return;
    this.#live.delete(live.stored.sessionId);
    this.#unwatch(live);
    live.cancel.abort(new Error("The vis session ended."));
    this.#publish(live.stored.threadId);
    // Never rejects; stopping a browser should not hold up ending.
    void this.#options.browse?.end(live.stored);
  }

  async #render(stored: ThreadVisStoredSession, file: string, rootPath: string, context: VisBuildContext, signal: AbortSignal): Promise<Rendered> {
    const command = {
      file, context, signal, run: this.#options.runCommand(stored), runs: this.#runs,
      powerShellExecutable: this.#options.powerShellExecutable,
      scratchPath: path.join(this.#options.scratchDirectory, `${stored.sessionId}-${randomUUID()}`),
    };
    if (isComponent(file)) {
      try {
        const built = await buildVisDocument(command);
        // Only the caller's project and a configured build folder are watched: anything else (Workbench's kit,
        // node_modules) is a dependency nobody edits mid-session.
        const watchRoots = context.config ? [rootPath] : [rootPath, context.rootPath];
        const inputs = built.inputs.map((input) => path.resolve(context.rootPath, input))
          .filter((input) => watchRoots.some((root) => isWithin(root, input)) && !input.split(path.sep).includes("node_modules"));
        return { document: built.document, failure: null, inputs };
      } catch (error) {
        return { document: null, failure: signal.aborted ? null : `Build: ${message(error)}`, inputs: null };
      }
    }
    let source: string;
    try {
      const info = await stat(file);
      if (!info.isFile()) return { document: null, failure: `${stored.path} is not a file.`, inputs: null };
      if (info.size > VIS_MAX_SOURCE_BYTES) return { document: null, failure: `${stored.path} is larger than 2 MB.`, inputs: null };
      source = await readFile(file, "utf8");
    } catch (error) {
      return { document: null, failure: `Unable to read ${stored.path}: ${message(error)}`, inputs: null };
    }
    let css: string | null = null;
    let failure: string | null = null;
    if (visWantsCss(source)) {
      try {
        css = await compileVisCss(command);
      } catch (error) {
        if (signal.aborted) return { document: null, failure: null, inputs: null };
        failure = `CSS: ${message(error)}`;
      }
    }
    const document = renderVisDocument(source, /\.svg$/iu.test(file) ? "svg" : "html", css);
    if (document.length > VIS_MAX_DOCUMENT_LENGTH) return { document: null, failure: "The rendered document is larger than 16 MB.", inputs: null };
    return { document, failure, inputs: null };
  }

  #publish(threadId: string) {
    for (const listener of [...this.#listeners.get(threadId) ?? []]) {
      try { listener(); }
      catch (error) { this.#options.log(`Vis observer failed: ${message(error)}`); }
    }
  }

  #now() { return (this.#options.now ?? Date.now)(); }
}
