"use client";

import { useEffect, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";

import type { RateLimitSnapshot } from "../../../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn, hasStaleApprovalState, isCurrentTurnWaitingOnApproval } from "../../../lib/codex/thread-state";
import type {
  ThreadPayload,
  WorkbenchAgentOption,
  WorkbenchModelOption,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "../../../lib/types";
import ThreadAgentPicker from "./ThreadAgentPicker";
import ThreadLightboxImage from "./ThreadLightboxImage";
import ThreadModelPicker from "./ThreadModelPicker";
import ThreadUserInputRequest from "./ThreadUserInputRequest";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

interface ComposerImageAttachment {
  id: string;
  url: string;
}

function createAttachmentId () {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function readFileAsDataUrl (file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error("Unable to read the pasted image."));
    };
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Unable to read the pasted image."));
    };
    reader.readAsDataURL(file);
  });
}

export default function ThreadComposer ({
  composerInfoMessage,
  onClearUserInputRequest,
  onListModels,
  onSendMessage,
  onShowExampleQuestion,
  onSubmitUserInputRequest,
  onThreadAgentChange,
  onThreadReasoningEffortChange,
  onThreadModelChange,
  pendingUserInputRequest,
  rateLimits,
  thread,
}: {
  composerInfoMessage: string;
  onClearUserInputRequest: (threadId: string) => void;
  onListModels: (harness: ThreadPayload["harness"]) => Promise<WorkbenchModelOption[]>;
  onSendMessage: (threadId: string, input: UserInput[]) => Promise<void>;
  onShowExampleQuestion: (threadId: string) => void;
  onSubmitUserInputRequest: (threadId: string, response: WorkbenchUserInputResponse) => Promise<void>;
  onThreadAgentChange: (threadId: string, agentPath: string | null) => void;
  onThreadReasoningEffortChange: (threadId: string, effort: string | null) => void;
  onThreadModelChange: (threadId: string, model: string) => void;
  pendingUserInputRequest: WorkbenchUserInputRequest | null;
  rateLimits: RateLimitSnapshot | null;
  thread: ThreadPayload;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const [availableModels, setAvailableModels] = useState<WorkbenchModelOption[]>([]);
  const [availableAgents, setAvailableAgents] = useState<WorkbenchAgentOption[]>([]);
  const [deprioritizedModelIdsByHarness, setDeprioritizedModelIdsByHarness] = useState<Record<ThreadPayload["harness"], string[]>>({
    codex: [],
    copilot: [],
  });
  const [activePicker, setActivePicker] = useState<"agent" | "model" | null>(null);
  const [error, setError] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [agentsError, setAgentsError] = useState("");
  const [modelsError, setModelsError] = useState("");
  const [pendingAttachmentReads, setPendingAttachmentReads] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const trimmedValue = value.trim();
  const isAttaching = pendingAttachmentReads > 0;
  const hasPendingUserInputRequest = pendingUserInputRequest !== null;
  const isCopilotAuthRequired = thread.harness === "copilot" && rateLimits?.limitId === "copilot:auth";
  const isThreadStateBroken = hasStaleApprovalState(thread);
  const isApprovalBlocked = isCurrentTurnWaitingOnApproval(thread);
  const isActiveThread = getCurrentInProgressTurn(thread) !== null;
  const isInputDisabled = hasPendingUserInputRequest || isSending || isAttaching || isThreadStateBroken || isCopilotAuthRequired;
  const helperText = hasPendingUserInputRequest
    ? "Answer the question card below to continue this local workbench preview."
    : isAttaching
      ? "Attaching pasted image..."
    : isCopilotAuthRequired
      ? "Open a terminal, run copilot, then use /login to authenticate Copilot CLI."
      : isThreadStateBroken
        ? "Thread state is out of sync. Sending is disabled here."
        : isApprovalBlocked
          ? "Current turn is waiting on approval. Sending adds guidance to that in-progress turn."
          : isActiveThread
            ? "Message the active turn. Press Enter to send and Shift+Enter for a new line."
            : thread.isDraft
              ? ""
              : "Press Enter to send and Shift+Enter for a new line.";
  const selectedModel = thread.model;
  const selectedModelOption = availableModels.find((model) => model.id === selectedModel) ?? null;
  const defaultModelOption = availableModels.find((model) => model.isDefault) ?? null;
  const modelButtonLabel = selectedModelOption?.displayName
    ?? selectedModel
    ?? defaultModelOption?.displayName
    ?? "Default model";
  const supportedReasoningEfforts = selectedModelOption?.supportedReasoningEfforts ?? [];
  const currentReasoningEffort = thread.reasoningEffort
    ?? selectedModelOption?.defaultReasoningEffort
    ?? supportedReasoningEfforts[0]
    ?? null;
  const showsReasoningEffortControl = Boolean(selectedModelOption?.supportsReasoningEffort && currentReasoningEffort);
  const isAgentPickerOpen = activePicker === "agent";
  const isModelPickerOpen = activePicker === "model";
  const isPickerOpen = activePicker !== null;
  const selectedAgent = availableAgents.find((agent) => agent.path === thread.agentPath) ?? null;
  const agentButtonLabel = selectedAgent?.name
    ?? thread.agentPath?.split("/").at(-1)?.replace(/\.agent\.md$/i, "")
    ?? "Agent";
  const deprioritizedModelIds = deprioritizedModelIdsByHarness[thread.harness] ?? [];

  useEffect(() => {
    setActivePicker(null);
    setAgentsError("");
    setModelsError("");
  }, [pendingUserInputRequest?.id, thread.id]);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingAgents(true);
    void fetch("/api/agents", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) {
        throw new Error("Unable to load agents.");
      }

      const payload = await response.json() as { data?: WorkbenchAgentOption[] };
      if (cancelled) {
        return;
      }

      setAvailableAgents(payload.data ?? []);
      setAgentsError("");
    }).catch((agentsLoadError) => {
      if (cancelled) {
        return;
      }

      setAgentsError(agentsLoadError instanceof Error ? agentsLoadError.message : "Unable to load agents.");
    }).finally(() => {
      if (!cancelled) {
        setIsLoadingAgents(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAvailableModels([]);
    void onListModels(thread.harness).then((models) => {
      if (cancelled) {
        return;
      }

      setAvailableModels(models);
    }).catch(() => {
      // Ignore background refresh failures; the picker load path shows a user-facing error.
    });

    return () => {
      cancelled = true;
    };
  }, [onListModels, thread.harness]);

  useEffect(() => {
    if (!isModelPickerOpen) {
      return;
    }

    let cancelled = false;
    setIsLoadingModels(true);
    setModelsError("");
    void onListModels(thread.harness).then((models) => {
      if (cancelled) {
        return;
      }

      setAvailableModels(models);
    }).catch((modelsLoadError) => {
      if (cancelled) {
        return;
      }

      setModelsError(modelsLoadError instanceof Error ? modelsLoadError.message : "Unable to load models.");
    }).finally(() => {
      if (!cancelled) {
        setIsLoadingModels(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isModelPickerOpen, onListModels, thread.harness]);

  const submit = async () => {
    if ((!trimmedValue && !attachments.length) || isInputDisabled || isPickerOpen) {
      return;
    }

    const input: UserInput[] = [];
    if (trimmedValue) {
      input.push({
        type: "text",
        text: trimmedValue,
        text_elements: [],
      });
    }
    for (const attachment of attachments) {
      input.push({
        type: "image",
        url: attachment.url,
      });
    }

    setIsSending(true);
    setError("");
    try {
      await onSendMessage(thread.id, input);
      setValue("");
      setAttachments([]);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Unable to send that message.");
    } finally {
      setIsSending(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || isComposing) {
      return;
    }

    event.preventDefault();
    void submit();
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (!imageFiles.length) {
      return;
    }

    event.preventDefault();
    setError("");
    setPendingAttachmentReads((count) => count + 1);
    void (async () => {
      try {
        const nextAttachments = await Promise.all(imageFiles.map(async (file) => ({
          id: createAttachmentId(),
          url: await readFileAsDataUrl(file),
        })));
        setAttachments((current) => [...current, ...nextAttachments]);
      } catch (pasteError) {
        setError(pasteError instanceof Error ? pasteError.message : "Unable to attach the pasted image.");
      } finally {
        setPendingAttachmentReads((count) => Math.max(0, count - 1));
      }
    })();
  };

  const cycleReasoningEffort = (direction: 1 | -1) => {
    if (!supportedReasoningEfforts.length || !currentReasoningEffort) {
      return;
    }

    const currentIndex = supportedReasoningEfforts.indexOf(currentReasoningEffort);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + direction + supportedReasoningEfforts.length) % supportedReasoningEfforts.length;
    onThreadReasoningEffortChange(thread.id, supportedReasoningEfforts[nextIndex] ?? null);
  };

  return (
    <form className="mt-6 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] pt-4" onSubmit={handleSubmit}>
      <div className="rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] p-3">
        {hasPendingUserInputRequest ? (
          <ThreadUserInputRequest
            request={pendingUserInputRequest}
            onClear={() => {
              onClearUserInputRequest(thread.id);
            }}
            onSubmit={async (response) => {
              await onSubmitUserInputRequest(thread.id, response);
            }}
          />
        ) : null}
        {!hasPendingUserInputRequest && attachments.length ? (
          <div className="mb-3 flex flex-wrap gap-3 px-1">
            {attachments.map((attachment, index) => (
              <div key={attachment.id} className="relative h-24 w-24">
                <ThreadLightboxImage
                  alt={`Attached image ${index + 1}`}
                  buttonClassName="h-full w-full rounded-[0.95rem]"
                  imageClassName="h-full w-full object-cover"
                  src={attachment.url}
                />
                <button
                  type="button"
                  aria-label={`Remove attached image ${index + 1}`}
                  title="Remove attached image"
                  className="absolute top-1.5 right-1.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] text-text shadow-sm transition hover:bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                  onClick={() => {
                    setAttachments((current) => current.filter((currentAttachment) => currentAttachment.id !== attachment.id));
                  }}
                >
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeWidth="1.8"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <label className="block" htmlFor={`thread-composer:${thread.id}`} hidden={hasPendingUserInputRequest}>
          <span className="sr-only">Message thread</span>
          <div hidden={isPickerOpen}>
            <textarea
              id={`thread-composer:${thread.id}`}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (error) {
                  setError("");
                }
              }}
              onCompositionStart={() => {
                setIsComposing(true);
              }}
              onCompositionEnd={() => {
                setIsComposing(false);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={isThreadStateBroken
                ? "New messages are disabled for this thread."
                : isCopilotAuthRequired
                  ? "Sign in to Copilot CLI to send messages."
                  : isActiveThread
                    ? "Message the current turn..."
                    : thread.isDraft
                      ? "Start a new thread..."
                      : "Continue this thread..."}
              className="min-h-[5.75rem] w-full resize-y border-0 bg-transparent px-1 py-1 text-[0.96em] leading-[1.65] text-text outline-none placeholder:text-muted"
              disabled={isInputDisabled}
            />
          </div>
        </label>
        {!hasPendingUserInputRequest && isModelPickerOpen ? (
          <ThreadModelPicker
            appliesOnNextTurnOnly={thread.harness === "codex" && isActiveThread}
            deprioritizedModelIds={deprioritizedModelIds}
            error={modelsError}
            harness={thread.harness}
            isLoading={isLoadingModels}
            models={availableModels}
            selectedModelId={selectedModel}
            onClose={() => {
              setActivePicker(null);
            }}
            onSelectModel={(model) => {
              onThreadModelChange(thread.id, model.id);
              setModelsError("");
              setActivePicker(null);
            }}
            onToggleModelPriority={(modelId) => {
              setDeprioritizedModelIdsByHarness((current) => {
                const currentIds = current[thread.harness] ?? [];
                const nextIds = currentIds.includes(modelId)
                  ? currentIds.filter((id) => id !== modelId)
                  : [...currentIds, modelId];

                return {
                  ...current,
                  [thread.harness]: nextIds,
                };
              });
            }}
          />
        ) : !hasPendingUserInputRequest && isAgentPickerOpen ? (
          <ThreadAgentPicker
            agents={availableAgents}
            error={agentsError}
            isLoading={isLoadingAgents}
            selectedAgentPath={thread.agentPath}
            onClose={() => {
              setActivePicker(null);
            }}
            onSelectAgent={(agentPath) => {
              onThreadAgentChange(thread.id, agentPath);
              setActivePicker(null);
            }}
          />
        ) : !hasPendingUserInputRequest ? (
          <div className={joinClasses(
            "mt-3 flex flex-wrap items-center gap-3",
            helperText ? "justify-between" : "justify-end",
          )}>
            {helperText ? (
              <p className={joinClasses(
                "m-0 text-[0.78em] leading-[1.6]",
                isThreadStateBroken ? "text-danger" : "text-muted",
              )}>
                {helperText}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-2 text-[0.78em] font-medium text-text transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                onClick={() => {
                  setActivePicker(null);
                  onShowExampleQuestion(thread.id);
                }}
              >
                Show example question
              </button>
              <div className="inline-flex items-stretch overflow-hidden rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_96%,transparent)] text-[0.78em] font-medium text-text">
                <button
                  type="button"
                  className="px-3 py-2 transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
                  onClick={() => {
                    setActivePicker("model");
                  }}
                >
                  {modelButtonLabel}
                </button>
                {showsReasoningEffortControl ? (
                  <>
                    <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
                    <button
                      type="button"
                      className="px-2.5 py-2 capitalize transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
                      title="Left click to increase effort. Right click to decrease effort."
                      onClick={() => {
                        cycleReasoningEffort(1);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        cycleReasoningEffort(-1);
                      }}
                    >
                      {currentReasoningEffort}
                    </button>
                  </>
                ) : null}
                <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
                <button
                  type="button"
                  className="px-3 py-2 transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
                  onClick={() => {
                    setActivePicker("agent");
                  }}
                >
                  {agentButtonLabel}
                </button>
              </div>
              <button
                type="submit"
                disabled={(!trimmedValue && !attachments.length) || isInputDisabled}
                className={joinClasses(
                  "rounded-full px-4 py-2 text-[0.84em] font-medium transition",
                  "bg-[color:color-mix(in_srgb,var(--text)_92%,var(--bg)_8%)] text-[var(--bg)]",
                  "hover:opacity-92 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text)_22%,transparent)]",
                  ((!trimmedValue && !attachments.length) || isInputDisabled) && "cursor-not-allowed opacity-45",
                )}
              >
                {isSending ? "Sending..." : isAttaching ? "Attaching..." : isThreadStateBroken ? "Unavailable" : "Send"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="mt-2 mb-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
      ) : null}
      {!error && composerInfoMessage ? (
        <p className="mt-2 mb-0 text-[0.84em] leading-[1.6] text-muted">{composerInfoMessage}</p>
      ) : null}
    </form>
  );
}
