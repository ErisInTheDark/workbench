/*
 * Exports:
 * - SingleFileTransport/SingleFileDocument: native protocol and scratch-file test boundaries.
 * - CodexSingleFileOptions: runtime construction ports.
 * - default CodexSingleFileController: single-turn editing, idle waits, recovery and drain.
 */
import { z } from "zod";
import type { ClientRequest } from "workbench-shared/codex/generated/app-server/ClientRequest";
import type { RequestId } from "workbench-shared/codex/generated/app-server/RequestId";
import type { DynamicToolCallResponse } from "workbench-shared/codex/generated/app-server/v2/DynamicToolCallResponse";
import type { SingleFileInput, SingleFileStart, WorkbenchProviderSingleFile } from "workbench-shared/workbench/provider/provider-single-file";
import buildWorkbenchOwnedPromptFields from "./codex-owned-prompt";
import type { SingleFileJournalTag } from "./CodexSingleFileDocuments";

type Request = ClientRequest extends infer R ? R extends { id: RequestId } ? Omit<R, "id"> : never : never;
export interface SingleFileTransport {
  request(request: Request): Promise<unknown>;
  respond(id: RequestId, response: DynamicToolCallResponse): void;
  dispose(): Promise<void>;
}
export interface SingleFileDocument {
  directory: string;
  file: string;
  read(): Promise<string>;
  append(tag: SingleFileJournalTag, text: string): Promise<void>;
  dispose(): Promise<void>;
}
export interface CodexSingleFileOptions {
  createTransport(onMessage: (message: unknown) => Promise<void>, onFailure: (error: Error) => void): SingleFileTransport;
  createDocument(text: string): Promise<SingleFileDocument>;
}
interface Session {
  start: SingleFileStart;
  document: SingleFileDocument;
  threadId: string;
  turnId: string | null;
  input: SingleFileInput | null;
  lastInput: SingleFileInput | null;
  closed: boolean;
  finalAdmitted: boolean;
  revision: number;
  text: string;
  pendingWait: { id: RequestId } | null;
  pumping: Promise<void> | null;
  turnAdmission: Promise<void> | null;
  reads: Promise<void>;
  recoveryInput: SingleFileInput | null;
  recoveryRevision: number;
  completedTurn: string | null;
  terminal: boolean;
  completion: Promise<Error | null>;
  complete: (error: Error | null) => void;
}
const identity = z.union([z.string(), z.number()]);
const envelope = z.object({
  method: z.string(), id: identity.optional(), params: z.record(z.string(), z.unknown()),
});
const completed = z.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.string() }) });
const fileItem = z.object({ threadId: z.string(), item: z.object({ type: z.string(), status: z.string().optional() }) });
const waitCall = z.object({
  threadId: z.string(), turnId: z.string(), tool: z.string(),
  arguments: z.object({}).strict(),
});

