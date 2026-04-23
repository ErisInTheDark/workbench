"use client";

import { useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import ThreadLightboxImage from "./ThreadLightboxImage";

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function isWaitingOnApproval(threadStatus: string) {
  return threadStatus.includes("waitingOnApproval");
}

interface ComposerImageAttachment {
  id: string;
  url: string;
}

function createAttachmentId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function readFileAsDataUrl(file: File) {
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
  onSendMessage,
  threadId,
  threadStatus,
}: {
  onSendMessage: (threadId: string, input: UserInput[]) => Promise<void>;
  threadId: string;
  threadStatus: string;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const [error, setError] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [pendingAttachmentReads, setPendingAttachmentReads] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const trimmedValue = value.trim();
  const isAttaching = pendingAttachmentReads > 0;
  const isApprovalBlocked = isWaitingOnApproval(threadStatus);
  const isActiveThread = threadStatus.startsWith("active");

  const submit = async () => {
    if ((!trimmedValue && !attachments.length) || isSending || isAttaching) {
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
      await onSendMessage(threadId, input);
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

  return (
    <form className="mt-6 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] pt-4" onSubmit={handleSubmit}>
      <div className="rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] p-3">
        {attachments.length ? (
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
        <label className="block" htmlFor={`thread-composer:${threadId}`}>
          <span className="sr-only">Message thread</span>
          <textarea
            id={`thread-composer:${threadId}`}
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
            placeholder={isActiveThread ? "Message the current turn..." : "Continue this thread..."}
            className="min-h-[5.75rem] w-full resize-y border-0 bg-transparent px-1 py-1 text-[0.96em] leading-[1.65] text-text outline-none placeholder:text-muted"
            disabled={isSending}
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 text-[0.78em] leading-[1.6] text-muted">
            {isAttaching
              ? "Attaching pasted image..."
              : isApprovalBlocked
              ? "Current turn is waiting on approval. Sending adds guidance to that in-progress turn."
              : isActiveThread
              ? "Message the active turn. Press Enter to send and Shift+Enter for a new line."
              : "Press Enter to send and Shift+Enter for a new line."}
          </p>
          <button
            type="submit"
            disabled={(!trimmedValue && !attachments.length) || isSending || isAttaching}
            className={joinClasses(
              "rounded-full px-4 py-2 text-[0.84em] font-medium transition",
              "bg-[color:color-mix(in_srgb,var(--text)_92%,var(--bg)_8%)] text-[var(--bg)]",
              "hover:opacity-92 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text)_22%,transparent)]",
              ((!trimmedValue && !attachments.length) || isSending || isAttaching) && "cursor-not-allowed opacity-45",
            )}
          >
            {isSending ? "Sending..." : isAttaching ? "Attaching..." : "Send"}
          </button>
        </div>
      </div>
      {error ? (
        <p className="mt-2 mb-0 text-[0.84em] leading-[1.6] text-danger">{error}</p>
      ) : null}
    </form>
  );
}
