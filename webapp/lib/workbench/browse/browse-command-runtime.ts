/*
 * Exports:
 * - createBrowseCommandResponse: return a no-store JSON response for one Browse command. Keywords: browse, command, response, json.
 * - createBrowseAgentSequenceResponse: return a no-store JSON response for a completed Browse sequence. Keywords: browse, sequence, response, json.
 * - createBrowseAgentSequenceProgressResponse: stream Browse sequence progress as NDJSON while keeping execution lifetime attached to the stream. Keywords: browse, sequence, streaming, ndjson.
 */
import type {
  WorkbenchBrowseAgentSequenceProgressEvent,
  WorkbenchBrowseAgentSequenceResponse,
  WorkbenchBrowseCommandResponse,
} from "../../types";

export function createBrowseCommandResponse(payload: WorkbenchBrowseCommandResponse, init?: ResponseInit) {
  return Response.json(payload, {
    ...init,
    headers: { "Cache-Control": "no-store", ...init?.headers },
  });
}

export function createBrowseAgentSequenceResponse(payload: WorkbenchBrowseAgentSequenceResponse, init?: ResponseInit) {
  return Response.json(payload, {
    ...init,
    headers: { "Cache-Control": "no-store", ...init?.headers },
  });
}

export function createBrowseAgentSequenceProgressResponse(
  runSequence: (emitProgress: (event: WorkbenchBrowseAgentSequenceProgressEvent) => void) => Promise<void>,
) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const emitProgress = (event: WorkbenchBrowseAgentSequenceProgressEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The request AbortSignal owns producer cancellation after the consumer disconnects.
        }
      };
      try {
        await runSequence(emitProgress);
      } catch (error) {
        emitProgress({
          durationMs: 0,
          ok: false,
          results: [{
            durationMs: 0,
            error: error instanceof Error ? error.message : "Unable to run Browse sequence.",
            exitCode: null,
            ok: false,
            stderr: "",
            stdout: "",
          }],
          stoppedAtIndex: null,
          type: "browse-sequence-complete",
        });
      } finally {
        try {
          controller.close();
        } catch {
          // The downstream response may already be cancelled.
        }
      }
    },
  }), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson; charset=utf-8",
    },
  });
}
