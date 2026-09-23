/*
 * Exports:
 * - default WorkbenchPresentationRoutes: bounded app-local presentation and attachment HTTP admission.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { PresentationMutationSchema } from "workbench-shared/state/workbench-presentation-state";
import WorkbenchPresentationController from "./WorkbenchPresentationController.ts";

const MAX_JSON_BYTES = 1_000_000;
const MAX_CHUNK_BYTES = 1024 * 1024;
const attachmentPath = /^\/api\/workbench-presentation\/drafts\/([^/]+)\/attachments\/([^/]+)(?:\/chunks\/(\d+)|\/complete)?$/u;
const completeInput = z.object({
  count: z.number().int().positive().max(1024),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

async function readBody(request: IncomingMessage, maximum: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) throw new Error("Presentation request exceeds its size limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function respond(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, {
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

export default class WorkbenchPresentationRoutes {
  private readonly streams = new Map<ServerResponse, Promise<void>>();
  constructor(private readonly owner: WorkbenchPresentationController) {}

  async close() {
    for (const response of this.streams.keys()) response.destroy();
    await Promise.allSettled([...this.streams.values()]);
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    const base = "/api/workbench-presentation";
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
    try {
      if (url.pathname === base && request.method === "GET") {
        respond(response, 200, this.owner.read());
        return true;
      }
      if (url.pathname === `${base}/mutate` && request.method === "POST") {
        const input = PresentationMutationSchema.parse(JSON.parse((await readBody(request, MAX_JSON_BYTES)).toString("utf8")));
        respond(response, 200, this.owner.mutate(input));
        return true;
      }
      const match = attachmentPath.exec(url.pathname);
      if (match) {
        const draftId = decodeURIComponent(match[1]!);
        const attachmentId = decodeURIComponent(match[2]!);
        if (!draftId || !attachmentId || draftId.length > 256 || attachmentId.length > 256) {
          throw new Error("Attachment identity is invalid.");
        }
        if (match[3] !== undefined && request.method === "PUT") {
          const index = Number(match[3]);
          this.owner.putAttachmentChunk(draftId, attachmentId, index,
            await readBody(request, MAX_CHUNK_BYTES));
          respond(response, 200, { accepted: true });
          return true;
        }
        if (url.pathname.endsWith("/complete") && request.method === "POST") {
          const input = completeInput.parse(JSON.parse((await readBody(request, MAX_JSON_BYTES)).toString("utf8")));
          respond(response, 200, this.owner.completeAttachment(
            draftId, attachmentId, input.count, input.mediaType, input.hash,
          ));
          return true;
        }
        if (match[3] === undefined && !url.pathname.endsWith("/complete") && request.method === "GET") {
          const content = this.owner.readAttachment(draftId, attachmentId);
          if (!content) {
            respond(response, 404, { error: "Attachment is unavailable." });
          } else {
            response.writeHead(200, {
              "Cache-Control": "private, no-store",
              "Content-Type": content.media_type,
              "Content-Length": content.content_length,
              "X-Content-Type-Options": "nosniff",
            });
            const streaming = this.sendAttachment(response, content.chunks());
            this.streams.set(response, streaming);
            try { await streaming; }
            finally { this.streams.delete(response); }
          }
          return true;
        }
      }
      respond(response, 404, { error: "Unknown presentation route." });
      return true;
    } catch (error) {
      if (response.headersSent) {
        console.error("[presentation] attachment stream failed",
          error instanceof Error ? error.name.slice(0, 80) : "unknown failure");
        response.destroy();
      } else {
        respond(response, 400, {
          error: error instanceof Error ? error.message.slice(0, 512) : "Presentation request failed.",
        });
      }
      return true;
    }
  }

  private async sendAttachment(response: ServerResponse, chunks: Iterable<{ content: Buffer }>) {
    for (const chunk of chunks) {
      if (response.destroyed) return;
      if (response.write(chunk.content)) continue;
      await new Promise<void>(resolve => {
        const finish = () => {
          response.off("drain", finish);
          response.off("close", finish);
          resolve();
        };
        response.once("drain", finish);
        response.once("close", finish);
      });
    }
    if (!response.destroyed) response.end();
  }
}
