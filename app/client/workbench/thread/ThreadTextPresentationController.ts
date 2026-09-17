/*
 * Exports:
 * - ThreadTextPresentationField/ThreadTextPresentationKey/ThreadTextPresentationSource: exact source-qualified streaming text identity.
 * - default ThreadTextPresentationController: owns bounded frame-paced text presentation and exact-field subscriptions.
 */

import type { TranscriptTextField } from "workbench-shared/workbench/transcript/thread-transcript-stream";
export type ThreadTextPresentationField = TranscriptTextField;

export interface ThreadTextPresentationSource {
  kind: "json" | "sqlite";
  sourceKey: string;
}

export interface ThreadTextPresentationKey {
  field: ThreadTextPresentationField;
  index: number | null;
  itemId: string;
  source: ThreadTextPresentationSource;
  threadId: string;
  turnId: string;
}

interface FieldState {
  canonicalText: string;
  displayedText: string;
  listeners: Set<() => void>;
  pendingText: string;
  revealStartedAt: number | null;
}

type ScheduleFrame = (callback: (timestamp: number) => void) => () => void;

const MAX_FIELD_PENDING_CHARACTERS = 512 * 1024;
const MAX_PASSIVE_FIELDS = 512;
const TEXT_REVEAL_DURATION_MS = 180;

function defaultScheduleFrame(callback: (timestamp: number) => void) {
  const frame = window.requestAnimationFrame(callback);
  return () => window.cancelAnimationFrame(frame);
}

function fieldKey(key: ThreadTextPresentationKey) {
  return [
    key.source.kind,
    key.source.sourceKey,
    key.threadId,
    key.turnId,
    key.itemId,
    key.field,
    key.index ?? "",
  ].join("\0");
}

function sourcePrefix(source: ThreadTextPresentationSource) {
  return `${source.kind}\0${source.sourceKey}\0`;
}

export default class ThreadTextPresentationController {
  readonly #fields = new Map<string, FieldState>();
  readonly #now: () => number;
  readonly #reducedMotion: () => boolean;
  readonly #scheduleFrame: ScheduleFrame;
  #cancelFrame: (() => void) | null = null;
  #disposed = false;

  constructor({
    now = () => performance.now(),
    reducedMotion = () => typeof window !== "undefined"
      && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
    scheduleFrame = defaultScheduleFrame,
  }: {
    now?: () => number;
    reducedMotion?: () => boolean;
    scheduleFrame?: ScheduleFrame;
  } = {}) {
    this.#now = now;
    this.#reducedMotion = reducedMotion;
    this.#scheduleFrame = scheduleFrame;
  }

  acceptDelta({
    canonicalText,
    delta,
    key,
  }: {
    canonicalText: string;
    delta: string;
    key: ThreadTextPresentationKey;
  }) {
    if (this.#disposed || !delta) return;
    const identity = fieldKey(key);
    const current = this.#fields.get(identity);
    if (!current) {
      for (const [passiveIdentity, passiveState] of this.#fields) {
        if (this.#fields.size < MAX_PASSIVE_FIELDS) break;
        if (!passiveState.listeners.size) this.#fields.delete(passiveIdentity);
      }
      this.#fields.set(identity, {
        canonicalText,
        displayedText: canonicalText,
        listeners: new Set(),
        pendingText: "",
        revealStartedAt: null,
      });
      return;
    }
    if (!current.listeners.size) {
      current.canonicalText = canonicalText;
      current.displayedText = canonicalText;
      current.pendingText = "";
      current.revealStartedAt = null;
      return;
    }
    if (
      canonicalText !== `${current.canonicalText}${delta}`
      || !canonicalText.startsWith(current.displayedText)
      || this.#reducedMotion()
    ) {
      this.#snap(identity, canonicalText);
      return;
    }

    const state = current;
    state.canonicalText = canonicalText;
    if (!state.pendingText) state.revealStartedAt = this.#now();
    state.pendingText += delta;
    if (state.pendingText.length > MAX_FIELD_PENDING_CHARACTERS) {
      this.#snap(identity, canonicalText);
      return;
    }
    this.#schedule();
  }

