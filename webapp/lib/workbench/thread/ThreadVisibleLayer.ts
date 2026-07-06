/*
 * Exports:
 * - ThreadVisibleLayerInput: complete overlay thread and public materialization input. Keywords: thread, visible, layer.
 * - default ThreadVisibleLayer: cache owner for final visible thread output. Keywords: thread, visible, controller.
 */

import type { ThreadPayload } from "../../types";

export interface ThreadVisibleLayerInput {
  key: string;
  overlayThread: ThreadPayload;
  publicRevision: number;
  selected: boolean;
}

interface ThreadVisibleLayerCacheEntry extends ThreadVisibleLayerInput {
  finalVisibleThread: ThreadPayload;
}

export default class ThreadVisibleLayer {
  private readonly cacheByKey = new Map<string, ThreadVisibleLayerCacheEntry>();

  clear() {
    this.cacheByKey.clear();
  }

  invalidate(key: string) {
    this.cacheByKey.delete(key);
  }

  render(input: ThreadVisibleLayerInput) {
    const previous = this.cacheByKey.get(input.key);
    if (
      previous
      && previous.overlayThread === input.overlayThread
      && previous.publicRevision === input.publicRevision
      && previous.selected === input.selected
    ) {
      return previous.finalVisibleThread;
    }

    this.cacheByKey.set(input.key, {
      ...input,
      finalVisibleThread: input.overlayThread,
    });
    return input.overlayThread;
  }
}
