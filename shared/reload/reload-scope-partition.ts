/*
 * Exports:
 * - partitionReloadScopes: route reload scopes, with process and installation replacement subsuming narrower work.
 */
function subsumed(scopes: string[], ...wide: string[]) {
  const scope = wide.find(candidate => scopes.includes(candidate));
  return scope ? [scope] : scopes;
}

/**
 * An app-only install leaves host and daemon reloads routed. An install that must also stop the host replaces every
 * process, and reloading daemon code first would run it against the old dependencies.
 */
export function partitionReloadScopes(scopes: readonly string[], { installRestartsHost = false } = {}) {
  if (installRestartsHost && scopes.includes("client:install")) return { client: ["client:install"], server: [] };
  const client = scopes.filter((scope) => scope.startsWith("client:"));
  const host = scopes.filter((scope) => scope.startsWith("host:"));
  const server = scopes.filter((scope) => !scope.startsWith("client:") && !scope.startsWith("host:"));
  return {
    client: [...subsumed(host, "host:process"), ...subsumed(client, "client:install", "client:process")],
    server: subsumed(server, "server:process"),
  };
}
