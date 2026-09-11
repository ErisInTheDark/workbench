/*
 * Exports:
 * - default CodexModelCatalog: read bounded local Codex model context capabilities.
 */
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WorkbenchModelContextCapabilitySchema } from "workbench-shared/workbench/thread/thread-profile";
import type { WorkbenchModelContextCapability } from "workbench-shared/types";
import { resolveCodexHome } from "../lib/codex/codex-home";

const cacheSchema = z.object({
  models: z.array(z.object({
    slug: z.string().min(1),
    context_window: z.number().int().positive().optional(),
    max_context_window: z.number().int().positive().optional(),
  })).max(10_000),
});

export default class CodexModelCatalog {
  constructor(private readonly home = resolveCodexHome()) {}

  async read(): Promise<WorkbenchModelContextCapability[]> {
    const file = await open(path.join(this.home, "models_cache.json"), "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!file) return [];
    try {
      const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size === buffer.length) throw new Error("Codex model metadata exceeds its bounded size.");
      let json: object;
      try { json = JSON.parse(buffer.subarray(0, size).toString("utf8")); }
      catch { throw new Error("Codex model metadata is not valid JSON."); }
      const parsed = cacheSchema.safeParse(json);
      if (!parsed.success) throw new Error("Codex model metadata has invalid capability fields.");
      return parsed.data.models.flatMap(model => {
        if (model.context_window === undefined || model.max_context_window === undefined) return [];
        const capability = WorkbenchModelContextCapabilitySchema.safeParse({
          model: model.slug, defaultTokens: model.context_window, maximumTokens: model.max_context_window,
        });
        if (!capability.success) throw new Error("Codex model context bounds are inconsistent.");
        return [capability.data];
      });
    } finally {
      await file.close();
    }
  }
}
