/*
 * Exports:
 * - BubbleCopyFeedbackNode: minimal button surface managed by the shared bubble copy feedback lifecycle. Keywords: bubble, copy, feedback, DOM.
 * - BubbleCopyFeedbackController: register, copy, and dispose bubble copy buttons through one shared timer owner. Keywords: clipboard, feedback, lifecycle.
 * - createBubbleCopyFeedbackController: create an injectable bubble copy lifecycle for production and deterministic tests. Keywords: clipboard, scheduler, test.
 * - bubbleCopyFeedbackController: shared production bubble copy feedback lifecycle backed by the Workbench clipboard owner. Keywords: bubble, copy, singleton.
 * - getUserMessageCopyMarkdown: preserve ordered user-authored text inputs as source Markdown while excluding attachments. Keywords: user message, markdown, attachment.
 */

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { writeTextToClipboard } from "../../../lib/workbench/dom/clipboard";

const BUBBLE_COPY_FEEDBACK_MS = 1_600;

export interface BubbleCopyFeedbackNode {
  setAttribute(name: string, value: string): void;
  title: string;
}

export interface BubbleCopyFeedbackController {
  copy(button: BubbleCopyFeedbackNode, markdown: string): Promise<boolean>;
  register(button: BubbleCopyFeedbackNode): () => void;
}

type BubbleCopyState = "copied" | "failed" | "idle";

function setBubbleCopyButtonState(button: BubbleCopyFeedbackNode, state: BubbleCopyState) {
  const label = state === "copied"
    ? "Copied message"
    : state === "failed"
      ? "Copy failed"
      : "Copy message";
  button.setAttribute("aria-label", label);
  button.setAttribute("data-thread-bubble-copy-state", state);
  button.title = label;
}

export function getUserMessageCopyMarkdown(input: readonly UserInput[]) {
  return input
    .filter((item): item is Extract<UserInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .filter((markdown) => Boolean(markdown.trim()))
    .join("\n\n");
}

export function createBubbleCopyFeedbackController({
  clearScheduled = clearTimeout,
  schedule = setTimeout,
  writeText = writeTextToClipboard,
}: {
  clearScheduled?: (handle: ReturnType<typeof setTimeout>) => void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  writeText?: (text: string) => Promise<boolean>;
} = {}): BubbleCopyFeedbackController {
  const registered = new Set<BubbleCopyFeedbackNode>();
  const resetTimers = new Map<BubbleCopyFeedbackNode, ReturnType<typeof setTimeout>>();

  const clearReset = (button: BubbleCopyFeedbackNode) => {
    const handle = resetTimers.get(button);
    if (handle !== undefined) {
      clearScheduled(handle);
      resetTimers.delete(button);
    }
  };

  const showFeedback = (button: BubbleCopyFeedbackNode, state: Exclude<BubbleCopyState, "idle">) => {
    clearReset(button);
    setBubbleCopyButtonState(button, state);
    const handle = schedule(() => {
      resetTimers.delete(button);
      if (registered.has(button)) {
        setBubbleCopyButtonState(button, "idle");
      }
    }, BUBBLE_COPY_FEEDBACK_MS);
    resetTimers.set(button, handle);
  };

  return {
    async copy(button, markdown) {
      if (!markdown.trim() || !registered.has(button)) {
        return false;
      }

      const didCopy = await writeText(markdown);
      if (!registered.has(button)) {
        return false;
      }

      showFeedback(button, didCopy ? "copied" : "failed");
      return didCopy;
    },
    register(button) {
      registered.add(button);
      setBubbleCopyButtonState(button, "idle");
      return () => {
        registered.delete(button);
        clearReset(button);
      };
    },
  };
}

export const bubbleCopyFeedbackController = createBubbleCopyFeedbackController();
