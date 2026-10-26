/*
 * Exports:
 * - InstallationRecordStatusSchema/InstallationRecordStatus: whether a daemon's data root records its running checkout as the installation.
 */
import { z } from "zod";

export const InstallationRecordStatusSchema = z.object({
  checkoutRoot: z.string().min(1),
  record: z.discriminatedUnion("state", [
    z.object({ state: z.literal("current") }).strict(),
    z.object({ state: z.literal("missing") }).strict(),
    z.object({ state: z.literal("elsewhere"), root: z.string().min(1), phase: z.enum(["cloning", "setup", "ready"]) }).strict(),
    z.object({ state: z.literal("invalid"), message: z.string() }).strict(),
  ]),
}).strict();

export type InstallationRecordStatus = z.infer<typeof InstallationRecordStatusSchema>;
