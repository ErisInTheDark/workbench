/*
 * Exports:
 * - default WorkbenchTokenCountController: own local GPT-5 counting and source-aware Workbench/project instruction reports.
 */
import path from "node:path";
import { isSamePath } from "workbench-shared/same-path";

import {
  buildProjectInstructionTokenCorpus,
  buildWorkbenchInstructionTokenCorpus,
  type InstructionTokenSource,
} from "../lib/workbench/commands/instruction-token-corpus";
import type { Gpt5TokenMeasure } from "../lib/workbench/commands/gpt-5-text-tokens";
import { Gpt5TokenDeadlineError, measureGpt5Tokens } from "../lib/workbench/commands/gpt-5-token-measure";
import { WorkbenchTokenCountExecutionRequestSchema } from "../lib/workbench/commands/token-command-definition";
import type { WorkbenchHarness } from "workbench-shared/types";

interface ProjectInstructionResolution {
  readonly cwd: string;
  readonly root: { readonly root: string };
}

interface WorkbenchTokenCountControllerOptions {
  projectRoot: string;
  resolveProjectFromCwd(cwd: string): Promise<ProjectInstructionResolution>;
  renderSkill?(request: { cwd: string; harness: WorkbenchHarness; name: string; threadId: string }, signal: AbortSignal): Promise<Response>;
}

function boundedErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b[A-Za-z]:[\\/][^\r\n]*/gu, "[path]")
    .replace(/(^|\s)\/[^\r\n]*/gu, "$1[path]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "?")
    .trim()
    .slice(0, 1000);
}

/** A count that had to split long unbroken runs says so. */
function tokenCount({ estimated, tokens }: Gpt5TokenMeasure) {
  return `${estimated ? "about " : ""}${tokens}`;
}

function tokenCountLabel(measure: Gpt5TokenMeasure) {
  return `${tokenCount(measure)} token${measure.tokens === 1 ? "" : "s"}`;
}

async function formatSourceBreakdown(sources: readonly InstructionTokenSource[], signal: AbortSignal) {
  const lines = [
    "Source and section counts are independent; heading ranges include nested headings, active sources are listed once even when imports reuse them, and these counts do not sum to the reported total.",
  ];
  const measures = await measureGpt5Tokens(sources.flatMap(source => [source.content, ...source.sections.map(section => section.content)]), { signal });
  let next = 0;
  for (const source of sources) {
    lines.push("", `${source.path}: ${tokenCountLabel(measures[next++]!)}`);
    for (const section of source.sections) {
      lines.push(`  ${section.startLine}-${section.endLine} ${section.heading ?? "[preamble]"}: ${tokenCountLabel(measures[next++]!)}`);
    }
  }
  return lines.join("\n");
}

export default class WorkbenchTokenCountController {
  private readonly projectRoot: string;
  private readonly resolveProjectFromCwd: WorkbenchTokenCountControllerOptions["resolveProjectFromCwd"];
  private readonly renderSkill: WorkbenchTokenCountControllerOptions["renderSkill"];

  constructor({ projectRoot, resolveProjectFromCwd, renderSkill }: WorkbenchTokenCountControllerOptions) {
    this.projectRoot = path.resolve(projectRoot);
    this.resolveProjectFromCwd = resolveProjectFromCwd;
    this.renderSkill = renderSkill;
  }

  async execute(input: object, signal: AbortSignal) {
    try {
      return await this.count(input, signal);
    } catch (error) {
      if (error instanceof Gpt5TokenDeadlineError) return new Response(`${error.message}\n`, { status: 422 });
      throw error;
    }
  }

  private async count(input: object, signal: AbortSignal) {
    const parsed = WorkbenchTokenCountExecutionRequestSchema.safeParse(input);
    if (!parsed.success) return new Response("A valid token count request is required.\n", { status: 400 });
    if (
      parsed.data.kind === "instructions"
      && parsed.data.callerThreadId !== null
      && !isSamePath(parsed.data.cwd, this.projectRoot)
    ) {
      return new Response("Managed threads can count Workbench instructions only from the running Workbench repository root.\n", { status: 403 });
    }
    if (signal.aborted) throw signal.reason;

    if (parsed.data.kind === "text") {
      const [measure] = await measureGpt5Tokens([parsed.data.text], { signal });
      return new Response(`${tokenCount(measure!)} tokens for ${parsed.data.model}\n`);
    }

    if (parsed.data.kind === "skill") {
      if (!this.renderSkill) return new Response("Skill token counting is not configured.\n", { status: 500 });
      const response = await this.renderSkill(parsed.data, signal);
      if (!response.ok) return response;
      const body = await response.text();
      signal.throwIfAborted();
      const [measure] = await measureGpt5Tokens([body], { signal });
      return new Response(`${tokenCount(measure!)} tokens for skill ${parsed.data.name} using ${parsed.data.model}\n`);
    }

    if (parsed.data.kind === "instructions") {
      try {
        const corpus = await buildWorkbenchInstructionTokenCorpus(
          path.join(this.projectRoot, "instructions"),
        );
        if (signal.aborted) throw signal.reason;
        const [measure] = await measureGpt5Tokens([corpus.content], { signal });
        const suffix = ` across ${corpus.files.length} instruction source${corpus.files.length === 1 ? "" : "s"}`;
        const summary = `${tokenCount(measure!)} tokens${suffix} for ${parsed.data.model}`;
        return new Response(parsed.data.toc
          ? `${summary}\n\n${await formatSourceBreakdown(corpus.sources, signal)}\n`
          : `${summary}\n`);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof Gpt5TokenDeadlineError) throw error;
        return new Response("Workbench instruction sources could not be read for token counting.\n", { status: 500 });
      }
    }

    let project: ProjectInstructionResolution;
    try {
      project = await this.resolveProjectFromCwd(parsed.data.cwd);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return new Response(
        `Project token counting requires a cwd inside a discovered Workbench project: ${boundedErrorMessage(error)}\n`,
        { status: 400 },
      );
    }
    if (signal.aborted) throw signal.reason;

    try {
      const corpus = buildProjectInstructionTokenCorpus({
        cwd: project.cwd,
        roots: [{ rootPath: project.root.root }],
      });
      if (signal.aborted) throw signal.reason;
      const [measure] = await measureGpt5Tokens([corpus.content], { signal });
      const summary = `${tokenCount(measure!)} tokens across the resolved project AGENTS chain for ${parsed.data.model}`;
      return new Response(parsed.data.toc
        ? `${summary}\n\n${await formatSourceBreakdown(corpus.sources, signal)}\n`
        : `${summary}\n`);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof Gpt5TokenDeadlineError) throw error;
      return new Response(
        `Project instructions could not be read for token counting: ${boundedErrorMessage(error)}\n`,
        { status: 500 },
      );
    }
  }
}
