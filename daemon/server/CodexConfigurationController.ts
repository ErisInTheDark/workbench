/*
 * Exports:
 * - CodexConfigurationOperations: native request and local model-context ports.
 * - default CodexConfigurationController: translate native models/account limits without owning another cache.
 */
import type { ModelListResponse } from "workbench-shared/codex/generated/app-server/v2/ModelListResponse";
import type { WorkbenchModelContextCapability, WorkbenchModelOption } from "workbench-shared/types";
import { WorkbenchAccountLimitsSchema, type WorkbenchAccountLimits } from "workbench-shared/workbench/provider/provider-account";

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

  async accountLimits(): Promise<WorkbenchAccountLimits> {
    return {
      ...WorkbenchAccountLimitsSchema.parse(await this.operations.request("account/rateLimits/read", {}, { background: true })),
      preferredLimitId: "codex",
    };
  }
}
