/*
 * Exports:
 * - WorkbenchClientController: mounted Workbench client, explorer, and transcript comparison read model. Keywords: client, controller, explorer.
 * - default WorkbenchClientContext: provide one mounted Workbench client to domain hooks. Keywords: React, context, provider.
 */
"use client";

import { createContext } from "react";

import type { ExplorerSnapshot, WorkbenchControls } from "workbench-shared/types";
import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { MountedWorkbenchClient } from "../../WorkbenchClient";

export interface WorkbenchClientController {
  controls: WorkbenchControls | null;
  explorer: ExplorerSnapshot;
  mounted: MountedWorkbenchClient | null;
  transcriptComparison: {
    available: boolean;
    projection: WorkbenchTranscriptProjection | null;
  };
}

const WorkbenchClientContext = createContext<WorkbenchClientController | null>(null);

export default WorkbenchClientContext;
