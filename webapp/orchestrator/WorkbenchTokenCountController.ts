/*
 * Exports:
 * - default WorkbenchTokenCountController: own official OpenAI token-count requests and Workbench instruction-corpus admission. Keywords: tokens, OpenAI, instructions, cwd.
 */
import path from "node:path";

import { z } from "zod";

import { buildWorkbenchInstructionTokenCorpus } from "../lib/workbench/commands/instruction-token-corpus";
import { WorkbenchTokenCountExecutionRequestSchema } from "../lib/workbench/commands/token-command-definition";

const OpenAIInputTokenCountSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  object: z.literal("response.input_tokens"),
}).passthrough();

interface WorkbenchTokenCountControllerOptions {
  apiKey?: () => string | undefined;
  fetchRequest?: typeof fetch;
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
  private readonly apiKey: () => string | undefined;
  private readonly fetchRequest: typeof fetch;
  private readonly projectRoot: string;

  constructor({
    apiKey = () => process.env.OPENAI_API_KEY,
    fetchRequest = fetch,
    projectRoot,
  }: WorkbenchTokenCountControllerOptions) {
    this.apiKey = apiKey;
    this.fetchRequest = fetchRequest;
    this.projectRoot = path.resolve(projectRoot);
  }

  async execute(input: object, signal: AbortSignal) {
    const parsed = WorkbenchTokenCountExecutionRequestSchema.safeParse(input);
    if (!parsed.success) return new Response("A valid token count request is required.\n", { status: 400 });
    if (parsed.data.kind === "instructions" && !pathsEqual(parsed.data.cwd, this.projectRoot)) {
      return new Response("Workbench instruction token counting is available only from the Workbench repository root.\n", { status: 403 });
    }
    if (signal.aborted) throw signal.reason;
    const apiKey = this.apiKey()?.trim();
    if (!apiKey) return new Response("OPENAI_API_KEY is required for exact model token counting.\n", { status: 503 });

    let corpus = null;
    try {
      corpus = parsed.data.kind === "instructions"
        ? await buildWorkbenchInstructionTokenCorpus(path.join(this.projectRoot, "webapp", "lib", "workbench", "instructions"))
        : null;
    } catch {
      return new Response("Workbench instruction sources could not be read for token counting.\n", { status: 500 });
    }
    if (signal.aborted) throw signal.reason;
    const body = parsed.data.kind === "instructions"
      ? { input: "", instructions: corpus!.content, model: parsed.data.model }
      : { input: parsed.data.text, model: parsed.data.model };
    let response: Response;
    try {
      response = await this.fetchRequest("https://api.openai.com/v1/responses/input_tokens", {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal,
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      return new Response("OpenAI token counting could not reach the API.\n", { status: 502 });
    }
    if (!response.ok) {
      return new Response(`OpenAI token counting failed with status ${response.status}.\n`, { status: 502 });
    }
    const counted = OpenAIInputTokenCountSchema.safeParse(await response.json().catch(() => null));
    if (!counted.success) return new Response("OpenAI returned an invalid token count response.\n", { status: 502 });
    const suffix = corpus
      ? ` across ${corpus.files.length} instruction file${corpus.files.length === 1 ? "" : "s"}`
      : "";
    return new Response(`${counted.data.input_tokens} tokens${suffix} for ${parsed.data.model}\n`);
  }
}
