/*
 * Exports:
 * - ThreadDocumentOverlayRevision: per-thread overlay revision clocks.
 * - ThreadDocumentRevision: complete per-thread freshness evidence for async fencing.
 * - ThreadDocumentSnapshot: one thread's canonical and visible document projection.
 * - ThreadStablePreferences: durable per-thread provider preference values.
 * - ThreadDocumentControllerOptions: projection layers and aggregate document-store ports.
 * - default ThreadDocumentController: own one thread's source, overlays, stable metadata, status, rendering, and streaming provenance.
 */

import type { ThreadPayload } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { ThreadDocumentStore as ThreadDocumentStoreApi } from "../state/ThreadDocumentStore";
import ThreadSourceStore from "../state/ThreadSourceStore";
import ThreadCanonicalLayer from "./ThreadCanonicalLayer";
import ThreadRenderPipeline from "./ThreadRenderPipeline";
import ThreadStreamingReconciler from "./ThreadStreamingReconciler";
import ThreadVisibleLayer from "./ThreadVisibleLayer";
import ThreadWorkbenchOverlayLayer from "./ThreadWorkbenchOverlayLayer";

export interface ThreadDocumentOverlayRevision {
  browseResultRevision: number;
  optimisticRevision: number;
  questionnaireForceProjectionEpoch: number;
  questionnaireRevision: number;
  steerRevision: number;
}

export interface ThreadDocumentRevision extends ThreadDocumentOverlayRevision {
  sourceRevision: number;
  stablePreferenceRevision: number;
  statusRevision: number;
}

export interface ThreadDocumentSnapshot {
  key: string;
  revision: ThreadDocumentRevision;
  source: ThreadPayload | null;
  visible: ThreadPayload | null;
}

export interface ThreadStablePreferences {
  agentNickname: string | null;
  agentPath: string | null;
  agentRole: string | null;
  model: string | null;
  reasoningEffort: string | null;
  revision: number;
  serviceTier: string | null;
  tokenUsage: ThreadPayload["tokenUsage"];
}

interface ThreadStatusRecord {
  revision: number;
  status: string | null;
}

export interface ThreadDocumentControllerOptions {
  applyBrowseResultOverlay: (thread: ThreadPayload) => ThreadPayload;
  applyOptimisticOverlay: (thread: ThreadPayload) => ThreadPayload;
  applyQuestionnaireOverlay: (thread: ThreadPayload) => ThreadPayload;
  applyStablePreferenceOverlay?: (thread: ThreadPayload) => ThreadPayload;
  applyStatusOverlay?: (thread: ThreadPayload) => ThreadPayload;
  applySteerOverlay: (thread: ThreadPayload) => ThreadPayload;
  documents: Pick<
    ThreadDocumentStoreApi,
    "deleteDocumentKey" | "getDocumentByKey" | "materializeFinalVisibleDocument"
  >;
  key: string;
  normalizeCanonicalThread: (thread: ThreadPayload) => ThreadPayload;
}

function emptyOverlayRevision(): ThreadDocumentOverlayRevision {
  return {
    browseResultRevision: 0,
    optimisticRevision: 0,
    questionnaireForceProjectionEpoch: 0,
    questionnaireRevision: 0,
    steerRevision: 0,
  };
}

export default class ThreadDocumentController {
  readonly streaming = new ThreadStreamingReconciler();

  private readonly listeners = new Set<() => void>();
  private readonly overlays = emptyOverlayRevision();
  private readonly pipeline: ThreadRenderPipeline;
  private readonly sources = ThreadSourceStore();
  private stablePreferences: ThreadStablePreferences | null = null;
  private status: ThreadStatusRecord | null = null;
  private snapshot: ThreadDocumentSnapshot;

  constructor(private readonly options: ThreadDocumentControllerOptions) {
    this.pipeline = new ThreadRenderPipeline({
      canonicalLayer: new ThreadCanonicalLayer({
        normalizeCanonicalThread: options.normalizeCanonicalThread,
      }),
      overlayLayer: new ThreadWorkbenchOverlayLayer({
        applyBrowseResultOverlay: options.applyBrowseResultOverlay,
        applyOptimisticOverlay: options.applyOptimisticOverlay,
        applyQuestionnaireOverlay: options.applyQuestionnaireOverlay,
        applyStablePreferenceOverlay: options.applyStablePreferenceOverlay ?? (thread => this.projectStablePreferences(thread)),
        applyStatusOverlay: options.applyStatusOverlay ?? (thread => this.projectStatus(thread)),
        applySteerOverlay: options.applySteerOverlay,
      }),
      visibleLayer: new ThreadVisibleLayer(),
    });
    this.snapshot = this.createSnapshot();
  }

