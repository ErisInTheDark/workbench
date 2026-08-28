/*
 * Exports:
 * - default conformWorkbenchThreadStateOpenResult: repair inbound browser bootstrap display state without writing repaired data back to the server. Keywords: browser, sidebar, schema, conformance, read-only.
 */

import { conformToZodSchema } from "../zod-schema-conformer";
import { WorkbenchThreadStateOpenResultSchema } from "./thread-state";

export default function conformWorkbenchThreadStateOpenResult(value: unknown, projectId: string) {
  return conformToZodSchema(WorkbenchThreadStateOpenResultSchema, value, {
    catalog: { data: [], rootPath: "" },
    project: null,
    sidebar: {
      entries: [],
      error: "The thread-state bootstrap response needed compatibility repair.",
      freshness: "partial",
      projectId,
      revision: 0,
    },
  });
}