  complete(key: ThreadTextPresentationKey, canonicalText: string, { snap = false } = {}) {
    if (this.#disposed) return;
    const identity = fieldKey(key);
    const state = this.#fields.get(identity);
    if (!state) return;
    const targetChanged = state.canonicalText !== canonicalText;
    state.canonicalText = canonicalText;
    if (snap || targetChanged || !canonicalText.startsWith(state.displayedText)) {
      this.#snap(identity, canonicalText);
    }
  }

  getSnapshot(key: ThreadTextPresentationKey) {
    return this.#fields.get(fieldKey(key))?.displayedText ?? null;
  }

  hasSubscribers(key: ThreadTextPresentationKey) {
    return Boolean(this.#fields.get(fieldKey(key))?.listeners.size);
  }

  subscribe(key: ThreadTextPresentationKey, canonicalText: string, listener: () => void) {
    if (this.#disposed) return () => undefined;
    const identity = fieldKey(key);
    let state = this.#fields.get(identity);
    if (!state) {
      state = {
        canonicalText,
        displayedText: canonicalText,
        listeners: new Set(),
        pendingText: "",
        revealStartedAt: null,
      };
      this.#fields.set(identity, state);
    } else if (
      !state.pendingText
      && state.canonicalText !== canonicalText
      && !state.canonicalText.startsWith(canonicalText)
    ) {
      state.canonicalText = canonicalText;
      state.displayedText = canonicalText;
      state.revealStartedAt = null;
    } else if (
      !state.canonicalText.startsWith(canonicalText)
      && !canonicalText.startsWith(state.displayedText)
    ) {
      state.canonicalText = canonicalText;
      state.displayedText = canonicalText;
      state.pendingText = "";
      state.revealStartedAt = null;
    }
    state.listeners.add(listener);
    return () => {
      state?.listeners.delete(listener);
      if (state && !state.listeners.size) {
        this.#fields.delete(identity);
        this.#cancelFrameIfIdle();
      }
    };
  }

  resetSource(source: ThreadTextPresentationSource) {
    if (this.#disposed) return;
    const prefix = sourcePrefix(source);
    for (const [identity, state] of this.#fields) {
      if (!identity.startsWith(prefix)) continue;
      this.#fields.delete(identity);
      this.#notify(state);
    }
    this.#cancelFrameIfIdle();
  }

  clear() {
    if (this.#disposed) return;
    const states = [...this.#fields.values()];
    this.#fields.clear();
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    for (const state of states) this.#notify(state);
  }

  dispose() {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
  }

  #schedule() {
    if (this.#cancelFrame || this.#disposed) return;
    if (![...this.#fields.values()].some((state) => state.pendingText)) return;
    this.#cancelFrame = this.#scheduleFrame((timestamp) => {
      this.#cancelFrame = null;
      this.#tick(timestamp);
    });
  }

  #tick(timestamp: number) {
    for (const [identity, state] of this.#fields) {
      const startedAt = state.revealStartedAt ?? timestamp;
      state.revealStartedAt = startedAt;
      const progress = Math.min(1, Math.max(0, timestamp - startedAt) / TEXT_REVEAL_DURATION_MS);
      const revealLength = Math.min(
        Math.max(1, Math.ceil(state.pendingText.length * progress)),
        state.pendingText.length,
      );
      if (revealLength === 0) continue;
      const nextText = `${state.displayedText}${state.pendingText.slice(0, revealLength)}`;
      if (!state.canonicalText.startsWith(nextText)) {
        this.#snap(identity, state.canonicalText);
        continue;
      }
      state.displayedText = nextText;
      state.pendingText = state.pendingText.slice(revealLength);
      if (!state.pendingText) state.revealStartedAt = null;
      this.#notify(state);
    }
    this.#schedule();
  }

  #snap(identity: string, canonicalText: string) {
    const state = this.#fields.get(identity);
    if (!state) return;
    const changed = state.displayedText !== canonicalText;
    state.canonicalText = canonicalText;
    state.displayedText = canonicalText;
    state.pendingText = "";
    state.revealStartedAt = null;
    if (changed) this.#notify(state);
    this.#cancelFrameIfIdle();
  }

  #notify(state: FieldState) {
    for (const listener of state.listeners) listener();
  }

  #cancelFrameIfIdle() {
    if ([...this.#fields.values()].some((state) => state.pendingText)) return;
    this.#cancelFrame?.();
    this.#cancelFrame = null;
  }
}
