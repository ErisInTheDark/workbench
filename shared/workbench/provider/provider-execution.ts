/*
 * Exports:
 * - ProviderToolMetadataSchema/ProviderToolMetadata: uninterpreted JSON metadata delivered to the selected provider.
 * - WorkbenchProviderCaller: validated WB identity and authoritative working directory.
 * - WorkbenchProviderTools: provider-owned MCP adaptation and sandbox execution.
 * - WorkbenchReadOnlyExecution: validated read-only command invocation.
 * - WorkbenchPatchClaimCheck: shared claim policy called with validated WB ownership.
 */
import { z } from "zod";
import type { JsonValue } from "../thread/workbench-thread-items.ts";
import type { WorkbenchThreadId } from "../identity.ts";
import type { WorkbenchShellInput, WorkbenchShellResult } from "../commands/workbench-shell-command.ts";

const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue),
]));
export const ProviderToolMetadataSchema = z.record(z.string(), jsonValue);
export type ProviderToolMetadata = z.infer<typeof ProviderToolMetadataSchema>;

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

export type WorkbenchPatchClaimCheck = (request: {
  cwd: string; harness: string; paths: string[]; threadId: WorkbenchThreadId;
}) => Promise<{ allowed: boolean; uncoveredPaths: string[] }>;

export interface WorkbenchProviderTools {
  patchClaims(input: { raw: string; callerThreadId: string | null }, check: WorkbenchPatchClaimCheck, signal: AbortSignal): Promise<string>;
  executeReadOnly(request: WorkbenchReadOnlyExecution, signal: AbortSignal): Promise<Pick<WorkbenchShellResult, "exitCode" | "stdout" | "stderr">>;
  describe(): Promise<{
    experimental: Record<string, Record<string, JsonValue>>;
    shellDescription: string;
  }>;
  caller(metadata: ProviderToolMetadata, signal: AbortSignal): Promise<WorkbenchProviderCaller>;
  shell(input: WorkbenchShellInput, metadata: ProviderToolMetadata, signal: AbortSignal): Promise<WorkbenchShellResult>;
}
