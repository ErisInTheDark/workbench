/*
 * Exports:
 * - CodexBridgeTransitionContext: one bridge transition's pre-transition queue and active generation. Keywords: codex, bridge, transition.
 * - default CodexBridgeTransitionController: own ordered upstream ingress, transition barriers, and process generation invalidation. Keywords: codex, queue, reload, generation.
 */

export interface CodexBridgeTransitionContext {
  generation: number;
  messagesBeforeTransition: Promise<void>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

export default class CodexBridgeTransitionController {
  private generation = 0;
  private queueTail: Promise<void> = Promise.resolve();
  private transition: Promise<void> | null = null;

  get currentGeneration() {
    return this.generation;
  }

  get isTransitioning() {
    return this.transition !== null;
  }

  enqueueUpstreamMessage(
    generation: number,
    handle: () => void | Promise<void>,
    onError: (error: unknown) => void,
  ) {
    const arrivalBarrier = this.transition;
    this.queueTail = this.queueTail
      .catch(() => undefined)
      .then(async () => {
        await arrivalBarrier?.catch(() => undefined);
        if (generation !== this.generation) {
          return;
        }
        await handle();
      })
      .catch(onError);
    return this.queueTail;
  }

  async runTransition(
    operation: (context: CodexBridgeTransitionContext) => void | Promise<void>,
    options: { drain?: boolean; invalidateGeneration?: boolean } = {},
  ) {
    while (this.transition) {
      await this.transition.catch(() => undefined);
    }

    const messagesBeforeTransition = this.queueTail;
    const barrier = deferred();
    this.transition = barrier.promise;
    if (options.invalidateGeneration) {
      this.generation += 1;
    }

    try {
      if (options.drain !== false) {
        await messagesBeforeTransition.catch(() => undefined);
      }
      await operation({ generation: this.generation, messagesBeforeTransition });
    } finally {
      barrier.resolve();
      if (this.transition === barrier.promise) {
        this.transition = null;
      }
    }
  }

  waitForIdle() {
    return this.queueTail.catch(() => undefined);
  }

  async waitForTransition() {
    while (this.transition) {
      await this.transition.catch(() => undefined);
    }
  }
}
