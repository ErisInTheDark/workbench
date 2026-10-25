/*
 * Exports:
 * - default MarkdownLinkChrome: the editor's link chrome: a card under the link at the caret or pointer, opening,
 *   editing, copying or removing it, and the link draft field Ctrl+K and the toolbar open. Web links open in a browser
 *   tab, links to files beside the document open in this tab, and `#heading` links scroll to the heading.
 */
"use client";

import {
  useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type ComponentPropsWithoutRef, type FormEvent, type KeyboardEvent, type ReactNode,
} from "react";
import { withFileDestination, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { resolveLinkTarget, type LinkTarget } from "../../../workbench/markdown/markdown-link-destination";
import type { LinkCardView, LinkChromeSnapshot, LinkDraftView } from "../../../workbench/editor/WorkbenchLinkController";
import { useWorkbenchSwapTab } from "../../../workbench/navigation/use-workbench-project-navigation";
import type { WorkbenchFilePanelClient } from "../../../workbench/WorkbenchFilePanelClient";
import IconButton from "../../ui/IconButton";
import Tooltip from "../../ui/Tooltip";
import { CommandTooltip } from "./MarkdownEditorToolbar";
import { ArrowRightIcon, CheckIcon, CopyIcon, ExternalLinkIcon, FileTextIcon, LinkIcon, SquarePenIcon, UnlinkIcon } from "../workbench-icons";

const EMPTY_SNAPSHOT: LinkChromeSnapshot = { card: null, draft: null, width: 0 };
const COPY_FEEDBACK_MS = 1400;
const noSubscription = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;

type Links = WorkbenchFilePanelClient["links"];

const surfaceClassName = `
  pointer-events-auto absolute font-sans bg-[color-mix(in_srgb,var(--app-bg-solid)_89%,var(--text)_11%)]
  motion-safe:animate-[fade-in_120ms_ease-out]
`;

/** Card buttons keep the editor's caret and focus, like the toolbar's. */
function keepEditorFocus(event: { preventDefault: () => void }) {
  event.preventDefault();
}

/** Sits at `left` but slides back to stay inside the shell's width. */
function Placed({ left, top, width, ...props }: ComponentPropsWithoutRef<"div"> & { left: number; top: number; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) element.style.left = `${Math.max(0, Math.min(left, width - element.offsetWidth))}px`;
  });
  return <div ref={ref} {...props} style={{ left, top }} />;
}

function describeTarget(href: string, target: LinkTarget | null) {
  if (target?.kind === "web") {
    return { icon: <ExternalLinkIcon size={14} />, label: "Open link", text: target.url.replace(/^https?:\/\//u, "").replace(/\/$/u, "") };
  }
  if (target?.kind === "file") return { icon: <FileTextIcon size={14} />, label: `Open ${target.path}`, text: target.path };
  if (target?.kind === "heading") return { icon: <ArrowRightIcon size={14} />, label: "Go to heading", text: href };
  return { icon: <ExternalLinkIcon size={14} />, label: "This link can't be opened from here", text: href };
}

function LinkCard({ card, links, route, width }: { card: LinkCardView; links: Links; route: WorkbenchRoute; width: number }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const target = resolveLinkTarget(card.href, route.filePath);
  const { icon, label, text } = describeTarget(card.href, target);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(card.href);
      setCopied(true);
    } catch {
      setCopied(false);
      return;
    }
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };
  const action = (name: string, glyph: ReactNode, onClick: () => void, options: { disabled?: boolean; tone?: "danger" } = {}) => (
    <Tooltip placement="bottom" delayMs={350} content={name}>
      <IconButton label={name} title="" size="compact" display="hover-border" disabled={options.disabled} tone={options.tone}
        onMouseDown={keepEditorFocus} onClick={onClick}>
        {glyph}
      </IconButton>
    </Tooltip>
  );

  return (
    <Placed
      role="toolbar"
      aria-label="Link"
      left={card.left}
      top={card.top}
      width={width}
      className={`${surfaceClassName} flex max-w-[min(30rem,100%)] items-center gap-0.5 rounded-full py-0.5 pr-0.5 pl-1 text-[0.8rem]`}
      onPointerEnter={() => links.setCardHeld(true)}
      onPointerLeave={() => links.setCardHeld(false)}
    >
        <button
          type="button"
          title={card.href}
          disabled={!target}
          className="min-w-0 cursor-pointer truncate rounded-full px-2 py-0.5 text-left text-fg/80 transition-colors enabled:hover:(bg-fg/6 text-text) disabled:cursor-default"
          onMouseDown={keepEditorFocus}
          onClick={() => links.openCard()}
        >
          {text}
        </button>
        {action(label, icon, () => links.openCard(), { disabled: !target })}
        {action(copied ? "Copied" : "Copy link", copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />, () => { void copy(); })}
        {card.editable ? (
          <>
            <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-fg/12" />
            <CommandTooltip command="link">
              <IconButton label="Edit link" title="" size="compact" display="hover-border" onMouseDown={keepEditorFocus} onClick={() => links.editCard()}>
                <SquarePenIcon size={14} />
              </IconButton>
            </CommandTooltip>
            {action("Remove link", <UnlinkIcon size={14} />, () => links.removeCardLink(), { tone: "danger" })}
          </>
        ) : null}
    </Placed>
  );
}

