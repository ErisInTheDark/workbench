/*
 * Exports:
 * - default ThreadTitleInput: edit and persist a thread title in place, committing on enter or blur and reverting on escape.
 */
"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

function boundedErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : "Unable to update the thread title.").slice(0, 500);
}

export default function ThreadTitleInput({ className = "", onDone, onSave, title }: {
  className?: string;
  /** Called once editing ends, whether the title was saved, kept or reverted. */
  onDone?: () => void;
  onSave: (title: string) => Promise<string>;
  title: string;
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
    if (!savingRef.current && document.activeElement !== inputRef.current) setDraftTitle(title);
  }, [title]);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function commit() {
    if (savingRef.current) return;
    const nextTitle = draftTitle.trim();
    if (!nextTitle || nextTitle === acceptedTitleRef.current) {
      setDraftTitle(acceptedTitleRef.current);
      onDone?.();
      return;
    }
    savingRef.current = true;
    setIsSaving(true);
    setError("");
    try {
      acceptedTitleRef.current = await onSave(nextTitle);
      setDraftTitle(acceptedTitleRef.current);
      onDone?.();
    } catch (saveError) {
      setDraftTitle(acceptedTitleRef.current);
      setError(boundedErrorMessage(saveError));
      inputRef.current?.focus();
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
      onDone?.();
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  return (
    <input
      ref={inputRef}
      aria-busy={isSaving || undefined}
      aria-invalid={Boolean(error) || undefined}
      aria-label="Thread title"
      autoComplete="off"
      className={`
        min-w-0 border-0 bg-transparent p-0 outline-none [appearance:textfield] [color:inherit] [font:inherit]
        ${error ? "text-danger" : ""}
        ${className}
      `}
      readOnly={isSaving}
      spellCheck={false}
      title={error || undefined}
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
      onClick={event => event.preventDefault()}
      onKeyDown={handleKeyDown}
    />
  );
}
