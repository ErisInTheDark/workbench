/* Exports:
 * - default buildWorkbenchOwnedPromptFields: resolved prompt payload with native prompt sources disabled.
 */
export default function buildWorkbenchOwnedPromptFields(baseInstructions: string | null, developerInstructions: string | null) {
  return {
    baseInstructions,
    developerInstructions,
    config: {
      developer_instructions: "",
      instructions: "",
      project_doc_max_bytes: 0,
    },
    personality: "none" as const,
  };
}
