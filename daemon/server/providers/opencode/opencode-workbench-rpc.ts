/*
 * Exports:
 * - OpenCodeGoQuotaSchema/OpenCodeGoQuota: normalised credential-free Go quota facts.
 * - OpenCodeGoQuotaResultSchema/OpenCodeGoQuotaResult: bounded quota success or failure facts.
 * - openCodeWorkbenchRpc: typed private RPC between the companion and daemon adapter.
 */
import { z } from "zod";

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
  events: {},
} as const;
