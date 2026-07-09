/*
 * Exports:
 * - ThreadWorkbenchOverlayLayerInput: complete live thread and overlay dependency input. Keywords: thread, overlay, layer.
 * - ThreadWorkbenchOverlayLayerOptions: ordered overlay projection callbacks. Keywords: thread, overlay, stable, status.
 * - default ThreadWorkbenchOverlayLayer: cache owner for complete Workbench-overlay thread output. Keywords: thread, overlay, controller.
 */

import type { ThreadPayload } from "../../types";

export interface ThreadWorkbenchOverlayLayerInput {
  key: string;
  liveThread: ThreadPayload;
  optimisticRevision: number;
  questionnaireForceProjectionEpoch: number;
  questionnaireRevision: number;
  browseResultRevision: number;
  stablePreferenceRevision: number;
  statusRevision: number;
  steerRevision: number;
}

export interface ThreadWorkbenchOverlayLayerOptions {
  applyBrowseResultOverlay: (thread: ThreadPayload) => ThreadPayload;
  applyOptimisticOverlay: (thread: ThreadPayload) => ThreadPayload;
  applyQuestionnaireOverlay: (thread: ThreadPayload) => ThreadPayload;
  applyStablePreferenceOverlay: (thread: ThreadPayload) => ThreadPayload;
  applyStatusOverlay: (thread: ThreadPayload) => ThreadPayload;
  applySteerOverlay: (thread: ThreadPayload) => ThreadPayload;
}

interface ThreadWorkbenchOverlayLayerCacheEntry extends Omit<ThreadWorkbenchOverlayLayerInput, "liveThread"> {
  liveThread: ThreadPayload;
  overlayThread: ThreadPayload;
}

export default class ThreadWorkbenchOverlayLayer {
  private readonly cacheByKey = new Map<string, ThreadWorkbenchOverlayLayerCacheEntry>();
  private readonly options: ThreadWorkbenchOverlayLayerOptions;

  constructor(options: ThreadWorkbenchOverlayLayerOptions) {
    this.options = options;
  }

  clear() {
    this.cacheByKey.clear();
  }

  invalidate(key: string) {
    this.cacheByKey.delete(key);
  }

  render(input: ThreadWorkbenchOverlayLayerInput) {
    const previous = this.cacheByKey.get(input.key);
    if (
      previous
      && previous.liveThread === input.liveThread
      && previous.optimisticRevision === input.optimisticRevision
      && previous.questionnaireForceProjectionEpoch === input.questionnaireForceProjectionEpoch
      && previous.questionnaireRevision === input.questionnaireRevision
      && previous.browseResultRevision === input.browseResultRevision
      && previous.stablePreferenceRevision === input.stablePreferenceRevision
      && previous.statusRevision === input.statusRevision
      && previous.steerRevision === input.steerRevision
    ) {
      return previous.overlayThread;
    }

    const stableThread = this.options.applyStablePreferenceOverlay(input.liveThread);
    const statusThread = this.options.applyStatusOverlay(stableThread);
    const questionnaireThread = this.options.applyQuestionnaireOverlay(statusThread);
    const steerThread = this.options.applySteerOverlay(questionnaireThread);
    const browseResultThread = this.options.applyBrowseResultOverlay(steerThread);
    const overlayThread = this.options.applyOptimisticOverlay(browseResultThread);
    this.cacheByKey.set(input.key, {
      ...input,
      overlayThread,
    });
    return overlayThread;
  }
}
