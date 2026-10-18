/*
 * Exports:
 * - CodexAccount: signed-in Codex account kind, ChatGPT plan and email.
 * - CodexConfigurationOperations: native request and local model-context ports.
 * - default CodexConfigurationController: translate native models, account and limits without owning another cache.
 */
import { z } from "zod";
import type { ModelListResponse } from "workbench-shared/codex/generated/app-server/v2/ModelListResponse";
import type { WorkbenchModelContextCapability, WorkbenchModelOption } from "workbench-shared/types";
import { WorkbenchAccountLimitsSchema, type WorkbenchAccountLimits } from "workbench-shared/workbench/provider/provider-account";
import providerAccountFingerprint from "./providers/provider-account-fingerprint";

const AccountResponseSchema = z.object({
  account: z.object({ type: z.string(), planType: z.string().nullish(), email: z.string().nullish() }).passthrough().nullable(),
}).passthrough();
export type CodexAccount = { type: string; planType?: string | null; email?: string | null };

export interface CodexConfigurationOperations {
  request(method: string, params: object, options?: { background?: boolean }): Promise<unknown>;
  warn(message: string): void;
}

export default class CodexConfigurationController {
  constructor(private readonly operations: CodexConfigurationOperations) {}

  async models(readModelContext: () => Promise<WorkbenchModelContextCapability[]>): Promise<WorkbenchModelOption[]> {
    const models: WorkbenchModelOption[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.operations.request("model/list", { cursor, includeHidden: false, limit: 100 }) as ModelListResponse;
      for (const model of response.data) {
        const serviceTierIds = new Set([...model.additionalSpeedTiers, ...model.serviceTiers.map(tier => tier.id)]);
        models.push({
          id: model.id,
          displayName: model.displayName,
          description: model.description,
          hidden: model.hidden,
          isDefault: model.isDefault,
          supportsPersonality: model.supportsPersonality,
          supportsReasoningEffort: model.supportedReasoningEfforts.length > 0,
          supportedReasoningEfforts: model.supportedReasoningEfforts.map(effort => effort.reasoningEffort),
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportsVision: model.inputModalities.includes("image"),
          supportsFastMode: serviceTierIds.has("fast"),
          inputModalities: [...model.inputModalities],
          maxContextWindowTokens: null,
          additionalSpeedTiers: [...model.additionalSpeedTiers],
          policyState: null,
          billingMultiplier: null,
        });
      }
      cursor = response.nextCursor;
    } while (cursor);

    try {
      const capabilities = await readModelContext();
      for (const model of models) {
        const context = capabilities.find(capability => capability.model === model.id);
        if (!context) continue;
        model.contextWindow = context.maximumTokens > context.defaultTokens
          ? { defaultTokens: context.defaultTokens, maximumTokens: context.maximumTokens } : null;
        model.maxContextWindowTokens = context.maximumTokens;
      }
    } catch {
      this.operations.warn("Codex context capabilities are unavailable; model choices and saved settings are retained.");
    }
    return models;
  }

  /** The signed-in Codex account kind and ChatGPT plan; null when signed out. */
  async account(): Promise<CodexAccount | null> {
    const response = AccountResponseSchema.parse(await this.operations.request("account/read", {}, { background: true }));
    return response.account;
  }

  /**
   * Limits with the account that read them; an API key or a login without an email has no identity. Codex refreshes its
   * ChatGPT token only for model requests, so an idle login's limits read fails until one explicit refresh.
   */
  async accountLimits(): Promise<WorkbenchAccountLimits> {
    const readLimits = () => this.operations.request("account/rateLimits/read", {}, { background: true });
    let limits: unknown;
    try {
      limits = await readLimits();
    } catch (error) {
      // Codex reports the backend's 401 only as text.
      if (!(error instanceof Error && error.message.includes("token_expired"))) throw error;
      await this.operations.request("account/read", { refreshToken: true }, { background: true });
      limits = await readLimits();
    }
    const account = await this.account();
    const email = account?.email?.trim();
    return {
      ...WorkbenchAccountLimitsSchema.parse(limits),
      preferredLimitId: "codex",
      identity: email ? { fingerprint: providerAccountFingerprint("codex", email.toLowerCase()), label: email } : null,
    };
  }
}
