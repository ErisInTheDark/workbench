/*
 * Exports:
 * - WorkbenchClientController: mounted Workbench client, explorer, and SQLite transcript source read model. Keywords: client, controller, explorer, transcript.
 * - default WorkbenchClientContext: provide one mounted Workbench client to domain hooks. Keywords: React, context, provider.
 */
"use client";

import { createContext } from "react";

import type { ExplorerSnapshot, WorkbenchControls } from "workbench-shared/types";
import type { MountedWorkbenchClient } from "../../WorkbenchClient";
import type { ThreadTranscriptProjectionState } from "../../workbench/transcript/ThreadTranscriptProjectionController";

export interface WorkbenchClientController {
  controls: WorkbenchControls | null;
  explorer: ExplorerSnapshot;
  mounted: MountedWorkbenchClient | null;
  transcriptSource: ThreadTranscriptProjectionState;
}

const WorkbenchClientContext = createContext<WorkbenchClientController | null>(null);

export default WorkbenchClientContext;
