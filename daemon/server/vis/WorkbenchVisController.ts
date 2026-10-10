/*
 * Exports:
 * - WorkbenchVisControllerOptions: storage, project, sandboxed project-command, browser and file-watching ports.
 * - default WorkbenchVisController: own live vis sessions for one daemon generation. Starting and ending snapshot the
 *   rendered file; between them a change to the file (or, for built components, any file the build read) keeps the
 *   last render and marks one in flight, and only a finished render replaces it. Live sessions survive reloads
 *   through storage and resume on start. Each session builds in its caller's project, another folder's `.wb.json`,
 *   or Workbench's kit, stores the answers its vis sends back, and has a headless browser agents check it in.
 */
import { randomUUID } from "node:crypto";
import { watch as watchDirectory } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  isVisPath, VIS_MAX_ANSWER_LENGTH, VIS_MAX_DOCUMENT_LENGTH, VIS_MAX_SOURCE_BYTES,
  type VisLiveSession, type VisProject, type VisSnapshotKind, type VisThread, type VisUserEnded,
} from "workbench-shared/workbench/vis/vis-contract";
import { renderVisDocument, visWantsCss } from "workbench-shared/workbench/vis/vis-document";
import type { ThreadVisCommand, ThreadVisResult, ThreadVisStoredBuild, ThreadVisStoredSession } from "../database/vis/WorkbenchThreadVisStore";
import { WORKBENCH_PROJECT_CONFIG_FILE } from "workbench-shared/workbench/project-config/workbench-project-config";
import {
  buildVisDocument, compileVisCss, VisRenderRuns, WORKBENCH_KIT_VIS_CONFIG,
  type VisBuildContext, type VisCommandRunner,
} from "./vis-project-command";
import type WorkbenchVisBrowse from "./WorkbenchVisBrowse";

export interface WorkbenchVisControllerOptions {
  store(command: ThreadVisCommand): Promise<ThreadVisResult>;
  /** The project root a stored session's path is relative to; null once the project is gone. */
  resolveRoot(session: ThreadVisStoredSession): Promise<string | null>;
  /** Runs a project's vis command as the session's thread, in that thread's sandbox. */
  runCommand(session: ThreadVisStoredSession): VisCommandRunner;
  /** Workbench-owned directory for project command input files. */
  scratchDirectory: string;
  /** Workbench's checkout, where the kit context's commands run. */
  workbenchRoot: string;
  /** Each session's headless browser, opened with it and stopped when it ends. */
  browse?: Pick<WorkbenchVisBrowse, "end" | "inspect" | "open">;
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

interface Live {
  stored: ThreadVisStoredSession;
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
  /** Per observed thread, the sessions its user ended; loaded on first observation. */
  readonly #userEnded = new Map<string, VisUserEnded[]>();
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
    const live = this.#begin(stored, file, input.rootPath, context, { document: rendered.document, renderedAt: stored.startedAt }, rendered.failure);
    this.#watch(live, rendered.inputs);
    // Warms the session's browser without holding up the start; it never rejects.
    void this.#options.browse?.open({ ...stored, document: rendered.document });
    return { sessionId: stored.sessionId, path: display, failure: rendered.failure };
  }

