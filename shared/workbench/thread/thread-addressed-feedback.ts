/*
 * Exports:
 * - WorkbenchThreadAddressedFeedbackSchema/WorkbenchThreadAddressedFeedback: one feedback report a thread was launched to address, as the reference it received.
 */
import { z } from "zod";
import { ComposerReferenceSchema } from "./composer-reference.ts";

const feedbackReference = ComposerReferenceSchema.options[1];
export const WorkbenchThreadAddressedFeedbackSchema = feedbackReference.extend({ daemonId: z.string().min(1) }).strict();
export type WorkbenchThreadAddressedFeedback = z.infer<typeof WorkbenchThreadAddressedFeedbackSchema>;
