/*
 * Exports:
 * - default WorkbenchClientProvider: provide one mounted Workbench client to nested domain hooks. Keywords: React, provider, client.
 */
"use client";

import type { ReactNode } from "react";

import WorkbenchClientContext, { type WorkbenchClientController } from "./workbench-client-context";

export default function WorkbenchClientProvider({
  children,
  client,
}: {
  children: ReactNode;
  client: WorkbenchClientController;
}) {
  return <WorkbenchClientContext.Provider value={client}>{children}</WorkbenchClientContext.Provider>;
}
