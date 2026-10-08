/*
 * Exports:
 * - partitionReloadScopes: route reload scopes, with process and installation replacement subsuming narrower work.
 */
export function partitionReloadScopes(scopes: readonly string[]) {
  if (scopes.includes("client:install")) return { client: ["client:install"], server: [] };
  const client = scopes.filter((scope) => scope.startsWith("client:"));
  const host = scopes.filter((scope) => scope.startsWith("host:"));
  const server = scopes.filter((scope) => !scope.startsWith("client:") && !scope.startsWith("host:"));
  return {
    client: [
      ...(host.includes("host:process") ? ["host:process"] : host),
      ...(client.includes("client:process") ? ["client:process"] : client),
    ],
    server: server.includes("server:process") ? ["server:process"] : server,
  };
}
