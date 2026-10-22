/*
 * Exports:
 * - applyServerCodexPermissions: apply platform-appropriate Workbench filesystem and network authority to one Codex turn.
 * - applyServerCodexSandboxPolicy: overwrite one Codex turn with the legacy server-owned workspace sandbox policy.
 * - applyServerCodexApprovalPolicy: let daemon-project turns ask before out-of-sandbox patches.
 * - withWorkbenchCodexSandboxConfig: install Linux managed-network profiles into thread configuration.
 */
import type { SandboxPolicy } from "workbench-shared/codex/generated/app-server/v2/SandboxPolicy";
import type { JsonRpcRequest } from "../../bridge-types";

type WorkspaceWriteSandboxPolicy = Extract<SandboxPolicy, { type: "workspaceWrite" }>;
const LOOPBACK_PERMISSIONS = "workbench-loopback";
const NETWORK_PERMISSIONS = "workbench-network";
const LOOPBACK_DOMAINS = {
  "127.0.0.1": "allow",
  "::1": "allow",
  localhost: "allow",
} as const;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function workspaceRoots(rootPaths: readonly string[]) {
  const roots = Array.from(new Set(rootPaths.map(rootPath => rootPath.trim()).filter(Boolean)));
  if (roots.length === 0) {
    throw new Error("Codex turn admission requires at least one server-resolved writable root.");
  }
  return roots;
}

function networkProfile(domains: Record<string, "allow">) {
  return {
    extends: ":workspace",
    network: {
      // Keep loopback on Codex's host proxy instead of bypassing it inside the isolated namespace.
      allow_local_binding: false,
      domains,
      enable_socks5: false,
      enabled: true,
      mode: "full",
    },
  };
}

export function withWorkbenchCodexSandboxConfig(
  params: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "linux") return params;
  const config = record(params.config);
  const features = record(config.features);
  const permissions = record(config.permissions);
  const { permissions: _callerPermissions, sandbox: _callerSandbox, sandboxPolicy: _callerPolicy, ...owned } = params;
  return {
    ...owned,
    permissions: LOOPBACK_PERMISSIONS,
    config: {
      ...config,
      default_permissions: LOOPBACK_PERMISSIONS,
      features: {
        ...features,
        network_proxy: { enabled: true },
      },
      permissions: {
        ...permissions,
        [LOOPBACK_PERMISSIONS]: networkProfile(LOOPBACK_DOMAINS),
        [NETWORK_PERMISSIONS]: networkProfile({ ...LOOPBACK_DOMAINS, "*": "allow" }),
      },
    },
  };
}

export function applyServerCodexSandboxPolicy(
  request: JsonRpcRequest,
  rootPaths: readonly string[],
  networkAccess: boolean,
): WorkspaceWriteSandboxPolicy {
  const writableRoots = workspaceRoots(rootPaths);
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

/**
 * Daemon-project turns edit machine files outside their sandbox through approved claims, so Codex must be able to ask
 * before an out-of-sandbox patch (claim-covered ones are then auto-allowed); with Codex's shell off, nothing else asks.
 * Other projects keep the user's own Codex approval settings.
 */
export function applyServerCodexApprovalPolicy(request: JsonRpcRequest, projectKind: string) {
  if (projectKind !== "daemon") return;
  request.params = { ...record(request.params), approvalPolicy: "on-request" };
}

export function applyServerCodexPermissions(
  request: JsonRpcRequest,
  rootPaths: readonly string[],
  networkAccess: boolean,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "linux") return applyServerCodexSandboxPolicy(request, rootPaths, networkAccess);
  const runtimeWorkspaceRoots = workspaceRoots(rootPaths);
  const {
    permissions: _callerPermissions,
    runtimeWorkspaceRoots: _callerRoots,
    sandboxPolicy: _callerPolicy,
    ...params
  } = record(request.params);
  request.params = {
    ...params,
    permissions: networkAccess ? NETWORK_PERMISSIONS : LOOPBACK_PERMISSIONS,
    runtimeWorkspaceRoots,
  };
}
