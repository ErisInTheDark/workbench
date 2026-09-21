/*
 * Exports:
 * - ProviderToolMetadataSchema/ProviderToolMetadata: uninterpreted JSON metadata delivered to the selected provider.
 * - WorkbenchProviderCaller: validated WB identity and authoritative working directory.
 * - WorkbenchProviderTools: provider-owned MCP adaptation and sandbox execution.
 * - WorkbenchReadOnlyExecution: validated read-only command invocation.
 * - WorkbenchAdmittedExecution: daemon-owned caller and resolved one-command permissions.
 * - WorkbenchPatchClaimCheck: shared claim policy called with validated WB ownership.
 * - ProviderToolResultSchema/ProviderToolResult: complete JSON-safe MCP result evidence.
 * - WorkbenchToolTranscriptReference/WorkbenchToolTranscript: pinned tool capture across provider generations.
 */
import { z } from "zod";
import type { JsonValue } from "../thread/workbench-thread-items.ts";
import type { WorkbenchThreadId, WorkbenchTurnId, WorkbenchItemId } from "../identity.ts";
import type { WorkbenchShellInput, WorkbenchShellResult } from "../commands/workbench-shell-command.ts";

const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue),
]));
export const ProviderToolMetadataSchema = z.record(z.string(), jsonValue);
export type ProviderToolMetadata = z.infer<typeof ProviderToolMetadataSchema>;
export const ProviderToolResultSchema = z.object({
  content: z.array(jsonValue),
  structuredContent: jsonValue.optional(),
  _meta: jsonValue.optional(),
  isError: z.boolean().optional(),
});
export type ProviderToolResult = z.infer<typeof ProviderToolResultSchema>;

export interface WorkbenchToolTranscriptReference {
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
  itemId: WorkbenchItemId;
  sourceId: string;
  parentId: string;
  tool: string;
  arguments: JsonValue;
  startedAt: number;
}

export interface WorkbenchToolTranscript {
  start(input: { tool: string; arguments: JsonValue; metadata: ProviderToolMetadata }, signal: AbortSignal): Promise<WorkbenchToolTranscriptReference | null>;
  finish(reference: WorkbenchToolTranscriptReference, result: ProviderToolResult): Promise<void>;
}

export interface WorkbenchProviderCaller {
  harness: string;
  threadId: WorkbenchThreadId;
  cwd: string;
}

export interface WorkbenchReadOnlyExecution {
  command: string[];
  cwd: string;
  env?: Record<string, string | null>;
}

export interface WorkbenchAdmittedExecution {
  caller: WorkbenchProviderCaller;
  command: string[];
  cwd: string;
  permissions:
    | { mode: "restricted"; writableRoots: string[]; network: boolean }
    | { mode: "approved-unrestricted" };
  timeoutMs?: number;
}

export type WorkbenchPatchClaimCheck = (request: {
  cwd: string; harness: string; paths: string[]; threadId: WorkbenchThreadId;
}) => Promise<{ allowed: boolean; uncoveredPaths: string[] }>;

export interface WorkbenchProviderTools {
  transcript?: WorkbenchToolTranscript;
  execute?(request: WorkbenchAdmittedExecution, signal: AbortSignal): Promise<Pick<WorkbenchShellResult, "exitCode" | "stdout" | "stderr">>;
  patchClaims(input: { raw: string; callerThreadId: string | null }, check: WorkbenchPatchClaimCheck, signal: AbortSignal): Promise<string>;
  describe(): Promise<{
    experimental: Record<string, Record<string, JsonValue>>;
    shellDescription: string;
  }>;
  caller(metadata: ProviderToolMetadata, signal: AbortSignal): Promise<WorkbenchProviderCaller>;
  shell(input: WorkbenchShellInput, metadata: ProviderToolMetadata, signal: AbortSignal): Promise<WorkbenchShellResult>;
}
