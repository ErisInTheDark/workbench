/*
 * Exports:
 * - seedNewThreadPrompt: leave a prompt for the next new-thread composer opened in a project.
 * - takeNewThreadPrompt: claim and clear a project's pending prompt, once.
 *
 * The seed only bridges one navigation; the composer then owns the text through its normal draft path.
 */
const seeds = new Map<string, string>();

export function seedNewThreadPrompt(projectId: string, prompt: string) {
  seeds.set(projectId, prompt);
}

export function takeNewThreadPrompt(projectId: string) {
  const prompt = seeds.get(projectId) ?? null;
  seeds.delete(projectId);
  return prompt;
}
