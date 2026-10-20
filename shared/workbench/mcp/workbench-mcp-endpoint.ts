/*
 * Exports:
 * - WorkbenchMcpEndpointScope: launcher-declared audience of one wb MCP connection.
 * - createWorkbenchMcpEndpointUrl: build a wb MCP connection URL; every audience flag is required so no launcher omits one.
 * - readWorkbenchMcpEndpointUrl: read the raw audience a connection URL declares.
 */
const WORKBENCH_MCP_PATH = "/daemon/mcp";

export interface WorkbenchMcpEndpointScope {
  provider: string;
  client: string;
  /** Lists commands reserved for threads at the Workbench repository root; callers are still gated per call. */
  projectLocal: boolean;
  subagent: boolean;
}

export function createWorkbenchMcpEndpointUrl(origin: string, scope: WorkbenchMcpEndpointScope) {
  const url = new URL(WORKBENCH_MCP_PATH, origin);
  url.searchParams.set("provider", scope.provider);
  url.searchParams.set("client", scope.client);
  if (scope.projectLocal) url.searchParams.set("project-local", "true");
  if (scope.subagent) url.searchParams.set("subagent", "true");
  return url;
}

export function readWorkbenchMcpEndpointUrl(url: URL) {
  return {
    provider: url.searchParams.get("provider"),
    client: url.searchParams.get("client")?.trim() || null,
    projectLocal: url.searchParams.get("project-local") === "true",
    subagent: url.searchParams.get("subagent") === "true",
  };
}
