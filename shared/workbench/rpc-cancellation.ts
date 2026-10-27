/*
 * Exports:
 * - WORKBENCH_RPC_CANCEL_METHOD/WorkbenchRpcCancelSchema: notification asking the peer to abort one in-flight request.
 * - sendCancellableRequest: send a request whose aborted signal, once dispatched, also asks the peer to stop.
 * - WorkbenchRpcInflight: one connection's cancellable running requests, aborted by that connection's cancel notifications.
 */
import { z } from "zod";
import type WorkbenchRpcSocketClient from "./WorkbenchRpcSocketClient.ts";
import { WorkbenchRpcRequestInterruptedError } from "./WorkbenchRpcSocketClient.ts";

export const WORKBENCH_RPC_CANCEL_METHOD = "rpc/cancel";
export const WorkbenchRpcCancelSchema = z.object({
  method: z.literal(WORKBENCH_RPC_CANCEL_METHOD),
  params: z.object({ id: z.union([z.number().int(), z.string().max(256)]) }).strict(),
}).strict();
type WorkbenchRpcCancel = z.infer<typeof WorkbenchRpcCancelSchema>;

/** The caller owns `message.id`, so it can name the request it cancels. */
export async function sendCancellableRequest<TResponse>(
  transport: Pick<WorkbenchRpcSocketClient, "isOpen" | "send" | "sendRequest">,
  message: { id: number; method: string; params?: unknown } & Record<string, unknown>,
  options: { requireOpen?: boolean; signal?: AbortSignal | undefined },
) {
  try {
    return await transport.sendRequest<TResponse>(message, options);
  } catch (error) {
    // The peer may still be working on it; a closed socket already orphaned it, so only an open one is told to stop.
    if (options.signal?.aborted && error instanceof WorkbenchRpcRequestInterruptedError && error.dispatched && transport.isOpen) {
      transport.send({ method: WORKBENCH_RPC_CANCEL_METHOD, params: { id: message.id } } satisfies WorkbenchRpcCancel);
    }
    throw error;
  }
}

/** One connection's running requests by id, so that connection's `rpc/cancel` can abort one. */
export class WorkbenchRpcInflight {
  private readonly requests = new Map<number | string, AbortController>();

  /** Runs `operation` with a signal its caller can cancel; an id-less request is never cancellable. */
  async run<TValue>(id: number | string | null | undefined, operation: (signal: AbortSignal) => Promise<TValue>): Promise<TValue> {
    const cancellation = new AbortController();
    if (id === null || id === undefined) return await operation(cancellation.signal);
    this.requests.set(id, cancellation);
    try {
      return await operation(cancellation.signal);
    } finally {
      if (this.requests.get(id) === cancellation) this.requests.delete(id);
    }
  }

  /** Aborts the request a parsed `rpc/cancel` names; unknown and finished ids are ignored. */
  cancel(cancel: WorkbenchRpcCancel) {
    this.requests.get(cancel.params.id)?.abort(new Error("The caller cancelled this request."));
  }
}
