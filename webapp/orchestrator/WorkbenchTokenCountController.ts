/*
 * Exports:
 * - default WorkbenchTokenCountController: own local GPT-5 text token counting and Workbench instruction-corpus admission. Keywords: tokens, GPT-5, instructions, cwd.
 */
import path from "node:path";

import { buildWorkbenchInstructionTokenCorpus } from "../lib/workbench/commands/instruction-token-corpus";
import Gpt5TextTokens from "../lib/workbench/commands/gpt-5-text-tokens";
import { WorkbenchTokenCountExecutionRequestSchema } from "../lib/workbench/commands/token-command-definition";

interface WorkbenchTokenCountControllerOptions {
  projectRoot: string;
}

function pathsEqual(left: string, right: string) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

export default class WorkbenchTokenCountController {
  private readonly projectRoot: string;

  constructor({ projectRoot }: WorkbenchTokenCountControllerOptions) {
    this.projectRoot = path.resolve(projectRoot);
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

    let corpus = null;
    try {
      corpus = parsed.data.kind === "instructions"
        ? await buildWorkbenchInstructionTokenCorpus(path.join(this.projectRoot, "webapp", "lib", "workbench", "instructions"))
        : null;
    } catch {
      return new Response("Workbench instruction sources could not be read for token counting.\n", { status: 500 });
    }
    if (signal.aborted) throw signal.reason;
    const content = parsed.data.kind === "instructions" ? corpus!.content : parsed.data.text;
    const count = Gpt5TextTokens.count(content);
    const suffix = corpus
      ? ` across ${corpus.files.length} instruction file${corpus.files.length === 1 ? "" : "s"}`
      : "";
    return new Response(`${count} tokens${suffix} for ${parsed.data.model}\n`);
  }
}
