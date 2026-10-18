/*
 * Exports:
 * - default MarkdownCodeBlockChrome: the header over each editor code block, as agent threads show it: an editable
 *   language, a copy button and the line wrapping toggle, kept outside the document's editable text.
 */
"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { CodeBlockChrome, CodeBlockChromeSnapshot } from "../../../workbench/editor/WorkbenchCodeBlockController";
import type { WorkbenchFilePanelClient } from "../../../workbench/WorkbenchFilePanelClient";
import IconButton from "../../ui/IconButton";
import { CheckIcon, CopyIcon, WrapTextIcon } from "../workbench-icons";

const EMPTY_SNAPSHOT: CodeBlockChromeSnapshot = { blocks: [], wrap: false };
const COPY_FEEDBACK_MS = 1400;
const noSubscription = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;

type CodeBlocks = WorkbenchFilePanelClient["codeBlocks"];
type CopyState = { id: string; ok: boolean } | null;

/** Header buttons keep the editor's selection, like the toolbar's. */
function keepEditorFocus(event: { preventDefault: () => void }) {
  event.preventDefault();
}

function LanguageField({ block, codeBlocks }: { block: CodeBlockChrome; codeBlocks: CodeBlocks }) {
  const commit = (input: HTMLInputElement) => {
    codeBlocks.setLanguage(block.id, input.value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(event.currentTarget);
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.currentTarget.value = block.language;
      event.currentTarget.blur();
    }
  };
  return (
    <input
      key={`${block.id}:${block.language}`}
      aria-label="Code block language"
      className="min-w-0 flex-1 bg-transparent pl-[0.15rem] font-mono text-[0.72rem] leading-none text-fg/muted outline-none placeholder:text-fg/muted focus:text-text"
      defaultValue={block.language}
      placeholder="code"
      spellCheck={false}
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={onKeyDown}
    />
  );
}

export default function MarkdownCodeBlockChrome({ client }: { client: WorkbenchFilePanelClient | null }) {
  const codeBlocks = client?.codeBlocks ?? null;
  const snapshot = useSyncExternalStore(codeBlocks?.subscribe ?? noSubscription, codeBlocks?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const [copyState, setCopyState] = useState<CopyState>(null);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  if (!codeBlocks || !snapshot.blocks.length) return null;

  const copy = async (id: string) => {
    const ok = await codeBlocks.copy(id);
    setCopyState({ id, ok });
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState(null), COPY_FEEDBACK_MS);
  };

  return (
    <div aria-label="Code blocks" className="pointer-events-none absolute inset-0 z-[5]">
      {snapshot.blocks.map((block) => {
        const copied = copyState?.id === block.id ? copyState : null;
        return (
          <div
            key={block.id}
            className="pointer-events-auto absolute flex h-(--code-block-head) items-center justify-between gap-2 px-[0.65rem] font-sans"
            style={{ left: block.left, top: block.top, width: block.width }}
          >
            <LanguageField block={block} codeBlocks={codeBlocks} />
            <div className="flex shrink-0 items-center gap-1">
              <IconButton
                type="button"
                label="Copy code block"
                title="Copy code block"
                display="hover-border"
                size="compact"
                className={copied ? (copied.ok ? "text-success" : "text-danger") : ""}
                onMouseDown={keepEditorFocus}
                onClick={() => { void copy(block.id); }}
              >
                {copied?.ok ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
              </IconButton>
              <IconButton
                type="button"
                label="Toggle code block line wrapping"
                title="Toggle code block line wrapping"
                display="hover-border"
                size="compact"
                aria-pressed={snapshot.wrap}
                className="aria-pressed:bg-fg/8"
                onMouseDown={keepEditorFocus}
                onClick={() => codeBlocks.setWrap(!snapshot.wrap)}
              >
                <WrapTextIcon size={16} />
              </IconButton>
            </div>
          </div>
        );
      })}
    </div>
  );
}
