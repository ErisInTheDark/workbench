/*
 * applyServerCodexSandboxPolicy: overwrite one Codex turn with a server-owned workspace sandbox policy. Keywords: Codex, sandbox, network, policy, security.
 */
import type { SandboxPolicy } from "../lib/codex/generated/app-server/v2/SandboxPolicy";
import type { JsonRpcRequest } from "./bridge-types";

type WorkspaceWriteSandboxPolicy = Extract<SandboxPolicy, { type: "workspaceWrite" }>;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function applyServerCodexSandboxPolicy(
  request: JsonRpcRequest,
  rootPaths: readonly string[],
  networkAccess: boolean,
): WorkspaceWriteSandboxPolicy {
  const writableRoots = Array.from(new Set(rootPaths.map((rootPath) => rootPath.trim()).filter(Boolean)));
  if (writableRoots.length === 0) {
    throw new Error("Codex turn admission requires at least one server-resolved writable root.");
  }
  const sandboxPolicy: WorkspaceWriteSandboxPolicy = {
    excludeSlashTmp: false,
    excludeTmpdirEnvVar: false,
    networkAccess,
    type: "workspaceWrite",
    writableRoots,
  };
  request.params = {
    ...record(request.params),
    sandboxPolicy,
  };
  return sandboxPolicy;
}
