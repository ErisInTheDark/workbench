/*
 * Exports:
 * - ProviderBoundaryToolNames: provider-native names for shared Workbench capabilities.
 * - PROVIDER_SHELL_PROOF_FILE: isolated project file written through the provider shell boundary.
 * - createProviderBoundaryJourney: build one ordered behavioural journey for every real provider.
 */
export const PROVIDER_SHELL_PROOF_FILE = ".workbench-provider-shell-proof";

export interface ProviderBoundaryToolNames {
  shell: string;
  taskGet: string;
  taskComplete: string;
  questionnaire: string;
}

export function createProviderBoundaryJourney(tools: ProviderBoundaryToolNames) {
  const ask = (id: string) => `Call ${tools.questionnaire} with exactly ${
    JSON.stringify({
      questions: [{
        header: "scenario",
        id,
        question: `Scenario ${id}?`,
        options: [{ label: "continue", description: "Continue the scenario." }],
      }],
    })
  }. Wait for the answer on that same tool call.`;
  const sleep = (proof: string) => [
    `Call ${tools.shell} with command \`node -e "setTimeout(()=>console.log('${proof}'),5000)"\`.`,
    "This is a five-second sleep. Do not replace, skip, shorten, or background it.",
  ].join(" ");
  return {
    ask,
    active: (prefixProof: string, sleepProof: string) => [
      "Authorised Workbench provider scenario. Follow exactly, in order. Do not finish early.",
      `1. Report the project-instruction proof "${prefixProof}" in commentary.`,
      `2. ${sleep(sleepProof)}`,
      "3. After the sleep, report the proof from the newest user steer in commentary.",
      `4. ${ask("live_answer")}`,
      "5. Quote the answer exactly in commentary.",
      `6. ${ask("held_answer")}`,
      "7. Wait. Do not create more questions or finish while waiting.",
    ].join("\n"),
    steer: (proof: string) =>
      `After the current sleep, quote "${proof}" exactly in commentary, then continue the numbered steps.`,
    heldContinuation: (prefixProof: string) => [
      "Authorised scenario continuation. Follow exactly, in order.",
      `1. Quote the answer and project-instruction proof "${prefixProof}" exactly in commentary.`,
      `2. ${ask("dismiss_preserved")}`,
      "3. Wait. Do not complete the task or make other calls.",
    ].join("\n"),
    stop: (proof: string) => [
      "Authorised interruption scenario. Follow exactly.",
      `1. ${sleep(proof)}`,
      "2. Make no additional tool calls. The scenario will interrupt this turn.",
    ].join("\n"),
    final: (prefixProof: string, finalProof: string) => [
      "Authorised final provider scenario. Follow exactly, in order.",
      `1. Call ${tools.taskGet}.`,
      `2. Call ${tools.shell} with command \`node -e "require('fs').writeFileSync('${
        PROVIDER_SHELL_PROOF_FILE
      }','${finalProof}')"\`.`,
      `3. Quote "${finalProof}", "${prefixProof}", and the task title together in commentary.`,
      `4. Call ${tools.taskComplete}. This completion is authorised.`,
      "5. End with an empty final response.",
    ].join("\n"),
  };
}
