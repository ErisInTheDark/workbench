/*
 * Exports:
 * - WorkbenchFeedbackCaller: the cwd-owned project, managed thread, and applied model settings behind one submission.
 * - default WorkbenchFeedbackCommandController: validate agent feedback, record it with its author's settings, and render paged reads.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type {
  WorkbenchFeedbackReadRequest,
  WorkbenchFeedbackReadResponse,
  WorkbenchFeedbackRecord,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { WorkbenchFeedbackSubmitRequestSchema } from "./lib/workbench/commands/feedback-command-definition";
import { WorkbenchFeedbackStatsExecutionRequestSchema } from "./lib/workbench/commands/stats-command-definitions";

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
    resolveProjectId(cwd: string): Promise<ProjectId>;
    projectName(projectId: string): string | null;
    record(entry: WorkbenchFeedbackRecord): Promise<number>;
    read(request: WorkbenchFeedbackReadRequest): Promise<WorkbenchFeedbackReadResponse>;
  }) {}

  async submit(input: object, signal: AbortSignal) {
    const parsed = WorkbenchFeedbackSubmitRequestSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    signal.throwIfAborted();
    const caller = await this.options.resolveCaller(parsed.data, signal);
    signal.throwIfAborted();
    const id = await this.options.record({
      category: parsed.data.category,
      channel: parsed.data.channel,
      harness: caller.harness,
      model: optionalSetting(caller.model, 200),
      projectId: caller.projectId,
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
    const { allProjects, cwd, ...filters } = parsed.data;
    // Workbench feedback concerns every project; project feedback stays with the project that owns the cwd.
    const projectId = await this.options.resolveProjectId(cwd);
    const projectIds = allProjects ? null : [projectId];
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
