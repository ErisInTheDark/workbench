/*
 * Exports:
 * - ProviderBoundaryToolNames: provider-native names for shared Workbench capabilities.
 * - PROVIDER_SEARCH_PROOF/PROVIDER_SEARCH_PROOF_FILE: isolated project fixture read through WB search.
 * - PROVIDER_SHELL_PROOF_FILE: isolated project file written through the provider shell boundary.
 * - fakeCodexTool: script a Workbench tool through Codex code mode.
 * - createProviderBoundaryJourney: build one ordered behavioural journey for every real provider.
 */
import type { FakeThreadAction } from "./FakeThreadModelServer";

export const PROVIDER_SEARCH_PROOF = "workbench-provider-search-proof";
export const PROVIDER_SEARCH_PROOF_FILE = ".workbench-provider-search-proof";
export const PROVIDER_SHELL_PROOF_FILE = ".workbench-provider-shell-proof";

export interface ProviderBoundaryToolNames {
  search: string;
  shell: string;
  taskGet: string;
  taskComplete: string;
  questionnaire: string;
}

export function fakeCodexTool(name: string, args: Record<string, unknown>, textValue?: string): FakeThreadAction {
  return {
    ...(textValue === undefined ? {} : { text: textValue }),
    tool: {
      nameSuffix: "exec",
      input: `// @exec: {"yield_time_ms": 1500000}\n`
        + `const result = await tools.mcp__wb__${name}(${JSON.stringify(args)});\n`
        + `if (result.isError || (result.structuredContent?.exitCode !== undefined && result.structuredContent.exitCode !== 0)) throw new Error("Workbench scenario tool failed");\n`
        + `for (const item of result.content ?? []) if (item.type === "text") text(item.text);`,
    },
  };
}

function fakeOpenCodeTool(name: string, args: Record<string, unknown>, textValue?: string): FakeThreadAction {
  return {
    ...(textValue === undefined ? {} : { text: textValue }),
    tool: {
      nameSuffix: "execute",
      arguments: {
        code: `return await tools.wb.${name}(${JSON.stringify(args)});`,
      },
    },
  };
}

export function createProviderBoundaryJourney(
  provider: "codex" | "opencode",
  tools: ProviderBoundaryToolNames,
  holdCommand: (proof: string) => string,
  shellProofFile = PROVIDER_SHELL_PROOF_FILE,
) {
  const question = (id: string) => ({
    questions: [{
      header: "scenario", id, question: `Scenario ${id}?`,
      options: [{ label: "continue", description: "Continue the scenario." }],
    }],
  });
  const ask = (id: string) => `Call ${tools.questionnaire} with exactly ${JSON.stringify(question(id))}. Wait for the answer on that same tool call.`;
  const hold = (proof: string) => [
    `Call ${tools.shell} with command \`${holdCommand(proof)}\`.`,
    "This tool waits for the scenario to release it. Do not replace, skip, or background it.",
  ].join(" ");
  const call = (nameSuffix: string, args: Record<string, unknown>, text?: string): FakeThreadAction =>
    provider === "codex"
      ? nameSuffix === "task_completed"
        ? { ...(text === undefined ? {} : { text }), tool: { nameSuffix, arguments: args } }
        : fakeCodexTool(nameSuffix, args, text)
      : fakeOpenCodeTool(nameSuffix, args, text);
  return {
    ask,
    fake: {
      active: (prefixProof: string, activeProof: string, steerProof: string, liveProof: string): FakeThreadAction[] => [
        call("shell", { command: holdCommand(activeProof) }, prefixProof),
        call("request_user_input", question("live-answer"), steerProof),
        call("request_user_input", question("held-answer"), liveProof),
      ],
      held: (prefixProof: string, heldProof: string): FakeThreadAction[] => [
        call("request_user_input", question("dismiss-preserved"), `${heldProof} ${prefixProof}`),
      ],
      stop: (proof: string): FakeThreadAction[] => [call("shell", { command: holdCommand(proof) })],
      final: (prefixProof: string, finalProof: string, title: string): FakeThreadAction[] => [
        call("task_get", {}),
        call("rg", { args: ["-n", PROVIDER_SEARCH_PROOF, PROVIDER_SEARCH_PROOF_FILE] }),
        call("shell", { command: `node -e "require('fs').writeFileSync('${shellProofFile}','${finalProof}')"` }),
        call("task_completed", {}, provider === "opencode" ? `${finalProof} ${prefixProof} ${title}` : undefined),
        { text: provider === "codex" ? `${finalProof} ${prefixProof} ${title}` : "" },
      ],
    },
    active: (prefixProof: string, activeProof: string) => [
      "Authorised Workbench provider scenario. Follow exactly, in order. Do not finish early.",
      `1. Report the project-instruction proof "${prefixProof}" in commentary.`,
      `2. ${hold(activeProof)}`,
      "3. After the tool returns, report the proof from the newest user steer in commentary.",
      `4. ${ask("live-answer")}`,
      "5. Quote the answer exactly in commentary.",
      `6. ${ask("held-answer")}`,
      "7. Wait. Do not create more questions or finish while waiting.",
    ].join("\n"),
    steer: (proof: string) =>
      `After the current sleep, quote "${proof}" exactly in commentary, then continue the numbered steps.`,
    heldContinuation: (prefixProof: string) => [
      "Authorised scenario continuation. Follow exactly, in order.",
      `1. Quote the answer and project-instruction proof "${prefixProof}" exactly in commentary.`,
      `2. ${ask("dismiss-preserved")}`,
      "3. Wait. Do not complete the task or make other calls.",
    ].join("\n"),
    stop: (proof: string) => [
      "Authorised interruption scenario. Follow exactly.",
      `1. ${hold(proof)}`,
      "2. Make no additional tool calls. The scenario will interrupt this turn.",
    ].join("\n"),
    final: (prefixProof: string, finalProof: string) => [
      "Authorised final provider scenario. Follow exactly, in order.",
      `1. Call ${tools.taskGet}.`,
      `2. Call ${tools.search} with exactly ${JSON.stringify({
        args: ["-n", PROVIDER_SEARCH_PROOF, PROVIDER_SEARCH_PROOF_FILE],
      })}.`,
      `3. Call ${tools.shell} with command \`node -e "require('fs').writeFileSync('${
        shellProofFile
      }','${finalProof}')"\`.`,
      `4. Quote "${finalProof}", "${prefixProof}", and the task title together in commentary.`,
      `5. Call ${tools.taskComplete}. This completion is authorised.`,
      "6. End with an empty final response.",
    ].join("\n"),
  };
}
