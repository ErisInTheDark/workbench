/*
 * Exports:
 * - CodexExecPermissionSchema/CodexExecPermission: native filesystem and network restrictions.
 * - CodexExecRequest/CodexExecResult: local sandbox execution input and bounded output.
 * - CodexExecProcessEvent: one validated process output, exit or close event.
 * - CODEX_EXEC_AUDIT_METHODS: exec-server notifications Workbench deliberately ignores.
 * - CodexExecFrame/readCodexExecFrame: classify one exec-server frame as a response, server request, process event or
 *   other notification, explaining malformed frames without echoing their payload.
 */
import { z } from "zod";

const fileUri = z.string().url().refine(value => URL.canParse(value) && new URL(value).protocol === "file:");
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
export type CodexExecProcessEvent = z.infer<typeof processEvent>;
const PROCESS_EVENT_METHODS: ReadonlySet<string> = new Set(processEvent.options.map(option => option.shape.method.value));
/** Codex's per-connection network policy audit; Workbench owns no reaction to it. */
export const CODEX_EXEC_AUDIT_METHODS: ReadonlySet<string> = new Set(["network/policyDecision"]);

const response = z.union([
  z.object({ id: z.number().int(), error: z.object({ code: z.number(), message: z.string() }) }),
  z.object({ id: z.number().int(), result: z.unknown() }),
]);
const envelope = z.object({ id: z.union([z.number().int(), z.string()]).optional(), method: z.string().optional() });

export type CodexExecFrame =
  | { kind: "response"; message: z.infer<typeof response> }
  | { kind: "request"; id: number | string; method: string }
  | { kind: "event"; event: CodexExecProcessEvent }
  | { kind: "notification"; method: string };

function parseOrExplain<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`${label}: ${z.prettifyError(parsed.error).replaceAll("\n", " ").slice(0, 300)}`);
}

/** Classifies one exec-server frame; throws a payload-free explanation when a frame is malformed. */
export function readCodexExecFrame(line: string): CodexExecFrame {
  let json: unknown;
  try { json = JSON.parse(line); } catch { throw new Error("frame is not JSON"); }
  const { id, method } = parseOrExplain(envelope, json, "frame");
  if (method === undefined) return { kind: "response", message: parseOrExplain(response, json, "response") };
  if (id !== undefined) return { kind: "request", id, method };
  if (PROCESS_EVENT_METHODS.has(method)) return { kind: "event", event: parseOrExplain(processEvent, json, method) };
  return { kind: "notification", method };
}
