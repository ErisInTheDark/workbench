/*
 * Exports:
 * - WORKBENCH_PROJECT_CONFIG_FILE: the project-root file holding project-owned Workbench settings.
 * - WorkbenchProjectConfigSchema/WorkbenchProjectConfig: every `.wb.json` section; each feature registers its own.
 * - WORKBENCH_PROJECT_CONFIG_REPAIR_TEMPLATE: empty sections that repair invalid entries one at a time.
 * - workbenchProjectConfigJsonSchema: the editor-facing JSON Schema published as `package/wb.schema.json`.
 */
import { z } from "zod";
import { VisProjectConfigSectionSchema } from "../vis/vis-project-config";

export const WORKBENCH_PROJECT_CONFIG_FILE = ".wb.json";

/** Add a feature's settings as one optional section; unknown sections are rejected so typos surface. */
const SECTIONS = {
  vis: VisProjectConfigSectionSchema.optional(),
};

export const WorkbenchProjectConfigSchema = z.object({
  $schema: z.string().optional().describe("Editor schema reference; ignored by Workbench."),
  ...SECTIONS,
}).strict().describe("Project-owned Workbench settings, read from .wb.json at the project root.");
export type WorkbenchProjectConfig = z.infer<typeof WorkbenchProjectConfigSchema>;

/**
 * Repair template: each section's empty shape, so an invalid entry inside a section is dropped on its own instead of
 * taking the whole section with it.
 */
export const WORKBENCH_PROJECT_CONFIG_REPAIR_TEMPLATE: z.input<typeof WorkbenchProjectConfigSchema> = { vis: {} };

export function workbenchProjectConfigJsonSchema() {
  return z.toJSONSchema(WorkbenchProjectConfigSchema, { io: "input" });
}
