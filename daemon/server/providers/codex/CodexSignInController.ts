/*
 * Exports:
 * - CodexSignInOperations: the main app-server request port and its signed-in account read.
 * - default CodexSignInController: sign Codex in with a ChatGPT device code or API key and out again through the main app-server,
 *   whose cached auth must see every change; `observe` receives its login completions.
 */
import { z } from "zod";
import type { LoginAccountParams } from "workbench-shared/codex/generated/app-server/v2/LoginAccountParams";
import type { ProviderAccountIntegration } from "workbench-shared/workbench/provider/provider-account-sign-in";
import type { ProviderSignInAdapter, ProviderSignInFlow } from "../ProviderSignInSession";
import type { CodexAccount } from "./CodexConfigurationController";

const INTEGRATION_ID = "openai";
const METHODS = [
  { id: "chatgpt", label: "ChatGPT", kind: "browser" },
  { id: "apiKey", label: "API key", kind: "key" },
] as const;

const DeviceCodeResponseSchema = z.object({
  type: z.literal("chatgptDeviceCode"), loginId: z.string(), verificationUrl: z.string(), userCode: z.string(),
}).passthrough();
const LoginCompletedSchema = z.object({
  loginId: z.string().nullable(), success: z.boolean(), error: z.string().nullable().optional(),
}).passthrough();

export interface CodexSignInOperations {
  request(method: string, params: object, options?: { background?: boolean }): Promise<unknown>;
  readAccount(): Promise<CodexAccount | null>;
}

export default class CodexSignInController implements ProviderSignInAdapter {
  private readonly logins = new Map<string, { resolve(): void; reject(error: Error): void }>();

  constructor(private readonly operations: CodexSignInOperations) {}

  /** Receives every main app-server notification; only login completions matter here. */
  observe(notification: { method: string; params?: unknown }) {
    if (notification.method !== "account/login/completed") return;
    const parsed = LoginCompletedSchema.safeParse(notification.params);
    if (!parsed.success || !parsed.data.loginId) return;
    const login = this.logins.get(parsed.data.loginId);
    if (!login) return;
    this.logins.delete(parsed.data.loginId);
    if (parsed.data.success) login.resolve();
    else login.reject(new Error(parsed.data.error || "Codex sign-in failed."));
  }

  async read(): Promise<ProviderAccountIntegration[]> {
    const account = await this.operations.readAccount();
    return [{
      id: INTEGRATION_ID, label: "OpenAI", primary: true, signedIn: account !== null,
      accountLabel: account?.email?.trim() || (account?.type === "apiKey" ? "API key" : null),
      methods: METHODS.map(method => ({ ...method })),
    }];
  }

  async begin(integrationId: string, methodId: string, signal: AbortSignal): Promise<ProviderSignInFlow> {
    if (integrationId !== INTEGRATION_ID || methodId !== "chatgpt") throw new Error("Unknown Codex sign-in method.");
    const params: LoginAccountParams = { type: "chatgptDeviceCode" };
    const response = DeviceCodeResponseSchema.parse(await this.operations.request("account/login/start", params));
    const { loginId } = response;
    const settled = new Promise<void>((resolve, reject) => { this.logins.set(loginId, { resolve, reject }); });
    signal.addEventListener("abort", () => { this.logins.delete(loginId); }, { once: true });
    return {
      url: response.verificationUrl, userCode: response.userCode, acceptsCode: false, expiresAt: null, settled,
      cancel: async () => { await this.operations.request("account/login/cancel", { loginId }); },
    };
  }

  async connectKey(integrationId: string, methodId: string, key: string) {
    if (integrationId !== INTEGRATION_ID || methodId !== "apiKey") throw new Error("Unknown Codex sign-in method.");
    const params: LoginAccountParams = { type: "apiKey", apiKey: key };
    await this.operations.request("account/login/start", params);
  }

  async signOut(integrationId: string) {
    if (integrationId !== INTEGRATION_ID) throw new Error("Unknown Codex account.");
    await this.operations.request("account/logout", {});
  }
}
