/*
 * Exports:
 * - default ThreadVisFrame: render an agent-authored document in a sandboxed frame that runs its scripts but reaches no network,
 *   with the injected `window.wb` bridge seeded from the file's synced control state; the frame takes the height its page
 *   reports, follows control state set elsewhere, and forwards its own control changes to `onControl` only while focused.
 *   Fullscreen lifts it over the whole page, with a close button, without reloading its page.
 */
"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { VisControls } from "workbench-shared/workbench/vis/vis-contract";
import {
  acceptVisFrameControl, frameVisDocument, readVisFrameHeight, visFrameControlsMessage,
} from "workbench-shared/workbench/vis/vis-frame";
import IconButton from "../../ui/IconButton";
import { XIcon } from "../workbench-icons";

const NO_CONTROLS: VisControls = {};

const fullscreenClassName = `
  fixed inset-0 m-0 size-full max-h-none max-w-none overflow-y-auto border-0 p-4 md:p-6
  bg-[var(--app-bg-solid)] text-text scrollbar-hover-reveal backdrop:bg-transparent
`;

/** `className` styles the frame's box; its height follows the page's content. */
export default function ThreadVisFrame({
  className = "", controls = NO_CONTROLS, document, fullscreen = false, onControl, onExitFullscreen, title,
}: {
  className?: string;
  /** The file's stored control state; snapshots show their page without it. */
  controls?: VisControls;
  document: string;
  /** Covers the whole page; the frame keeps its content height and the cover scrolls. */
  fullscreen?: boolean;
  /** Live frames only; snapshots ignore what their page sets. */
  onControl?: (id: string, value: string) => void;
  /** The cover's close button and Escape (while focus is outside the frame) call this. */
  onExitFullscreen?: () => void;
  title: string;
}) {
  const coverRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onControlRef = useRef(onControl);
  onControlRef.current = onControl;
  const onExitFullscreenRef = useRef(onExitFullscreen);
  onExitFullscreenRef.current = onExitFullscreen;
  // The top layer escapes the transforms and clipping of whatever holds the frame, and unlike a portal it never
  // moves the frame in the DOM, which would reload its page.
  useLayoutEffect(() => {
    const cover = coverRef.current;
    if (!fullscreen || !cover) return;
    cover.showPopover();
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExitFullscreenRef.current?.();
    };
    window.addEventListener("keydown", exit);
    return () => {
      window.removeEventListener("keydown", exit);
      if (cover.matches(":popover-open")) cover.hidePopover();
    };
  }, [fullscreen]);
  // Changes this frame made that the stored state has not echoed yet; they win, so a late echo never undoes a newer pick.
  const pendingRef = useRef(new Map<string, string>());
  for (const [id, value] of pendingRef.current) if (controls[id] === value) pendingRef.current.delete(id);
  const current = { ...controls, ...Object.fromEntries(pendingRef.current) };
  const currentRef = useRef(current);
  currentRef.current = current;
  // State is seeded once per document; later changes reach the running page as messages, so picks never reload it.
  const source = useMemo(() => frameVisDocument(document, currentRef.current), [document]);
  /** Null until the page first reports its height. */
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(visFrameControlsMessage(currentRef.current), "*");
  }, [controls]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      const fromOwnFrame = Boolean(frame) && event.source === frame!.contentWindow;
      const reported = readVisFrameHeight({ fromOwnFrame, data: event.data });
      if (reported !== null) {
        setHeight(reported);
        return;
      }
      if (!onControlRef.current) return;
      const change = acceptVisFrameControl({ fromOwnFrame, frameFocused: Boolean(frame) && frame!.ownerDocument.activeElement === frame, data: event.data });
      if (!change) return;
      pendingRef.current.set(change.id, change.value);
      onControlRef.current(change.id, change.value);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return (
    <div className={fullscreen ? fullscreenClassName : "contents"} popover={fullscreen ? "manual" : undefined} ref={coverRef}>
      <div className={`overflow-hidden ${height === null ? "h-48" : ""} ${className}`} style={height === null ? undefined : { height }}>
        <iframe
          className="block size-full border-0 bg-transparent scheme-light-dark"
          ref={frameRef}
          sandbox="allow-scripts"
          srcDoc={source}
          title={title}
        />
      </div>
      {fullscreen ? (
        <IconButton className="fixed right-3 top-3" label="Exit fullscreen" onClick={onExitFullscreen}>
          <XIcon size={16} />
        </IconButton>
      ) : null}
    </div>
  );
}
