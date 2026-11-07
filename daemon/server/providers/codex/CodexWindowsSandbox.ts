/*
 * Exports:
 * - CodexWindowsSandboxOptions: the main app-server request port and the daemon platform.
 * - CodexWindowsSandboxLevel: sandbox level agent shells request from the exec server.
 * - CodexWindowsSandboxFacts: Codex's elevated setup receipt and readiness plus Workbench's setup flight.
 * - resolveWindowsSandboxStatus: decide one daemon's Windows sandbox status from those facts.
 * - default CodexWindowsSandbox: own the elevated Windows sandbox status, the level agent shells use and the one setup flight.
 */
import { z } from "zod";
import {
  WINDOWS_SANDBOX_ERROR_LIMIT, type WindowsSandboxStatus,
} from "workbench-shared/workbench/provider/windows-sandbox";
import type { CodexExecRequest } from "./codex-exec-protocol";

/** Codex's elevated setup writes `windows.sandbox`; Workbench reads it as the machine's setup receipt, never as a preference. */
const ConfigurationSchema = z.object({
  config: z.object({ windows: z.object({ sandbox: z.enum(["elevated", "unelevated"]).nullish() }).nullish() }),
});
const ReadinessSchema = z.object({ status: z.enum(["ready", "notConfigured", "updateRequired"]) });
const SetupStartSchema = z.object({ started: z.boolean() });
const SetupCompletedSchema = z.object({ mode: z.enum(["elevated", "unelevated"]), success: z.boolean(), error: z.string().nullish() });

export interface CodexWindowsSandboxOptions {
  request(method: string, params: object): Promise<unknown>;
  platform?: NodeJS.Platform;
}

export type CodexWindowsSandboxLevel = Extract<CodexExecRequest["windowsSandboxLevel"], "elevated" | "restricted-token">;

export interface CodexWindowsSandboxFacts {
  /** True when Codex recorded a completed elevated setup. */
  elevatedReceipt: boolean;
  /** Codex readiness, read only when the receipt exists. */
  readiness: z.infer<typeof ReadinessSchema>["status"] | null;
  settingUp: boolean;
  /** The last setup attempt's failure, cleared by a successful or new attempt. */
  failure: string | null;
}

function elevatedReady({ elevatedReceipt, readiness }: Pick<CodexWindowsSandboxFacts, "elevatedReceipt" | "readiness">) {
  return elevatedReceipt && readiness === "ready";
}

export function resolveWindowsSandboxStatus(facts: CodexWindowsSandboxFacts): WindowsSandboxStatus {
  if (facts.settingUp) return { state: "setting-up" };
  if (elevatedReady(facts)) return { state: "ready" };
  if (facts.failure !== null) return { state: "failed", error: facts.failure };
  return facts.elevatedReceipt ? { state: "update-required" } : { state: "not-set-up" };
}

type SetupOutcome = { ok: true } | { ok: false; error: string };
interface SetupFlight {
  completion: Promise<SetupOutcome>;
  settle(outcome: SetupOutcome): void;
  abort(error: Error): void;
}

function bounded(message: string) {
  return message.slice(0, WINDOWS_SANDBOX_ERROR_LIMIT);
}

export default class CodexWindowsSandbox {
  private readonly platform: NodeJS.Platform;
  private flight: SetupFlight | null = null;
  private failure: string | null = null;

  constructor(private readonly options: CodexWindowsSandboxOptions) {
    this.platform = options.platform ?? process.platform;
  }

  async status(): Promise<WindowsSandboxStatus> {
    if (this.platform !== "win32") return { state: "unsupported" };
    if (this.flight) return { state: "setting-up" };
    return resolveWindowsSandboxStatus({ ...await this.read(null), settingUp: false, failure: this.failure });
  }

  /** Elevated only while Codex reports its setup ready, so stale or missing setup degrades instead of failing commands. */
  async level(cwd: string): Promise<CodexWindowsSandboxLevel> {
    if (this.platform !== "win32") return "restricted-token";
    return elevatedReady(await this.read(cwd)) ? "elevated" : "restricted-token";
  }

  /** Starts or joins the one elevated setup; Codex shows the administrator prompt on this daemon's machine. */
  async setUp(): Promise<WindowsSandboxStatus> {
    if (this.platform !== "win32") throw new Error("The elevated sandbox is only available on Windows.");
    this.flight ??= this.start();
    await this.flight.completion;
    return await this.status();
  }

  /** Receives every main app-server notification; only elevated setup completions matter here. */
  observe(notification: { method: string; params?: unknown }) {
    if (notification.method !== "windowsSandbox/setupCompleted") return;
    const parsed = SetupCompletedSchema.safeParse(notification.params);
    if (!parsed.success || parsed.data.mode !== "elevated") return;
    this.flight?.settle(parsed.data.success ? { ok: true }
      : { ok: false, error: bounded(parsed.data.error || "Windows sandbox setup failed.") });
  }

  /** A retired bridge never sees the completion, so callers recheck status instead of waiting forever. */
  dispose() {
    this.flight?.abort(new Error("Codex reloaded during Windows sandbox setup. Recheck its status."));
    this.flight = null;
  }

  private start(): SetupFlight {
    let settle!: SetupFlight["settle"];
    let abort!: SetupFlight["abort"];
    const completion = new Promise<SetupOutcome>((resolve, reject) => { settle = resolve; abort = reject; });
    const flight: SetupFlight = { completion, settle, abort };
    this.failure = null;
    // Registered before any joiner awaits, so joiners read status after the flight cleared.
    void completion.then(outcome => {
      this.failure = outcome.ok ? null : outcome.error;
      if (this.flight === flight) this.flight = null;
    }, () => undefined);
    void this.options.request("windowsSandbox/setupStart", { mode: "elevated" }).then(response => {
      if (!SetupStartSchema.parse(response).started) settle({ ok: false, error: "Codex did not start Windows sandbox setup." });
    }, (error: unknown) => {
      settle({ ok: false, error: bounded(error instanceof Error ? error.message : String(error)) });
    });
    return flight;
  }

  private async read(cwd: string | null): Promise<Pick<CodexWindowsSandboxFacts, "elevatedReceipt" | "readiness">> {
    const { config } = ConfigurationSchema.parse(await this.options.request("config/read", {
      includeLayers: false, ...(cwd === null ? {} : { cwd }),
    }));
    const elevatedReceipt = config.windows?.sandbox === "elevated";
    const readiness = elevatedReceipt
      ? ReadinessSchema.parse(await this.options.request("windowsSandbox/readiness", {})).status
      : null;
    return { elevatedReceipt, readiness };
  }
}
