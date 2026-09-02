/*
 * Exports:
 * - default WorkbenchTokenCountController: own local GPT-5 text counting, Workbench source admission, and catalog-owned project AGENTS counting. Keywords: tokens, GPT-5, instructions, project, cwd.
 */
import path from "node:path";

import {
  buildProjectInstructionTokenCorpus,
  buildWorkbenchInstructionTokenCorpus,
} from "../lib/workbench/commands/instruction-token-corpus";
import Gpt5TextTokens from "../lib/workbench/commands/gpt-5-text-tokens";
import { WorkbenchTokenCountExecutionRequestSchema } from "../lib/workbench/commands/token-command-definition";

interface ProjectInstructionResolution {
  readonly cwd: string;
  readonly root: { readonly root: string };
}

interface WorkbenchTokenCountControllerOptions {
  projectRoot: string;
  resolveProjectFromCwd(cwd: string): Promise<ProjectInstructionResolution>;
}

function pathsEqual(left: string, right: string) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

function boundedErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b[A-Za-z]:[\\/][^\r\n]*/gu, "[path]")
    .replace(/(^|\s)\/[^\r\n]*/gu, "$1[path]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "?")
    .trim()
    .slice(0, 1000);
}

export default class WorkbenchTokenCountController {
  private readonly projectRoot: string;
  private readonly resolveProjectFromCwd: WorkbenchTokenCountControllerOptions["resolveProjectFromCwd"];

  constructor({ projectRoot, resolveProjectFromCwd }: WorkbenchTokenCountControllerOptions) {
    this.projectRoot = path.resolve(projectRoot);
    this.resolveProjectFromCwd = resolveProjectFromCwd;
  }

  async execute(input: object, signal: AbortSignal) {
    const parsed = WorkbenchTokenCountExecutionRequestSchema.safeParse(input);
    if (!parsed.success) return new Response("A valid token count request is required.\n", { status: 400 });
    if (
      parsed.data.kind === "instructions"
      && parsed.data.callerThreadId !== null
      && !pathsEqual(parsed.data.cwd, this.projectRoot)
    ) {
      return new Response("Managed threads can count Workbench instructions only from the running Workbench repository root.\n", { status: 403 });
    }
    if (signal.aborted) throw signal.reason;

    if (parsed.data.kind === "text") {
      return new Response(`${Gpt5TextTokens.count(parsed.data.text)} tokens for ${parsed.data.model}\n`);
    }

    if (parsed.data.kind === "instructions") {
      try {
        const corpus = await buildWorkbenchInstructionTokenCorpus(
          path.join(this.projectRoot, "webapp", "lib", "workbench", "instructions"),
        );
        if (signal.aborted) throw signal.reason;
        const count = Gpt5TextTokens.count(corpus.content);
        const suffix = ` across ${corpus.files.length} instruction file${corpus.files.length === 1 ? "" : "s"}`;
        return new Response(`${count} tokens${suffix} for ${parsed.data.model}\n`);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
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
      return new Response(
        `${Gpt5TextTokens.count(corpus.content)} tokens across the resolved project AGENTS chain for ${parsed.data.model}\n`,
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return new Response(
        `Project instructions could not be read for token counting: ${boundedErrorMessage(error)}\n`,
        { status: 500 },
      );
    }
  }
}
