/*
 * Exports:
 * - WorkbenchFeedbackCaller: the cwd-owned project, managed thread, and applied model settings behind one submission.
 * - default WorkbenchFeedbackCommandController: validate agent feedback, record it against the project it is about with its author's
 *   settings, and render paged reads for local and relayed callers.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type {
  WorkbenchFeedbackReadRequest,
  WorkbenchFeedbackReadResponse,
  WorkbenchFeedbackRecord,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { WorkbenchFeedbackSubmitRequestSchema } from "../lib/workbench/commands/feedback-command-definition";
import { WorkbenchFeedbackStatsExecutionRequestSchema } from "../lib/workbench/commands/stats-command-definitions";

export interface WorkbenchFeedbackCaller {
  harness: WorkbenchHarness;
  model: string | null;
  projectId: ProjectId;
  reasoningEffort: string | null;
  threadId: WorkbenchThreadId;
}

const TEXT_HEADERS = { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" };
const oneLine = (value: string, limit = 4_000) => value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, limit);
const optionalSetting = (value: string | null, limit: number) => value?.trim() ? oneLine(value, limit) : null;
const formatTime = (value: number) => `${new Date(value).toISOString().slice(0, 16).replace("T", " ")}Z`;

function invalid(issues: readonly { message: string; path: readonly PropertyKey[] }[]) {
  const detail = issues.slice(0, 5).map(({ message, path }) => `${path.map(String).join(".") || "input"}: ${message}`).join("\n");
  return new Response(`Invalid feedback arguments.\n${detail}\n`, { headers: TEXT_HEADERS, status: 400 });
}

export default class WorkbenchFeedbackCommandController {
  constructor(private readonly options: {
    resolveCaller(input: { cwd: string; harness: string; threadId: string }, signal: AbortSignal): Promise<WorkbenchFeedbackCaller>;
    resolveProjectId(cwd: string, endpointName: string): Promise<ProjectId>;
    projectName(projectId: string): string | null;
    record(entry: WorkbenchFeedbackRecord): Promise<number>;
    read(request: WorkbenchFeedbackReadRequest): Promise<WorkbenchFeedbackReadResponse>;
  }) {}

  async submit(input: object, signal: AbortSignal) {
    const parsed = WorkbenchFeedbackSubmitRequestSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    if (parsed.data.path && parsed.data.channel !== "project") {
      return invalid([{ message: "path applies only to project feedback", path: ["path"] }]);
    }
    signal.throwIfAborted();
    const caller = await this.options.resolveCaller(parsed.data, signal);
    signal.throwIfAborted();
    const target = parsed.data.path ? await this.targetProjectId(path.resolve(parsed.data.cwd, parsed.data.path)) : caller.projectId;
    if (target instanceof Response) return target;
    signal.throwIfAborted();
    const id = await this.options.record({
      category: parsed.data.category,
      channel: parsed.data.channel,
      harness: caller.harness,
      model: optionalSetting(caller.model, 200),
      projectId: target,
      reasoningEffort: optionalSetting(caller.reasoningEffort, 50),
      report: parsed.data.report,
      threadId: caller.threadId,
      title: parsed.data.title,
    });
    return new Response(`Recorded ${parsed.data.channel}/${parsed.data.category} feedback #${id}. Thanks.\n`, { headers: TEXT_HEADERS });
  }

  async read(input: object, signal: AbortSignal) {
    const parsed = WorkbenchFeedbackStatsExecutionRequestSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    signal.throwIfAborted();
    const { cwd, ...filters } = parsed.data;
    // Workbench feedback concerns every project; project feedback is read by the project it is about.
    return await this.render(filters, await this.options.resolveProjectId(cwd, "Feedback statistics"), signal);
  }

  /** A file targets its folder's project. */
  private async targetProjectId(target: string): Promise<ProjectId | Response> {
    let folder: string;
    try {
      folder = (await fs.stat(target)).isDirectory() ? target : path.dirname(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return invalid([{ message: `${target} does not exist`, path: ["path"] }]);
    }
    return await this.options.resolveProjectId(folder, "Feedback path");
  }

  /** Another daemon's thread reading this daemon's feedback: `null` is the wb channel across projects, a project its own feedback. */
  async readRemote(projectId: ProjectId | null, input: object, signal: AbortSignal) {
    const parsed = WorkbenchFeedbackStatsExecutionRequestSchema.safeParse({ ...input, cwd: ".", host: null, callerThreadId: null });
    if (!parsed.success) return invalid(parsed.error.issues);
    const { cwd: _cwd, ...filters } = parsed.data;
    return await this.render(projectId ? { ...filters, allProjects: false } : { ...filters, allProjects: true, channel: "wb" }, projectId, signal);
  }

  private async render(
    { allProjects, host: _host, callerThreadId: _caller, ...filters }: Omit<ReturnType<typeof WorkbenchFeedbackStatsExecutionRequestSchema.parse>, "cwd">,
    projectId: ProjectId | null, signal: AbortSignal,
  ) {
    const projectIds = allProjects || !projectId ? null : [projectId];
    const result = await this.options.read({ ...filters, projectIds });
    signal.throwIfAborted();
    if (result.page > result.pages) return new Response(`Page must be between 1 and ${result.pages}.\n`, { headers: TEXT_HEADERS, status: 400 });
    const lines = [`Page ${result.page} of ${result.pages}`, ""];
    for (const row of result.rows) {
      const author = [row.model ?? "unknown model", row.reasoningEffort, row.scored ? null : "unscored"].filter(Boolean).join(" ");
      const thread = row.threadId ?? "[thread removed]";
      const project = allProjects ? `  ${oneLine(this.options.projectName(row.projectId) ?? row.projectId, 120)}` : "";
      lines.push(
        `${String(Math.round(row.importance * 100)).padStart(3)}  ${formatTime(row.createdAt)}  ${row.channel}/${row.category}  ${author}${project}  ${oneLine(row.title, 120)}  ${thread}`,
        `     ${oneLine(row.report)}`,
      );
    }
    if (!result.rows.length) lines.push("No feedback.");
    return new Response(`${lines.join("\n")}\n`, { headers: TEXT_HEADERS });
  }
}
