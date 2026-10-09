/*
 * Exports:
 * - WorkbenchToolPromptCost: average always-on prompt tokens per wb tool (served spec and `<docs>` text) across providers.
 * - WorkbenchToolCatalogueTokensOptions: tool spec, instruction catalogue, instruction source and tokenizer ports.
 * - default WorkbenchToolCatalogueTokens: count each wb tool's prompt cost, recounting only when specs or instruction sources change.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import Gpt5TextTokens from "../lib/workbench/commands/gpt-5-text-tokens";
import { collectWorkbenchInstructionToolDocs } from "../lib/workbench/instructions/instruction-tool-docs";
import { resolveWorkbenchInstructionToolReference, type WorkbenchInstructionTool } from "../lib/workbench/instructions/instruction-tool-reference";

export interface WorkbenchToolPromptCost {
  readonly docsTokens: number;
  readonly specTokens: number;
  readonly tools: ReadonlyMap<string, { readonly docsTokens: number; readonly specTokens: number }>;
}

interface ServedToolSpec {
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly name: string;
}

export interface WorkbenchToolCatalogueTokensOptions {
  /** Providers whose served catalogues are averaged. */
  readonly harnesses: readonly WorkbenchHarness[];
  readonly readToolSpecs: (harness: WorkbenchHarness) => Promise<readonly ServedToolSpec[]>;
  readonly readInstructionTools: () => Promise<readonly WorkbenchInstructionTool[]>;
  readonly readInstructionSources: () => Promise<readonly { readonly content: string; readonly relativePath: string }[]>;
  readonly count?: (text: string) => number;
}

/** Skills reach agents only when activated and templates document syntax, so neither is always-on prompt. */
function isAlwaysOnSource(relativePath: string) {
  return !relativePath.startsWith("skills/") && !relativePath.endsWith(".template.md");
}

export default class WorkbenchToolCatalogueTokens {
  #cached: { key: string; value: WorkbenchToolPromptCost } | null = null;

  constructor(private readonly options: WorkbenchToolCatalogueTokensOptions) {}

  async read(): Promise<WorkbenchToolPromptCost> {
    const [instructionTools, allSources, ...served] = await Promise.all([
      this.options.readInstructionTools(),
      this.options.readInstructionSources(),
      ...this.options.harnesses.map((harness) => this.options.readToolSpecs(harness)),
    ]);
    const sources = allSources.filter(({ relativePath }) => isAlwaysOnSource(relativePath));
    // Counting is the expensive part; the inputs are cheap to read and compare as one signature.
    const specTexts = served.map((specs) => specs.map((spec) => `${spec.name}\n${spec.description ?? ""}\n${JSON.stringify(spec.inputSchema)}`));
    const key = [
      this.options.harnesses.join(","),
      instructionTools.map(({ id }) => id).join(","),
      ...specTexts.flat(),
      ...sources.map(({ content, relativePath }) => `${relativePath}\n${content}`),
    ].join("\0");
    if (this.#cached?.key === key) return this.#cached.value;

    const count = this.options.count ?? ((text: string) => Gpt5TextTokens.count(text));
    const totals = new Map<string, { docsTokens: number; specTokens: number }>();
    const add = (tool: string, field: "docsTokens" | "specTokens", tokens: number) => {
      const entry = totals.get(tool) ?? { docsTokens: 0, specTokens: 0 };
      entry[field] += tokens / Math.max(1, this.options.harnesses.length);
      totals.set(tool, entry);
    };
    this.options.harnesses.forEach((harness, index) => {
      served[index]!.forEach((spec, specIndex) => add(spec.name, "specTokens", count(specTexts[index]![specIndex]!)));
      const docs = collectWorkbenchInstructionToolDocs(sources, {
        // A typical root thread: one project root, no optional local settings, no model-specific guidance.
        facts: { settings: new Set(), workspace: new Set(["project"]) },
        harness,
        model: null,
        resolveTool: (id) => resolveWorkbenchInstructionToolReference(id, harness, instructionTools),
        shell: process.platform === "win32" ? "pwsh" : "bash",
      });
      // Shared docs split evenly, so the per-tool figures sum to the real prompt cost.
      for (const region of docs) {
        const tokens = count(region.text);
        for (const tool of region.tools) add(tool, "docsTokens", tokens / region.tools.length);
      }
    });
    const value: WorkbenchToolPromptCost = {
      docsTokens: [...totals.values()].reduce((sum, { docsTokens }) => sum + docsTokens, 0),
      specTokens: [...totals.values()].reduce((sum, { specTokens }) => sum + specTokens, 0),
      tools: totals,
    };
    this.#cached = { key, value };
    return value;
  }
}
