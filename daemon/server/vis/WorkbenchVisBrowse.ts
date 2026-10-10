/*
 * Exports:
 * - VisBrowsePort: run a Browse script or stop a session as a vis session's thread.
 * - VisBrowseTarget: the vis session, its thread and the render to show.
 * - default WorkbenchVisBrowse: own each vis session's headless Browse session: write its current render as a framed
 *   page, open it, return a snapshot or screenshot of it, and stop it with the vis.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkbenchBrowseAgentScriptInlineRequest, WorkbenchBrowseCommandResponse } from "workbench-shared/types";
import { formatVisScreenshotResult } from "workbench-shared/workbench/vis/vis-contract";
import { frameVisDocument } from "workbench-shared/workbench/vis/vis-frame";

export interface VisBrowsePort {
  execute(request: WorkbenchBrowseAgentScriptInlineRequest): Promise<Response>;
  stop(request: { session: string; threadId: string; cwd: string }): Promise<void>;
}

export interface VisBrowseTarget {
  sessionId: string;
  threadId: string;
  cwd: string;
  path: string;
  document: string;
}

/** Close to the card's frame width, so layouts break where the user sees them break. */
const VIEWPORT = "viewport 960 720";

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export default class WorkbenchVisBrowse {
  readonly #directory: string;
  readonly #port: VisBrowsePort;
  readonly #log: (message: string) => void;

  constructor(options: { directory: string; port: VisBrowsePort; log(message: string): void }) {
    this.#directory = options.directory;
    this.#port = options.port;
    this.#log = options.log;
  }

  static sessionName(sessionId: string) {
    return `vis-${sessionId.slice(0, 8)}`;
  }

  /** Opens the render ahead of the first check; checks reopen it anyway, so failing here only costs a warning. */
  async open(target: VisBrowseTarget) {
    try {
      await this.#load(target, `Opening vis of ${target.path}`);
    } catch (error) {
      this.#log(`Vis browser for ${target.path} could not open: ${message(error)}`);
    }
  }

  /**
   * Reopens the current render each time, since the page may have re-rendered since the last check. The check runs
   * as its own one-line script: a script's output joins every line's JSON, so only a single line parses as one value.
   */
  async inspect(target: VisBrowseTarget, kind: "snapshot" | "screenshot") {
    const verb = kind === "snapshot" ? "Snapshotting" : "Screenshotting";
    await this.#load(target, `${verb} vis of ${target.path}`);
    const stdout = await this.#script(target, kind === "snapshot" ? "snapshot --compact" : "screenshot --full-page", `${verb} vis of ${target.path}`);
    if (kind === "screenshot") {
      const assetUrl = (JSON.parse(stdout) as { assetUrl?: unknown }).assetUrl;
      return formatVisScreenshotResult(target.path, typeof assetUrl === "string" ? assetUrl : null);
    }
    const tree = (JSON.parse(stdout) as { tree?: unknown }).tree;
    if (typeof tree !== "string") throw new Error("Browse returned a snapshot without an accessibility tree.");
    return `${tree}\n`;
  }

  async end(target: Pick<VisBrowseTarget, "sessionId" | "threadId" | "cwd">) {
    try {
      await this.#port.stop({ session: WorkbenchVisBrowse.sessionName(target.sessionId), threadId: target.threadId, cwd: target.cwd });
    } catch (error) {
      this.#log(`Vis browser ${WorkbenchVisBrowse.sessionName(target.sessionId)} could not stop: ${message(error)}`);
    }
    await rm(this.#page(target.sessionId), { force: true }).catch((error: unknown) => {
      this.#log(`Vis browser page for ${target.sessionId} could not be removed: ${message(error)}`);
    });
  }

  #page(sessionId: string) {
    return path.join(this.#directory, `${sessionId}.html`);
  }

  /** Writes the framed current render and opens it at the card's width. */
  async #load(target: VisBrowseTarget, summary: string) {
    const page = this.#page(target.sessionId);
    await mkdir(this.#directory, { recursive: true });
    await writeFile(page, frameVisDocument(target.document));
    await this.#script(target, `open ${pathToFileURL(page).href} --headless\n${VIEWPORT}`, summary);
  }

  /** Script requests answer with one command response; failures carry `error`. */
  async #script(target: VisBrowseTarget, script: string, summary: string) {
    const response = await this.#port.execute({
      cwd: target.cwd,
      threadId: target.threadId,
      session: WorkbenchVisBrowse.sessionName(target.sessionId),
      mode: "headless",
      // The agent checks its own work; the user sees the vis itself, not these screenshots.
      hiddenScreenshots: true,
      stopOnError: true,
      summary,
      script,
    });
    const body = await response.json() as Partial<WorkbenchBrowseCommandResponse>;
    if (!response.ok || !body.ok) throw new Error(body.error || body.stderr || `Browse failed with status ${response.status}.`);
    return body.stdout ?? "";
  }
}
