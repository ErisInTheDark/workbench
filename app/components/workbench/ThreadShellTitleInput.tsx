/*
 * Exports:
 * - default ThreadShellTitleInput: edit and persist the active shell thread title without changing header layout. Keywords: thread, title, input, shell.
 * - Local helper: bound displayed mutation failures without exposing response payloads. Keywords: error, boundary, title.
 */
"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";

function boundedErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : "Unable to update the thread title.").slice(0, 500);
}

export default function ThreadShellTitleInput({
  activityLabel,
  onSave,
  statusRef,
  title,
  titleRef,
}: {
  activityLabel: string;
  onSave?: (title: string) => Promise<string>;
  statusRef: Ref<HTMLParagraphElement>;
  title: string;
  titleRef: Ref<HTMLParagraphElement>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const acceptedTitleRef = useRef(title);
  const skipBlurCommitRef = useRef(false);
  const savingRef = useRef(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    acceptedTitleRef.current = title;
    if (!savingRef.current && document.activeElement !== inputRef.current) {
      setDraftTitle(title);
    }
  }, [title]);

  async function commit() {
    if (!onSave || savingRef.current) return;
    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      setDraftTitle(acceptedTitleRef.current);
      setError("A thread title cannot be empty.");
      return;
    }
    if (nextTitle === acceptedTitleRef.current) {
      setDraftTitle(acceptedTitleRef.current);
      setError("");
      return;
    }

    savingRef.current = true;
    setIsSaving(true);
    setError("");
    try {
      const acceptedTitle = await onSave(nextTitle);
      acceptedTitleRef.current = acceptedTitle;
      setDraftTitle(acceptedTitle);
    } catch (saveError) {
      setDraftTitle(acceptedTitleRef.current);
      setError(boundedErrorMessage(saveError));
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      skipBlurCommitRef.current = true;
      setDraftTitle(acceptedTitleRef.current);
      setError("");
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  return (
    <>
      <p id="file-path" ref={titleRef} className="truncate text-base font-semibold leading-tight">
        <input
          ref={inputRef}
          aria-busy={isSaving || undefined}
          aria-describedby="status-line"
          aria-invalid={Boolean(error) || undefined}
          aria-label="Thread title"
          autoComplete="off"
          className="block w-full min-w-0 truncate border-0 bg-transparent p-0 [appearance:textfield] [color:inherit] [font:inherit] [line-height:inherit] outline-none"
          readOnly={!onSave || isSaving}
          spellCheck={false}
          title={error || "Edit thread title"}
          value={draftTitle}
          onBlur={() => {
            if (skipBlurCommitRef.current) {
              skipBlurCommitRef.current = false;
              return;
            }
            void commit();
          }}
          onChange={(event) => {
            setDraftTitle(event.currentTarget.value);
            if (error) setError("");
          }}
          onKeyDown={handleKeyDown}
        />
      </p>
      <p
        id="status-line"
        ref={statusRef}
        className={`mt-1 text-[0.84rem] tracking-[0.02em] ${error ? "text-danger" : "text-fg/muted"}`}
        role={error ? "alert" : undefined}
      >
        {error || activityLabel}
      </p>
    </>
  );
}