  get key() {
    return this.options.key;
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  hasSource() {
    return this.sources.has(this.key);
  }

  getSource() {
    return this.sources.get(this.key);
  }

  getRevision(): ThreadDocumentRevision {
    return {
      ...this.overlays,
      sourceRevision: this.sources.getRevision(this.key),
      stablePreferenceRevision: this.stablePreferences?.revision ?? 0,
      statusRevision: this.status?.revision ?? 0,
    };
  }

  getOverlayRevision(): ThreadDocumentOverlayRevision {
    return { ...this.overlays };
  }

  isRevisionCurrent(revision: ThreadDocumentRevision) {
    return areDeeplyEqual(revision, this.getRevision());
  }

  installSource(thread: ThreadPayload) {
    this.assertKey(thread);
    this.sources.install(thread);
    this.publish();
    return this.key;
  }

  updateSource(updater: (thread: ThreadPayload) => ThreadPayload | null) {
    const changed = this.sources.update(this.key, updater);
    if (changed) this.publish();
    return changed;
  }

  bumpOverlay(revision: keyof ThreadDocumentOverlayRevision) {
    this.overlays[revision] += 1;
    this.publish();
  }

  captureStablePreferences(thread: ThreadPayload) {
    this.assertKey(thread);
    const record = this.stablePreferences ?? {
      agentNickname: null,
      agentPath: null,
      agentRole: null,
      model: null,
      reasoningEffort: null,
      revision: 0,
      serviceTier: null,
      tokenUsage: null,
    };
    const next = {
      agentNickname: thread.agentNickname ?? record.agentNickname,
      agentPath: thread.agentPath ?? record.agentPath,
      agentRole: thread.agentRole ?? record.agentRole,
      model: thread.model ?? record.model,
      reasoningEffort: thread.reasoningEffort ?? record.reasoningEffort,
      serviceTier: thread.serviceTier ?? record.serviceTier,
      tokenUsage: thread.tokenUsage ?? record.tokenUsage,
    };
    if (
      record.agentNickname === next.agentNickname
      && record.agentPath === next.agentPath
      && record.agentRole === next.agentRole
      && record.model === next.model
      && record.reasoningEffort === next.reasoningEffort
      && record.serviceTier === next.serviceTier
      && areDeeplyEqual(record.tokenUsage, next.tokenUsage)
    ) {
      this.stablePreferences ??= record;
      return false;
    }
    this.stablePreferences = { ...next, revision: record.revision + 1 };
    this.publish();
    return true;
  }

  updateStablePreferences(updater: (record: Omit<ThreadStablePreferences, "revision">) => void) {
    const source = this.getSource();
    if (!source) return false;
    this.captureStablePreferences(source);
    const record = this.stablePreferences!;
    const next = { ...record };
    updater(next);
    if (
      record.agentNickname === next.agentNickname
      && record.agentPath === next.agentPath
      && record.agentRole === next.agentRole
      && record.model === next.model
      && record.reasoningEffort === next.reasoningEffort
      && record.serviceTier === next.serviceTier
      && areDeeplyEqual(record.tokenUsage, next.tokenUsage)
    ) return false;
    this.stablePreferences = { ...next, revision: record.revision + 1 };
    this.publish();
    return true;
  }

  setStatus(status: string | null) {
    if (this.status?.status === status) return false;
    this.status = { revision: (this.status?.revision ?? 0) + 1, status };
    this.publish();
    return true;
  }

  getStatus() {
    return this.status?.status ?? null;
  }

  getStablePreferences() {
    return this.stablePreferences;
  }

  render({ selected = false }: { selected?: boolean } = {}) {
    const source = this.getSource();
    if (!source) return null;
    const revision = this.getRevision();
    return this.pipeline.render({
      ...revision,
      canonicalRevision: revision.sourceRevision,
      key: this.key,
      publicRevision: 0,
      rawThread: source,
      selected,
    });
  }

  materialize({ select = false }: { select?: boolean } = {}) {
    const visible = this.render({ selected: select });
    if (!visible) return null;
    this.options.documents.materializeFinalVisibleDocument(this.key, visible, { select });
    this.publish();
    return visible;
  }

  invalidateProjection() {
    this.pipeline.delete(this.key);
    this.publish();
  }

  clear() {
    const sourceChanged = this.sources.delete(this.key);
    const documentChanged = this.options.documents.deleteDocumentKey(this.key);
    this.pipeline.delete(this.key);
    this.streaming.clearClientCreatedItemKeys();
    this.stablePreferences = null;
    this.status = null;
    Object.assign(this.overlays, emptyOverlayRevision());
    const changed = sourceChanged || documentChanged;
    if (changed) this.publish();
    return changed;
  }

  private assertKey(thread: Pick<ThreadPayload, "harness" | "id">) {
    const key = `${thread.harness}:${thread.id}`;
    if (key !== this.key) {
      throw new Error(`Thread document owner ${this.key} cannot accept source ${key}.`);
    }
  }

  private projectStablePreferences(thread: ThreadPayload) {
    const record = this.stablePreferences;
    if (!record) return thread;
    const next = {
      ...thread,
      agentNickname: thread.agentNickname ?? record.agentNickname,
      agentPath: thread.agentPath ?? record.agentPath,
      agentRole: thread.agentRole ?? record.agentRole,
      model: thread.model ?? record.model,
      reasoningEffort: thread.reasoningEffort ?? record.reasoningEffort,
      serviceTier: thread.serviceTier ?? record.serviceTier,
      tokenUsage: thread.tokenUsage ?? record.tokenUsage,
    };
    return next.agentNickname === thread.agentNickname
      && next.agentPath === thread.agentPath
      && next.agentRole === thread.agentRole
      && next.model === thread.model
      && next.reasoningEffort === thread.reasoningEffort
      && next.serviceTier === thread.serviceTier
      && next.tokenUsage === thread.tokenUsage
      ? thread
      : next;
  }

  private projectStatus(thread: ThreadPayload) {
    const status = this.status?.status;
    return status && status !== thread.status ? { ...thread, status } : thread;
  }

  private createSnapshot(): ThreadDocumentSnapshot {
    return {
      key: this.key,
      revision: this.getRevision(),
      source: this.getSource(),
      visible: this.options.documents.getDocumentByKey(this.key),
    };
  }

  private publish() {
    this.snapshot = this.createSnapshot();
    for (const listener of this.listeners) listener();
  }
}
