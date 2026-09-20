/*
 * Exports:
 * - OpenCodeGoQuotaSchema/OpenCodeGoQuota: normalised credential-free Go quota facts.
 * - openCodeWorkbenchRpc: typed private RPC between the companion and daemon adapter.
 */
import { z } from "zod";

const quotaWindow = z.object({
  percent: z.number().finite().min(0).max(100),
  resetsAt: z.number().int().nonnegative(),
  status: z.string().max(80),
});

export const OpenCodeGoQuotaSchema = z.object({
  available: z.boolean(),
  observedAt: z.number().int().nonnegative(),
  windows: z.object({
    rolling: quotaWindow,
    weekly: quotaWindow,
    monthly: quotaWindow,
  }).nullable(),
});
export type OpenCodeGoQuota = z.infer<typeof OpenCodeGoQuotaSchema>;

export const openCodeWorkbenchRpc = {
  id: "workbench",
  methods: {
    goQuota: {
      input: z.object({}),
      output: OpenCodeGoQuotaSchema,
    },
  },
  events: {},
} as const;
