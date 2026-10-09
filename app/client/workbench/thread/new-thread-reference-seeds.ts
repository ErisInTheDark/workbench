/*
 * Exports:
 * - seedNewThreadReferences: leave composer references for the next new-thread composer opened in a project.
 * - takeNewThreadReferences: claim and clear a project's pending references, once.
 *
 * The seed only bridges one navigation; the composer then owns the references through its normal draft path.
 */
import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";

const seeds = new Map<string, readonly PresentationDraftReference[]>();

export function seedNewThreadReferences(projectId: string, references: readonly PresentationDraftReference[]) {
  seeds.set(projectId, references);
}

export function takeNewThreadReferences(projectId: string) {
  const references = seeds.get(projectId) ?? null;
  seeds.delete(projectId);
  return references;
}