export default class CodexSingleFileController implements WorkbenchProviderSingleFile {
  private readonly transport: SingleFileTransport;
  private ready: Promise<void> | null = null;
  private session: Session | null = null;
  private starting = false;
  private disposed = false;
  constructor(private readonly options: CodexSingleFileOptions) {
    this.transport = options.createTransport(message => this.observe(message), error => this.fail(error));
  }
  prepare() {
    if (this.disposed) return Promise.reject(new Error("Single-file editor is disposed."));
    return this.ready ??= this.transport.request({
      method: "initialize",
      params: { clientInfo: { name: "workbench-voice", title: "Workbench voice", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } },
    }).then(() => undefined);
  }
  async start(start: SingleFileStart) {
    if (this.starting || this.session) throw new Error("Single-file editor is busy.");
    this.starting = true;
    let document: SingleFileDocument | null = null;
    try {
      await this.prepare();
      document = await this.options.createDocument(start.text);
      if (this.disposed) throw new Error("Single-file editor was disposed during startup.");
      const profile = `voice-${start.sessionId}`;
      const prompt = buildWorkbenchOwnedPromptFields(start.instructions, "");
      await document.append("instructions", start.instructions);
      const dynamicTools = [{
        type: "function" as const, name: "wait_for_transcript",
        description: "Receive the latest speech context, waiting if necessary. Patch the document, then call again. End only after the final-input note.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }];
      await document.append("tools", JSON.stringify(dynamicTools, null, 2));
      console.info("[voice-transformer] session", document.directory);
      const response = z.object({
        thread: z.object({ id: z.string() }), reasoningEffort: z.literal("none"),
        approvalPolicy: z.literal("never"), activePermissionProfile: z.object({ id: z.literal(profile) }),
      }).parse(await this.transport.request({
        method: "thread/start",
        params: {
          ...prompt,
          model: start.settings.model, cwd: document.directory, runtimeWorkspaceRoots: [],
          approvalPolicy: "never", permissions: profile, ephemeral: true, environments: [],
          serviceTier: null,
          config: {
            ...prompt.config, model_reasoning_effort: "none",
            permissions: { [profile]: { filesystem: { [document.file]: "write" }, network: { enabled: false } } },
          },
          dynamicTools,
        },
      }));
      if (this.disposed) throw new Error("Single-file editor was disposed during startup.");
      let complete!: Session["complete"];
      const completion = new Promise<Error | null>(resolve => { complete = resolve; });
      const session: Session = {
        start, document, threadId: response.thread.id, turnId: null,
        input: null, lastInput: null, closed: false, finalAdmitted: false,
        revision: 0, text: start.text, pendingWait: null, pumping: null, turnAdmission: null, reads: Promise.resolve(),
        recoveryInput: null, recoveryRevision: -1, completedTurn: null, terminal: false, completion, complete,
      };
      this.session = session;
      await this.pump(session);
    } catch (error) {
      if (this.session) this.fail(error instanceof Error ? error : new Error("Single-file startup failed."));
      else if (document) {
        try { await document.append("error", error instanceof Error ? error.message : "Single-file startup failed."); }
        finally { await document.dispose(); }
      }
      throw error;
    } finally { this.starting = false; }
  }
  async input(sessionId: string, input: SingleFileInput) {
    const session = this.owned(sessionId);
    if (session.closed) throw new Error("Transcript input is closed.");
    session.input = input;
    session.closed = input.final;
    await this.pump(session);
  }
  async finish(sessionId: string) {
    const session = this.owned(sessionId);
    if (!session.closed) throw new Error("Final transcript must be queued before finishing.");
    await this.pump(session);
    const error = await session.completion;
    if (error) throw error;
    await this.cleanup(session);
  }
  async cancel(sessionId: string) {
    const session = this.session;
    if (!session || session.start.sessionId !== sessionId) return;
    session.terminal = true;
    this.cancelWait(session);
    session.complete(new Error("Voice editing cancelled."));
    // Admission can reveal a turn identity after cancellation. Drain it before
    // interrupting so a late turn cannot continue editing a retired document.
    await session.pumping?.catch(() => undefined); // Pump owns reporting.
    if (session.turnId) {
      try { await this.transport.request({ method: "turn/interrupt", params: { threadId: session.threadId, turnId: session.turnId } }); }
      catch (error) { console.warn("[voice-transformer] interrupt failed", error instanceof Error ? error.message.slice(0, 300) : "protocol failure"); }
    }
    await session.reads;
    try { await session.document.append("cancelled", "Voice editing cancelled."); }
    finally { await this.cleanup(session); }
    session.start.onEvent({ type: "cancelled", sessionId });
  }
  async dispose() {
    this.disposed = true;
    try { if (this.session) await this.cancel(this.session.start.sessionId); }
    finally { await this.transport.dispose(); }
  }
  private owned(sessionId: string) {
    const session = this.session;
    if (!session || session.start.sessionId !== sessionId) throw new Error("Unknown single-file session.");
    return session;
  }
  private pump(session: Session): Promise<void> {
    if (session.pumping) return session.pumping;
    if (session.terminal || this.session !== session) return Promise.resolve();
    const run = async () => {
      while (!session.terminal && this.session === session) {
        const input = session.input;
        if (!session.turnId) {
          if (session.completedTurn) {
            if (!input && session.recoveryInput === session.lastInput && session.recoveryRevision === session.revision) break;
            session.recoveryInput = session.lastInput;
            session.recoveryRevision = session.revision;
          }
          await session.reads;
          const text = await session.document.read();
          const message = this.message(input ?? session.lastInput, text);
          await session.document.append("agent-input", message);
          const admission = Promise.withResolvers<void>();
          session.turnAdmission = admission.promise;
          try {
            const response = z.object({ turn: z.object({ id: z.string() }) }).parse(await this.transport.request({
              method: "turn/start",
              params: {
                threadId: session.threadId, effort: "none",
                input: [{ type: "text", text: message, text_elements: [] }],
              },
            }));
            session.turnId = session.completedTurn === response.turn.id ? null : response.turn.id;
            if (input) await session.document.append("vtt", message);
          } finally {
            session.turnAdmission = null;
            admission.resolve();
          }
          if (session.terminal) break;
        } else if (session.pendingWait && (input || session.finalAdmitted)) {
          await session.reads;
          if (session.terminal) break;
          const message = this.message(input ?? session.lastInput);
          await session.document.append("vtt", message);
          if (session.terminal) break;
          const wait = session.pendingWait;
          session.pendingWait = null;
          if (wait) this.transport.respond(wait.id, { success: true, contentItems: [{ type: "inputText", text: message }] });
        } else break;
        if (input) {
          session.lastInput = input;
          session.finalAdmitted = input.final;
          if (session.input === input) session.input = null;
        }
        if (!session.input) break;
      }
    };
    const pumping = run().catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error("Voice transformer admission failed."));
      throw error;
    }).finally(() => { if (session.pumping === pumping) session.pumping = null; });
    session.pumping = pumping;
    return pumping;
  }
  private message(input: SingleFileInput | null, document?: string) {
    const current = document === undefined ? "" : `Current document.txt (line numbers are context only):\n${document.split("\n").map((line, index) => `${index + 1} | ${line}`).join("\n")}\nContinue from this actual state and existing history; do not reapply completed edits.\n`;
    return `${current}${input ? `Transcript input: ${input.final ? "FINAL - no more packets; finish edits and end the turn" : "OPEN - patch then wait_for_transcript(), do not end"}\nLatest recognition context (replaces earlier uncertainty, not repeated commands):\n${input.transcript}` : "Speech input is open. Call wait_for_transcript() to receive it. Do not end the turn."}`;
  }
  private async observe(message: unknown) {
    const parsed = envelope.safeParse(message);
    if (!parsed.success) return;
    const { method, params, id } = parsed.data;
    const session = this.session;
    if (!session || session.terminal) return;
    if (method.startsWith("item/") || method === "error" || method === "turn/completed" || id !== undefined) {
      // Admission stays synchronous so cancellation cannot miss an already observed
      // file completion. The document owner orders and drains all evidence writes.
      void session.document.append("agent-output", JSON.stringify(message, null, 2)).catch(error => {
        this.fail(error instanceof Error ? error : new Error("Unable to retain agent output."));
      });
    }
    if (method === "item/tool/call" && id !== undefined) {
      if (session.turnAdmission) {
        await session.turnAdmission;
        await session.pumping;
        if (session.terminal || this.session !== session) return;
      }
      const call = waitCall.safeParse(params);
      if (!call.success || call.data.threadId !== session.threadId || call.data.turnId !== session.turnId || call.data.tool !== "wait_for_transcript") {
        this.rejectTool(session, id, "Unsupported tool call.");
        return;
      }
      if (session.pendingWait) {
        this.rejectTool(session, id, "A transcript wait is already pending.");
        return;
      }
      session.pendingWait = { id };
      await this.pump(session);
    } else if (method === "item/completed") {
      const item = fileItem.safeParse(params);
      if (!item.success || item.data.threadId !== session.threadId || item.data.item.type !== "fileChange") return;
      const admission = session.turnAdmission;
      session.reads = session.reads.then(async () => {
        await admission;
        const text = await session.document.read();
        await session.document.append("patch-applied", text);
        if (session.terminal || this.session !== session) return;
        if (text !== session.text) {
          session.text = text;
          session.start.onEvent({ type: "document", sessionId: session.start.sessionId, revision: ++session.revision, text });
        }
        if (item.data.item.status === "failed") throw new Error("Native document edit failed.");
      }).catch(error => this.fail(error instanceof Error ? error : new Error("Unable to read edited document.")));
    } else if (method === "turn/completed") {
      const result = completed.safeParse(params);
      if (!result.success || result.data.threadId !== session.threadId) return;
      if (session.turnId && result.data.turn.id !== session.turnId) return;
      session.turnId = null;
      session.pendingWait = null;
      session.completedTurn = result.data.turn.id;
      await this.afterCompletion(session, result.data.turn.id, result.data.turn.status);
    } else if (id !== undefined) {
      this.fail(new Error("Voice transformer requested unsupported interaction or permissions."));
    }
  }
  private async afterCompletion(session: Session, turnId: string, status: string) {
    try {
      await session.pumping;
      await session.reads;
      if (session.terminal || this.session !== session) return;
      // Admission may have recovered into a different turn while this completion
      // waited. Only the latest completed turn can close the final-input drain.
      if (session.turnId !== null || session.completedTurn !== turnId) return;
      if (status === "failed" || status === "interrupted") throw new Error("Voice transformer turn failed.");
      if (session.finalAdmitted) {
        await session.document.append("completed", "Final input processed; native turn completed.");
        session.terminal = true;
        session.complete(null);
        session.start.onEvent({ type: "finished", sessionId: session.start.sessionId });
      } else await this.pump(session);
    } catch (error) { this.fail(error instanceof Error ? error : new Error("Voice continuation failed.")); }
  }
  private cancelWait(session: Session) {
    const wait = session.pendingWait;
    if (!wait) return;
    session.pendingWait = null;
    this.rejectTool(session, wait.id, "Session cancelled.");
  }
  private rejectTool(session: Session, id: RequestId, text: string) {
    void session.document.append("tool-response", text).catch(error => {
      console.warn("[voice-transformer] unable to retain tool response");
      this.fail(error instanceof Error ? error : new Error("Unable to retain tool response."));
    });
    this.transport.respond(id, { success: false, contentItems: [{ type: "inputText", text }] });
  }
  private fail(error: Error) {
    const session = this.session;
    if (!session || session.terminal) return;
    session.terminal = true;
    this.cancelWait(session);
    session.reads = session.reads.then(() => session.document.append("error", error.message.slice(0, 512)))
      .catch(() => { console.warn("[voice-transformer] unable to retain session failure"); });
    session.complete(error);
    console.warn("[voice-transformer]", error.message.replace(/\s+/g, " ").slice(0, 300));
    session.start.onEvent({ type: "error", sessionId: session.start.sessionId, message: error.message.slice(0, 512) });
  }
  private async cleanup(session: Session) {
    await session.pumping?.catch(() => undefined); // Failure already retained and published by pump.
    await session.reads;
    try { await this.transport.request({ method: "thread/unsubscribe", params: { threadId: session.threadId } }); }
    finally {
      try { await session.document.dispose(); }
      finally { if (this.session === session) this.session = null; }
    }
  }
}
