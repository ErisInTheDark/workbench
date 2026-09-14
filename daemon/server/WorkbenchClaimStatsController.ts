/*
 * Exports:
 * - default WorkbenchClaimStatsController: validate project ownership and render compact paged claim reports.
 */
import path from "node:path";
import { WorkbenchClaimStatsExecutionRequestSchema } from "./lib/workbench/commands/stats-command-definitions";
import { formatWorkspaceQualifiedPath, parseWorkspaceQualifiedPath, resolveProjectFilePath } from "./lib/project";
import type { AgentEndpointProjectResolution } from "./lib/workbench/project/agent-endpoint-project";
import type { WorkbenchClaimStatsRequest, WorkbenchClaimStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-claims-contract";

const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 2_000);

export default class WorkbenchClaimStatsController {
  constructor(private readonly options: {
    resolveProjectFromCwd(cwd: string): Promise<AgentEndpointProjectResolution>;
    read(request: WorkbenchClaimStatsRequest): Promise<WorkbenchClaimStatsResponse>;
  }) {}

  async execute(input: object, signal: AbortSignal) {
    const parsed = WorkbenchClaimStatsExecutionRequestSchema.safeParse(input);
    if (!parsed.success) return new Response("Invalid claim statistics arguments.\n", { status: 400 });
    signal.throwIfAborted();
    const { project, root } = await this.options.resolveProjectFromCwd(parsed.data.cwd);
    signal.throwIfAborted();
    let file: WorkbenchClaimStatsRequest["file"] = null;
    if (parsed.data.file) {
      const raw = parsed.data.file;
      const qualified = path.isAbsolute(raw) ? null : parseWorkspaceQualifiedPath(raw);
      const selectedRoot = qualified ? project.roots.find(({ id }) => id === qualified.rootId) : root;
      if (!selectedRoot) return new Response("Unknown workspace root.\n", { status: 400 });
      const relative = qualified?.relativePath ?? (path.isAbsolute(raw) ? path.relative(selectedRoot.root, raw) : raw);
      const target = resolveProjectFilePath(project, project.kind === "workspace"
        ? formatWorkspaceQualifiedPath(selectedRoot.id, relative) : relative);
      const canonicalPath = path.relative(target.root.root, target.absolutePath).replace(/\\/gu, "/");
      if (!canonicalPath) return new Response("A file path is required.\n", { status: 400 });
      file = { rootId: target.root.id, path: canonicalPath };
    }
    const result = await this.options.read({
      projectId: project.id, file, range: parsed.data.range, page: parsed.data.page,
    });
    signal.throwIfAborted();
    if (result.page > result.pages) return new Response(`Page must be between 1 and ${result.pages}.\n`, { status: 400 });
    const lines = [`Page ${result.page} of ${result.pages}`, ""];
    if (result.kind === "files") {
      lines.push("Threads  File");
      for (const row of result.rows) lines.push(`${String(row.threadCount).padStart(7)}  ${oneLine(formatWorkspaceQualifiedPath(row.rootId, row.path))}`);
    } else {
      if (result.rows.some((row) => row.identity !== "managed")) {
        return new Response("This claim report contains historical threads whose Workbench identity has not been observed. Their claim evidence is retained.\n", { status: 409 });
      }
      for (const row of result.rows) {
        lines.push(`${oneLine(row.threadId)}  ${row.title ? oneLine(row.title) : "[title unavailable]"}`);
      }
    }
    if (!result.rows.length) lines.push("No results.");
    return new Response(`${lines.join("\n")}\n`);
  }
}
