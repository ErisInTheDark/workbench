/*
 * Exports:
 * - default WorkbenchToolStatsCommandController: validate project scope and render the wb tool value report agents read through `wb stats tools`.
 */
import type { WorkbenchStatsReadRequest, WorkbenchStatsSectionData } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { statsToolValueRows, summariseStatsTools } from "workbench-shared/workbench/stats/workbench-stats-tool-value";
import { WorkbenchToolStatsExecutionRequestSchema } from "./lib/workbench/commands/stats-command-definitions";

function whole(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

export default class WorkbenchToolStatsCommandController {
  constructor(private readonly options: {
    resolveProject(cwd: string): Promise<{ id: string; name: string }>;
    read(request: Omit<WorkbenchStatsReadRequest, "section">): Promise<WorkbenchStatsSectionData<"tools">>;
  }) {}

  async execute(input: object, signal: AbortSignal) {
    const parsed = WorkbenchToolStatsExecutionRequestSchema.safeParse(input);
    if (!parsed.success) return new Response("Invalid tool statistics arguments.\n", { status: 400 });
    signal.throwIfAborted();
    const { allProjects, descending, range, sort } = parsed.data;
    const project = allProjects ? null : await this.options.resolveProject(parsed.data.cwd);
    signal.throwIfAborted();
    const { tools } = await this.options.read({ projectIds: project ? [project.id] : null, range });
    signal.throwIfAborted();

    const summary = summariseStatsTools(tools);
    const catalogue = tools.catalogue;
    const prompt = catalogue ? catalogue.specTokens + catalogue.docsTokens : 0;
    const lines = [
      `${range} · ${project ? project.name : "all projects"} · ${whole(summary.calls)} wb tool calls in ${whole(tools.threadCount)} threads`,
      catalogue
        ? `Always-on tool prompt ≈${whole(prompt)} tokens (${whole(catalogue.specTokens)} spec, ${whole(catalogue.docsTokens)} docs, averaged across providers)`
        : "Tool prompt cost is unavailable; calls only.",
      summary.wastePerThread === null || !prompt
        ? `${summary.idle} of ${summary.catalogued} tools never called`
        : `Tool waste per thread ≈${whole(summary.wastePerThread)} tokens (${Math.round(summary.wastePerThread / prompt * 100)}% of tool prompt); ${summary.idle} of ${summary.catalogued} tools never called`,
      "",
      " Calls  Threads   Spec   Docs   Cost  Calls/100  Tool",
    ];
    for (const row of statsToolValueRows(tools, { key: sort, descending })) {
      const value = row.value === null ? "-" : row.value.toFixed(2);
      lines.push([
        whole(row.calls).padStart(6), whole(row.threads).padStart(8),
        (row.retired ? "-" : whole(row.specTokens)).padStart(6), whole(row.docsTokens).padStart(6),
        whole(row.cost).padStart(6), value.padStart(10), ` ${row.tool}${row.retired ? " (retired)" : ""}`,
      ].join(" "));
    }
    if (!tools.workbench.length) lines.push("No wb tools are catalogued or used in this period.");
    return new Response(`${lines.join("\n")}\n`);
  }
}
