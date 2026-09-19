/*
 * Exports:
 * - CodexExecPermissionSchema/CodexExecPermission: native filesystem and network restrictions.
 * - CodexExecRequest/CodexExecResult: local sandbox execution input and bounded output.
 * - CodexExecMessageSchema: validated exec-server responses and process events.
 */
import { z } from "zod";

const fileUri = z.string().url().refine(value => new URL(value).protocol === "file:");
const specialPath = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["root", "minimal", "tmpdir", "slash_tmp"]) }),
  z.object({ kind: z.enum(["project_roots", "current_working_directory"]), subpath: z.string().optional() }),
  z.object({ kind: z.literal("unknown"), path: z.string(), subpath: z.string().optional() }),
]);
const filesystem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unrestricted") }),
  z.object({
    type: z.literal("restricted"),
    entries: z.array(z.object({
      path: z.discriminatedUnion("type", [
        z.object({ type: z.literal("path"), path: fileUri }),
        z.object({ type: z.literal("glob_pattern"), pattern: z.string() }),
        z.object({ type: z.literal("special"), value: specialPath }),
      ]),
      access: z.enum(["read", "write", "deny", "none"]),
      missing_path_behavior: z.literal("skip").optional(),
    })),
    glob_scan_max_depth: z.number().int().positive().optional(),
  }),
]);
export const CodexExecPermissionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("disabled") }),
  z.object({ type: z.literal("external"), network: z.enum(["restricted", "enabled"]) }),
  z.object({ type: z.literal("managed"), file_system: filesystem, network: z.enum(["restricted", "enabled"]) }),
]);
export type CodexExecPermission = z.infer<typeof CodexExecPermissionSchema>;

export interface CodexExecRequest {
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  envPolicy?: {
    inherit: "all" | "core" | "none";
    ignoreDefaultExcludes: boolean;
    exclude: string[];
    set: Record<string, string>;
    includeOnly: string[];
  };
  permissions: CodexExecPermission;
  windowsSandboxLevel: "disabled" | "restricted-token" | "elevated";
  windowsSandboxPrivateDesktop: boolean;
  workspaceRoots: string[];
  useLegacyLandlock?: boolean;
  timeoutMs?: number;
}

export interface CodexExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const processEvent = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("process/output"),
    params: z.object({
      processId: z.string(), seq: z.number().int().nonnegative(),
      stream: z.enum(["stdout", "stderr", "pty"]), chunk: z.string().base64(),
    }),
  }),
  z.object({
    method: z.literal("process/exited"),
    params: z.object({ processId: z.string(), seq: z.number().int().nonnegative(), exitCode: z.number().int() }),
  }),
  z.object({
    method: z.literal("process/closed"),
    params: z.object({ processId: z.string(), seq: z.number().int().nonnegative() }),
  }),
]);
export const CodexExecMessageSchema = z.union([
  z.object({ id: z.number().int(), error: z.object({ code: z.number(), message: z.string() }) }),
  z.object({ id: z.number().int(), result: z.unknown() }),
  processEvent,
]);
