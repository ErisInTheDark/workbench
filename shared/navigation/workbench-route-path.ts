/*
 * Exports:
 * - encodeWorkbenchRoutePath: encode a slash-delimited Workbench route value by segment. Keywords: route, URL, path.
 * - createWorkbenchProjectHref: build a canonical standalone project href. Keywords: project, navigation, URL.
 */

export function encodeWorkbenchRoutePath(value: string) {
  if (value.includes("://")) return encodeURIComponent(value);
  return value
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function createWorkbenchProjectHref(projectId: string) {
  const projectPath = encodeWorkbenchRoutePath(projectId);
  return projectPath ? `/${projectPath}` : "/";
}
