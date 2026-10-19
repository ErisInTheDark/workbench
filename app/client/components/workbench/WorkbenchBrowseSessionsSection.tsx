"use client";

/*
 * Exports:
 * - default WorkbenchBrowseSessionsSection: the sidebar's live Browse sessions, each with its stop and forget menu.
 */

import { useCallback, useSyncExternalStore } from "react";

import type { WorkbenchBrowseSessionSummary } from "workbench-shared/types";
import type WorkbenchBrowseSessionController from "../../workbench/browse/WorkbenchBrowseSessionController";
import { writeTextToClipboard } from "../../workbench/dom/clipboard";
import ContextMenuCapability from "./ContextMenuCapability";
import { workbenchThreadListButtonClassName, workbenchThreadListLabelClassName } from "./workbench-class-names";
import {
  ArchiveIcon,
  BrowserSessionIcon,
  CopyIcon,
  StopIcon,
} from "./workbench-icons";
import type { WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";
import WorkbenchSidebarSectionDisclosure from "./WorkbenchSidebarSectionDisclosure";

function formatBrowseSessionDetail(session: WorkbenchBrowseSessionSummary) {
  return [session.mode, session.threadId ? `thread ${session.threadId.slice(0, 8)}` : null, session.state]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

export default function WorkbenchBrowseSessionsSection ({
  controller,
}: {
  controller: WorkbenchBrowseSessionController;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const getSessionContextMenu = useCallback((
    session: WorkbenchBrowseSessionSummary,
  ): WorkbenchContextMenuDefinition => ({
    id: `browse-session:${session.name}`,
    items: [
      {
        icon: <CopyIcon size={16} />,
        id: "copy-session",
        label: "Copy session name",
        onSelect: () => {
          void writeTextToClipboard(session.name);
        },
      },
      {
        icon: <StopIcon size={16} />,
        id: "stop-session",
        label: "Stop session",
        onSelect: () => {
          void controller.update(session, "stop");
        },
      },
      {
        icon: <StopIcon size={16} />,
        id: "force-stop-session",
        label: "Force stop session",
        onSelect: () => {
          void controller.update(session, "stop", { force: true });
        },
        tone: "danger",
      },
      {
        icon: <ArchiveIcon size={16} />,
        id: "forget-session",
        label: "Forget record",
        onSelect: () => {
          void controller.update(session, "forget");
        },
      },
    ],
    label: `Browse session actions for ${session.name}`,
  }), [controller]);

  if (!snapshot.sessions.length) return null;

  return (
    <section className="shrink-0 pb-3">
      <WorkbenchSidebarSectionDisclosure
        contentClassName="space-y-2"
        icon={BrowserSessionIcon}
        preferenceKey="browseSessionsOpen"
        title="Browse sessions"
      >
        <ul className="m-0 space-y-1 p-0">
          {snapshot.sessions.map((session) => {
            const detail = formatBrowseSessionDetail(session);
            const isProblemState = session.state === "orphan" || session.state === "stale" || session.state === "unknown";
            return (
              <li key={session.name} className="m-0 list-none">
                <ContextMenuCapability menu={getSessionContextMenu(session)}>
                  <div
                    title={`${session.name}${detail ? ` — ${detail}` : ""}`}
                    className={`${workbenchThreadListButtonClassName} ${isProblemState ? "text-accent" : "text-fg/muted"}`}
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <BrowserSessionIcon className="shrink-0" size={16} />
                      <span className="min-w-0">
                        <span className={`${workbenchThreadListLabelClassName} ${isProblemState ? "font-semibold" : ""}`}>
                          {session.name}
                        </span>
                        {detail ? <span className="block truncate text-[0.75rem] leading-4 text-fg/muted">{detail}</span> : null}
                      </span>
                    </span>
                  </div>
                </ContextMenuCapability>
              </li>
            );
          })}
        </ul>
        {snapshot.error ? (
          <p className="m-0 pr-2 text-[0.84rem] leading-6 text-danger">
            {snapshot.error}
          </p>
        ) : null}
      </WorkbenchSidebarSectionDisclosure>
    </section>
  );
}