const fieldClassName = "min-w-0 flex-1 bg-transparent py-1.5 text-text outline-none placeholder:text-fg/45";

function LinkDraft({ draft, links, width }: { draft: LinkDraftView; links: Links; width: number }) {
  const [invalid, setInvalid] = useState(false);
  const hrefRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const field = draft.needsText ? textRef.current : hrefRef.current;
    field?.focus({ preventScroll: true });
    field?.select();
  }, [draft.needsText]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setInvalid(!links.submitDraft(hrefRef.current?.value ?? "", textRef.current?.value ?? ""));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    links.cancelDraft();
  };

  return (
    <Placed left={draft.left} top={draft.top} width={width} className={`${surfaceClassName} w-[min(24rem,100%)] rounded-[0.9rem] p-1 text-[0.85rem]`}>
      <form
        aria-label={draft.editing ? "Edit link" : "Add link"}
        className="flex flex-col [&>*+*]:(border-t border-fg-alpha/8)"
        onSubmit={submit}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) links.cancelDraft({ refocus: false });
        }}
      >
        {draft.needsText ? (
          <label className="flex items-center gap-2 pl-2.5">
            <span className="w-8 shrink-0 text-[0.75rem] text-fg/muted">Text</span>
            <input ref={textRef} className={fieldClassName} placeholder="Shown as the link" spellCheck={false} />
          </label>
        ) : null}
        <label className="flex items-center gap-2 pl-2.5">
          <span className="flex w-8 shrink-0 text-fg/muted"><LinkIcon size={14} /></span>
          <input
            ref={hrefRef}
            aria-label="Link address"
            aria-invalid={invalid}
            className={`${fieldClassName} ${invalid ? "text-danger" : ""}`}
            defaultValue={draft.href}
            placeholder="Paste or type a link"
            spellCheck={false}
            onChange={() => setInvalid(false)}
          />
          <span className="flex shrink-0 items-center">
            {draft.editing ? (
              <Tooltip placement="bottom" delayMs={350} content="Remove link">
                <IconButton label="Remove link" title="" size="small" display="hover-border" tone="danger" onClick={() => links.submitDraft("")}>
                  <UnlinkIcon size={16} />
                </IconButton>
              </Tooltip>
            ) : null}
            <Tooltip placement="bottom" delayMs={350} content="Apply (Enter)">
              <IconButton type="submit" label="Apply link" title="" size="small" display="hover-border">
                <CheckIcon size={16} />
              </IconButton>
            </Tooltip>
          </span>
        </label>
        {invalid ? <p role="alert" className="m-0 px-2.5 py-1 text-[0.75rem] text-danger">Links can't run scripts or hold data.</p> : null}
      </form>
    </Placed>
  );
}

export default function MarkdownLinkChrome({ client, route }: { client: WorkbenchFilePanelClient | null; route: WorkbenchRoute }) {
  const links = client?.links ?? null;
  const snapshot = useSyncExternalStore(links?.subscribe ?? noSubscription, links?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const swapTab = useWorkbenchSwapTab();

  useEffect(() => {
    if (!links) return;
    links.setOpenHandler((href) => {
      const target = resolveLinkTarget(href, route.filePath);
      if (target?.kind === "web") window.open(target.url, "_blank", "noopener,noreferrer");
      else if (target?.kind === "file") swapTab(withFileDestination(route, target.path));
      else if (target?.kind === "heading") links.revealHeading(target.slug);
    });
    return () => links.setOpenHandler(null);
  }, [links, route, swapTab]);

  if (!links || (!snapshot.card && !snapshot.draft)) return null;
  return (
    <div aria-label="Link controls" className="pointer-events-none absolute inset-0 z-[25]">
      {snapshot.draft ? (
        <LinkDraft key={`${snapshot.draft.needsText}:${snapshot.draft.href}`} draft={snapshot.draft} links={links} width={snapshot.width} />
      ) : snapshot.card ? (
        <LinkCard card={snapshot.card} links={links} route={route} width={snapshot.width} />
      ) : null}
    </div>
  );
}
