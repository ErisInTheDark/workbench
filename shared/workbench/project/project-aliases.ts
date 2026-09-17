/*
 * Exports:
 * - composeProjectAliases: flatten proven ownership conversions without allowing unrelated alias reassignment.
 */
import { z } from "zod";
import { ProjectIdSchema } from "../identity";
import type { WorkbenchProjectAlias } from "../../types";

const uuid = z.string().uuid();

export function composeProjectAliases(
  existing: readonly WorkbenchProjectAlias[],
  incoming: readonly WorkbenchProjectAlias[],
): { aliases: WorkbenchProjectAlias[]; changes: WorkbenchProjectAlias[] } {
  const previous = new Map(existing.map(item => [item.alias, item.projectId]));
  const supplied = new Map<string, string>();
  for (const { alias, projectId } of incoming) {
    if (!alias || alias === projectId || (projectId !== "workbench-library"
      && !uuid.safeParse(projectId).success && !/^(?:remote|local|workspace):\/\/.+$/u.test(projectId))) {
      throw new Error("Project alias has an invalid canonical destination.");
    }
    if (supplied.has(alias) && supplied.get(alias) !== projectId) {
      throw new Error("Project aliases contain conflicting ownership.");
    }
    supplied.set(alias, projectId);
  }
  const mapping = new Map<string, string>([...previous, ...supplied]);
  const resolve = (id: string) => {
    const visited = new Set<string>();
    while (mapping.has(id)) {
      if (visited.has(id)) throw new Error("Project aliases cannot form cycles.");
      visited.add(id);
      id = mapping.get(id)!;
    }
    return id;
  };
  for (const [alias, destination] of supplied) {
    const prior = previous.get(alias);
    if (prior && resolve(prior) !== resolve(destination)) {
      throw new Error("Project alias changes retained ownership without a conversion.");
    }
  }
  const aliases = [...mapping.keys()].map(alias => ({ alias, projectId: ProjectIdSchema.parse(resolve(alias)) }));
  return { aliases, changes: aliases.filter(item => previous.get(item.alias) !== item.projectId) };
}
