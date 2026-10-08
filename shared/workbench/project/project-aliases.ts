/*
 * Exports:
 * - composeProjectAliases: flatten proven ownership conversions and reverse canonical direction without unrelated reassignment.
 */
import { z } from "zod";
import { ProjectIdentityKeySchema, ProjectIdSchema } from "../identity";
import type { WorkbenchProjectAlias } from "../../types";

const canonicalProjectId = z.union([z.uuid(), ProjectIdentityKeySchema]);

export function composeProjectAliases(
  existing: readonly WorkbenchProjectAlias[],
  incoming: readonly WorkbenchProjectAlias[],
): { aliases: WorkbenchProjectAlias[]; changes: WorkbenchProjectAlias[]; removals: string[] } {
  const previous = new Map(existing.map(item => [item.alias, item.projectId]));
  const resolve = (mapping: ReadonlyMap<string, string>, initial: string) => {
    let id = initial;
    const visited = new Set<string>();
    while (mapping.has(id)) {
      if (visited.has(id)) throw new Error("Project aliases cannot form cycles.");
      visited.add(id);
      id = mapping.get(id)!;
    }
    return id;
  };
  const supplied = new Map<string, string>();
  for (const { alias, projectId } of incoming) {
    if (!alias || alias === projectId || !canonicalProjectId.safeParse(projectId).success) {
      throw new Error("Project alias has an invalid canonical destination.");
    }
    if (supplied.has(alias) && supplied.get(alias) !== projectId) {
      throw new Error("Project aliases contain conflicting ownership.");
    }
    supplied.set(alias, projectId);
  }
  const removals = new Set<string>();
  for (const [alias, destination] of supplied) {
    // A newly fixed canonical ID can previously have been retained as an alias
    // to the old owner. Remove that reverse edge before flattening toward it.
    if (resolve(previous, destination) !== alias) continue;
    previous.delete(destination);
    removals.add(destination);
  }
  const mapping = new Map<string, string>([...previous, ...supplied]);
  for (const [alias, destination] of supplied) {
    const prior = previous.get(alias);
    if (prior && resolve(mapping, prior) !== resolve(mapping, destination)) {
      throw new Error("Project alias changes retained ownership without a conversion.");
    }
  }
  const aliases = [...mapping.keys()].map(alias => ({
    alias,
    projectId: ProjectIdSchema.parse(resolve(mapping, alias)),
  }));
  return {
    aliases,
    changes: aliases.filter(item => previous.get(item.alias) !== item.projectId),
    removals: [...removals].filter(alias => !mapping.has(alias)),
  };
}
