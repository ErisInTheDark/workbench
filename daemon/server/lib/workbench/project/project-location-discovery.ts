/*
 * Exports:
 * - projectLocationKey: identify one concrete Git checkout or workspace root set.
 */
import path from "node:path";

export function projectLocationKey(project: {
  kind: string;
  rootPath: string;
  roots: readonly { rootPath: string }[];
}) {
  const comparable = (value: string) => {
    const resolved = path.resolve(value).replace(/\\/gu, "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const roots = project.kind === "workspace"
    ? project.roots.map(root => comparable(root.rootPath)).sort()
    : [comparable(project.rootPath)];
  return JSON.stringify([project.kind, roots]);
}