  /** Checks the session's current render in its headless browser: an accessibility snapshot, or a screenshot sent to the agent. */
  async inspect(input: { threadId: string; cwd: string; rootPath: string; path: string }, kind: "snapshot" | "screenshot") {
    await this.start();
    const { display } = await this.#resolve(input.rootPath, input.cwd, input.path, false);
    const live = this.#findLive(input.threadId, display);
    if (!live) throw new Error(`No vis session is live on ${display}.`);
    if (!live.state.render) throw new Error(`${display} has not rendered yet; try again once it has.`);
    if (!this.#options.browse) throw new Error("Vis browser checks are unavailable.");
    return await this.#options.browse.inspect({ ...live.stored, document: live.state.render.document }, kind);
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
    for (const threadId of threadIds) this.#userEnded.delete(threadId);
    await this.#options.store({ kind: "delete", threadIds });
  }

  async readSnapshot(sessionId: string, kind: VisSnapshotKind) {
    return (await this.#options.store({ kind: "readSnapshot", sessionId, snapshotKind: kind })).snapshot;
  }

  /** The user's force-end from the card; their transcript shows it, the agent is never told. */
  async endById(threadId: string, sessionId: string) {
    await this.start();
    const live = this.#live.get(sessionId);
    if (!live || live.stored.threadId !== threadId) throw new Error("That vis session is no longer live.");
    return await this.#end(live, "user");
  }

  /** A value the user's vis sent through `wb.send`; the card only forwards messages from its own focused frame. */
  async answer(threadId: string, sessionId: string, value: string) {
    if (value.length > VIS_MAX_ANSWER_LENGTH) throw new Error("Vis answers are limited to 16 KB of JSON.");
    try { JSON.parse(value); }
    catch { throw new Error("Vis answers must be JSON."); }
    const { sessions } = await this.#options.store({ kind: "answer", threadId, sessionId, sentAt: this.#now(), value });
    if (!sessions.length) throw new Error("That vis session is no longer live.");
  }

  /** Answers of the caller's newest session on `path`, live or ended. */
  async readAnswers(input: { threadId: string; cwd: string; rootPath: string; path: string }) {
    const { display } = await this.#resolve(input.rootPath, input.cwd, input.path, false);
    const { answers = [] } = await this.#options.store({ kind: "readAnswers", threadId: input.threadId, path: display });
    return { path: display, answers, live: this.#findLive(input.threadId, display) !== null };
  }

  read(threadId: string): VisThread {
    return {
      sessions: [...this.#live.values()].filter(({ stored }) => stored.threadId === threadId)
        .map(({ state }) => state).sort((left, right) => left.startedAt - right.startedAt),
      userEnded: this.#userEnded.get(threadId) ?? [],
    };
  }

  observe(threadId: string, onChange: () => void) {
    let listeners = this.#listeners.get(threadId);
    if (!listeners) this.#listeners.set(threadId, listeners = new Set());
    if (!this.#userEnded.has(threadId)) void this.#loadUserEnded(threadId);
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

  async #loadUserEnded(threadId: string) {
    try {
      const { userEnded = [] } = await this.#options.store({ kind: "readUserEnded", threadId });
      if (this.#lifetime.signal.aborted || this.#userEnded.has(threadId)) return;
      this.#userEnded.set(threadId, userEnded);
      this.#publish(threadId);
    } catch (error) {
      this.#options.log(`Vis user-ended sessions could not be read: ${message(error)}`);
    }
  }

  async #restore() {
    const { sessions } = await this.#options.store({ kind: "readActive" });
    for (const stored of sessions) {
      if (this.#lifetime.signal.aborted) return;
      const rootPath = await this.#options.resolveRoot(stored);
      if (!rootPath) continue;
      const live = this.#begin(stored, path.resolve(rootPath, stored.path), rootPath, this.#context(stored.build, rootPath), null, null);
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

  #begin(stored: ThreadVisStoredSession, file: string, rootPath: string, context: VisBuildContext, render: VisLiveSession["render"], failure: string | null) {
    const live: Live = {
      stored, file, rootPath, context, running: null, again: false, watched: new Map(),
      cancel: new AbortController(),
      state: { sessionId: stored.sessionId, path: stored.path, startedAt: stored.startedAt, render, rendering: false, failure },
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
      live.state = {
        ...live.state,
        render: replace ? { document: rendered.document!, renderedAt: this.#now() } : live.state.render,
        failure: rendered.failure,
        rendering: live.again,
      };
      this.#publish(live.stored.threadId);
    } while (live.again);
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
    if (endedBy === "user") {
      const threadId = live.stored.threadId;
      this.#userEnded.set(threadId, [...this.#userEnded.get(threadId) ?? [], { sessionId: live.stored.sessionId, path: live.stored.path, endedAt: capturedAt }]);
      this.#publish(threadId);
    }
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
    if (document.length > VIS_MAX_DOCUMENT_LENGTH) return { document: null, failure: "The rendered document is larger than 6 MB.", inputs: null };
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
