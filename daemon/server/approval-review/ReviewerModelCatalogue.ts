/*
 * Exports:
 * - REVIEWER_CATALOGUE_MAX_AGE_MS: how long one listed catalogue answers lookups.
 * - default ReviewerModelCatalogue: resolve registry model specs to concrete ids, listing catalogue endpoints at most once per max age.
 */
import { z } from "zod";
import type { ApprovalReviewerModel } from "workbench-shared/workbench/approval-review/approval-reviewers";

export const REVIEWER_CATALOGUE_MAX_AGE_MS = 10 * 60_000;

const CatalogueSchema = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough();

export default class ReviewerModelCatalogue {
  readonly #listings = new Map<string, { listedAt: number; ids: Promise<readonly string[]> }>();

  constructor(private readonly options: { fetch?: typeof fetch; now?: () => number } = {}) {}

  /** The concrete model id, or null when the catalogue lists no match. Listing failures reject and are not cached. */
  async resolve(model: ApprovalReviewerModel, apiKey: string): Promise<string | null> {
    if (typeof model === "string") return model;
    const ids = await this.list(model.catalogue, apiKey);
    return ids.find(id => model.pattern.test(id)) ?? null;
  }

  private list(url: string, apiKey: string) {
    const now = (this.options.now ?? Date.now)();
    const cached = this.#listings.get(url);
    if (cached && now - cached.listedAt < REVIEWER_CATALOGUE_MAX_AGE_MS) return cached.ids;
    const ids = (async () => {
      const response = await (this.options.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!response.ok) throw new Error(`Model list returned HTTP ${response.status}.`);
      const parsed = CatalogueSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Model list has an unexpected shape.");
      return parsed.data.data.map(entry => entry.id);
    })();
    const listing = { listedAt: now, ids };
    this.#listings.set(url, listing);
    ids.catch(() => { if (this.#listings.get(url) === listing) this.#listings.delete(url); });
    return ids;
  }
}
