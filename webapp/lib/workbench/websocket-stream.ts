/*
 * Exports:
 * - WORKBENCH_EVENT_STREAM_ACK_METHOD/WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD: shared browser-stream protocol names. Keywords: websocket, stream, acknowledgement, sequence.
 * - WorkbenchEventStreamAckSchema/WorkbenchEventStreamAck: strict cumulative browser receipt contract. Keywords: websocket, acknowledgement, zod.
 * - WorkbenchEventStreamHealth: aggregate browser-agnostic stream pressure evidence. Keywords: websocket, health, backpressure, aggregate.
 */
import { z } from "zod";

export const WORKBENCH_EVENT_STREAM_ACK_METHOD = "workbench/event-stream/ack";
export const WORKBENCH_EVENT_STREAM_SEQUENCE_FIELD = "workbenchEventStreamSequence";

export const WorkbenchEventStreamAckSchema = z.object({
  method: z.literal(WORKBENCH_EVENT_STREAM_ACK_METHOD),
  params: z.object({
    sequence: z.number().int().positive(),
  }).strict(),
}).strict();

export type WorkbenchEventStreamAck = z.infer<typeof WorkbenchEventStreamAckSchema>;

export interface WorkbenchEventStreamHealth {
  behind: boolean;
  behindConsumers: number;
  connectedConsumers: number;
  oldestUnacknowledgedMs: number;
  socketBufferedBytes: number;
  unacknowledgedBytes: number;
  unacknowledgedEvents: number;
}
