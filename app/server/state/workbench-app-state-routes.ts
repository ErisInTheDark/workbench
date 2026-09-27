/*
 * Exports:
 * - default WorkbenchAppStateRoutes: own app-state HTTP routes and bounded mutation/remap admission.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import {
  WORKBENCH_BROWSER_STATE_HEADER,
  isWorkbenchBrowserStateId,
  WorkbenchDaemonRegistrationRequestSchema,
  WorkbenchClientStateMutationSchema,
  WorkbenchProjectRemapSchema,
  workbenchClientStateMutationKinds,
  type WorkbenchClientStateIdentity,
  type WorkbenchClientStateResponse,
} from "workbench-shared/state/workbench-client-state";

import WorkbenchBrowserStateRegistry from "./WorkbenchBrowserStateRegistry.ts";

const MAX_BODY_BYTES = 1_000_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const attachmentInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("composerDraft"),
    browserStateId: z.string().min(1),
    daemonRegistrationId: z.string().min(1),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    attachmentId: z.string().min(1).max(256),
  }),
  z.object({
    kind: z.literal("questionnaireDraft"),
    browserStateId: z.string().min(1),
    daemonRegistrationId: z.string().min(1),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    requestKey: z.string().min(1),
    attachmentId: z.string().min(1).max(256),
  }),
]);
const mediaType = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function sendJson(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, {
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function negotiatedState(value: WorkbenchClientStateResponse, url: URL) {
  if (url.searchParams.get("capabilities") === "3") return value;
  const { attachmentsAsUrls: _attachmentsAsUrls, ...previous } = value;
  if (url.searchParams.get("capabilities") === "2") return previous;
  const { registrations: _registrations, ...legacy } = previous;
  return legacy;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("Workbench app-state request is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readImage(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_IMAGE_BYTES) throw new Error("Draft image exceeds its size limit.");
    chunks.push(buffer);
  }
  if (!bytes) throw new Error("Draft image is empty.");
  return Buffer.concat(chunks);
}

export default class WorkbenchAppStateRoutes {
  readonly #registry: WorkbenchBrowserStateRegistry;

  constructor(registry: WorkbenchBrowserStateRegistry,
    private readonly verifyAttachedDaemon: (daemonId: string) => boolean = () => false) {
    this.#registry = registry;
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    const isReadRoute = url.pathname === "/api/workbench-client-state";
    const isAttachmentRoute = url.pathname === "/api/workbench-client-state/attachment";
    const isRemapRoute = url.pathname === "/api/workbench-client-state/project-remap";
    const isRegistrationRoute = url.pathname === "/api/workbench-client-state/daemon-register";
    const mutationKinds = workbenchClientStateMutationKinds(url.pathname);
    if (!isReadRoute && !isAttachmentRoute && !isRemapRoute && !isRegistrationRoute && !mutationKinds) {
      if (!url.pathname.startsWith("/api/workbench-client-state/")) return false;
      sendJson(response, 404, { error: "Unknown Workbench app-state route." });
      return true;
    }
    try {
      const rawBrowserStateId = request.headers[WORKBENCH_BROWSER_STATE_HEADER];
      if (Array.isArray(rawBrowserStateId)) throw new Error("Workbench browser state ID is invalid.");
      const browserStateId = rawBrowserStateId || undefined;
      if (isAttachmentRoute && (request.method === "GET" || request.method === "PUT")) {
        const parsed = attachmentInput.parse(Object.fromEntries(url.searchParams));
        if (parsed.browserStateId !== "shared" && !isWorkbenchBrowserStateId(parsed.browserStateId)) {
          throw new Error("Browser state ID is invalid.");
        }
        const owner = parsed.kind === "composerDraft"
          ? {
            kind: parsed.kind, daemonRegistrationId: parsed.daemonRegistrationId,
            projectId: parsed.projectId, threadId: parsed.threadId,
          }
          : {
            kind: parsed.kind, daemonRegistrationId: parsed.daemonRegistrationId,
            projectId: parsed.projectId, threadId: parsed.threadId, requestKey: parsed.requestKey,
          };
        const imageBrowser = parsed.browserStateId === "shared" ? undefined : parsed.browserStateId;
        if (request.method === "GET") {
          const image = await this.#registry.readBrowserAttachment(imageBrowser, owner, parsed.attachmentId);
          if (!image) {
            sendJson(response, 404, { error: "Draft image is unavailable." });
            return true;
          }
          response.writeHead(200, {
            "Cache-Control": "private, no-store",
            "Content-Type": image.mediaType,
            "Content-Length": image.content.length,
            "X-Content-Type-Options": "nosniff",
          });
          response.end(image.content);
          return true;
        }
        if (browserStateId !== imageBrowser) throw new Error("Draft image belongs to another browser.");
        const type = mediaType.parse(request.headers["content-type"]?.split(";")[0]?.trim());
        const content = await readImage(request);
        sendJson(response, 200, await this.#registry.putBrowserAttachment(
          imageBrowser, owner, parsed.attachmentId, type, content));
        return true;
      }
      if (isRegistrationRoute && request.method === "POST") {
        const input = WorkbenchDaemonRegistrationRequestSchema.safeParse(await readJson(request));
        if (!input.success || input.data.attachedLocal && !this.verifyAttachedDaemon(input.data.daemonId)) {
          sendJson(response, 400, { error: "Daemon registration is invalid or not attached." });
          return true;
        }
        sendJson(response, 200, await this.#registry.registerBrowserDaemon(
          browserStateId, input.data.daemonId, input.data.attachedLocal));
        return true;
      }
      if (isRemapRoute && request.method === "POST") {
        const input = WorkbenchProjectRemapSchema.safeParse(await readJson(request));
        if (!input.success) {
          sendJson(response, 400, { error: "Workbench project remap is invalid." });
          return true;
        }
        sendJson(response, 200, negotiatedState(
          await this.#registry.remapBrowserProjects(browserStateId, input.data), url));
        return true;
      }
      if (isReadRoute && request.method === "GET") {
        const rawRevision = url.searchParams.get("sinceRevision");
        const sinceRevision = rawRevision === null ? undefined : Number(rawRevision);
        if (sinceRevision !== undefined && (!Number.isSafeInteger(sinceRevision) || sinceRevision < 0)) {
          sendJson(response, 400, { error: "sinceRevision must be a non-negative integer." });
          return true;
        }
        sendJson(response, 200, negotiatedState(await this.#registry.readBrowser(
          browserStateId, sinceRevision, url.searchParams.get("capabilities") === "3"), url));
        return true;
      }
      if (mutationKinds && (request.method === "PUT" || request.method === "DELETE")) {
        const value = await readJson(request);
        const parsed = WorkbenchClientStateMutationSchema.safeParse(request.method === "PUT"
          ? { action: "put", record: value } : { action: "delete", identity: value });
        if (!parsed.success || !mutationKinds.includes(parsed.data.action === "put"
          ? parsed.data.record.kind : parsed.data.identity.kind)) {
          sendJson(response, 400, { error: "Workbench app-state mutation is invalid." });
          return true;
        }
        sendJson(response, 200, negotiatedState(await this.#registry.mutateBrowser(
          browserStateId, parsed.data, url.searchParams.get("capabilities") === "3"), url));
        return true;
      }
      response.writeHead(405, { Allow: isReadRoute ? "GET" : isRemapRoute || isRegistrationRoute ? "POST" : "DELETE, PUT" });
      response.end();
      return true;
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message.slice(0, 1_000) : "Workbench app-state request failed.",
      });
      return true;
    }
  }
}
