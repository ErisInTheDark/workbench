/*
 * Exports:
 * - OpenCodeGoQuotaSchema/OpenCodeGoQuota: normalised credential-free Go quota facts.
 * - OpenCodeGoQuotaResultSchema/OpenCodeGoQuotaResult: bounded quota success or failure facts.
 * - openCodeWorkbenchRpc: typed private RPC between the companion and daemon adapter.
 * - OpenCodePatchObservationSchema/OpenCodePatchObservation: transient request-fenced file previews.
 * - OpenCodeToolContextSchema/OpenCodeToolContext: exact companion child and parent identities.
 * - OpenCodeFileClaimRequestSchema/OpenCodeFileClaimResultSchema: native mutation admission messages.
 */
import { z } from "zod";
import { ToolPatchPreviewFileSchema } from "workbench-shared/workbench/thread/tool-patch-preview";

export const OpenCodeFileClaimRequestSchema = z.object({
  sessionID: z.string().min(1),
  resources: z.array(z.string().min(1).refine(value => !value.includes("\0"))).min(1),
});
export const OpenCodeFileClaimResultSchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), reason: z.string().min(1).max(1000) }),
]);

export const OpenCodeToolContextSchema = z.object({
  childID: z.uuid(),
  parentID: z.string().min(1),
  assistantMessageID: z.string().min(1),
});
export type OpenCodeToolContext = z.infer<typeof OpenCodeToolContextSchema>;

const patchRequest = { sessionID: z.string(), requestID: z.string() };
export const OpenCodePatchObservationSchema = z.discriminatedUnion("kind", [
  z.object({ ...patchRequest, kind: z.literal("request") }),
  z.object({
    ...patchRequest, kind: z.literal("preview"), callID: z.string(),
    tool: z.enum(["patch", "edit", "write"]), files: z.array(ToolPatchPreviewFileSchema),
  }),
  z.object({ ...patchRequest, kind: z.literal("withdraw") }),
]);
export type OpenCodePatchObservation = z.infer<typeof OpenCodePatchObservationSchema>;

const quotaWindow = z.object({
  percent: z.number().finite().min(0).max(100),
  resetsAt: z.number().int().nonnegative(),
  status: z.string().max(80),
});

export const OpenCodeGoQuotaSchema = z.object({
  observedAt: z.number().int().nonnegative(),
  windows: z.object({
    rolling: quotaWindow,
    weekly: quotaWindow,
    monthly: quotaWindow,
  }),
});
export type OpenCodeGoQuota = z.infer<typeof OpenCodeGoQuotaSchema>;

export const OpenCodeGoQuotaResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    quota: OpenCodeGoQuotaSchema,
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      kind: z.enum(["credential", "request", "response"]),
      message: z.string().min(1).max(500),
    }),
  }),
]);
export type OpenCodeGoQuotaResult = z.infer<typeof OpenCodeGoQuotaResultSchema>;

export const openCodeWorkbenchRpc = {
  id: "workbench",
  methods: {
    goQuota: {
      input: z.object({}),
      output: OpenCodeGoQuotaResultSchema,
    },
  },
  events: { patchPreview: { schema: OpenCodePatchObservationSchema } },
} as const;
