/*
 * Exports:
 * - ThreadTextPresentationField/ThreadTextPresentationKey/ThreadTextPresentationSource: exact source-qualified streaming text identity. Keywords: thread, text, presentation, source, field.
 * - default ThreadTextPresentationController: owns bounded frame-paced text presentation and exact-field subscriptions. Keywords: thread, text, replay, frame, lifecycle.
 */

export type ThreadTextPresentationField =
  | "agentMessageText"
  | "commandExecutionOutput"
  | "planText"
  | "reasoningContent"
  | "reasoningSummary";

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

interface PendingChunk {
  dueAt: number;
  text: string;
}

interface FieldState {
  canonicalText: string;
  displayedText: string;
  lastIngressAt: number;
  listeners: Set<() => void>;
  pending: PendingChunk[];
  pendingCharacters: number;
}

type ScheduleFrame = (callback: () => void) => () => void;

const MAX_FIELD_PENDING_CHUNKS = 512;
const MAX_FIELD_PENDING_CHARACTERS = 512 * 1024;
const MAX_PASSIVE_FIELDS = 512;
const MAX_REPLAY_GAP_MS = 120;

function defaultScheduleFrame(callback: () => void) {
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

function revealBudget(pendingCharacters: number) {
  if (pendingCharacters > 16_384) return 2_048;
  if (pendingCharacters > 4_096) return 1_024;
  if (pendingCharacters > 1_024) return 256;
  return 64;
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
        lastIngressAt: this.#now(),
        listeners: new Set(),
        pending: [],
        pendingCharacters: 0,
      });
      return;
    }
    if (!current.listeners.size) {
      current.canonicalText = canonicalText;
      current.displayedText = canonicalText;
      current.lastIngressAt = this.#now();
      current.pending = [];
      current.pendingCharacters = 0;
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

    const now = this.#now();
    const state = current;

    const gap = Math.min(MAX_REPLAY_GAP_MS, Math.max(0, now - state.lastIngressAt));
    const priorDueAt = state.pending.at(-1)?.dueAt ?? now;
    state.canonicalText = canonicalText;
    state.lastIngressAt = now;
    state.pending.push({
      dueAt: Math.max(now, priorDueAt + gap),
      text: delta,
    });
    state.pendingCharacters += delta.length;
    if (
      state.pending.length > MAX_FIELD_PENDING_CHUNKS
      || state.pendingCharacters > MAX_FIELD_PENDING_CHARACTERS
    ) {
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
        lastIngressAt: this.#now(),
        listeners: new Set(),
        pending: [],
        pendingCharacters: 0,
      };
      this.#fields.set(identity, state);
    } else if (
      !state.pending.length
      && state.canonicalText !== canonicalText
      && !state.canonicalText.startsWith(canonicalText)
    ) {
      state.canonicalText = canonicalText;
      state.displayedText = canonicalText;
    } else if (
      !state.canonicalText.startsWith(canonicalText)
      && !canonicalText.startsWith(state.displayedText)
    ) {
      state.canonicalText = canonicalText;
      state.displayedText = canonicalText;
      state.pending = [];
      state.pendingCharacters = 0;
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
    if (![...this.#fields.values()].some((state) => state.pending.length)) return;
    this.#cancelFrame = this.#scheduleFrame(() => {
      this.#cancelFrame = null;
      this.#tick();
    });
  }

  #tick() {
    const now = this.#now();
    let totalPending = 0;
    for (const state of this.#fields.values()) totalPending += state.pendingCharacters;
    let budget = revealBudget(totalPending);

    for (const [identity, state] of this.#fields) {
      let changed = false;
      while (budget > 0 && state.pending[0]?.dueAt <= now) {
        const chunk = state.pending[0];
        const revealLength = Math.min(budget, chunk.text.length);
        const suffix = chunk.text.slice(0, revealLength);
        const nextText = `${state.displayedText}${suffix}`;
        if (!state.canonicalText.startsWith(nextText)) {
          this.#snap(identity, state.canonicalText);
          changed = false;
          break;
        }
        state.displayedText = nextText;
        state.pendingCharacters -= revealLength;
        budget -= revealLength;
        changed = true;
        if (revealLength === chunk.text.length) {
          state.pending.shift();
        } else {
          chunk.text = chunk.text.slice(revealLength);
        }
      }
      if (changed) this.#notify(state);
      if (budget === 0) break;
    }
    this.#schedule();
  }

  #snap(identity: string, canonicalText: string) {
    const state = this.#fields.get(identity);
    if (!state) return;
    const changed = state.displayedText !== canonicalText;
    state.canonicalText = canonicalText;
    state.displayedText = canonicalText;
    state.pending = [];
    state.pendingCharacters = 0;
    if (changed) this.#notify(state);
    this.#cancelFrameIfIdle();
  }

  #notify(state: FieldState) {
    for (const listener of state.listeners) listener();
  }

  #cancelFrameIfIdle() {
    if ([...this.#fields.values()].some((state) => state.pending.length)) return;
    this.#cancelFrame?.();
    this.#cancelFrame = null;
  }
}
