/*
 * Exports:
 * - ThreadRenderPipelineInput: ordered complete-thread pipeline input. Keywords: thread, render, pipeline.
 * - ThreadRenderPipelineLayers: layer controller bundle for rendering. Keywords: thread, render, layers.
 * - default ThreadRenderPipeline: coordinates canonical, overlay, and final visible layer rendering. Keywords: thread, render, controller.
 */

import type { ThreadPayload } from "../../types";
import ThreadCanonicalLayer from "./ThreadCanonicalLayer";
import ThreadVisibleLayer from "./ThreadVisibleLayer";
import ThreadWorkbenchOverlayLayer, { type ThreadWorkbenchOverlayLayerInput } from "./ThreadWorkbenchOverlayLayer";

export interface ThreadRenderPipelineInput extends Omit<ThreadWorkbenchOverlayLayerInput, "key" | "liveThread"> {
  canonicalRevision: number;
  key: string;
  publicRevision: number;
  rawThread: ThreadPayload;
  selected: boolean;
}

export interface ThreadRenderPipelineLayers {
  canonicalLayer: ThreadCanonicalLayer;
  overlayLayer: ThreadWorkbenchOverlayLayer;
  visibleLayer: ThreadVisibleLayer;
}

export default class ThreadRenderPipeline {
  private readonly layers: ThreadRenderPipelineLayers;
  private readonly materializationCountsByKey = new Map<string, number>();

  constructor(layers: ThreadRenderPipelineLayers) {
    this.layers = layers;
  }

  clear() {
    this.layers.canonicalLayer.clear();
    this.layers.overlayLayer.clear();
    this.layers.visibleLayer.clear();
    this.materializationCountsByKey.clear();
  }

  invalidate(key: string) {
    this.layers.canonicalLayer.invalidate(key);
    this.layers.overlayLayer.invalidate(key);
    this.layers.visibleLayer.invalidate(key);
  }

  render(input: ThreadRenderPipelineInput) {
    this.materializationCountsByKey.set(input.key, (this.materializationCountsByKey.get(input.key) ?? 0) + 1);
    const canonicalThread = this.layers.canonicalLayer.render({
      key: input.key,
      rawThread: input.rawThread,
      revision: input.canonicalRevision,
    });
    const overlayThread = this.layers.overlayLayer.render({
      key: input.key,
      liveThread: canonicalThread,
      optimisticRevision: input.optimisticRevision,
      questionnaireForceProjectionEpoch: input.questionnaireForceProjectionEpoch,
      questionnaireRevision: input.questionnaireRevision,
      screenshotRevision: input.screenshotRevision,
      stablePreferenceRevision: input.stablePreferenceRevision,
      statusRevision: input.statusRevision,
      steerRevision: input.steerRevision,
    });
    return this.layers.visibleLayer.render({
      key: input.key,
      overlayThread,
      publicRevision: input.publicRevision,
      selected: input.selected,
    });
  }

  getMaterializationCount(key: string) {
    return this.materializationCountsByKey.get(key) ?? 0;
  }

  getMaterializationCountsSnapshot() {
    return new Map(this.materializationCountsByKey);
  }
}
